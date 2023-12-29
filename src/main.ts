import { Component, EventRef, Events, Keymap, Notice, Plugin, loadPdfJs } from 'obsidian';

import { patchPDF } from 'patchers/pdf';
import { patchBacklink } from 'patchers/backlink';
import { patchWorkspace } from 'patchers/workspace';
import { patchPagePreview } from 'patchers/page-preview';
import { BacklinkHighlighter } from 'highlight';
import { ColorPalette } from 'color-palette';
import { BacklinkPanePDFManager } from 'pdf-backlink';
import { DEFAULT_BACKLINK_HOVER_COLOR, DEFAULT_SETTINGS, PDFPlusSettings, PDFPlusSettingTab } from 'settings';
import { copyLink, isHexString, iterateBacklinkViews, iteratePDFViews, subpathToParams } from 'utils';
import { PDFEmbed, PDFView, PDFViewerChild } from 'typings';


export default class PDFPlus extends Plugin {
	settings: PDFPlusSettings;
	/** Maps a `div.pdf-viewer` element to the corresponding `PDFViewerChild` object */
	pdfViwerChildren: Map<HTMLElement, PDFViewerChild> = new Map();
	/** Manages DOMs and event handlers introduced by this plugin */
	elementManager: Component;
	pdfjsLib: typeof import('pdfjs-dist');
	events: Events = new Events();

	async onload() {
		this.pdfjsLib = await loadPdfJs();

		await this.loadSettings();
		await this.saveSettings();
		this.addSettingTab(new PDFPlusSettingTab(this));

		this.elementManager = this.addChild(new Component());

		this.app.workspace.onLayoutReady(() => this.loadStyle());

		// Patch Obsidian internals
		this.app.workspace.onLayoutReady(() => {
			patchWorkspace(this);
			patchPagePreview(this);
		});
		this.tryPatchUntilSuccess(patchPDF, () => {
			iteratePDFViews(this.app, async (view) => {
				// reflect the patch to existing PDF views
				const file = view.file;
				if (file) view.onLoadFile(file);
			});
		}, {
			message: 'Some features for PDF embeds will not be activated until a PDF file is opened in a viewer.',
			duration: 7000
		});
		this.tryPatchUntilSuccess(patchBacklink, () => {
			iterateBacklinkViews(this.app, (view) => {
				 // reflect the patch to existing backlink views
				if (view.file?.extension === 'pdf') {
					if (!view.pdfManager) {
						view.pdfManager = new BacklinkPanePDFManager(this, view.backlink, view.file).setParents(this, view);
					}
				}
			});
		});

		// Make PDF embeds with a subpath unscrollable
		this.registerDomEvent(document, 'wheel', (evt) => {
			if (this.settings.embedUnscrollable
				&& evt.target instanceof HTMLElement
				&& evt.target.closest('.pdf-embed[src*="#"] .pdf-viewer-container')) {
				evt.preventDefault();
			}
		}, { passive: false });

		// Click PDF embeds to open links
		this.registerDomEvent(window, 'click', (evt) => {
			if (this.settings.clickEmbedToOpenLink && evt.target instanceof HTMLElement) {
				const linktext = evt.target.closest('.pdf-embed[src]')?.getAttribute('src');
				const viewerEl = evt.target.closest<HTMLElement>('div.pdf-viewer');
				if (linktext) {
					const sourcePath = viewerEl ? (this.pdfViwerChildren.get(viewerEl)?.file?.path ?? '') : '';
					this.app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(evt));
				}
			}
		})

		// keep this.pdfViewerChildren up-to-date
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			for (const viewerEl of this.pdfViwerChildren.keys()) {
				if (!viewerEl?.isShown()) this.pdfViwerChildren.delete(viewerEl);
			}
		}));

		const originalPDFEmbedCreator = this.app.embedRegistry.embedByExtension['pdf'];
		this.app.embedRegistry.unregisterExtension('pdf');
		this.app.embedRegistry.registerExtension('pdf', (info, file, subpath) => {
			const embed = originalPDFEmbedCreator(info, file, subpath) as PDFEmbed;
			embed.viewer.then((child) => {
				if (this.settings.noSidebarInEmbed) {
					child.pdfViewer.pdfSidebar.open = function () {
						this.close();
					};
				}
			});
			const params = subpathToParams(subpath);
			if (params.has('color')) {
				embed.containerEl.dataset.highlightColor = params.get('color')!.toLowerCase();
			} else if (this.settings.defaultColor) {
				embed.containerEl.dataset.highlightColor = this.settings.defaultColor.toLowerCase();
			}
			return embed;
		});

		this.registerHoverLinkSource('pdf-plus', {
			defaultMod: true,
			display: 'PDF++ hover action'
		});

		this.registerCommands();

		(window as any).pdfPlus = this;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	tryPatchUntilSuccess(patcher: (plugin: PDFPlus) => boolean, onSuccess?: () => any, noticeOnFail?: { message: string, duration?: number }) {
		this.app.workspace.onLayoutReady(() => {
			const success = patcher(this);
			if (success) onSuccess?.();
			else {
				const notice = noticeOnFail ? new Notice(`${this.manifest.name}: ${noticeOnFail.message}`, noticeOnFail.duration) : null;

				const eventRef = this.app.workspace.on('layout-change', () => {
					const success = patcher(this);
					if (success) {
						this.app.workspace.offref(eventRef);
						notice?.hide();
						onSuccess?.();
					}
				});
				this.registerEvent(eventRef);
			}
		});
	}

	/** 
	 * Registers an HTML element that will be refreshed when a style setting is updated
	 * and will be removed when the plugin gets unloaded. 
	 */
	registerEl<HTMLElementType extends HTMLElement>(el: HTMLElementType) {
		this.elementManager.register(() => el.remove());
		return el;
	}

	loadStyle() {
		this.elementManager.unload();
		// reload only if parent is loaded
		this.removeChild(this.elementManager);
		this.addChild(this.elementManager);

		for (const child of this.pdfViwerChildren.values()) {
			if (child.toolbar) new ColorPalette(this, child.toolbar.toolbarLeftEl);
		}

		const styleEl = this.registerEl(createEl('style', { attr: { id: 'pdf-plus-style' } }));
		document.head.append(styleEl);

		styleEl.textContent = Object.entries(this.settings.colors).map(([name, color]) => {
			return isHexString(color) ? [
				`.textLayer .mod-focused.pdf-plus-backlink:not(.hovered-highlight)[data-highlight-color="${name.toLowerCase()}"],`,
				`.pdf-embed[data-highlight-color="${name.toLowerCase()}"] .textLayer .mod-focused {`,
				`    background-color: ${color};`,
				`}`
			].join('\n') : '';
		}).join('\n');

		const defaultColor = this.settings.colors[this.settings.defaultColor];
		if (defaultColor && isHexString(defaultColor)) {
			styleEl.textContent += [
				`\n.textLayer .mod-focused.pdf-plus-backlink:not(.hovered-highlight) {`,
				`    background-color: ${defaultColor};`,
				`}`
			].join('\n');
		}

		let backlinkHoverColor = this.settings.colors[this.settings.backlinkHoverColor];
		if (!backlinkHoverColor || !isHexString(backlinkHoverColor)) backlinkHoverColor = DEFAULT_BACKLINK_HOVER_COLOR;
		styleEl.textContent += [
			`\n.textLayer .mod-focused.pdf-plus-backlink.hovered-highlight {`,
			`	background-color: ${backlinkHoverColor};`,
			`}`
		].join('\n');

		this.app.workspace.trigger('css-change');
	}

	registerCommands() {
		this.addCommand({
			id: 'copy-link-to-selection',
			name: 'Copy link to selection with color & format specified in toolbar',
			checkCallback: (checking: boolean) => {
				// get the toolbar in the active PDF viewer, if any
				const toolbar = this.getToolbar();
				if (!toolbar) return false;

				const buttonEl = toolbar.toolbarEl.querySelector<HTMLElement>(`.pdf-plus-action-menu[data-checked-index]`);
				if (!buttonEl) return false;

				// get the index of the checked item in the action dropdown menu
				if (buttonEl.dataset.checkedIndex === undefined) return false;
				const index = +buttonEl.dataset.checkedIndex;

				// get the currently selected color name
				const selectedItemEl = toolbar.toolbarEl.querySelector<HTMLElement>('.pdf-plus-color-palette-item.is-active[data-highlight-color]');
				const colorName = selectedItemEl?.dataset.highlightColor;

				copyLink(this, this.settings.copyCommands[index].format, checking, colorName);
			}
		});
	}

	on(evt: "highlighted", callback: (data: { type: 'selection' | 'annotation', source: 'obsidian' | 'pdf-plus', pageNumber: number, child: PDFViewerChild }) => any, context?: any): EventRef;

	on(evt: string, callback: (...data: any) => any, context?: any): EventRef {
		return this.events.on(evt, callback, context);
	}

	off(evt: string, callback: (...data: any) => any) {
		this.events.off(evt, callback);
	}

	offref(ref: EventRef) {
		this.events.offref(ref);
	}

	trigger(evt: "highlighted", data: { type: 'selection' | 'annotation', source: 'obsidian' | 'pdf-plus', pageNumber: number, child: PDFViewerChild }): void;

	trigger(evt: string, ...args: any[]): void {
		this.events.trigger(evt, ...args);
	}

	// console utilities

	getPDFView(): PDFView | undefined {
		const leaf = this.app.workspace.activeLeaf;
		if (leaf?.view.getViewType() === 'pdf') return leaf.view as PDFView;
		return this.app.workspace.getLeavesOfType('pdf')[0]?.view as PDFView | undefined;
	}

	getPDFViewer() {
		return this.getPDFView()?.viewer;
	}

	getPDFViewerChild() {
		return this.getPDFViewer()?.child;
	}

	getObsidianViewer() {
		return this.getPDFViewerChild()?.pdfViewer;
	}

	getRawPDFViewer() {
		return this.getObsidianViewer()?.pdfViewer;
	}

	getToolbar() {
		return this.getPDFViewerChild()?.toolbar;
	}
}
