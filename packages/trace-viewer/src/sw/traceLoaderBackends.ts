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
// @ts-ignore
import * as zipImport from '@zip.js/zip.js/lib/zip-no-worker-inflate.js';

import type * as zip from '@zip.js/zip.js';
import type { TraceLoaderBackend } from '@isomorphic/trace/traceLoader';

const zipjs = zipImport as typeof zip;

type Progress = (done: number, total: number) => undefined;

export class ZipTraceLoaderBackend implements TraceLoaderBackend {
  private _zipReader: zip.ZipReader<unknown>;
  private _entriesPromise: Promise<Map<string, zip.Entry>>;

  constructor(traceUri: string, progress: Progress) {
    zipjs.configure({ baseURL: self.location.href } as any);

    this._zipReader = new zipjs.ZipReader(
        new zipjs.HttpReader(this._resolveTraceURI(traceUri), { mode: 'cors', preventHeadRequest: true } as any),
        { useWebWorkers: false });
    this._entriesPromise = this._zipReader.getEntries({ onprogress: progress }).then(entries => {
      const map = new Map<string, zip.Entry>();
      for (const entry of entries)
        map.set(entry.filename, entry);
      return map;
    });
  }

  private _resolveTraceURI(traceUri: string): string {
    if (traceUri.startsWith('https://www.dropbox.com/'))
      return 'https://dl.dropboxusercontent.com/' + traceUri.substring('https://www.dropbox.com/'.length);
    return traceUri;
  }

  isLive() {
    return false;
  }

  async entryNames(): Promise<string[]> {
    const entries = await this._entriesPromise;
    return [...entries.keys()];
  }

  async hasEntry(entryName: string): Promise<boolean> {
    const entries = await this._entriesPromise;
    return entries.has(entryName);
  }

  async readText(entryName: string): Promise<string | undefined> {
    const entries = await this._entriesPromise;
    const entry = entries.get(entryName);
    if (!entry)
      return;
    const writer = new zipjs.TextWriter();
    await entry.getData?.(writer);
    return writer.getData();
  }

  async readBlob(entryName: string): Promise<Blob | undefined> {
    const entries = await this._entriesPromise;
    const entry = entries.get(entryName);
    if (!entry)
      return;
    const writer = new zipjs.BlobWriter() as zip.BlobWriter;
    await entry.getData!(writer);
    return writer.getData();
  }
}

export class FetchTraceLoaderBackend implements TraceLoaderBackend {
  private _traceUri: string;
  private _entriesPromise: Promise<Map<string, string>>;

  constructor(traceUri: string) {
    this._traceUri = traceUri;
    this._entriesPromise = this._readEntries();
  }

  private async _readEntries(): Promise<Map<string, string>> {
    const response = await this._readFile(this._traceUri);
    if (!response)
      throw new Error('File not found');
    const json = await response.json();
    const entries = new Map<string, string>();
    for (const entry of json.entries)
      entries.set(entry.name, entry.path);
    return entries;
  }

  isLive() {
    return true;
  }

  async refresh() {
    const entries = await this._readEntries();
    this._entriesPromise = Promise.resolve(entries);
  }

  async readLines(entryName: string, offset: number): Promise<{ text: string, nextOffset: number } | undefined> {
    const entries = await this._entriesPromise;
    const fileUri = entries.get(entryName);
    if (!fileUri)
      return;
    const response = await fetch(fileUri, offset ? { headers: { range: `bytes=${offset}-` } } : undefined);
    if (response.status === 404)
      return;
    if (response.status === 416) {
      // Nothing after the offset, unless the file was written again with less content.
      const size = Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]);
      if (!(size >= offset))
        throw new Error(`${entryName} is smaller than before`);
      return { text: '', nextOffset: offset };
    }
    if (offset && response.status !== 206)
      throw new Error(`Cannot read ${entryName} from an offset`);
    // A line can be incomplete while it is written: read it on the next update.
    // The last line of a finished file can have no newline: read it when it is complete.
    const bytes = new Uint8Array(await response.arrayBuffer());
    let end = bytes.lastIndexOf(10 /* \n */) + 1;
    if (end < bytes.length && isCompleteJSON(new TextDecoder().decode(bytes.subarray(end))))
      end = bytes.length;
    return { text: new TextDecoder().decode(bytes.subarray(0, end)), nextOffset: offset + end };
  }

  async entryNames(): Promise<string[]> {
    const entries = await this._entriesPromise;
    return [...entries.keys()];
  }

  async hasEntry(entryName: string): Promise<boolean> {
    const entries = await this._entriesPromise;
    return entries.has(entryName);
  }

  async readText(entryName: string): Promise<string | undefined> {
    const response = await this._readEntry(entryName);
    return response?.text();
  }

  async readBlob(entryName: string): Promise<Blob | undefined> {
    const response = await this._readEntry(entryName);
    return response?.status === 200 ? await response?.blob() : undefined;
  }

  private async _readEntry(entryName: string): Promise<Response | undefined> {
    const entries = await this._entriesPromise;
    const fileUri = entries.get(entryName);
    if (!fileUri)
      return;
    return this._readFile(fileUri);
  }

  private async _readFile(uri: string): Promise<Response | undefined> {
    const response = await fetch(uri);
    if (response.status === 404)
      return;
    return response;
  }
}

function isCompleteJSON(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
