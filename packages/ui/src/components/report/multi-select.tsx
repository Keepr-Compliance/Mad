'use client';

import * as React from 'react';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Checkbox } from '../checkbox';
import { useClickOutside } from './use-click-outside';
import { selectAllValues } from './select-all';

/**
 * Report kit — multi-select (BACKLOG-3502a, amendment A4).
 *
 * `MultiSelectOptions` is THE one option list: optional "Select all" /
 * "Clear all" rows, then one row per option. It is purely controlled — it
 * renders `selected` and reports changes through `onChange`, holding no copy
 * of its own — so a phone parent can keep a pending selection and apply it
 * from a footer button.
 *
 * Desktop: `MultiSelect` wraps it in a trigger ("Label" / "Label (n)") and a
 * popover that closes on a click outside or Escape (window capture listener,
 * so inside a kit Dialog only the popover closes; focus returns to the trigger).
 *
 * Phone recipe: `FilterSelectButton` + `BottomSheet` + `MultiSelectOptions`
 * with `bulkActions={false}`; the sheet header carries the Select all / Clear
 * text buttons and the footer applies the pending selection. See README.
 *
 * DOM contract (existing admin tests rely on it): each option's text is a
 * `<span>` inside a `<label>` that wraps the checkbox, so activating the label
 * toggles it and the checkbox's accessible name is exactly the option label.
 * An option's `count` sits OUTSIDE that label so it never changes the name.
 */
export interface MultiSelectOption {
  value: string;
  label: string;
  /** Optional count shown on the right (e.g. rows with this value). */
  count?: number;
}

export interface MultiSelectOptionsProps {
  options: readonly MultiSelectOption[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Show the "Select all" / "Clear all" rows. Default true. */
  bulkActions?: boolean;
  /** `compact` = desktop popover density (min-h-9 text-sm). Default `comfortable` (phone). */
  size?: 'comfortable' | 'compact';
  /** Accessible name of the option group, e.g. "Outcome" (aria-label, no visible text). */
  ariaLabel?: string;
  className?: string;
}

export function MultiSelectOptions({
  options,
  selected,
  onChange,
  bulkActions = true,
  size = 'comfortable',
  ariaLabel,
  className,
}: MultiSelectOptionsProps) {
  const row = cn(
    'flex items-center gap-3 px-3 text-gray-900',
    size === 'compact' ? 'min-h-9 text-sm' : 'min-h-12 text-base'
  );
  const allSelected = options.every((o) => selected.includes(o.value));

  function toggle(value: string) {
    if (selected.includes(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  }

  return (
    <fieldset
      data-slot="multi-select-options"
      aria-label={ariaLabel}
      className={cn(
        'm-0 min-w-0 divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 p-0',
        className
      )}
    >
      {bulkActions ? (
        <>
          <button
            type="button"
            onClick={() => onChange(selectAllValues(options, selected))}
            disabled={allSelected}
            className={cn(row, 'w-full text-left font-medium text-primary-700 hover:bg-gray-50 disabled:text-gray-400')}
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={selected.length === 0}
            className={cn(row, 'w-full text-left text-gray-500 hover:bg-gray-50 disabled:text-gray-400')}
          >
            Clear all
          </button>
        </>
      ) : null}
      {options.map((option) => {
        const checked = selected.includes(option.value);
        return (
          <div
            key={option.value}
            data-slot="multi-select-option"
            data-state={checked ? 'checked' : 'unchecked'}
            className={cn(row, checked && 'bg-primary-50')}
          >
            <label className="flex flex-1 cursor-pointer items-center gap-3 self-stretch">
              <Checkbox checked={checked} onCheckedChange={() => toggle(option.value)} />
              <span>{option.label}</span>
            </label>
            {option.count !== undefined ? (
              <span className="text-sm tabular-nums text-gray-500">{option.count}</span>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

export interface MultiSelectProps {
  /** Trigger text; the trigger reads "Label" or "Label (n)". */
  label: string;
  options: readonly MultiSelectOption[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  bulkActions?: boolean;
  className?: string;
}

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  bulkActions = true,
  className,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const close = React.useCallback(() => setOpen(false), []);
  useClickOutside(containerRef, close, open);

  // Escape: window keydown in CAPTURE phase, only while open (same as Dropdown),
  // so inside a kit Dialog it closes this panel and not the dialog (BACKLOG-4032).
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const hasSelection = selected.length > 0;
  const triggerLabel = hasSelection ? `${label} (${selected.length})` : label;

  return (
    <div ref={containerRef} data-slot="multi-select" className={cn('relative', className)}>
      <div
        className={cn(
          'inline-flex items-stretch rounded-md border text-sm focus-within:ring-2 focus-within:ring-primary-500',
          hasSelection ? 'border-primary-300 bg-primary-50 text-primary-700' : 'border-gray-300 bg-white text-gray-700'
        )}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn('inline-flex items-center gap-1.5 py-1.5 focus:outline-none', hasSelection ? 'pl-3 pr-1' : 'px-3')}
        >
          <span className="truncate">{triggerLabel}</span>
          {hasSelection ? null : <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />}
        </button>
        {hasSelection ? (
          <button
            type="button"
            aria-label={`Clear ${label} filter`}
            onClick={() => onChange([])}
            className="inline-flex items-center pl-1 pr-2 focus:outline-none"
          >
            <X className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="absolute z-50 mt-1 w-56 rounded-lg bg-white shadow-lg">
          <MultiSelectOptions
            options={options}
            selected={selected}
            onChange={onChange}
            bulkActions={bulkActions}
            size="compact"
            ariaLabel={label}
          />
        </div>
      ) : null}
    </div>
  );
}
