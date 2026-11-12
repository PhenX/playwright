/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { NodeSnapshot } from '@isomorphic/trace/trace';

export type SnapshotData = {
  doctype?: string,
  html: NodeSnapshot,
  resourceOverrides: {
    url: string,
    // String is the content. Number is "x snapshots ago", same url.
    content: string | number,
    contentType: 'text/css'
  }[],
  viewport: { width: number, height: number },
  url: string,
  wallTime: number,
  collectionTime: number,
  // Check mode only: the first difference from a full walk.
  checkError?: string,
};

// With `check`, each snapshot is compared with a full walk of a second streamer, see _checkSnapshot().
export function frameSnapshotStreamer(snapshotStreamer: string, removeNoScript: boolean, check?: boolean) {
  // Communication with Playwright.
  if ((window as any)[snapshotStreamer])
    return;

  // Attributes present in the snapshot.
  const kShadowAttribute = '__playwright_shadow_root_';
  const kValueAttribute = '__playwright_value_';
  const kCheckedAttribute = '__playwright_checked_';
  const kSelectedAttribute = '__playwright_selected_';
  const kScrollTopAttribute = '__playwright_scroll_top_';
  const kScrollLeftAttribute = '__playwright_scroll_left_';
  const kStyleSheetAttribute = '__playwright_style_sheet_';
  const kTargetAttribute = '__playwright_target__';
  const kCustomElementsAttribute = '__playwright_custom_elements__';
  const kCurrentSrcAttribute = '__playwright_current_src__';
  const kBoundingRectAttribute = '__playwright_bounding_rect__';
  const kPopoverOpenAttribute = '__playwright_popover_open_';
  const kDialogOpenAttribute = '__playwright_dialog_open_';

  // Symbols for our own info on Nodes/StyleSheets.
  const kSnapshotFrameId = Symbol('__playwright_snapshot_frameid_');
  // The generation of the last mark of an action target, set by _refreshListeners().
  const kTargetGeneration = Symbol('__playwright_target_generation_');
  const kCachedData = Symbol('__playwright_snapshot_cache_');
  const kEndOfList = Symbol('__playwright_end_of_list_');
  type CachedData = {
    cached?: any[], // Cached values to determine whether the snapshot will be the same.
    ref?: [number, number], // Previous snapshotNumber and nodeIndex.
    attributesCached?: boolean, // Whether node attributes have not changed.
    cssText?: string, // Text for stylesheets.
    cssRef?: number, // Previous snapshotNumber for overridden stylesheets.
    refHistoryEpoch?: number, // For style sheets: `ref` is valid only in this history epoch.

    // The fields below are for nodes only.
    historyEpoch?: number, // The data of a node is valid only in the same history epoch.
    dirtyEpoch?: number, // The node or a node in its subtree changed in this mark epoch.
    insertedEpoch?: number, // The node was inserted in this mark epoch, visit its full subtree.
    volatileValues?: any[], // Values that can change without a DOM mutation, see _volatileValues().
    // Read on every element in each snapshot, because they can change without a DOM mutation.
    scrollTop?: number,
    scrollLeft?: number,
    shadowRoot?: ShadowRoot | null,
    adoptedStyleSheets?: CSSStyleSheet[], // For documentElement and shadow roots.
  };

  // Use for style sheets.
  function ensureCachedData(obj: any): CachedData {
    if (!obj[kCachedData])
      obj[kCachedData] = {};
    return obj[kCachedData];
  }

  // Use for nodes. resetHistory() increments the epoch, which makes all node data invalid.
  let historyEpoch = 0;

  function nodeData(node: Node): CachedData | undefined {
    const data = (node as any)[kCachedData] as CachedData | undefined;
    return data?.historyEpoch === historyEpoch ? data : undefined;
  }

  function ensureNodeData(node: Node): CachedData {
    let data = nodeData(node);
    if (!data) {
      // All fields in the same order, so that the JS engine uses one object shape for all nodes.
      data = {
        historyEpoch,
        dirtyEpoch: 0,
        insertedEpoch: 0,
        cached: undefined,
        ref: undefined,
        attributesCached: undefined,
        volatileValues: undefined,
        scrollTop: 0,
        scrollLeft: 0,
        shadowRoot: null,
        adoptedStyleSheets: undefined,
      };
      (node as any)[kCachedData] = data;
    }
    return data;
  }

  function arraysEqual(a: any[] | undefined, b: any[]) {
    if (!a || a.length !== b.length)
      return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i])
        return false;
    }
    return true;
  }

  const kObserverConfig: MutationObserverInit = { attributes: true, childList: true, characterData: true, subtree: true };

  function removeHash(url: string) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  class Streamer {
    private _lastSnapshotNumber = 0;
    private _staleStyleSheets = new Set<CSSStyleSheet>();
    private _modifiedStyleSheets = new Set<CSSStyleSheet>();
    private _readingStyleSheet = false;  // To avoid invalidating due to our own reads.
    private _fakeBase: HTMLBaseElement;
    private _observer: MutationObserver;
    private _observedDocument: Document | undefined;
    private _targetGeneration = 0;
    private _nativeFirstChild: (this: Node) => Node | null;
    private _nativeNextSibling: (this: Node) => Node | null;
    private _nativeShadowRootGetter: (this: Element) => ShadowRoot | null;

    // A snapshot visits only the nodes that are marked as dirty in the current mark epoch,
    // and their ancestors. Other nodes are the same as in the previous snapshot.
    // Each snapshot marks the nodes with changes that a MutationObserver does not report, so that
    // the result is the same as a full walk. See _markChangesWithoutMutations().
    private _markEpoch = 1;
    // Elements with state that can change without a DOM mutation, for example an input value.
    private _volatileElements = new Set<Element>();
    private _customElements = new Set<Element>();
    private _bodies = new Set<Element>();
    private _shadowRoots = new Set<ShadowRoot>();
    private _markedTargets = new Set<Element>();
    private _lastBaseURI: string | undefined;
    // Check mode only: the streamer that makes the full walks, and the nodes of each snapshot.
    _reference: Streamer | undefined;
    private _checkNodes = new Map<number, NodeSnapshot[]>();
    // The reference streamer of check mode visits all nodes and returns no references.
    _fullWalks = false;

    constructor() {
      // Some pages overwrite the following native functions, so capture them in advance.
      this._nativeFirstChild = Object.getOwnPropertyDescriptor(window.Node.prototype, 'firstChild')!.get!;
      this._nativeNextSibling = Object.getOwnPropertyDescriptor(window.Node.prototype, 'nextSibling')!.get!;
      this._nativeShadowRootGetter = Object.getOwnPropertyDescriptor(window.Element.prototype, 'shadowRoot')!.get!;

      const invalidateCSSGroupingRule = (rule: CSSGroupingRule) => {
        if (rule.parentStyleSheet)
          this._invalidateStyleSheet(rule.parentStyleSheet);
      };
      this._interceptNativeMethod(window.CSSStyleSheet.prototype, 'insertRule', (sheet: CSSStyleSheet) => this._invalidateStyleSheet(sheet));
      this._interceptNativeMethod(window.CSSStyleSheet.prototype, 'deleteRule', (sheet: CSSStyleSheet) => this._invalidateStyleSheet(sheet));
      this._interceptNativeMethod(window.CSSStyleSheet.prototype, 'addRule', (sheet: CSSStyleSheet) => this._invalidateStyleSheet(sheet));
      this._interceptNativeMethod(window.CSSStyleSheet.prototype, 'removeRule', (sheet: CSSStyleSheet) => this._invalidateStyleSheet(sheet));
      this._interceptNativeGetter(window.CSSStyleSheet.prototype, 'rules', (sheet: CSSStyleSheet) => this._invalidateStyleSheet(sheet));
      this._interceptNativeGetter(window.CSSStyleSheet.prototype, 'cssRules', (sheet: CSSStyleSheet) => this._invalidateStyleSheet(sheet));
      this._interceptNativeMethod(window.CSSStyleSheet.prototype, 'replaceSync', (sheet: CSSStyleSheet) => this._invalidateStyleSheet(sheet));
      this._interceptNativeMethod(window.CSSGroupingRule.prototype, 'insertRule', invalidateCSSGroupingRule);
      this._interceptNativeMethod(window.CSSGroupingRule.prototype, 'deleteRule', invalidateCSSGroupingRule);
      this._interceptNativeGetter(window.CSSGroupingRule.prototype, 'cssRules', invalidateCSSGroupingRule);
      this._interceptNativeSetter(window.StyleSheet.prototype, 'disabled', (sheet: StyleSheet) => {
        if (sheet instanceof CSSStyleSheet)
          this._invalidateStyleSheet(sheet as CSSStyleSheet);
      });
      this._interceptNativeAsyncMethod(window.CSSStyleSheet.prototype, 'replace', (sheet: CSSStyleSheet) => this._invalidateStyleSheet(sheet));

      this._fakeBase = document.createElement('base');

      this._observer = new MutationObserver(list => this._handleMutations(list));
      this._ensureObservingCurrentDocument();
    }

    private _refreshListenersWhenNeeded() {
      this._refreshListeners();

      const customEventName = '__playwright_snapshotter_global_listeners_check__';

      let seenEvent = false;
      const handleCustomEvent = () => seenEvent = true;
      window.addEventListener(customEventName, handleCustomEvent);

      const observer = new MutationObserver(entries => {
        // Check for new documentElement in case we need to reinstall document listeners.
        const newDocumentElement = entries.some(entry => Array.from(entry.addedNodes).includes(document.documentElement));
        if (newDocumentElement) {
          // New documentElement - let's check whether listeners are still here.
          seenEvent = false;
          window.dispatchEvent(new CustomEvent(customEventName));
          if (!seenEvent) {
            // Listener did not fire. Reattach the listener and notify.
            window.addEventListener(customEventName, handleCustomEvent);
            this._refreshListeners();
          }
        }
      });
      observer.observe(document, { childList: true });
    }

    private _refreshListeners() {
      (document as any).addEventListener('__playwright_mark_target__', (event: CustomEvent) => {
        const target = event.composedPath()[0] as Element;
        if (target?.nodeType !== Node.ELEMENT_NODE)
          return;
        (target as any)[kTargetGeneration] = this._targetGeneration;
        this._markedTargets.add(target);
        this._markDirty(target);
      });
      (document as any).addEventListener('__playwright_reset_targets__', () => this._resetTargets());
    }

    _resetTargets() {
      ++this._targetGeneration;
      for (const target of this._markedTargets)
        this._markDirty(target);
      this._markedTargets.clear();
    }

    // Marks the node and its ancestors, so that the next snapshot visits them.
    private _markDirty(node: Node) {
      for (let n: Node | null = node; n; n = n.parentNode || (n.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (n as ShadowRoot).host : null)) {
        const data = ensureNodeData(n);
        // The ancestors are already marked in this epoch.
        if (data.dirtyEpoch === this._markEpoch)
          return;
        data.dirtyEpoch = this._markEpoch;
      }
    }

    private _shadowRoot(element: Element): ShadowRoot | null {
      // Some frameworks define fake `element.shadowRoot` properties, thus the native getter.
      return this._nativeShadowRootGetter.call(element);
    }

    private _interceptNativeMethod(obj: any, method: string, cb: (thisObj: any, result: any) => void) {
      const native = obj[method] as Function;
      if (!native)
        return;
      obj[method] = function(...args: any[]) {
        const result = native.call(this, ...args);
        cb(this, result);
        return result;
      };
    }

    private _interceptNativeAsyncMethod(obj: any, method: string, cb: (thisObj: any, result: any) => void) {
      const native = obj[method] as Function;
      if (!native)
        return;
      obj[method] = async function(...args: any[]) {
        const result = await native.call(this, ...args);
        cb(this, result);
        return result;
      };
    }

    private _interceptNativeGetter(obj: any, prop: string, cb: (thisObj: any, result: any) => void) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, prop)!;
      Object.defineProperty(obj, prop, {
        ...descriptor,
        get: function() {
          const result = descriptor.get!.call(this);
          cb(this, result);
          return result;
        },
      });
    }

    private _interceptNativeSetter(obj: any, prop: string, cb: (thisObj: any, result: any) => void) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, prop)!;
      Object.defineProperty(obj, prop, {
        ...descriptor,
        set: function(value: any) {
          const result = descriptor.set!.call(this, value);
          cb(this, value);
          return result;
        },
      });
    }

    private _handleMutations(list: MutationRecord[]) {
      for (const mutation of list) {
        if (mutation.type === 'attributes') {
          ensureNodeData(mutation.target).attributesCached = undefined;
        } else if (mutation.type === 'childList') {
          // The inserted subtree can have changed while it was not observed, for example
          // when it was not in the document.
          for (const node of mutation.addedNodes)
            ensureNodeData(node).insertedEpoch = this._markEpoch;
        }
        this._markDirty(mutation.target);
      }
    }

    private _ensureObservingCurrentDocument() {
      // A window can swap its document without re-running the init script (e.g.
      // a popup reusing its initial about:blank document), leaving our observers
      // and listeners bound to the stale one. Re-attach on swap.
      // https://github.com/microsoft/playwright/issues/40895
      if (this._observedDocument === document)
        return;
      this._observedDocument = document;
      this._observer.disconnect();
      this._observer.observe(document, kObserverConfig);
      this._refreshListenersWhenNeeded();
      // The tracked elements and shadow roots are from the old document.
      this.resetHistory();
    }

    private _invalidateStyleSheet(sheet: CSSStyleSheet) {
      if (this._readingStyleSheet)
        return;
      this._staleStyleSheets.add(sheet);
      if (sheet.href !== null)
        this._modifiedStyleSheets.add(sheet);
    }

    private _updateStyleElementStyleSheetTextIfNeeded(sheet: CSSStyleSheet, forceText?: boolean): string | undefined {
      const data = ensureCachedData(sheet);
      if (this._staleStyleSheets.has(sheet) || (forceText && data.cssText === undefined)) {
        this._staleStyleSheets.delete(sheet);
        try {
          data.cssText = this._getSheetText(sheet);
        } catch (e) {
          // Sometimes we cannot access cross-origin stylesheets.
          data.cssText = '';
        }
      }
      return data.cssText;
    }

    // Returns either content, ref, or no override.
    private _updateLinkStyleSheetTextIfNeeded(sheet: CSSStyleSheet, snapshotNumber: number): string | number | undefined {
      const data = ensureCachedData(sheet);
      if (this._staleStyleSheets.has(sheet)) {
        this._staleStyleSheets.delete(sheet);
        try {
          data.cssText = this._getSheetText(sheet);
          data.cssRef = snapshotNumber;
          return data.cssText;
        } catch (e) {
          // Sometimes we cannot access cross-origin stylesheets.
        }
      }
      return data.cssRef === undefined ? undefined : snapshotNumber - data.cssRef;
    }

    markIframe(iframeElement: HTMLIFrameElement | HTMLFrameElement, frameId: string) {
      (iframeElement as any)[kSnapshotFrameId] = frameId;
      this._markDirty(iframeElement);
      this._reference?.markIframe(iframeElement, frameId);
    }

    resetHistory() {
      this._reference?.resetHistory();
      this._staleStyleSheets.clear();
      // All node data becomes invalid, so the next snapshot visits all nodes again.
      ++historyEpoch;
      // The next snapshot adds the elements and shadow roots again.
      this._volatileElements.clear();
      this._customElements.clear();
      this._bodies.clear();
      this._shadowRoots.clear();
      this._checkNodes.clear();
      this._lastBaseURI = undefined;
    }

    private _trackShadowRoot(shadowRoot: ShadowRoot) {
      if (this._shadowRoots.has(shadowRoot))
        return;
      this._shadowRoots.add(shadowRoot);
      // The document observer does not see changes in shadow roots.
      this._observer.observe(shadowRoot, kObserverConfig);
    }

    private _isVolatileElement(element: Element, nodeName: string): boolean {
      return nodeName === 'INPUT' || nodeName === 'TEXTAREA' || nodeName === 'OPTION' ||
          nodeName === 'CANVAS' || nodeName === 'IFRAME' || nodeName === 'FRAME' ||
          nodeName === 'IMG' || nodeName === 'DIALOG' || !!(element as HTMLElement).popover;
    }

    // Values in the snapshot that can change without a DOM mutation.
    // These must be the same values that captureSnapshot() reads for the element.
    private _volatileValues(element: Element, nodeName: string): any[] {
      const values: any[] = [];
      if (nodeName === 'INPUT' || nodeName === 'TEXTAREA')
        values.push((element as HTMLInputElement).value);
      if (nodeName === 'INPUT')
        values.push((element as HTMLInputElement).type, (element as HTMLInputElement).checked);
      if (nodeName === 'OPTION')
        values.push((element as HTMLOptionElement).selected);
      if (nodeName === 'CANVAS' || nodeName === 'IFRAME' || nodeName === 'FRAME')
        values.push(this._boundingRect(element));
      if ((element as HTMLElement).popover)
        values.push(!!(element as HTMLElement).matches?.(':popover-open'));
      if (nodeName === 'IMG')
        values.push((element as HTMLImageElement).currentSrc);
      if (nodeName === 'DIALOG')
        values.push((element as HTMLDialogElement).open, (element as HTMLDialogElement).open && (element as HTMLDialogElement).matches(':modal'));
      return values;
    }

    private _boundingRect(element: Element): string {
      const boundingRect = element.getBoundingClientRect();
      return JSON.stringify({
        left: boundingRect.left,
        top: boundingRect.top,
        right: boundingRect.right,
        bottom: boundingRect.bottom
      });
    }

    // Marks the nodes with changes that a MutationObserver does not report.
    private _markChangesWithoutMutations() {
      for (const element of this._volatileElements) {
        if (!element.isConnected) {
          this._volatileElements.delete(element);
          continue;
        }
        if (!arraysEqual(nodeData(element)?.volatileValues, this._volatileValues(element, element.nodeName)))
          this._markDirty(element);
      }

      // The list of defined custom elements is an attribute of the body.
      // It changes when a custom element is defined, without a DOM mutation.
      for (const body of this._bodies) {
        if (!body.isConnected)
          this._bodies.delete(body);
        else if (this._customElements.size)
          this._markDirty(body);
      }

      if (document.documentElement)
        this._markChangedAdoptedStyleSheets(document, document.documentElement);
      for (const shadowRoot of this._shadowRoots) {
        if (!shadowRoot.host.isConnected) {
          this._shadowRoots.delete(shadowRoot);
          continue;
        }
        this._markChangedAdoptedStyleSheets(shadowRoot, shadowRoot);
      }

      // The scroll offsets and the shadow root of any element can change without a DOM mutation,
      // and the browser does not fire an event before the snapshot in all cases. A full walk reads
      // them on every element, so read them on every element too. This is the largest part of an
      // incremental snapshot.
      if (document.documentElement && nodeData(document.documentElement)?.ref) {
        this._markScrollAndShadowRootChanges(document.getElementsByTagName('*'));
        for (const shadowRoot of this._shadowRoots)
          this._markScrollAndShadowRootChanges(shadowRoot.querySelectorAll('*'));
      }

      for (const sheet of this._staleStyleSheets) {
        if (sheet.ownerNode?.nodeName === 'STYLE')
          this._markDirty(sheet.ownerNode);
      }

      // The fake <base> in the head uses the base URI, which changes for example with history.pushState().
      if (document.baseURI !== this._lastBaseURI && document.head) {
        const data = ensureNodeData(this._fakeBase);
        data.attributesCached = undefined;
        data.dirtyEpoch = this._markEpoch;
        this._markDirty(document.head);
      }
    }

    private _markScrollAndShadowRootChanges(elements: ArrayLike<Element>) {
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        const data = nodeData(element);
        // Never visited: the element is new and gets a full visit, or it is not in snapshots.
        if (!data?.ref)
          continue;
        if (data.scrollTop !== element.scrollTop || data.scrollLeft !== element.scrollLeft || data.shadowRoot !== this._shadowRoot(element))
          this._markDirty(element);
      }
    }

    // The defined custom elements in the body, and in the shadow roots in it.
    // The list is sorted, so that it does not depend on the order of the visits.
    private _definedCustomElements(body: Element): string {
      const names = new Set<string>();
      for (const element of this._customElements) {
        if (!element.isConnected) {
          this._customElements.delete(element);
          continue;
        }
        if (names.has(element.localName) || !window.customElements?.get(element.localName))
          continue;
        for (let n: Node | null = element; n; n = n.parentNode || (n.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (n as ShadowRoot).host : null)) {
          if (n === body) {
            names.add(element.localName);
            break;
          }
        }
      }
      return [...names].sort().join(',');
    }

    private _markChangedAdoptedStyleSheets(root: Document | ShadowRoot, node: Node) {
      const sheets: CSSStyleSheet[] = (root as any).adoptedStyleSheets || [];
      const cached = nodeData(node)?.adoptedStyleSheets || [];
      let changed = sheets.length !== cached.length;
      for (let i = 0; !changed && i < sheets.length; i++)
        changed = sheets[i] !== cached[i] || this._staleStyleSheets.has(sheets[i]);
      if (changed)
        this._markDirty(node);
    }

    private __sanitizeMetaAttribute(name: string, value: string, httpEquiv: string) {
      if (name === 'charset')
        return 'utf-8';

      if (httpEquiv.toLowerCase() !== 'content-type' || name !== 'content')
        return value;

      const [type, ...params] = value.split(';');
      if (type !== 'text/html' || params.length <= 0)
        return value;

      const charsetParamIdx = params.findIndex(param => param.trim().startsWith('charset='));
      if (charsetParamIdx > -1)
        params[charsetParamIdx] = 'charset=utf-8';

      return `${type}; ${params.join('; ')}`;
    }

    private _sanitizeUrl(url: string): string {
      if (url.startsWith('javascript:') || url.startsWith('vbscript:'))
        return '';
      return url;
    }

    private _sanitizeSrcSet(srcset: string): string {
      return srcset.split(',').map(src => {
        src = src.trim();
        const spaceIndex = src.lastIndexOf(' ');
        if (spaceIndex === -1)
          return this._sanitizeUrl(src);
        return this._sanitizeUrl(src.substring(0, spaceIndex).trim()) + src.substring(spaceIndex);
      }).join(', ');
    }

    private _resolveUrl(base: string, url: string): string {
      if (url === '')
        return '';
      try {
        return new URL(url, base).href;
      } catch (e) {
        return url;
      }
    }

    private _getSheetBase(sheet: CSSStyleSheet): string {
      let rootSheet = sheet;
      while (rootSheet.parentStyleSheet)
        rootSheet = rootSheet.parentStyleSheet;
      if (rootSheet.ownerNode)
        return rootSheet.ownerNode.baseURI;
      return document.baseURI;
    }

    private _getSheetText(sheet: CSSStyleSheet): string {
      this._readingStyleSheet = true;
      try {
        if (sheet.disabled)
          return '';
        const rules: string[] = [];
        for (const rule of sheet.cssRules)
          rules.push(rule.cssText);
        return rules.join('\n');
      } finally {
        this._readingStyleSheet = false;
      }
    }

    captureSnapshot(reset?: 'history' | 'targets'): SnapshotData | undefined {
      const timestamp = performance.now();
      const snapshotNumber = ++this._lastSnapshotNumber;
      this._ensureObservingCurrentDocument();
      if (reset === 'history')
        this.resetHistory();
      if (reset) {
        this._resetTargets();
        this._reference?._resetTargets();
      }
      let nodeCounter = 0;
      let shadowDomNesting = 0;
      let headNesting = 0;

      // Ensure we are up to date.
      this._handleMutations(this._observer.takeRecords());
      this._markChangesWithoutMutations();
      // Nodes that change from now on are marked for the next snapshot.
      const markEpoch = this._markEpoch++;

      const visitNode = (node: Node | ShadowRoot, deep: boolean): { equals: boolean, n: NodeSnapshot } | undefined => {
        const nodeType = node.nodeType;
        const nodeName = nodeType === Node.DOCUMENT_FRAGMENT_NODE ? 'template' : node.nodeName;

        if (nodeType !== Node.ELEMENT_NODE &&
            nodeType !== Node.DOCUMENT_FRAGMENT_NODE &&
            nodeType !== Node.TEXT_NODE)
          return;
        if (nodeName === 'SCRIPT')
          return;
        // Don't preload resources.
        if (nodeName === 'LINK' && nodeType === Node.ELEMENT_NODE) {
          const rel = (node as Element).getAttribute('rel')?.toLowerCase();
          if (rel === 'preload' || rel === 'prefetch')
            return;
        }
        if (removeNoScript && nodeName === 'NOSCRIPT')
          return;
        if (nodeName === 'META') {
          const httpEquiv = (node as HTMLMetaElement).httpEquiv.toLowerCase();
          // Drop META directives that can navigate, set cookies, or otherwise
          // affect the trace viewer when the recorded snapshot is rendered.
          if (httpEquiv === 'content-security-policy' || httpEquiv === 'refresh' || httpEquiv === 'set-cookie')
            return;
        }
        // Skip iframes which are inside document's head as they are not visible.
        // See https://github.com/microsoft/playwright/issues/12005.
        if ((nodeName === 'IFRAME' || nodeName === 'FRAME') && headNesting)
          return;

        const data = ensureNodeData(node);
        if (data.insertedEpoch === markEpoch)
          deep = true;
        // Nothing changed in this subtree since the previous snapshot: a full visit would
        // find that the node is equal and return the same reference.
        if (!deep && data.ref && data.dirtyEpoch !== markEpoch)
          return { equals: true, n: [[snapshotNumber - data.ref[0], data.ref[1]]] };

        const values: any[] = [];
        let equals = !!data.cached && !this._fullWalks;
        let extraNodes = 0;

        const expectValue = (value: any) => {
          equals = equals && data.cached![values.length] === value;
          values.push(value);
        };

        const checkAndReturn = (n: NodeSnapshot): { equals: boolean, n: NodeSnapshot } => {
          data.attributesCached = true;
          if (equals)
            return { equals: true, n: [[snapshotNumber - data.ref![0], data.ref![1]]] };
          nodeCounter += extraNodes;
          data.ref = [snapshotNumber, nodeCounter++];
          data.cached = values;
          return { equals: false, n };
        };

        if (nodeType === Node.TEXT_NODE) {
          const value = node.nodeValue || '';
          expectValue(value);
          return checkAndReturn(value);
        }

        if (nodeName === 'STYLE') {
          const sheet = (node as HTMLStyleElement).sheet;
          let cssText: string | undefined;
          if (sheet)
            cssText = this._updateStyleElementStyleSheetTextIfNeeded(sheet);
          cssText = cssText || node.textContent || '';
          expectValue(cssText);
          // Compensate for the extra 'cssText' text node.
          extraNodes++;
          return checkAndReturn([nodeName, {}, cssText]);
        }

        const attrs: { [attr: string]: string } = {};
        const result: NodeSnapshot = [nodeName, attrs];

        const visitChild = (child: Node) => {
          const snapshot = visitNode(child, deep);
          if (snapshot) {
            result.push(snapshot.n);
            expectValue(child);
            equals = equals && snapshot.equals;
          }
        };

        const visitChildStyleSheet = (child: CSSStyleSheet) => {
          const snapshot = visitStyleSheet(child);
          if (snapshot) {
            result.push(snapshot.n);
            expectValue(child);
            equals = equals && snapshot.equals;
          }
        };

        if (nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
          attrs[kShadowAttribute] = 'open';
          this._trackShadowRoot(node as ShadowRoot);
        }

        if (nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          if (element.localName.includes('-'))
            this._customElements.add(element);
          if (this._isVolatileElement(element, nodeName)) {
            this._volatileElements.add(element);
            data.volatileValues = this._volatileValues(element, nodeName);
          } else {
            this._volatileElements.delete(element);
          }
          if (nodeName === 'INPUT' || nodeName === 'TEXTAREA') {
            const value = (element as HTMLInputElement).value;
            expectValue(kValueAttribute);
            expectValue(value);
            attrs[kValueAttribute] = value;
          }
          if (nodeName === 'INPUT' && ['checkbox', 'radio'].includes((element as HTMLInputElement).type)) {
            const value = (element as HTMLInputElement).checked ? 'true' : 'false';
            expectValue(kCheckedAttribute);
            expectValue(value);
            attrs[kCheckedAttribute] = value;
          }
          if (nodeName === 'OPTION') {
            const value = (element as HTMLOptionElement).selected ? 'true' : 'false';
            expectValue(kSelectedAttribute);
            expectValue(value);
            attrs[kSelectedAttribute] = value;
          }
          if (nodeName === 'CANVAS' || nodeName === 'IFRAME' || nodeName === 'FRAME') {
            const value = this._boundingRect(element);
            expectValue(kBoundingRectAttribute);
            expectValue(value);
            attrs[kBoundingRectAttribute] = value;
          }
          if ((element as HTMLElement).popover && (element as HTMLElement).matches && (element as HTMLElement).matches(':popover-open')) {
            const value = 'true';
            expectValue(kPopoverOpenAttribute);
            expectValue(value);
            attrs[kPopoverOpenAttribute] = value;
          }
          if (nodeName === 'DIALOG' && (element as HTMLDialogElement).open) {
            const value = (element as HTMLDialogElement).matches(':modal') ? 'modal' : 'true';
            expectValue(kDialogOpenAttribute);
            expectValue(value);
            attrs[kDialogOpenAttribute] = value;
          }
          const scrollTop = element.scrollTop;
          const scrollLeft = element.scrollLeft;
          data.scrollTop = scrollTop;
          data.scrollLeft = scrollLeft;
          if (scrollTop) {
            expectValue(kScrollTopAttribute);
            expectValue(scrollTop);
            attrs[kScrollTopAttribute] = '' + scrollTop;
          }
          if (scrollLeft) {
            expectValue(kScrollLeftAttribute);
            expectValue(scrollLeft);
            attrs[kScrollLeftAttribute] = '' + scrollLeft;
          }
          const shadowRoot = this._shadowRoot(element);
          data.shadowRoot = shadowRoot;
          if (shadowRoot) {
            ++shadowDomNesting;
            visitChild(shadowRoot);
            --shadowDomNesting;
          }
          if ((element as any)[kTargetGeneration] === this._targetGeneration) {
            expectValue(kTargetAttribute);
            attrs[kTargetAttribute] = '';
          }
        }

        if (nodeName === 'HEAD') {
          ++headNesting;
          // Insert fake <base> first, to ensure all <link> elements use the proper base uri.
          this._lastBaseURI = document.baseURI;
          this._fakeBase.setAttribute('href', this._lastBaseURI);
          visitChild(this._fakeBase);
        }
        for (let child = this._nativeFirstChild.call(node); child; child = this._nativeNextSibling.call(child))
          visitChild(child);
        if (nodeName === 'HEAD')
          --headNesting;
        expectValue(kEndOfList);
        let documentOrShadowRoot = null;
        if (node.ownerDocument!.documentElement === node)
          documentOrShadowRoot = node.ownerDocument;
        else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE)
          documentOrShadowRoot = node;
        if (documentOrShadowRoot) {
          const sheets: CSSStyleSheet[] = [...((documentOrShadowRoot as any).adoptedStyleSheets || [])];
          data.adoptedStyleSheets = sheets;
          for (const sheet of sheets)
            visitChildStyleSheet(sheet);
          expectValue(kEndOfList);
        }

        // Process iframe src attribute before bailing out since it depends on a symbol, not the DOM.
        if (nodeName === 'IFRAME' || nodeName === 'FRAME') {
          const element = node as Element;
          const frameId = (element as any)[kSnapshotFrameId];
          const name = 'src';
          const value = frameId ? `/snapshot/${frameId}` : '';
          expectValue(name);
          expectValue(value);
          attrs[name] = value;
        }

        // Process custom elements before bailing out since they depend on JS, not the DOM.
        if (nodeName === 'BODY') {
          this._bodies.add(node as Element);
          const value = this._definedCustomElements(node as Element);
          if (value) {
            expectValue(kCustomElementsAttribute);
            expectValue(value);
            attrs[kCustomElementsAttribute] = value;
          }
        }

        // Process currentSrc before bailing out since it depends on JS, not the DOM.
        if (nodeName === 'IMG' || nodeName === 'PICTURE') {
          const value = nodeName === 'PICTURE' ? '' : this._sanitizeUrl((node as HTMLImageElement).currentSrc);
          expectValue(kCurrentSrcAttribute);
          expectValue(value);
          attrs[kCurrentSrcAttribute] = value;
        }

        // We can skip attributes comparison because nothing else has changed,
        // and mutation observer didn't tell us about the attributes.
        if (equals && data.attributesCached && !shadowDomNesting)
          return checkAndReturn(result);

        if (nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          for (let i = 0; i < element.attributes.length; i++) {
            const name = element.attributes[i].name;
            if (nodeName === 'LINK' && name === 'integrity')
              continue;
            if (nodeName === 'IFRAME' && (name === 'src' || name === 'srcdoc' || name === 'sandbox'))
              continue;
            if (nodeName === 'FRAME' && name === 'src')
              continue;
            if (nodeName === 'DIALOG' && name === 'open')
              continue;
            let value = element.attributes[i].value;
            if (nodeName === 'META')
              value = this.__sanitizeMetaAttribute(name, value, (node as HTMLMetaElement).httpEquiv);
            else if (name === 'src' && (nodeName === 'IMG'))
              value = this._sanitizeUrl(value);
            else if (name === 'srcset' && (nodeName === 'IMG'))
              value = this._sanitizeSrcSet(value);
            else if (name === 'srcset' && (nodeName === 'SOURCE'))
              value = this._sanitizeSrcSet(value);
            else if (name === 'href' && (nodeName === 'LINK'))
              value = this._sanitizeUrl(value);
            else if (name.startsWith('on'))
              value = '';
            expectValue(name);
            expectValue(value);
            attrs[name] = value;
          }
          expectValue(kEndOfList);
        }

        if (result.length === 2 && !Object.keys(attrs).length)
          result.pop();  // Remove empty attrs when there are no children.
        return checkAndReturn(result);
      };

      const visitStyleSheet = (sheet: CSSStyleSheet): { equals: boolean, n: NodeSnapshot } => {
        const data = ensureCachedData(sheet);
        const oldCSSText = data.cssText;
        const cssText = this._updateStyleElementStyleSheetTextIfNeeded(sheet, true /* forceText */)!;
        // A reference to a snapshot from before resetHistory() cannot be resolved.
        if (cssText === oldCSSText && data.refHistoryEpoch === historyEpoch && !this._fullWalks)
          return { equals: true, n: [[snapshotNumber - data.ref![0], data.ref![1]]] };
        data.ref = [snapshotNumber, nodeCounter++];
        data.refHistoryEpoch = historyEpoch;
        return {
          equals: false,
          n: ['template', {
            [kStyleSheetAttribute]: cssText,
          }]
        };
      };

      let html: NodeSnapshot;
      if (document.documentElement) {
        const { n } = visitNode(document.documentElement, this._fullWalks)!;
        html = n;
      } else {
        html = ['html'];
      }

      const result: SnapshotData = {
        html,
        doctype: document.doctype ? document.doctype.name : undefined,
        resourceOverrides: [],
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        url: location.href,
        wallTime: Date.now(),
        collectionTime: 0,
      };

      for (const sheet of this._modifiedStyleSheets) {
        if (sheet.href === null)
          continue;
        const content = this._updateLinkStyleSheetTextIfNeeded(sheet, snapshotNumber);
        if (content === undefined) {
          // Unable to capture stylesheet contents.
          continue;
        }
        const base = this._getSheetBase(sheet);
        const url = removeHash(this._resolveUrl(base, sheet.href!));
        result.resourceOverrides.push({ url, content, contentType: 'text/css' },);
      }

      result.collectionTime = performance.now() - timestamp;
      if (this._reference)
        result.checkError = this._checkSnapshot(snapshotNumber, html);
      return result;
    }

    // Check mode: compares the snapshot, with its references resolved like the trace viewer does,
    // with a full walk of the reference streamer. Returns the first difference.
    private _checkSnapshot(snapshotNumber: number, html: NodeSnapshot): string | undefined {
      const nodes: NodeSnapshot[] = [];
      this._checkNodes.set(snapshotNumber, nodes);
      const expand = (n: NodeSnapshot): NodeSnapshot => {
        if (typeof n === 'string') {
          nodes.push(n);
          return n;
        }
        if (Array.isArray(n[0])) {
          const [snapshotsAgo, index] = n[0] as [number, number];
          const referenced = this._checkNodes.get(snapshotNumber - snapshotsAgo)?.[index];
          if (referenced === undefined)
            throw new Error(`cannot resolve reference [${snapshotsAgo}, ${index}]`);
          return referenced;
        }
        const [name, attrs, ...children] = n as any[];
        const expanded: any[] = n.length > 1 ? [name, attrs, ...children.map(expand)] : [name];
        // Post-order, like the node indexes.
        nodes.push(expanded as NodeSnapshot);
        return expanded as NodeSnapshot;
      };
      try {
        const actual = expand(html);
        const expected = this._reference!.captureSnapshot()!.html;
        return firstDifference(actual, expected, '');
      } catch (e) {
        return String(e);
      }
    }
  }

  function firstDifference(a: any, b: any, path: string): string | undefined {
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
      return a === b ? undefined : `${path}: ${JSON.stringify(a)?.slice(0, 200)} !== ${JSON.stringify(b)?.slice(0, 200)}`;
    if (Array.isArray(a) !== Array.isArray(b))
      return `${path}: array mismatch`;
    if (Array.isArray(a)) {
      const name = typeof a[0] === 'string' ? `${path}/${a[0]}` : path;
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const difference = firstDifference(a[i], b[i], i ? `${name}[${i}]` : name);
        if (difference)
          return difference;
      }
      return;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const difference = firstDifference(a[key], b[key], `${path}@${key}`);
      if (difference)
        return difference;
    }
  }

  const streamer = new Streamer();
  (window as any)[snapshotStreamer] = streamer;
  if (check) {
    // A second streamer, with its own node data, makes the full walks to compare with.
    const referenceName = snapshotStreamer + '_check_reference';
    frameSnapshotStreamer(referenceName, removeNoScript);
    streamer._reference = (window as any)[referenceName];
    streamer._reference!._fullWalks = true;
  }
}
