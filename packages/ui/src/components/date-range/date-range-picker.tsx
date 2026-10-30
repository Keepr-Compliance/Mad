'use client';

import * as React from 'react';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useClickOutside } from '../../lib/use-click-outside';
import { Button } from '../button';
import { dropdownSide } from '../dropdown/dropdown';
import {
  addDays,
  addMonths,
  addYears,
  endOfWeek,
  formatDay,
  formatDayLong,
  formatMonth,
  formatRange,
  isIsoDay,
  localToday,
  monthGrid,
  monthKey,
  monthOf,
  startOfWeek,
  WEEK_STARTS_ON,
  WEEKDAYS_LONG,
  type IsoDay,
} from './calendar';

/**
 * DateRangePicker (BACKLOG-4032 slice 3): a pill that opens a two-month
 * calendar. Nothing applies until Apply.
 *
 * - Values are `YYYY-MM-DD` calendar days (see ./calendar.ts for the time-zone
 *   rule). `onChange` fires once, on Apply, always with a complete range,
 *   `from <= to`. A reversed range cannot be drafted: a second pick before the
 *   start becomes the new start.
 * - Cancel, Escape, an outside press, or Tab past the last control (Shift+Tab
 *   before the first) discard the draft and close. Escape / Cancel / Tab return
 *   focus (`returnFocusRef`, else the trigger); an outside press leaves focus
 *   where the user clicked.
 * - Escape is caught by a window keydown listener in CAPTURE phase while open
 *   (same as Dropdown), so inside a kit Dialog only the picker closes.
 * - Grid: WAI-ARIA APG date-picker grid. The focusable day IS the gridcell
 *   (roving tabindex across both months). Arrows = day / week, Home / End =
 *   week start / end (Monday-first, matching the reports' "This week"),
 *   PageUp / PageDown = month, Shift+PageUp / PageDown = year, Enter / Space
 *   pick.
 * - Inline popover like Dropdown (no portal): an `overflow-hidden` ancestor
 *   clips it.
 */
export interface DateRangeValue {
  from?: string;
  to?: string;
}

export interface DateRangePickerProps {
  /** The committed range. */
  value: DateRangeValue;
  /** Apply only. Always complete, `from <= to`. */
  onChange: (range: { from: string; to: string }) => void;
  /** Accessible name of the trigger and the calendar dialog. Default "Date range". */
  ariaLabel?: string;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where focus goes on Cancel / Escape / Tab-out. Default: this picker's trigger. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  className?: string;
  /** RESERVED (not built): single-date mode. */
  mode?: 'range';
  /** RESERVED (not rendered): preset column inside the panel. */
  presets?: readonly unknown[];
  /** RESERVED: only 'popover' is built; a phone sheet comes with a phone consumer. */
  presentation?: 'popover';
  /** RESERVED (ignored until a caller needs it): earliest pickable day. */
  min?: string;
  /** RESERVED (ignored until a caller needs it): latest pickable day. */
  max?: string;
  /** RESERVED (ignored): the grid is Monday-first. */
  weekStartsOn?: 0 | 1;
  /** RESERVED (ignored): trigger text with no range is "Pick dates". */
  placeholder?: string;
}

/** Two months + header + footer: the most the panel can need (for the up/down flip). */
const PANEL_MAX = 420;
/** Two months side by side; right-align the panel when it would run off the right edge. */
const PANEL_WIDTH = 600;

const PILL =
  'inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500';

const HEADER_DAYS = Array.from({ length: 7 }, (_, i) => (WEEK_STARTS_ON + i) % 7);

function committedRange(value: DateRangeValue): DateRangeValue {
  const { from, to } = value;
  if (isIsoDay(from) && isIsoDay(to) && from <= to) return { from, to };
  return {};
}

function draftText(draft: DateRangeValue): string {
  if (draft.from && draft.to) return formatRange(draft.from, draft.to);
  if (draft.from) return `${formatDay(draft.from)} – pick an end date`;
  return 'Pick a start date';
}

export function DateRangePicker({
  value,
  onChange,
  ariaLabel = 'Date range',
  open: openProp,
  onOpenChange,
  returnFocusRef,
  className,
}: DateRangePickerProps) {
  const baseId = React.useId();
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;

  const [openState, setOpenState] = React.useState(false);
  const isOpen = openProp ?? openState;

  const [draft, setDraft] = React.useState<DateRangeValue>({});
  const [focusDay, setFocusDay] = React.useState<IsoDay>(() => localToday());
  const [viewStart, setViewStart] = React.useState<IsoDay>(() => monthOf(localToday()));
  const [side, setSide] = React.useState<'top' | 'bottom'>('bottom');
  const [alignRight, setAlignRight] = React.useState(false);

  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  /** Move DOM focus to `focusDay` after the next render (open, keyboard move). */
  const pendingFocus = React.useRef(false);

  // Reset the draft, the focused day and the visible months each time the panel opens
  // (state-from-props pattern, so a controlled `open` gets the same reset in the same render).
  // Starts false so a picker MOUNTED open (PeriodPicker on picking Custom) is reset too.
  const [wasOpen, setWasOpen] = React.useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      const start = committedRange(value);
      const day = start.from ?? localToday();
      setDraft(start);
      setFocusDay(day);
      setViewStart(monthOf(day));
      pendingFocus.current = true;
    }
  }

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setOpenState(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange]
  );

  const close = React.useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus) (returnFocusRef?.current ?? triggerRef.current)?.focus();
    },
    [setOpen, returnFocusRef]
  );

  // Placement, measured each time it opens.
  React.useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSide(dropdownSide(rect, window.innerHeight, PANEL_MAX));
    setAlignRight(rect.left + PANEL_WIDTH > window.innerWidth);
  }, [isOpen]);

  // Focus the roving day after open / keyboard moves. Runs after the Dropdown
  // (PeriodPicker) has returned focus to its own trigger, so the grid wins.
  React.useEffect(() => {
    if (!isOpen || !pendingFocus.current) return;
    pendingFocus.current = false;
    panelRef.current?.querySelector<HTMLElement>(`[data-date="${focusDay}"]`)?.focus();
  });

  const closeFromOutside = React.useCallback(() => close(false), [close]);
  useClickOutside(wrapperRef, closeFromOutside, isOpen);

  React.useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close(true);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, close]);

  const secondMonth = addMonths(viewStart, 1);
  const lastVisible = addDays(addMonths(viewStart, 2), -1);

  function moveFocus(next: IsoDay) {
    setFocusDay(next);
    if (next < viewStart) setViewStart(monthOf(next));
    else if (next > lastVisible) setViewStart(addMonths(monthOf(next), -1));
    pendingFocus.current = true;
  }

  function shiftView(months: number) {
    const nextStart = addMonths(viewStart, months);
    setViewStart(nextStart);
    // Keep the roving day inside the visible months.
    const nextEnd = addDays(addMonths(nextStart, 2), -1);
    if (focusDay < nextStart || focusDay > nextEnd) setFocusDay(addMonths(focusDay, months));
  }

  function pick(day: IsoDay) {
    setDraft((d) => {
      if (!d.from || d.to) return { from: day };
      if (day >= d.from) return { from: d.from, to: day };
      return { from: day };
    });
    setFocusDay(day);
  }

  function apply() {
    if (!draft.from || !draft.to) return;
    onChange({ from: draft.from, to: draft.to });
    close(false);
    triggerRef.current?.focus();
  }

  function onGridKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    let next: IsoDay | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        next = addDays(focusDay, -1);
        break;
      case 'ArrowRight':
        next = addDays(focusDay, 1);
        break;
      case 'ArrowUp':
        next = addDays(focusDay, -7);
        break;
      case 'ArrowDown':
        next = addDays(focusDay, 7);
        break;
      case 'Home':
        next = startOfWeek(focusDay);
        break;
      case 'End':
        next = endOfWeek(focusDay);
        break;
      case 'PageUp':
        next = e.shiftKey ? addYears(focusDay, -1) : addMonths(focusDay, -1);
        break;
      case 'PageDown':
        next = e.shiftKey ? addYears(focusDay, 1) : addMonths(focusDay, 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        pick(focusDay);
        return;
      default:
        return;
    }
    e.preventDefault();
    moveFocus(next);
  }

  // Tab-out (not focusout: a month shift unmounts the focused day and would close it).
  const applyDisabled = !draft.from || !draft.to;
  function onPanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const target = e.target as HTMLElement;
    const slot = target.getAttribute('data-picker-slot');
    const last = applyDisabled ? 'cancel' : 'apply';
    if ((!e.shiftKey && slot === last) || (e.shiftKey && slot === 'prev')) close(true);
  }

  const committed = committedRange(value);
  const triggerText = committed.from && committed.to ? formatRange(committed.from, committed.to) : 'Pick dates';
  const today = localToday();

  function renderMonth(monthStart: IsoDay, position: 'first' | 'second') {
    const headingId = `${baseId}-${monthKey(monthStart)}-heading`;
    return (
      <div key={monthKey(monthStart)} data-month={monthKey(monthStart)} className="min-w-[16rem] flex-1">
        <div className="mb-2 flex h-8 items-center justify-between">
          {position === 'first' ? (
            <button
              type="button"
              data-picker-slot="prev"
              aria-label="Previous month"
              onClick={() => shiftView(-1)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <span className="h-8 w-8" />
          )}
          <div id={headingId} aria-live="polite" className="text-sm font-medium text-gray-900">
            {formatMonth(monthStart)}
          </div>
          {position === 'second' ? (
            <button
              type="button"
              data-picker-slot="next"
              aria-label="Next month"
              onClick={() => shiftView(1)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <span className="h-8 w-8" />
          )}
        </div>
        <table role="grid" aria-labelledby={headingId} className="w-full border-collapse" onKeyDown={onGridKeyDown}>
          <thead>
            <tr>
              {HEADER_DAYS.map((wd) => (
                <th
                  key={wd}
                  scope="col"
                  role="columnheader"
                  abbr={WEEKDAYS_LONG[wd]}
                  className="h-8 w-9 text-center text-xs font-medium text-gray-500"
                >
                  {WEEKDAYS_LONG[wd][0]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthGrid(monthStart).map((week, i) => (
              <tr key={i}>
                {week.map((day, j) => {
                  if (!day) return <td key={`x${j}`} role="gridcell" className="h-9 w-9" />;
                  const isStart = day === draft.from;
                  const isEnd = day === draft.to;
                  const inside = Boolean(draft.from && draft.to && day > draft.from && day < draft.to);
                  const selected = isStart || isEnd || inside;
                  return (
                    <td
                      key={day}
                      role="gridcell"
                      data-date={day}
                      tabIndex={day === focusDay ? 0 : -1}
                      aria-selected={selected}
                      aria-current={day === today ? 'date' : undefined}
                      aria-label={formatDayLong(day)}
                      onClick={() => pick(day)}
                      onFocus={() => setFocusDay(day)}
                      className={cn(
                        'h-9 w-9 cursor-pointer select-none text-center text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                        isStart || isEnd
                          ? 'rounded-md bg-primary-600 font-medium text-white'
                          : inside
                            ? 'bg-primary-50 text-primary-700'
                            : 'rounded-md text-gray-900 hover:bg-gray-100',
                        day === today && !(isStart || isEnd) && 'ring-1 ring-inset ring-primary-300'
                      )}
                    >
                      {Number(day.slice(8))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} data-slot="date-range-picker" className={cn('relative inline-block', className)}>
      <span id={labelId} className="sr-only">
        {ariaLabel}
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => (isOpen ? close(false) : setOpen(true))}
        className={PILL}
      >
        <Calendar className="h-4 w-4 flex-shrink-0 text-gray-500" aria-hidden="true" />
        <span id={valueId} className="truncate">
          {triggerText}
        </span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      </button>
      {isOpen ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label={ariaLabel}
          data-slot="date-range-panel"
          data-side={side}
          data-align={alignRight ? 'right' : 'left'}
          onKeyDown={onPanelKeyDown}
          className={cn(
            'absolute z-50 w-max max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-3 shadow-lg',
            side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
            alignRight ? 'right-0' : 'left-0'
          )}
        >
          <div className="flex flex-wrap gap-4">
            {renderMonth(viewStart, 'first')}
            {renderMonth(secondMonth, 'second')}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-gray-100 pt-3">
            <span data-slot="date-range-draft" aria-live="polite" className="text-sm text-gray-700">
              {draftText(draft)}
            </span>
            <span className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" data-picker-slot="cancel" onClick={() => close(true)}>
                Cancel
              </Button>
              <Button type="button" size="sm" data-picker-slot="apply" disabled={applyDisabled} onClick={apply}>
                Apply
              </Button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
