/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import * as React from 'react';
import { clsx, scrollIntoViewIfNeeded } from '../uiUtils';
import './treeView.css';

export type TreeItem = {
  id: string,
  parent: TreeItem | undefined,
  children: TreeItem[],
};

export type TreeState = {
  expandedItems: Map<string, boolean>;
};

export type TreeViewProps<T> = {
  name: string,
  rootItem: T,
  render: (item: T) => React.ReactNode,
  title?: (item: T) => string,
  icon?: (item: T) => string | undefined,
  isError?: (item: T) => boolean,
  isVisible?: (item: T) => boolean | 'if-needed',
  selectedItem?: T,
  onAccepted?: (item: T) => void,
  onSelected?: (item: T) => void,
  onHighlighted?: (item: T | undefined) => void,
  noItemsMessage?: string,
  dataTestId?: string,
  treeState: TreeState,
  setTreeState: (treeState: TreeState) => void,
  autoExpandDepth?: number,
  revealSelectedKey?: number,
  // With more visible items than this, only the rows near the visible area are rendered.
  virtualizeAbove?: number,
};

const scrollPositions = new Map<string, number>();

// A virtualized tree renders the rows in this distance from the visible area.
const kVirtualOverscan = 600;
// The height of a row that is not rendered yet.
const kVirtualRowHeight = 28;

export function TreeView<T extends TreeItem>({
  name,
  rootItem,
  render,
  title,
  icon,
  isError,
  isVisible,
  selectedItem,
  onAccepted,
  onSelected,
  onHighlighted,
  treeState,
  setTreeState,
  noItemsMessage,
  dataTestId,
  autoExpandDepth,
  revealSelectedKey,
  virtualizeAbove,
}: TreeViewProps<T>) {
  const treeItems = React.useMemo(() => {
    return indexTree<T>(rootItem, selectedItem, treeState.expandedItems, autoExpandDepth || 0, isVisible);
  }, [rootItem, selectedItem, treeState, autoExpandDepth, isVisible]);

  const itemListRef = React.useRef<HTMLDivElement>(null);
  const [highlightedItem, setHighlightedItem] = React.useState<any>();
  const virtualized = virtualizeAbove !== undefined && treeItems.size > virtualizeAbove;
  const virtual = useVirtualRows(itemListRef, treeItems, virtualized, selectedItem, revealSelectedKey);

  React.useEffect(() => {
    onHighlighted?.(highlightedItem);
  }, [onHighlighted, highlightedItem]);

  React.useEffect(() => {
    const treeElem = itemListRef.current;
    if (!treeElem)
      return;
    const saveScrollPosition = () => {
      scrollPositions.set(name, treeElem.scrollTop);
    };
    treeElem.addEventListener('scroll', saveScrollPosition, { passive: true });
    return () => treeElem.removeEventListener('scroll', saveScrollPosition);
  }, [name]);

  React.useEffect(() => {
    if (itemListRef.current)
      itemListRef.current.scrollTop = scrollPositions.get(name) || 0;
  }, [name]);

  React.useEffect(() => {
    // A virtualized tree reveals the selected item itself, see useVirtualRows().
    if (revealSelectedKey === undefined || virtualized)
      return;
    const selectedEl = itemListRef.current?.querySelector('[aria-selected="true"]');
    if (selectedEl)
      scrollIntoViewIfNeeded(selectedEl);
  }, [revealSelectedKey, virtualized]);

  const toggleExpanded = React.useCallback((item: T) => {
    const { expanded } = treeItems.get(item)!;
    if (expanded) {
      // Move nested selection up.
      for (let i: TreeItem | undefined = selectedItem; i; i = i.parent) {
        if (i === item) {
          onSelected?.(item as T);
          break;
        }
      }
      treeState.expandedItems.set(item.id, false);
    } else {
      treeState.expandedItems.set(item.id, true);
    }
    setTreeState({ ...treeState });
  }, [treeItems, selectedItem, onSelected, treeState, setTreeState]);

  const toggleSubtree = React.useCallback((item: T) => {
    const { expanded } = treeItems.get(item)!;

    const stack: TreeItem[] = [item];
    while (stack.length) {
      const current = stack.pop()!;
      stack.push(...current.children);

      treeState.expandedItems.set(current.id, !expanded);
    }

    setTreeState({ ...treeState });
  }, [treeItems, treeState, setTreeState]);

  return <div className={clsx(`tree-view vbox`, name + '-tree-view')} data-testid={dataTestId || (name + '-tree')}>
    <div
      className={clsx('tree-view-content')}
      role={treeItems.size > 0 ? 'tree' : undefined}
      tabIndex={0}
      onKeyDown={event => {
        // Enter is handled by the focused button inside the row, if any.
        if (selectedItem && event.key === 'Enter' && event.target === event.currentTarget) {
          onAccepted?.(selectedItem);
          return;
        }
        if (event.key !== 'ArrowDown' &&  event.key !== 'ArrowUp' && event.key !== 'ArrowLeft' &&  event.key !== 'ArrowRight')
          return;

        event.stopPropagation();
        event.preventDefault();

        if (selectedItem && event.key === 'ArrowLeft') {
          const { expanded, parent } = treeItems.get(selectedItem)!;
          if (expanded) {
            treeState.expandedItems.set(selectedItem.id, false);
            setTreeState({ ...treeState });
          } else if (parent) {
            onSelected?.(parent as T);
          }
          return;
        }
        if (selectedItem && event.key === 'ArrowRight') {
          if (selectedItem.children.length) {
            treeState.expandedItems.set(selectedItem.id, true);
            setTreeState({ ...treeState });
          }
          return;
        }

        let newSelectedItem: T | undefined = selectedItem;
        if (event.key === 'ArrowDown') {
          if (selectedItem) {
            const itemData = treeItems.get(selectedItem)!;
            newSelectedItem = itemData.next as T;
          } else if (treeItems.size) {
            const itemList = [...treeItems.keys()];
            newSelectedItem = itemList[0];
          }
        }
        if (event.key === 'ArrowUp') {
          if (selectedItem) {
            const itemData = treeItems.get(selectedItem)!;
            newSelectedItem = itemData.prev as T;
          } else if (treeItems.size) {
            const itemList = [...treeItems.keys()];
            newSelectedItem = itemList[itemList.length - 1];
          }
        }

        onHighlighted?.(undefined);
        if (newSelectedItem)
          onSelected?.(newSelectedItem);
        setHighlightedItem(undefined);
      }}
      ref={itemListRef}
    >
      {noItemsMessage && treeItems.size === 0 && <div className='tree-view-empty'>{noItemsMessage}</div>}
      {virtual && <div style={{ height: virtual.topSpace, flex: 'none' }} />}
      {(virtual ? virtual.rows : rootItem.children as T[]).map(child => {
        const itemData = treeItems.get(child);
        return itemData && <TreeItemHeader
          key={child.id}
          item={child}
          treeItems={treeItems}
          selectedItem={selectedItem}
          onSelected={onSelected}
          onAccepted={onAccepted}
          isError={isError}
          toggleExpanded={toggleExpanded}
          toggleSubtree={toggleSubtree}
          highlightedItem={highlightedItem}
          setHighlightedItem={setHighlightedItem}
          render={render}
          icon={icon}
          title={title}
          flat={!!virtual}
          rowRef={virtual?.rowRef} />;
      })}
      {virtual && <div style={{ height: virtual.bottomSpace, flex: 'none' }} />}
    </div>
  </div>;
}

type VirtualRows<T> = {
  rows: T[],
  topSpace: number,
  bottomSpace: number,
  rowRef: (id: string, element: HTMLElement | null) => void,
};

// Renders only the rows near the visible area, as a flat list. Rows can have different heights:
// they are measured once rendered, and other rows count with an estimated height.
function useVirtualRows<T extends TreeItem>(
  containerRef: React.RefObject<HTMLDivElement | null>,
  treeItems: Map<T, TreeItemData>,
  enabled: boolean,
  selectedItem: T | undefined,
  revealSelectedKey: number | undefined): VirtualRows<T> | undefined {
  const [viewport, setViewport] = React.useState({ top: 0, height: 0 });
  const [measured, setMeasured] = React.useState(0);
  const heights = React.useRef(new Map<string, number>());
  const elements = React.useRef(new Map<string, HTMLElement>());

  React.useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container)
      return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setViewport({ top: container.scrollTop, height: container.clientHeight });
    };
    const scheduleUpdate = () => {
      if (!frame)
        frame = requestAnimationFrame(update);
    };
    update();
    container.addEventListener('scroll', scheduleUpdate, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(container);
    return () => {
      container.removeEventListener('scroll', scheduleUpdate);
      resizeObserver.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [enabled, containerRef]);

  const allRows = React.useMemo(() => enabled ? [...treeItems.keys()] : [], [enabled, treeItems]);
  const offsets = React.useMemo(() => {
    const result = new Array<number>(allRows.length + 1);
    result[0] = 0;
    for (let i = 0; i < allRows.length; i++)
      result[i + 1] = result[i] + (heights.current.get(allRows[i].id) ?? kVirtualRowHeight);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, measured]);

  // Measure the rendered rows. A change of height updates the offsets once.
  React.useLayoutEffect(() => {
    if (!enabled)
      return;
    let changed = false;
    for (const [id, element] of elements.current) {
      const height = element.offsetHeight;
      if (height && heights.current.get(id) !== height) {
        heights.current.set(id, height);
        changed = true;
      }
    }
    if (changed)
      setMeasured(value => value + 1);
  }, [enabled, allRows, viewport, measured]);

  // Scroll to the selected row, so that it is rendered. The row itself then scrolls into view when needed.
  const selectedIndex = enabled && selectedItem ? allRows.indexOf(selectedItem) : -1;
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || selectedIndex === -1)
      return;
    const top = offsets[selectedIndex];
    const bottom = offsets[selectedIndex + 1];
    if (top < container.scrollTop)
      container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight)
      container.scrollTop = bottom - container.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem?.id, revealSelectedKey]);

  const rowRef = React.useCallback((id: string, element: HTMLElement | null) => {
    if (element)
      elements.current.set(id, element);
    else
      elements.current.delete(id);
  }, []);

  if (!enabled)
    return undefined;
  const start = Math.max(0, upperBound(offsets, viewport.top - kVirtualOverscan) - 1);
  const end = Math.min(allRows.length, upperBound(offsets, viewport.top + viewport.height + kVirtualOverscan));
  return {
    rows: allRows.slice(start, end),
    topSpace: offsets[start],
    bottomSpace: offsets[allRows.length] - offsets[end],
    rowRef,
  };
}

// The index of the first offset that is greater than the value.
function upperBound(offsets: number[], value: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle] <= value)
      low = middle + 1;
    else
      high = middle;
  }
  return low;
}

type TreeItemHeaderProps<T> = {
  item: T,
  treeItems: Map<T, TreeItemData>,
  selectedItem: T | undefined,
  onSelected?: (item: T) => void,
  toggleExpanded: (item: T) => void,
  toggleSubtree: (item: T) => void,
  highlightedItem: T | undefined,
  isError?: (item: T) => boolean,
  onAccepted?: (item: T) => void,
  setHighlightedItem: (item: T | undefined) => void,
  render: (item: T) => React.ReactNode,
  title?: (item: T) => string,
  icon?: (item: T) => string | undefined,
  // A flat row does not render its children: the virtualized tree renders all rows as a list.
  flat?: boolean,
  rowRef?: (id: string, element: HTMLElement | null) => void,
};

export function TreeItemHeader<T extends TreeItem>({
  item,
  treeItems,
  selectedItem,
  onSelected,
  highlightedItem,
  setHighlightedItem,
  isError,
  onAccepted,
  toggleExpanded,
  toggleSubtree,
  render,
  title,
  icon,
  flat,
  rowRef }: TreeItemHeaderProps<T>) {
  const groupId = React.useId();
  const itemRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (selectedItem?.id === item.id && itemRef.current)
      scrollIntoViewIfNeeded(itemRef.current);
  }, [item.id, selectedItem?.id]);

  const itemData = treeItems.get(item)!;
  const indentation = itemData.depth;
  const expanded = itemData.expanded;
  let expandIcon = 'codicon-blank';
  if (typeof expanded === 'boolean')
    expandIcon = expanded ? 'codicon-chevron-down' : 'codicon-chevron-right';
  const rendered = render(item);
  const children = !flat && expanded && item.children.length ? item.children as T[] : [];
  const titled = title?.(item);
  const iconed = icon?.(item) || 'codicon-blank';
  const setElement = (element: HTMLDivElement | null) => {
    itemRef.current = element;
    rowRef?.(item.id, element);
  };

  return <div
    ref={setElement}
    role='treeitem'
    aria-selected={item === selectedItem}
    aria-expanded={expanded}
    aria-controls={flat ? undefined : groupId}
    aria-level={flat ? indentation + 1 : undefined}
    title={titled}
    className='vbox'
    style={{ flex: 'none' }}>
    <div
      onDoubleClick={() => onAccepted?.(item)}
      className={clsx(
          'tree-view-entry',
          selectedItem === item && 'selected',
          highlightedItem === item && 'highlighted',
          isError?.(item) && 'error')}
      onClick={() => onSelected?.(item)}
      onMouseEnter={() => setHighlightedItem(item)}
      onMouseLeave={() => setHighlightedItem(undefined)}
    >
      {indentation ? new Array(indentation).fill(0).map((_, i) => <div key={'indent-' + i} className='tree-view-indent'></div>) : undefined}
      <div
        aria-hidden='true'
        className={'codicon ' + expandIcon}
        style={{ minWidth: 16, marginRight: 4 }}
        onDoubleClick={e => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={e => {
          e.stopPropagation();
          e.preventDefault();
          if (e.altKey)
            toggleSubtree(item);
          else
            toggleExpanded(item);
        }}
      />
      {icon && <div className={'codicon ' + iconed} style={{ minWidth: 16, marginRight: 4 }} aria-label={'[' + iconed.replace('codicon', 'icon') + ']'}></div>}
      {typeof rendered === 'string' ? <div style={{ textOverflow: 'ellipsis', overflow: 'hidden' }}>{rendered}</div> : rendered}
    </div>
    {!!children.length && <div id={groupId} role='group'>
      {children.map(child => {
        const itemData = treeItems.get(child);
        return itemData && <TreeItemHeader
          key={child.id}
          item={child}
          treeItems={treeItems}
          selectedItem={selectedItem}
          onSelected={onSelected}
          onAccepted={onAccepted}
          isError={isError}
          toggleExpanded={toggleExpanded}
          toggleSubtree={toggleSubtree}
          highlightedItem={highlightedItem}
          setHighlightedItem={setHighlightedItem}
          render={render}
          title={title}
          icon={icon} />;
      })}
    </div>}
  </div>;
}

type TreeItemData = {
  depth: number;
  expanded: boolean | undefined;
  parent: TreeItem | null;
  next: TreeItem | null;
  prev: TreeItem | null;
};

function isEffectivelyVisible<T extends TreeItem>(
  item: T,
  isVisible: (item: T) => boolean | 'if-needed',
  cache: Map<string, boolean>): boolean {
  const cached = cache.get(item.id);
  if (cached !== undefined)
    return cached;
  const v = isVisible(item);
  const result = v === 'if-needed' ? item.children.some(child => isEffectivelyVisible(child as T, isVisible, cache)) : v;
  cache.set(item.id, result);
  return result;
}

function indexTree<T extends TreeItem>(
  rootItem: T,
  selectedItem: T | undefined,
  expandedItems: Map<string, boolean | undefined>,
  autoExpandDepth: number,
  isVisible: (item: T) => boolean | 'if-needed' = () => true): Map<T, TreeItemData> {
  const visibilityCache = new Map<string, boolean>();
  if (!isEffectivelyVisible(rootItem, isVisible, visibilityCache))
    return new Map();

  const result = new Map<T, TreeItemData>();
  const temporaryExpanded = new Set<string>();
  for (let item: TreeItem | undefined = selectedItem?.parent; item; item = item.parent)
    temporaryExpanded.add(item.id);
  let lastItem: T | null = null;

  const appendChildren = (parent: T, depth: number) => {
    for (const item of parent.children as T[]) {
      if (!isEffectivelyVisible(item, isVisible, visibilityCache))
        continue;
      const expandState = temporaryExpanded.has(item.id) || expandedItems.get(item.id);
      const autoExpandMatches = autoExpandDepth > depth && result.size < 25 && expandState !== false;
      const expanded = item.children.length ? expandState ?? autoExpandMatches : undefined;
      const itemData: TreeItemData = {
        depth,
        expanded,
        parent: rootItem === parent ? null : parent,
        next: null,
        prev: lastItem,
      };
      if (lastItem)
        result.get(lastItem)!.next = item;
      lastItem = item;
      result.set(item, itemData);
      if (expanded)
        appendChildren(item, depth + 1);
    }
  };
  appendChildren(rootItem, 0);
  return result;
}
