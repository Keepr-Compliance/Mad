'use client';

import * as React from 'react';
import { Check, Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { selectAllValues } from '../report/select-all';
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
 *
 * `mode="multi"` (slice 4a): the listbox is aria-multiselectable and every
 * option carries aria-selected true/false. Enter or a click TOGGLES the active
 * row and calls onChange(next); the query and the active row are kept. Space
 * types into the search (it toggles only when there is no search field). A
 * "Select all" / "Clear all" strip sits between the search and the list; both
 * act on every enabled option, not the search results. Tab from the search
 * goes to the first ENABLED bulk button (a disabled one is skipped), Tab from
 * the last enabled one calls onTabOut; with none enabled, Tab calls onTabOut.
 * A bulk action returns focus to the search. The check square at the left is
 * decorative (aria-hidden): an interactive checkbox inside role=option would
 * be invalid ARIA.
 */
/** Bulk rows: the same look as MultiSelectOptions' "Select all" / "Clear all" rows. */
const bulkButton =
  'flex w-full items-center px-3 text-left hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:bg-transparent';

function isNavigable<V extends string>(row: DropdownRow<V>): boolean {
  return row.kind === 'option' && !row.option.disabled;
}

export function DropdownOptions<V extends string = string>(props: DropdownOptionsProps<V>) {
  const {
    options,
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
    fill = false,
    className,
  } = props;
  const multi = props.mode === 'multi';
  const selectedValues: readonly V[] =
    props.mode === 'multi' ? props.value : props.value === null ? [] : [props.value];
  const isSelected = (v: V) => selectedValues.includes(v);

  const baseId = React.useId();
  const listboxId = `${baseId}-listbox`;

  const [innerQuery, setInnerQuery] = React.useState('');
  const query = queryProp ?? innerQuery;

  // The active row is tracked by VALUE and re-derived against the current
  // rows on every render, so a filtered or shrunk list never leaves a stale id.
  // Multi opens on the first ENABLED selected option in option order, else
  // the first enabled row (null falls back to it below).
  const [activeValue, setActiveValue] = React.useState<V | null>(() =>
    props.mode === 'multi'
      ? (options.find((o) => !o.disabled && props.value.includes(o.value))?.value ?? null)
      : props.value
  );

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
    const v = row.option.value;
    if (props.mode === 'multi') {
      const current = props.value;
      props.onChange(current.includes(v) ? current.filter((x) => x !== v) : [...current, v]);
      // The toggled row stays active, so Enter again toggles it back.
      setActiveValue(v);
    } else {
      props.onSelect(v);
    }
  }

  // Bulk strip (multi only).
  const enabledOptions = options.filter((o) => !o.disabled);
  const canSelectAll = multi && enabledOptions.some((o) => !isSelected(o.value));
  const canClearAll = multi && selectedValues.length > 0;
  const selectAllRef = React.useRef<HTMLButtonElement>(null);
  const clearAllRef = React.useRef<HTMLButtonElement>(null);
  const firstBulk = canSelectAll ? selectAllRef : canClearAll ? clearAllRef : null;
  const lastBulk = canClearAll ? clearAllRef : canSelectAll ? selectAllRef : null;

  function bulk(next: V[]) {
    if (props.mode !== 'multi') return;
    props.onChange(next);
    // A keyboard press would leave focus on a button that may now be disabled.
    hostRef.current?.focus();
  }

  function onBulkKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Tab' && !e.shiftKey && lastBulk?.current === e.currentTarget) onTabOut?.();
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
      case ' ':
        // Space types into the search; with no search field it toggles in multi.
        if (multi && !searchable) {
          e.preventDefault();
          pick(activeRow);
        }
        break;
      case 'Tab':
        if (multi && !e.shiftKey && firstBulk?.current) {
          e.preventDefault();
          firstBulk.current.focus();
          break;
        }
        onTabOut?.();
        break;
      default:
        break;
    }
  }

  const comfortable = size === 'comfortable';
  const rowSize = comfortable ? 'min-h-12 text-base' : 'min-h-9 text-sm';
  const searchLabel = searchPlaceholder ?? `Search ${ariaLabel}`;

  return (
    <div
      data-slot="dropdown-options"
      className={cn('overflow-hidden rounded-lg border border-gray-200', fill && 'flex h-full min-h-0 flex-col', className)}
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
      {multi ? (
        <div data-slot="dropdown-bulk" className="divide-y divide-gray-100 border-b border-gray-100">
          <button
            ref={selectAllRef}
            type="button"
            disabled={!canSelectAll}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => bulk(selectAllValues(enabledOptions, selectedValues))}
            onKeyDown={onBulkKeyDown}
            className={cn(bulkButton, rowSize, 'font-medium text-primary-700')}
          >
            Select all
          </button>
          <button
            ref={clearAllRef}
            type="button"
            disabled={!canClearAll}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => bulk([])}
            onKeyDown={onBulkKeyDown}
            className={cn(bulkButton, rowSize, 'text-gray-500')}
          >
            Clear all
          </button>
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
        aria-multiselectable={multi ? true : undefined}
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-labelledby={labelledBy}
        tabIndex={searchable ? -1 : 0}
        aria-activedescendant={searchable ? undefined : activeId}
        onKeyDown={searchable ? undefined : onKeyDown}
        className={cn(
          'divide-y divide-gray-100 overflow-y-auto focus:outline-none',
          fill ? (rows.length > 0 ? 'min-h-0 flex-1' : 'flex-none') : 'max-h-60'
        )}
      >
        {rows.map((row) => {
          if (row.kind !== 'option') return null;
          const { option } = row;
          const selected = isSelected(option.value);
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
              {multi ? (
                <span
                  data-slot="dropdown-check"
                  aria-hidden="true"
                  className={cn(
                    'inline-flex h-4 w-4 flex-none items-center justify-center rounded-sm border shadow-sm',
                    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-white',
                    option.disabled && 'opacity-50'
                  )}
                >
                  {selected ? <Check className="h-3.5 w-3.5" /> : null}
                </span>
              ) : null}
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
              {multi ? null : selected ? (
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
            fill && 'flex-1',
            comfortable ? 'min-h-12 text-base' : 'min-h-9 text-sm'
          )}
        >
          {emptyText}
        </div>
      ) : null}
    </div>
  );
}
