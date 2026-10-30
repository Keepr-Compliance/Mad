'use client';

import * as React from 'react';
import { Check, Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { filterDropdownOptions } from './filter-options';
import type { DropdownOptionsProps, DropdownRow } from './types';

/**
 * DropdownOptions (BACKLOG-4032): the search field + listbox, with no trigger
 * and no popover. `Dropdown` wraps it in a popover, or in a BottomSheet with
 * `presentation="sheet"`; a phone filter bar puts it in a BottomSheet itself
 * (README "Phone").
 *
 * a11y: ARIA 1.2 combobox. Focus stays in the search field (role=combobox)
 * and the active row is announced through aria-activedescendant, so typing
 * keeps filtering while the arrow keys move. Without search, the listbox
 * itself takes focus and carries aria-activedescendant.
 *
 * Keys on the focus host: ArrowDown/ArrowUp = next/previous enabled row (no
 * wrap), Home/End = first/last enabled row, Enter = pick the active row,
 * Tab = onTabOut. Escape is the parent's job (see Dropdown).
 *
 * Disabled rows are skipped by the arrow keys (founder decision 2026-10-21);
 * they are announced by browse mode and their hint is their description.
 */
function isNavigable<V extends string>(row: DropdownRow<V>): boolean {
  return row.kind === 'option' && !row.option.disabled;
}

export function DropdownOptions<V extends string = string>({
  options,
  value,
  onSelect,
  ariaLabel,
  labelledBy,
  searchable = true,
  searchPlaceholder,
  emptyText = 'No results',
  query: queryProp,
  onQueryChange,
  autoFocus = false,
  onTabOut,
  size = 'default',
  className,
}: DropdownOptionsProps<V>) {
  const baseId = React.useId();
  const listboxId = `${baseId}-listbox`;

  const [innerQuery, setInnerQuery] = React.useState('');
  const query = queryProp ?? innerQuery;

  // The active row is tracked by VALUE and re-derived against the current
  // rows on every render, so a filtered or shrunk list never leaves a stale id.
  const [activeValue, setActiveValue] = React.useState<V | null>(value);

  const indexByValue = React.useMemo(() => {
    const m = new Map<V, number>();
    options.forEach((o, i) => m.set(o.value, i));
    return m;
  }, [options]);

  const rows = React.useMemo<DropdownRow<V>[]>(
    () =>
      filterDropdownOptions(options, query).map((option) => {
        const id = `${baseId}-o${indexByValue.get(option.value)}`;
        return { kind: 'option', option, id, labelId: `${id}-label` };
      }),
    [options, query, baseId, indexByValue]
  );

  const firstNavigable = rows.findIndex(isNavigable);
  let activeIndex = rows.findIndex(
    (r) => isNavigable(r) && r.kind === 'option' && r.option.value === activeValue
  );
  if (activeIndex === -1) activeIndex = firstNavigable;
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const activeId = activeRow?.id;

  const hostRef = React.useRef<HTMLElement | null>(null);
  const rowRefs = React.useRef(new Map<string, HTMLElement>());

  React.useEffect(() => {
    if (autoFocus) hostRef.current?.focus();
    // Mount only: autoFocus is read once when the panel opens.
  }, []);

  React.useEffect(() => {
    if (!activeId) return;
    const el = rowRefs.current.get(activeId);
    // Optional call: jsdom (and broker-portal jest, which has no polyfill) lacks it.
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  function setQuery(next: string) {
    if (queryProp === undefined) setInnerQuery(next);
    onQueryChange?.(next);
    // After each query change the active row is the first enabled result.
    setActiveValue(null);
  }

  function activate(index: number) {
    const row = rows[index];
    if (row && row.kind === 'option') setActiveValue(row.option.value);
  }

  function step(dir: 1 | -1) {
    if (activeIndex < 0) return;
    for (let i = activeIndex + dir; i >= 0 && i < rows.length; i += dir) {
      if (isNavigable(rows[i])) {
        activate(i);
        return;
      }
    }
  }

  function edge(which: 'first' | 'last') {
    if (which === 'first') {
      if (firstNavigable >= 0) activate(firstNavigable);
      return;
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      if (isNavigable(rows[i])) {
        activate(i);
        return;
      }
    }
  }

  function pick(row: DropdownRow<V> | undefined) {
    if (!row || row.kind !== 'option' || row.option.disabled) return;
    onSelect(row.option.value);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'Home':
        e.preventDefault();
        edge('first');
        break;
      case 'End':
        e.preventDefault();
        edge('last');
        break;
      case 'Enter':
        e.preventDefault();
        pick(activeRow);
        break;
      case 'Tab':
        onTabOut?.();
        break;
      default:
        break;
    }
  }

  const comfortable = size === 'comfortable';
  const searchLabel = searchPlaceholder ?? `Search ${ariaLabel}`;

  return (
    <div
      data-slot="dropdown-options"
      className={cn('overflow-hidden rounded-lg border border-gray-200', className)}
    >
      {searchable ? (
        <div
          className={cn(
            'flex items-center gap-2 border-b border-gray-200 px-3',
            comfortable ? 'min-h-12' : 'min-h-9'
          )}
        >
          <Search className="h-4 w-4 flex-shrink-0 text-gray-400" aria-hidden="true" />
          <input
            ref={(el) => {
              hostRef.current = el;
            }}
            type="text"
            data-autofocus={autoFocus ? '' : undefined}
            role="combobox"
            aria-label={searchLabel}
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className={cn(
              'min-w-0 flex-1 border-0 bg-transparent p-0 text-gray-900 outline-none placeholder:text-gray-400 focus:outline-none focus:ring-0',
              comfortable ? 'text-base' : 'text-sm'
            )}
          />
        </div>
      ) : null}
      <div
        ref={
          searchable
            ? undefined
            : (el) => {
                hostRef.current = el;
              }
        }
        id={listboxId}
        data-autofocus={autoFocus && !searchable ? '' : undefined}
        role="listbox"
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-labelledby={labelledBy}
        tabIndex={searchable ? -1 : 0}
        aria-activedescendant={searchable ? undefined : activeId}
        onKeyDown={searchable ? undefined : onKeyDown}
        className="max-h-60 divide-y divide-gray-100 overflow-y-auto focus:outline-none"
      >
        {rows.map((row) => {
          if (row.kind !== 'option') return null;
          const { option } = row;
          const selected = option.value === value;
          const active = row.id === activeId;
          const descId = option.description ? `${row.id}-desc` : undefined;
          const hintId = option.hint ? `${row.id}-hint` : undefined;
          const tall = Boolean(option.description || option.hint);
          return (
            <div
              key={row.id}
              id={row.id}
              ref={(el) => {
                if (el) rowRefs.current.set(row.id, el);
                else rowRefs.current.delete(row.id);
              }}
              role="option"
              aria-selected={selected}
              aria-disabled={option.disabled ? true : undefined}
              aria-labelledby={descId ? `${row.labelId} ${descId}` : row.labelId}
              aria-describedby={hintId}
              data-active={active ? '' : undefined}
              // Keep focus in the search field: a mousedown on a row must not blur it.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => {
                if (!option.disabled && !active) setActiveValue(option.value);
              }}
              onClick={() => pick(row)}
              className={cn(
                'flex w-full items-center gap-3 px-3 text-left',
                comfortable ? 'min-h-12 py-2 text-base' : 'text-sm',
                !comfortable && (tall ? 'min-h-12 py-1.5' : 'min-h-9'),
                option.disabled ? 'cursor-not-allowed text-gray-400' : 'cursor-pointer text-gray-900',
                selected ? (active ? 'bg-primary-100' : 'bg-primary-50') : active && 'bg-gray-50'
              )}
            >
              <span className="min-w-0 flex-1">
                <span id={row.labelId} className={cn('block', selected && 'font-medium')}>
                  {option.label}
                </span>
                {option.description ? (
                  <span
                    id={descId}
                    className={cn('block', comfortable ? 'text-sm' : 'text-xs', option.disabled ? 'text-gray-400' : 'text-gray-600')}
                  >
                    {option.description}
                  </span>
                ) : null}
                {option.hint ? (
                  <span id={hintId} className="block text-xs text-gray-500">
                    {option.hint}
                  </span>
                ) : null}
              </span>
              {selected ? (
                <Check className="h-4 w-4 flex-none text-primary-600" aria-hidden="true" />
              ) : (
                <span className="w-4 flex-none" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <div
          data-slot="dropdown-empty"
          className={cn(
            'flex items-center justify-center px-3 text-gray-500',
            comfortable ? 'min-h-12 text-base' : 'min-h-9 text-sm'
          )}
        >
          {emptyText}
        </div>
      ) : null}
    </div>
  );
}
