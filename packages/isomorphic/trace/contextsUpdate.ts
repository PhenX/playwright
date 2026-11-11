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

import type { ContextEntry, ContextsUpdate } from './entries';

// While a live trace grows, items are only added to the lists of its contexts, and only actions change.
// A poll can then get only the changes, see ContextsUpdate.

export type ContextListLengths = {
  pages: number[];
  resources: number;
  screenshots: number;
  ariaSnapshots: number;
  domSnapshots: number;
  videos: number;
  events: number;
  stdio: number;
  errors: number;
};

export function contextListLengths(context: ContextEntry): ContextListLengths {
  return {
    pages: context.pages.map(page => page.screencastFrames.length),
    resources: context.resources.length,
    screenshots: context.screenshots.length,
    ariaSnapshots: context.ariaSnapshots.length,
    domSnapshots: context.domSnapshots.length,
    videos: context.videos.length,
    events: context.events.length,
    stdio: context.stdio.length,
    errors: context.errors.length,
  };
}

// The changes of a context since its lists had the given lengths. Without lengths, the context is new.
export function contextChanges(context: ContextEntry, from: ContextListLengths | undefined, isActionChanged: (callId: string) => boolean): ContextEntry {
  return {
    ...context,
    pages: context.pages.map((page, index) => ({ ...page, screencastFrames: page.screencastFrames.slice(from?.pages[index] ?? 0) })),
    actions: from ? context.actions.filter(action => isActionChanged(action.callId)) : context.actions,
    resources: context.resources.slice(from?.resources ?? 0),
    screenshots: context.screenshots.slice(from?.screenshots ?? 0),
    ariaSnapshots: context.ariaSnapshots.slice(from?.ariaSnapshots ?? 0),
    domSnapshots: context.domSnapshots.slice(from?.domSnapshots ?? 0),
    videos: context.videos.slice(from?.videos ?? 0),
    events: context.events.slice(from?.events ?? 0),
    stdio: context.stdio.slice(from?.stdio ?? 0),
    errors: context.errors.slice(from?.errors ?? 0),
  };
}

// Returns the contexts after the update. It does not change the given contexts, and keeps the objects that did not change.
export function applyContextsUpdate(contexts: ContextEntry[], update: ContextsUpdate): ContextEntry[] {
  if (update.full)
    return update.contexts;
  const result = contexts.slice();
  update.contexts.forEach((changes, index) => {
    const context = contexts[index];
    if (!context) {
      result[index] = changes;
      return;
    }
    result[index] = {
      ...changes,
      pages: changes.pages.map((page, index) => {
        const existing = context.pages[index];
        if (!existing)
          return page;
        return page.screencastFrames.length ? { ...existing, screencastFrames: existing.screencastFrames.concat(page.screencastFrames) } : existing;
      }),
      actions: mergeActions(context.actions, changes.actions),
      resources: append(context.resources, changes.resources),
      screenshots: append(context.screenshots, changes.screenshots),
      ariaSnapshots: append(context.ariaSnapshots, changes.ariaSnapshots),
      domSnapshots: append(context.domSnapshots, changes.domSnapshots),
      videos: append(context.videos, changes.videos),
      events: append(context.events, changes.events),
      stdio: append(context.stdio, changes.stdio),
      errors: append(context.errors, changes.errors),
    };
  });
  return result;
}

function mergeActions(actions: ContextEntry['actions'], changed: ContextEntry['actions']): ContextEntry['actions'] {
  if (!changed.length)
    return actions;
  const byCallId = new Map(actions.map(action => [action.callId, action]));
  for (const action of changed)
    byCallId.set(action.callId, action);
  // The same order as in the trace loader: by start time, then in the order of the trace.
  return [...byCallId.values()].sort((a1, a2) => a1.startTime - a2.startTime);
}

function append<T>(list: T[], items: T[]): T[] {
  return items.length ? list.concat(items) : list;
}
