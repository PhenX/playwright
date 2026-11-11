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

import { applyContextsUpdate } from '@isomorphic/trace/contextsUpdate';
import { TraceModel } from '@isomorphic/trace/traceModel';

import type { ContextEntry, ContextsUpdate } from '@isomorphic/trace/entries';

// A live trace, as loaded by the last poll.
export type LiveTrace = {
  traceUri: string;
  cursor: string;
  contexts: ContextEntry[];
  model: TraceModel;
};

// Loads the new lines of a live trace, and gets only the changes since the previous poll.
// Returns undefined when the trace did not change.
export async function loadLiveTrace(traceUri: string, previous: LiveTrace | undefined, signal?: AbortSignal): Promise<LiveTrace | undefined> {
  if (previous?.traceUri !== traceUri)
    previous = undefined;
  const params = new URLSearchParams();
  params.set('trace', traceUri);
  params.set('reload', '1');
  params.set('since', previous?.cursor ?? '');
  const response = await fetch(`contexts?${params.toString()}`, { signal });
  if (!response.ok)
    throw new Error(`Could not load the trace: ${response.status}`);
  const update = await response.json() as ContextsUpdate;
  if (previous && update.cursor === previous.cursor)
    return undefined;
  const contexts = applyContextsUpdate(previous?.contexts ?? [], update);
  return { traceUri, cursor: update.cursor, contexts, model: new TraceModel(traceUri, contexts) };
}
