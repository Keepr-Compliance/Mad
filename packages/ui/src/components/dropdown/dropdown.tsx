'use client';

import * as React from 'react';
import { AlertCircle, ChevronDown, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useClickOutside } from '../../lib/use-click-outside';
import { BottomSheet } from '../phone/bottom-sheet';
import { DropdownOptions } from './dropdown-options';
import type { DropdownProps } from './types';

/**
 * Dropdown (BACKLOG-4032): searchable single- or multi-choice picker.
 *
 * `mode="multi"` (slice 4a, popover only): the trigger reads "Label" or
 * "Label (n)" (n = value.length, never the filtered rows) and is named by that
 * text alone. With `onClear` and a non-empty value, a sibling button
 * "Clear <Label> filter" sits at the right of the pill (outside the trigger,
 * inside the wrapper so a press on it is not an outside press) and the
 * chevron hides. A toggle calls onChange and keeps the panel open; Escape and
 * outside presses behave as in single mode and never change the value.
 *
 * `presentation="sheet"` (slice 2): the same field trigger opens a
 * BottomSheet instead of the panel. The sheet is titled by the label, its rows
 * are comfortable, a pick commits and closes, and focus returns to the trigger
 * (BottomSheet `returnFocusRef`). Radix owns Escape and outside presses in
 * sheet mode: the click-outside hook and the window Escape listener below run
 * for the popover only, so one Escape closes the sheet (even with search
 * text) and a tap on a row inside the portal is not an "outside" press.
 *
 * Popover:
 *
 * Inline popover (no portal, no new dependency): a `relative` wrapper and an
 * `absolute z-50` panel under the trigger. An `overflow-hidden` ancestor
 * clips the panel; see README "Dropdown" for where that applies.
 * - The panel opens upward when the viewport has less than PANEL_MAX px
 *   below the trigger and more room above (measured on open), so inside a
 *   fixed, centered kit Dialog near the bottom of the screen it stays on
 *   screen (BACKLOG-4007 People popups).
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
/** Search field + `max-h-60` listbox + borders: the most the panel can need. */
const PANEL_MAX = 300;

/**
 * 'top' when there is less than `panelMax` below the trigger and more room
 * above. `panelMax` defaults to the Dropdown panel's height; a taller popover
 * (the DateRangePicker calendar) passes its own.
 */
export function dropdownSide(
  rect: { top: number; bottom: number },
  viewportHeight: number,
  panelMax: number = PANEL_MAX
): 'top' | 'bottom' {
  const below = viewportHeight - rect.bottom;
  return below < panelMax && rect.top > below ? 'top' : 'bottom';
}

function assignRef<T>(ref: React.Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node);
  else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
}

export function Dropdown<V extends string = string>(props: DropdownProps<V>) {
  const {
    options,
    label,
    ariaLabel,
    id,
    placeholder: placeholderProp,
    searchable = true,
    searchPlaceholder,
    emptyText,
    invalid = false,
    error,
    disabled = false,
    presentation = 'popover',
    variant = 'field',
    triggerIcon,
    triggerRef: externalTriggerRef,
    onClear,
    className,
  } = props;
  const multi = props.mode === 'multi';
  // Multi is popover only (its type has no 'sheet'); guard plain-JS callers too.
  const sheet = !multi && presentation === 'sheet';
  const filter = variant === 'filter';
  // A filter pill with nothing chosen reads as its name ("Period"), not "Select…".
  const placeholder = placeholderProp ?? (filter ? (label ?? ariaLabel) : 'Select…');

  const baseId = React.useId();
  const triggerId = id ?? `${baseId}-trigger`;
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const errorId = `${baseId}-error`;

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [side, setSide] = React.useState<'top' | 'bottom'>('bottom');
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const setTriggerRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      assignRef(externalTriggerRef, node);
    },
    [externalTriggerRef]
  );

  const selected =
    props.mode === 'multi' || props.value === null ? undefined : options.find((o) => o.value === props.value);
  const multiCount = props.mode === 'multi' ? props.value.length : 0;
  const hasValue = multi ? multiCount > 0 : selected !== undefined;
  const nameText = label ?? ariaLabel;
  const triggerText = multi
    ? multiCount > 0
      ? `${nameText} (${multiCount})`
      : placeholder
    : selected
      ? selected.label
      : placeholder;
  const showClear = multi && onClear !== undefined && multiCount > 0;

  const openPanel = React.useCallback(() => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    setSide(rect && typeof window !== 'undefined' ? dropdownSide(rect, window.innerHeight) : 'bottom');
    setQuery('');
    setOpen(true);
  }, [disabled]);

  const close = React.useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const closeFromOutside = React.useCallback(() => close(false), [close]);
  useClickOutside(wrapperRef, closeFromOutside, open && !sheet);

  // Escape: window capture, only while open (see header comment).
  const queryRef = React.useRef(query);
  queryRef.current = query;
  React.useEffect(() => {
    if (!open || sheet) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (queryRef.current !== '') setQuery('');
      else close(true);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, sheet, close]);

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPanel();
    }
  }

  const showError = invalid && Boolean(error);
  // A removable filter (value + onClear) reads blue, like MultiSelect with a selection.
  const filterActive = filter && hasValue && onClear !== undefined;

  return (
    <div
      ref={wrapperRef}
      data-slot="dropdown"
      data-presentation={presentation}
      data-variant={variant}
      className={cn('relative', filter && 'inline-block', className)}
    >
      {label && !filter ? (
        <label id={labelId} htmlFor={triggerId} className="mb-1 block text-sm font-medium text-gray-700">
          {label}
        </label>
      ) : (
        <span id={labelId} className="sr-only">
          {label ?? ariaLabel}
        </span>
      )}
      <div className="relative">
        <button
          ref={setTriggerRef}
          id={triggerId}
          type="button"
          disabled={disabled}
          aria-haspopup={sheet ? 'dialog' : 'listbox'}
          aria-expanded={open}
          // Multi: named by the pill text alone ("Organization (2)"); single keeps "Label Value".
          aria-labelledby={multi ? valueId : `${labelId} ${valueId}`}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={showError ? errorId : undefined}
          onClick={() => (open ? close(false) : openPanel())}
          onKeyDown={onTriggerKeyDown}
          className={
            filter
              ? cn(
                  'inline-flex items-center gap-1.5 rounded-md border py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                  showClear ? 'pl-3 pr-7' : 'px-3',
                  filterActive ? 'border-primary-300 bg-primary-50 text-primary-700' : 'border-gray-300 bg-white text-gray-700',
                  invalid && 'border-danger-600 ring-1 ring-danger-600',
                  disabled && 'cursor-not-allowed bg-gray-100 text-gray-400'
                )
              : cn(
                  'flex min-h-9 w-full items-center gap-2 rounded-md border bg-white py-1.5 text-left text-sm text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                  showClear ? 'pl-3 pr-8' : 'px-3',
                  invalid ? 'border-danger-600 ring-1 ring-danger-600' : 'border-gray-300',
                  open && !invalid && 'border-primary-500 ring-2 ring-primary-500',
                  disabled && 'cursor-not-allowed bg-gray-100 text-gray-400'
                )
          }
        >
          {triggerIcon ? (
            <span className="inline-flex flex-shrink-0 text-gray-500" aria-hidden="true">
              {triggerIcon}
            </span>
          ) : null}
          <span
            id={valueId}
            data-placeholder={hasValue ? undefined : ''}
            className={cn(filter ? 'truncate' : 'min-w-0 flex-1 truncate', !hasValue && 'text-muted-foreground')}
          >
            {triggerText}
          </span>
          {showClear ? null : (
            <ChevronDown
              className={cn('flex-shrink-0', filter ? 'h-3.5 w-3.5' : 'h-4 w-4 text-gray-500')}
              aria-hidden="true"
            />
          )}
        </button>
        {showClear ? (
          <button
            type="button"
            data-slot="dropdown-clear"
            aria-label={`Clear ${nameText} filter`}
            disabled={disabled}
            onClick={() => {
              onClear?.();
              triggerRef.current?.focus();
            }}
            className={cn(
              'absolute top-1/2 inline-flex -translate-y-1/2 items-center rounded p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
              filter ? 'right-2 text-primary-700' : 'right-2.5 text-gray-500'
            )}
          >
            <X className={filter ? 'h-3.5 w-3.5' : 'h-4 w-4'} aria-hidden="true" />
          </button>
        ) : null}
        {open && !sheet ? (
          <div
            data-slot="dropdown-panel"
            data-side={side}
            className={cn(
              'absolute z-50 rounded-lg bg-white shadow-lg',
              filter ? 'w-max min-w-56' : 'w-full',
              side === 'top' ? 'bottom-full mb-1' : 'mt-1'
            )}
          >
            <DropdownOptions<V>
              {...(props.mode === 'multi'
                ? { mode: 'multi' as const, value: props.value, onChange: props.onChange }
                : {
                    value: props.value,
                    onSelect: (v: V) => {
                      props.onChange(v);
                      close(true);
                    },
                  })}
              options={options}
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
      </div>
      {sheet ? (
        <BottomSheet
          open={open}
          onOpenChange={(next) => (next ? openPanel() : close(false))}
          title={nameText ?? ''}
          returnFocusRef={triggerRef}
          fixedHeight
        >
          <DropdownOptions<V>
            options={options}
            value={props.value}
            onSelect={(v) => {
              props.onChange(v);
              close(false);
            }}
            ariaLabel={nameText ?? ''}
            searchable={searchable}
            searchPlaceholder={searchPlaceholder}
            emptyText={emptyText}
            query={query}
            onQueryChange={setQuery}
            size="comfortable"
            fill
            autoFocus
          />
        </BottomSheet>
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
