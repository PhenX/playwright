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

import { artifactsFolderName } from '@testIsomorphic/folders';
import type { TreeItem } from '@testIsomorphic/testTree';
import '@web/common.css';
import '@web/third_party/vscode/codicon.css';
import type * as reporterTypes from 'playwright/types/testReporter';
import React from 'react';
import type { ContextEntry } from '@isomorphic/trace/entries';
import type { SourceLocation } from '@isomorphic/trace/traceModel';
import { TraceModel } from '@isomorphic/trace/traceModel';
import { Workbench } from './workbench';

export const TraceView: React.FC<{
  item: { treeItem?: TreeItem, testFile?: SourceLocation, testCase?: reporterTypes.TestCase },
  rootDir?: string,
  onOpenExternally?: (location: SourceLocation) => void,
  revealSource?: boolean,
  pathSeparator: string,
  onModelChange?: (model: TraceModel | undefined) => void,
}> = ({ item, rootDir, onOpenExternally, revealSource, pathSeparator, onModelChange }) => {
  const [model, setModel] = React.useState<{ model: TraceModel, isLive: boolean } | undefined>(undefined);
  const [counter, setCounter] = React.useState(0);
  // The contexts of the last live poll: a poll with the same contexts does not update the model.
  const liveContexts = React.useRef<string | undefined>(undefined);
  // The delay before the next live poll. A poll loads the whole trace, so it costs more as the trace
  // grows: the delay grows with it, and a large trace updates less often.
  const livePollDelay = React.useRef(kMinLivePollDelay);

  const { outputDir } = React.useMemo(() => {
    const outputDir = item.testCase ? outputDirForTestCase(item.testCase) : undefined;
    return { outputDir };
  }, [item]);

  React.useEffect(() => {
    const result = item.testCase?.results[0];
    if (!result || item.treeItem?.status === 'scheduled') {
      setModel(undefined);
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;

    // Test finished.
    const attachment = result && result.duration >= 0 && result.attachments.find(a => a.name === 'trace');
    if (attachment && attachment.path) {
      loadSingleTraceFile(attachment.path, result.startTime.getTime(), signal).then(model => model && setModel({ model, isLive: false })).catch(e => {
        if (!signal.aborted)
          throw e;
      });
      return () => abortController.abort();
    }

    if (!outputDir) {
      setModel(undefined);
      return;
    }

    const traceLocation = [
      outputDir,
      artifactsFolderName(result.workerIndex),
      'traces',
      `${item.testCase?.id}.json`
    ].join(pathSeparator);
    // Start polling running test.
    const pollTimer = setTimeout(async () => {
      const pollStart = performance.now();
      try {
        const model = await loadSingleTraceFile(traceLocation, undefined, signal, liveContexts);
        if (model)
          setModel({ model, isLive: true });
      } catch {
        if (signal.aborted)
          return;
        const model = new TraceModel('', []);
        model.errorDescriptors.push(...result.errors.flatMap(error => !!error.message ? [{ message: error.message }] : []));
        setModel({ model, isLive: false });
      }
      // Include the render of the new model in the cost of the poll.
      await Promise.race([
        new Promise(f => requestAnimationFrame(f)),
        new Promise(f => setTimeout(f, 1000)),
      ]);
      if (signal.aborted)
        return;
      livePollDelay.current = Math.max(kMinLivePollDelay, 2 * (performance.now() - pollStart));
      setCounter(counter + 1);
    }, livePollDelay.current);
    return () => {
      clearTimeout(pollTimer);
      abortController.abort();
    };
  }, [outputDir, item, setModel, counter, setCounter, pathSeparator]);

  React.useEffect(() => {
    onModelChange?.(model?.model);
  }, [model, onModelChange]);

  return <Workbench
    model={model?.model}
    key='workbench'
    showSourcesFirst={true}
    rootDir={rootDir}
    fallbackLocation={item.testFile}
    isLive={model?.isLive}
    status={item.treeItem?.status}
    defaultAnnotations={item.testCase?.annotations ?? []}
    onOpenExternally={onOpenExternally}
    revealSource={revealSource}
  />;
};

const kMinLivePollDelay = 500;

const outputDirForTestCase = (testCase: reporterTypes.TestCase): string | undefined => {
  for (let suite: reporterTypes.Suite | undefined = testCase.parent; suite; suite = suite.parent) {
    if (suite.project())
      return suite.project()?.outputDir;
  }
  return undefined;
};

// Without a timestamp, the trace is live: it keeps the same uri, so that the urls of its resources and
// snapshots do not change between polls, and the reload parameter loads the trace again.
async function loadSingleTraceFile(absolutePath: string, timestamp: number | undefined, signal: AbortSignal, previousContexts?: React.MutableRefObject<string | undefined>): Promise<TraceModel | undefined> {
  const traceUri = `file?path=${encodeURIComponent(absolutePath)}` + (timestamp !== undefined ? `&timestamp=${timestamp}` : '');
  const params = new URLSearchParams();
  params.set('trace', traceUri);
  if (timestamp === undefined)
    params.set('reload', '1');
  const response = await fetch(`contexts?${params.toString()}`, { signal });
  const text = await response.text();
  if (previousContexts) {
    if (previousContexts.current === text)
      return undefined;
    previousContexts.current = text;
  }
  const contextEntries = JSON.parse(text) as ContextEntry[];
  return new TraceModel(traceUri, contextEntries);
}
