/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';

import * as yazl from 'yazl';
import { ManualPromise } from '@isomorphic/manualPromise';

import type { EventEmitter } from 'events';

type NameValue = { name: string, value: string };
type SerializedFSOperation = {
  op: 'mkdir', dir: string,
} | {
  op: 'writeFile', file: string, content: string | Buffer, skipIfExists?: boolean,
} | {
  op: 'appendFile', file: string, content: string,
} | {
  op: 'copyFile', from: string, to: string,
} | {
  op: 'zip', entries: NameValue[], zipFileName: string,
};

// Per-file pending appendFile chunks are flushed once they accumulate to this
// size, and the merge in _appendOperation stops merging past it. Bounding
// merged content keeps any single op below V8's ~512MB max string length.
const APPEND_CHUNK_SIZE = 64 * 1024;

// Deferred flushes in this time become one write.
const DEFERRED_FLUSH_DELAY = 100;

export class SerializedFS {
  // flushCount: the number of chunks that the next deferred flush writes.
  private _buffers = new Map<string, { chunks: string[], size: number, flushCount: number }>(); // Should never be accessed from within appendOperation.
  private _deferredFlushTimer: NodeJS.Timeout | undefined;
  private _error: Error | undefined;
  private _operations: SerializedFSOperation[] = [];
  private _operationsDone: ManualPromise<void>;

  constructor() {
    this._operationsDone = new ManualPromise();
    this._operationsDone.resolve();  // No operations scheduled yet.
  }

  mkdir(dir: string) {
    this._appendOperation({ op: 'mkdir', dir });
  }

  writeFile(file: string, content: string | Buffer, skipIfExists?: boolean) {
    this._buffers.delete(file); // No need to flush the buffer since we'll overwrite anyway.
    this._appendOperation({ op: 'writeFile', file, content, skipIfExists });
  }

  // flush: true writes the buffered text now. 'deferred' writes the text that is buffered now
  // a little later, in the same write as other deferred flushes.
  appendFile(file: string, text: string, flush?: boolean | 'deferred') {
    let buffer = this._buffers.get(file);
    if (!buffer) {
      buffer = { chunks: [], size: 0, flushCount: 0 };
      this._buffers.set(file, buffer);
    }
    buffer.chunks.push(text);
    buffer.size += text.length;
    if (flush === true || buffer.size >= APPEND_CHUNK_SIZE) {
      this._flushFile(file);
    } else if (flush === 'deferred') {
      buffer.flushCount = buffer.chunks.length;
      this._deferredFlushTimer ??= setTimeout(() => this._flushDeferred(), DEFERRED_FLUSH_DELAY);
    }
  }

  private _flushDeferred() {
    this._deferredFlushTimer = undefined;
    for (const [file, buffer] of this._buffers) {
      if (!buffer.flushCount)
        continue;
      const content = buffer.chunks.splice(0, buffer.flushCount).join('');
      buffer.flushCount = 0;
      buffer.size -= content.length;
      if (!buffer.chunks.length)
        this._buffers.delete(file);
      this._appendOperation({ op: 'appendFile', file, content });
    }
  }

  private _flushAll() {
    for (const file of this._buffers.keys())
      this._flushFile(file);
    clearTimeout(this._deferredFlushTimer);
    this._deferredFlushTimer = undefined;
  }

  private _flushFile(file: string) {
    const buffer = this._buffers.get(file);
    if (buffer === undefined)
      return;
    const content = buffer.chunks.join('');
    this._buffers.delete(file);
    this._appendOperation({ op: 'appendFile', file, content });
  }

  copyFile(from: string, to: string) {
    this._flushFile(from);
    this._buffers.delete(to); // No need to flush the buffer since we'll overwrite anyway.
    this._appendOperation({ op: 'copyFile', from, to });
  }

  async sync() {
    this._flushAll();
    await this._operationsDone;
    if (this._error) {
      const e = this._error;
      this._error = undefined;
      throw e;
    }
  }

  zip(entries: NameValue[], zipFileName: string) {
    this._flushAll();

    // Chain the export operation against write operations,
    // so that files do not change during the export.
    this._appendOperation({ op: 'zip', entries, zipFileName });
  }

  // This method serializes all writes to the trace.
  private _appendOperation(op: SerializedFSOperation): void {
    const last = this._operations[this._operations.length - 1];
    if (last?.op === 'appendFile' && op.op === 'appendFile' && last.file === op.file
        && last.content.length < APPEND_CHUNK_SIZE) {
      // Merge pending appendFile operations for performance, but cap merging at
      // APPEND_CHUNK_SIZE so a single op never grows past V8's max string length.
      last.content += op.content;
      return;
    }

    this._operations.push(op);
    if (this._operationsDone.isDone())
      this._performOperations();
  }

  private async _performOperations() {
    this._operationsDone = new ManualPromise();
    while (this._operations.length) {
      const op = this._operations.shift()!;
      // Ignore all operations after the first error.
      if (this._error)
        continue;
      try {
        await this._performOperation(op);
      } catch (e) {
        this._error = e;
      }
    }
    this._operationsDone.resolve();
  }

  private async _performOperation(op: SerializedFSOperation) {
    switch (op.op) {
      case 'mkdir': {
        await fs.promises.mkdir(op.dir, { recursive: true });
        return;
      }
      case 'writeFile': {
        // Note: 'wx' flag only writes when the file does not exist.
        // See https://nodejs.org/api/fs.html#file-system-flags.
        // This way tracing never have to write the same resource twice.
        if (op.skipIfExists)
          await fs.promises.writeFile(op.file, op.content, { flag: 'wx' }).catch(() => {});
        else
          await fs.promises.writeFile(op.file, op.content);
        return;
      }
      case 'copyFile': {
        await fs.promises.copyFile(op.from, op.to);
        return;
      }
      case 'appendFile': {
        await fs.promises.appendFile(op.file, op.content);
        return;
      }
      case 'zip': {
        const zipFile = new yazl.ZipFile();
        const result = new ManualPromise<void>();
        (zipFile as any as EventEmitter).on('error', error => result.reject(error));
        for (const entry of op.entries)
          zipFile.addFile(entry.value, entry.name);
        zipFile.end();
        zipFile.outputStream
            .pipe(fs.createWriteStream(op.zipFileName))
            .on('close', () => result.resolve())
            .on('error', error => result.reject(error));
        await result;
        return;
      }
    }
  }
}
