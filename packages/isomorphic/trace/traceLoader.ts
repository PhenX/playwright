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

import { contextChanges, contextListLengths } from './contextsUpdate';
import { SnapshotStorage } from './snapshotStorage';
import { TraceModernizer } from './traceModernizer';

import type { ContextListLengths } from './contextsUpdate';
import type { ContextEntry, ContextsUpdate } from './entries';

export interface TraceLoaderBackend {
  entryNames(): Promise<string[]>;
  hasEntry(entryName: string): Promise<boolean>;
  readText(entryName: string): Promise<string | undefined>;
  readBlob(entryName: string): Promise<Blob | undefined>;
  isLive(): boolean;
  // Live traces only: their files grow while the test runs.
  // refresh() reads the list of entries again.
  refresh?(): Promise<void>;
  // Reads the complete lines after a byte offset, and returns the offset after them.
  // Returns undefined when the entry does not exist, and throws when the entry is now smaller.
  readLines?(entryName: string, offset: number): Promise<{ text: string, nextOffset: number } | undefined>;
}

// The state of one trace file of a live trace, to load the lines that are added later.
type LiveContext = {
  contextEntry: ContextEntry;
  modernizer: TraceModernizer;
  offsets: Map<string, number>;
  stacks: string | undefined;
  resourceCount: number;
  // The last revision that added or changed each action.
  actionRevisions: Map<string, number>;
};

// The number of past revisions of a live trace that a poll can get the changes from.
const kKeptRevisions = 20;

export class TraceLoader {
  contextEntries: ContextEntry[] = [];
  private _snapshotStorage: SnapshotStorage | undefined;
  private _backend!: TraceLoaderBackend;
  private _resourceToContentType = new Map<string, string>();
  private _liveContexts: Map<string, LiveContext> | undefined;
  // Live traces: each update that changes the trace makes a new revision.
  private _revision = 0;
  // A cursor of another trace loader, for example before the service worker restarted, gets the whole contexts.
  private _cursorPrefix = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  private _listLengths = new Map<number, ContextListLengths[]>();

  constructor() {
  }

  async load(backend: TraceLoaderBackend, traceFile?: string, unzipProgress?: (done: number, total: number) => void) {
    this._backend = backend;

    if (backend.readLines && !traceFile) {
      this._snapshotStorage = new SnapshotStorage();
      this._liveContexts = new Map();
      await this.update();
      if (!this.contextEntries.length)
        throw new Error('Cannot find .trace file');
      unzipProgress?.(1, 1);
      return;
    }

    const prefix = traceFile?.match(/(.+)\.trace$/)?.[1];
    const prefixes: string[] = [];
    let hasSource = false;
    for (const entryName of await this._backend.entryNames()) {
      const match = entryName.match(/(.+)\.trace$/);
      if (match && (!prefix || prefix  === match[1]))
        prefixes.push(match[1] || '');
      if (entryName.startsWith('src/') || entryName.includes('src@'))
        hasSource = true;
    }
    if (!prefixes.length)
      throw new Error('Cannot find .trace file');

    this._snapshotStorage = new SnapshotStorage();

    // 3 * ordinals progress increments below.
    const total = prefixes.length * 3;
    let done = 0;
    for (const prefix of prefixes) {
      const contextEntry = createEmptyContext();
      contextEntry.hasSource = hasSource;
      const modernizer = new TraceModernizer(contextEntry, this._snapshotStorage);

      const trace = await this._backend.readText(prefix + '.trace') || '';
      modernizer.appendTrace(trace);
      unzipProgress?.(++done, total);

      const network = await this._backend.readText(prefix + '.network') || '';
      modernizer.appendTrace(network);
      unzipProgress?.(++done, total);

      const stacks = await this._backend.readText(prefix + '.stacks');
      if (stacks)
        modernizer.appendStacks(stacks);
      unzipProgress?.(++done, total);

      contextEntry.actions = modernizer.actions().sort((a1, a2) => a1.startTime - a2.startTime);

      if (!backend.isLive()) {
        // Terminate actions w/o after event gracefully.
        // This would close after hooks event that has not been closed because
        // the trace is usually saved before after hooks complete.
        for (const action of contextEntry.actions.slice().reverse()) {
          if (!action.endTime && !action.error) {
            for (const a of contextEntry.actions) {
              if (a.parentId === action.callId && action.endTime < a.endTime)
                action.endTime = a.endTime;
            }
          }
        }
      }

      for (const resource of contextEntry.resources)
        this._addResourceContentType(resource);

      this.contextEntries.push(contextEntry);
    }

    this._snapshotStorage.finalize();
  }

  canUpdate(): boolean {
    return !!this._liveContexts;
  }

  // Loads the lines that were added to a live trace since the last load, instead of all lines again.
  async update() {
    const backend = this._backend;
    const liveContexts = this._liveContexts!;
    await backend.refresh?.();

    const prefixes: string[] = [];
    let hasSource = false;
    for (const entryName of await backend.entryNames()) {
      if (entryName.endsWith('.trace') && entryName.length > '.trace'.length)
        prefixes.push(entryName.slice(0, -'.trace'.length));
      if (entryName.startsWith('src/') || entryName.includes('src@'))
        hasSource = true;
    }

    const revision = this._revision + 1;
    let changed = false;
    for (const prefix of prefixes) {
      let live = liveContexts.get(prefix);
      if (!live) {
        const contextEntry = createEmptyContext();
        live = { contextEntry, modernizer: new TraceModernizer(contextEntry, this._snapshotStorage!), offsets: new Map(), stacks: undefined, resourceCount: 0, actionRevisions: new Map() };
        live.modernizer.trackChangedActions();
        liveContexts.set(prefix, live);
        this.contextEntries.push(contextEntry);
        changed = true;
      }
      if (live.contextEntry.hasSource !== hasSource) {
        live.contextEntry.hasSource = hasSource;
        changed = true;
      }

      let appended = false;
      for (const entryName of [prefix + '.trace', prefix + '.network']) {
        const result = await backend.readLines!(entryName, live.offsets.get(entryName) || 0);
        if (!result)
          continue;
        if (result.text) {
          live.modernizer.appendTrace(result.text);
          appended = true;
        }
        live.offsets.set(entryName, result.nextOffset);
      }

      // The stacks file is written again as a whole: apply it to the new actions too.
      const stacks = await backend.readText(prefix + '.stacks');
      if (stacks && (appended || stacks !== live.stacks)) {
        try {
          live.modernizer.appendStacks(stacks);
          live.stacks = stacks;
        } catch {
          // The file can be read while it is written: use it on the next update.
        }
      }

      for (const callId of live.modernizer.takeChangedActions()) {
        live.actionRevisions.set(callId, revision);
        changed = true;
      }

      if (!appended)
        continue;
      changed = true;
      live.contextEntry.actions = live.modernizer.actions().sort((a1, a2) => a1.startTime - a2.startTime);
      for (const resource of live.contextEntry.resources.slice(live.resourceCount))
        this._addResourceContentType(resource);
      live.resourceCount = live.contextEntry.resources.length;
    }

    this._snapshotStorage!.finalize();
    if (changed) {
      this._revision = revision;
      this._listLengths.set(revision, this.contextEntries.map(contextListLengths));
      this._listLengths.delete(revision - kKeptRevisions);
    }
  }

  // Live traces: the changes since the cursor of an earlier update, or the whole contexts.
  contextsUpdate(since: string | null): ContextsUpdate {
    const cursor = `${this._cursorPrefix}.${this._revision}`;
    const [cursorPrefix, revisionText] = since?.split('.') ?? [];
    const revision = Number(revisionText);
    const lengths = cursorPrefix === this._cursorPrefix ? this._listLengths.get(revision) : undefined;
    if (!this._liveContexts || !lengths)
      return { cursor, full: true, contexts: this.contextEntries };
    if (revision === this._revision)
      return { cursor, full: false, contexts: [] };
    const contexts = [...this._liveContexts.values()].map((live, index) => {
      return contextChanges(live.contextEntry, lengths[index], callId => live.actionRevisions.get(callId)! > revision);
    });
    return { cursor, full: false, contexts };
  }

  private _addResourceContentType(resource: ContextEntry['resources'][number]) {
    if (resource.request.postData?._file)
      this._resourceToContentType.set(resource.request.postData._file, stripEncodingFromContentType(resource.request.postData.mimeType));
    if (resource.response.content?._file)
      this._resourceToContentType.set(resource.response.content._file, stripEncodingFromContentType(resource.response.content.mimeType));
  }

  async hasEntry(filename: string): Promise<boolean> {
    return this._backend.hasEntry(filename);
  }

  async resourceEntry(file: string): Promise<Blob | undefined> {
    const blob = await this._backend.readBlob(file);
    const contentType = this._resourceToContentType.get(file);
    // "x-unknown" in the har means "no content type".
    if (!blob || contentType === undefined || contentType === 'x-unknown')
      return blob;
    return new Blob([blob], { type: contentType });
  }

  storage(): SnapshotStorage {
    return this._snapshotStorage!;
  }
}

function stripEncodingFromContentType(contentType: string) {
  const charset = contentType.match(/^(.*);\s*charset=.*$/);
  if (charset)
    return charset[1];
  return contentType;
}

function createEmptyContext(): ContextEntry {
  return {
    origin: 'testRunner',
    startTime: Number.MAX_SAFE_INTEGER,
    wallTime: Number.MAX_SAFE_INTEGER,
    monotonicTime: 0,
    endTime: 0,
    browserName: '',
    options: {
      deviceScaleFactor: 1,
      isMobile: false,
      viewport: { width: 1280, height: 800 },
    },
    pages: [],
    resources: [],
    actions: [],
    screenshots: [],
    ariaSnapshots: [],
    domSnapshots: [],
    videos: [],
    events: [],
    errors: [],
    stdio: [],
    hasSource: false,
  };
}
