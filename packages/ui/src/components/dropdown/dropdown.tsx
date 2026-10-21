'use client';

import * as React from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useClickOutside } from '../../lib/use-click-outside';
import { DropdownOptions } from './dropdown-options';
import type { DropdownProps } from './types';

/**
 * Dropdown (BACKLOG-4032 slice 1): searchable single-choice picker.
 *
 * Inline popover (no portal, no new dependency): a `relative` wrapper and an
 * `absolute z-50` panel under the trigger. An `overflow-hidden` ancestor
 * clips the panel; see README "Dropdown" for where that applies.
 *
 * - The trigger shows the label of `value` looked up in the FULL `options`,
 *   so a search that hides the selected row never blanks the trigger.
 * - Value is fully controlled; the component keeps no copy of it.
 * - Escape is caught by a window keydown listener in CAPTURE phase, active
 *   only while the panel is open. That runs before Radix DismissableLayer's
 *   document capture listener, so Escape inside a kit Dialog closes the
 *   dropdown and not the dialog. First Escape clears a non-empty search;
 *   the next closes. Escape never changes the value.
 * - Enter / click pick and return focus to the trigger. A pointerdown
 *   outside closes WITHOUT moving focus, so the user's click target keeps it.
 */
export function Dropdown<V extends string = string>(props: DropdownProps<V>) {
  const {
    options,
    value,
    onChange,
    label,
    ariaLabel,
    id,
    placeholder = 'Select…',
    searchable = true,
    searchPlaceholder,
    emptyText,
    invalid = false,
    error,
    disabled = false,
    className,
  } = props;

  const baseId = React.useId();
  const triggerId = id ?? `${baseId}-trigger`;
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const errorId = `${baseId}-error`;

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const selected = value === null ? undefined : options.find((o) => o.value === value);
  const nameText = label ?? ariaLabel;

  const openPanel = React.useCallback(() => {
    if (disabled) return;
    setQuery('');
    setOpen(true);
  }, [disabled]);

  const close = React.useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const closeFromOutside = React.useCallback(() => close(false), [close]);
  useClickOutside(wrapperRef, closeFromOutside, open);

  // Escape: window capture, only while open (see header comment).
  const queryRef = React.useRef(query);
  queryRef.current = query;
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (queryRef.current !== '') setQuery('');
      else close(true);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPanel();
    }
  }

  const showError = invalid && Boolean(error);

  return (
    <div ref={wrapperRef} data-slot="dropdown" className={cn('relative', className)}>
      {label ? (
        <label id={labelId} htmlFor={triggerId} className="mb-1 block text-sm font-medium text-gray-700">
          {label}
        </label>
      ) : (
        <span id={labelId} className="sr-only">
          {ariaLabel}
        </span>
      )}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={showError ? errorId : undefined}
        onClick={() => (open ? close(false) : openPanel())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'flex min-h-9 w-full items-center gap-2 rounded-md border bg-white px-3 py-1.5 text-left text-sm text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
          invalid ? 'border-danger-600 ring-1 ring-danger-600' : 'border-gray-300',
          open && !invalid && 'border-primary-500 ring-2 ring-primary-500',
          disabled && 'cursor-not-allowed bg-gray-100 text-gray-400'
        )}
      >
        <span
          id={valueId}
          data-placeholder={selected ? undefined : ''}
          className={cn('min-w-0 flex-1 truncate', !selected && 'text-muted-foreground')}
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className="h-4 w-4 flex-shrink-0 text-gray-500" aria-hidden="true" />
      </button>
      {open ? (
        <div data-slot="dropdown-panel" className="absolute z-50 mt-1 w-full rounded-lg bg-white shadow-lg">
          <DropdownOptions<V>
            options={options}
            value={value}
            onSelect={(v) => {
              onChange(v);
              close(true);
            }}
            ariaLabel={nameText ?? ''}
            labelledBy={labelId}
            searchable={searchable}
            searchPlaceholder={searchPlaceholder}
            emptyText={emptyText}
            query={query}
            onQueryChange={setQuery}
            autoFocus
            onTabOut={() => close(true)}
          />
        </div>
      ) : null}
      {showError ? (
        <p id={errorId} role="alert" className="mt-1 flex items-center gap-1.5 text-xs text-danger-600">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
