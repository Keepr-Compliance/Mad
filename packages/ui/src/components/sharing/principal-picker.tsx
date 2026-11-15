'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useClickOutside } from '../../lib/use-click-outside';
import { displayName, principalKey } from './sharing-avatar';
import type { SharingPrincipal } from './types';

/**
 * "Add people or roles": picked principals as chips, then a combobox input
 * whose listbox offers the remaining candidates (BACKLOG-3513).
 *
 * - Typing or ArrowDown opens the list; ArrowUp/ArrowDown move the active
 *   option (aria-activedescendant); Enter adds it. Picking keeps the list open
 *   and clears the text, so several can be added in a row.
 * - Backspace in an empty field removes the last chip.
 * - Escape while the list is open closes only the list (window capture, as
 *   Dropdown does), never the dialog.
 */
export interface PrincipalPickerProps {
  label: string;
  placeholder: string;
  /** Null while loading: the field is disabled. */
  candidates: readonly SharingPrincipal[] | null;
  /** Keys (principalKey) never offered: current entries, the owner. */
  exclude: ReadonlySet<string>;
  chips: readonly SharingPrincipal[];
  onAdd: (p: SharingPrincipal) => void;
  onRemoveChip: (p: SharingPrincipal) => void;
  /** id of the text field, e.g. to move focus there after a removal. Default: generated. */
  inputId?: string;
}

export function PrincipalPicker({
  label,
  placeholder,
  candidates,
  exclude,
  chips,
  onAdd,
  onRemoveChip,
  inputId: externalInputId,
}: PrincipalPickerProps) {
  const baseId = React.useId();
  const inputId = externalInputId ?? `${baseId}-input`;
  const listId = `${baseId}-list`;
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const chipKeys = new Set(chips.map(principalKey));
  const q = query.trim().toLowerCase();
  const options = (candidates ?? []).filter((c) => {
    const key = principalKey(c);
    if (exclude.has(key) || chipKeys.has(key)) return false;
    if (q === '') return true;
    return c.name.toLowerCase().includes(q) || (c.detail ?? '').toLowerCase().includes(q);
  });
  const activeIndex = options.length === 0 ? -1 : Math.min(active, options.length - 1);
  const showList = open && candidates !== null;

  const close = React.useCallback(() => {
    setOpen(false);
    setActive(0);
  }, []);
  useClickOutside(wrapperRef, close, showList);

  React.useEffect(() => {
    if (!showList) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showList, close]);

  function pick(p: SharingPrincipal) {
    onAdd(p);
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
      } else if (options.length > 0) setActive((activeIndex + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open && options.length > 0) setActive((activeIndex - 1 + options.length) % options.length);
    } else if (e.key === 'Enter') {
      if (showList && activeIndex >= 0) {
        e.preventDefault();
        pick(options[activeIndex]);
      }
    } else if (e.key === 'Backspace' && query === '' && chips.length > 0) {
      onRemoveChip(chips[chips.length - 1]);
    } else if (e.key === 'Tab') {
      close();
    }
  }

  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const disabled = candidates === null;

  return (
    <div ref={wrapperRef} data-slot="sharing-picker" className="relative flex min-w-0 flex-1 flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
        {label}
      </label>
      <div
        className={cn(
          'flex min-h-9 flex-wrap items-center gap-2 rounded-md border bg-white px-2 py-1',
          showList ? 'border-primary-500 ring-1 ring-primary-500' : 'border-gray-300',
          'focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500',
          disabled && 'cursor-not-allowed bg-gray-100'
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((chip) => {
          const name = displayName(chip);
          return (
            <span
              key={principalKey(chip)}
              data-slot="sharing-chip"
              className="inline-flex items-center gap-1 rounded-full bg-primary-100 py-0.5 pl-2 pr-1 text-xs font-medium text-primary-800"
            >
              {name}
              <button
                type="button"
                aria-label={`Remove ${name} from the list`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveChip(chip);
                  inputRef.current?.focus();
                }}
                className="flex h-4 w-4 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showList && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={disabled ? 'Loading…' : placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="min-w-[8rem] flex-1 border-none bg-transparent text-sm text-gray-900 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
      </div>
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          data-slot="sharing-picker-list"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-lg"
        >
          {options.length === 0 ? (
            <li role="option" aria-selected={false} aria-disabled="true" className="px-2.5 py-2 text-sm text-gray-500">
              No one else to add
            </li>
          ) : (
            options.map((option, i) => (
              <li
                key={principalKey(option)}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(option)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2',
                  i === activeIndex && 'bg-gray-100'
                )}
              >
                <span className="text-sm text-gray-900">{displayName(option)}</span>
                {option.detail ? <span className="text-xs text-gray-500">{option.detail}</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
