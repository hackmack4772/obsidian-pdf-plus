import { PDFAnnotationHighlight, PDFPageView, PDFTextHighlight, PDFView } from 'typings';
import { App, Component, Modifier, Platform } from 'obsidian';
import { ObsidianViewer, PDFViewerChild } from 'typings';
import PDFPlus from 'main';

export function getTextLayerNode(pageEl: HTMLElement, node: Node): HTMLElement | null {
    if (!pageEl.contains(node))
        return null;
    if (node.instanceOf(HTMLElement) && node.hasClass("textLayerNode"))
        return node;
    for (let n: Node | null = node; n = n.parentNode;) {
        if (n === pageEl)
            return null;
        if (n.instanceOf(HTMLElement) && n.hasClass("textLayerNode"))
            return n;
    }
    return null
}

/** 
 * Register a callback executed when the text layer for a page gets rendered. 
 * Note that PDF rendering is "lazy"; the text layer for a page is not rendered until the page is scrolled into view.
 * 
 * @param component A component such that the callback is unregistered when the component is unloaded, or `null` if the callback should be called only once.
 */
export function onTextLayerReady(viewer: ObsidianViewer, component: Component | null, cb: (pageView: PDFPageView, pageNumber: number) => any) {
    viewer.pdfViewer._pages
        .forEach((pageView, pageIndex) => {
            if (pageView.textLayer) {
                cb(pageView, pageIndex + 1); // page number is 1-based
            }
        });
    const listener = async (data: { source: PDFPageView, pageNumber: number, numTextDivs: number }) => {
        await cb(data.source, data.pageNumber);
        if (!component) viewer.eventBus.off("textlayerrendered", listener);
    };
    component?.register(() => viewer.eventBus.off("textlayerrendered", listener));
    return viewer.eventBus.on("textlayerrendered", listener);
}

/** 
 * Register a callback executed when the annotation layer for a page gets rendered. 
 * 
 * @param component A component such that the callback is unregistered when the component is unloaded, or `null` if the callback should be called only once.
 */
export function onAnnotationLayerReady(viewer: ObsidianViewer, component: Component | null, cb: (pageView: PDFPageView, pageNumber: number) => any) {
    viewer.pdfViewer._pages
        .forEach((pageView, pageIndex) => {
            if (pageView.annotationLayer) {
                cb(pageView, pageIndex + 1); // page number is 1-based
            }
        });
    const listener = async (data: { source: PDFPageView, pageNumber: number }) => {
        await cb(data.source, data.pageNumber);
        if (!component) viewer.eventBus.off("annotationlayerrendered", listener);
    };
    component?.register(() => viewer.eventBus.off("annotationlayerrendered", listener));
    return viewer.eventBus.on("annotationlayerrendered", listener);
}

export function iteratePDFViews(app: App, cb: (view: PDFView) => any) {
    app.workspace.getLeavesOfType('pdf').forEach((leaf) => cb(leaf.view as PDFView));
}

export function highlightSubpath(child: PDFViewerChild, subpath: string, duration: number) {
    child.applySubpath(subpath);
    if (child.subpathHighlight?.type === 'text') {
        onTextLayerReady(child.pdfViewer, null, () => {
            if (!child.subpathHighlight) return;
            const { page, range } = child.subpathHighlight as PDFTextHighlight;
            child.highlightText(page, range);
            if (duration > 0) {
                setTimeout(() => {
                    child.clearTextHighlight();
                    child.backlinkManager?.highlightBacklinks();
                }, duration * 1000);
            }
        });
    } else if (child.subpathHighlight?.type === 'annotation') {
        onAnnotationLayerReady(child.pdfViewer, null, () => {
            if (!child.subpathHighlight) return;
            const { page, id } = child.subpathHighlight as PDFAnnotationHighlight;
            child.highlightAnnotation(page, id);
            if (duration > 0) setTimeout(() => child.clearAnnotationHighlight(), duration * 1000);
        });
    }
}

export async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isHexString(color: string) {
    return color.length === 7 && color.startsWith('#');
}

export const getLinkToSelection = (plugin: PDFPlus, params?: Record<string, string>): string | null => {
    const selection = window.getSelection();
    if (!selection) return null;
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const pageEl = range?.startContainer.parentElement?.closest('.page');
    if (!pageEl || !(pageEl.instanceOf(HTMLElement)) || pageEl.dataset.pageNumber === undefined) return null;

    const viewerEl = pageEl.closest<HTMLElement>('.pdf-viewer');
    if (!viewerEl) return null;

    const child = plugin.pdfViwerChildren.get(viewerEl);
    if (!child) return null;

    const page = pageEl.dataset.pageNumber;
    params = {
        page,
        selection: child.getTextSelectionRangeStr(pageEl),
        ...params ?? {}
    }
    const linktext = child.getMarkdownLink('#' + Object.entries(params).map(([k, v]) => k && v ? `${k}=${v}` : '').join('&'), child.getPageLinkAlias(+page));
    return linktext;
}


export const copyLinkToSelection = (plugin: PDFPlus, embed: boolean = false, checking: boolean = false, params?: Record<string, string>): boolean => {
    let linktext = getLinkToSelection(plugin, params);
    if (embed) linktext = '!' + linktext;
    if (linktext === null) return false;
    if (!checking) navigator.clipboard.writeText(linktext);
    return true;
}

export const copyAsQuote = (plugin: PDFPlus, checking: boolean = false, params?: Record<string, string>): boolean => {
    const linktext = getLinkToSelection(plugin, params);
    const selection = window.getSelection()?.toString().replace(/[\r\n]+/g, " ");
    if (!linktext || !selection) return false;
    if (!checking) {
        navigator.clipboard.writeText("> ".concat(selection, "\n\n").concat(linktext));
    }
    return true;
}

export function getModifierNameInPlatform(mod: Modifier): string {
    if (mod === "Mod") {
        return Platform.isMacOS || Platform.isIosApp ? "Command" : "Ctrl";
    }
    if (mod === "Shift") {
        return "Shift";
    }
    if (mod === "Alt") {
        return Platform.isMacOS || Platform.isIosApp ? "Option" : "Alt";
    }
    if (mod === "Meta") {
        return Platform.isMacOS || Platform.isIosApp ? "Command" : Platform.isWin ? "Win" : "Meta";
    }
    return "Ctrl";
}
