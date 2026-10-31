'use client';

import * as React from 'react';
import { Calendar } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Dropdown } from '../dropdown/dropdown';
import { DateRangePicker } from '../date-range/date-range-picker';

/**
 * Report kit — the period picker (BACKLOG-3502a; restyled in BACKLOG-4032
 * slice 3). Props and the onChange signature are unchanged.
 *
 * Two pills: the Period pill (kit Dropdown, filter variant) holds the quick
 * picks; a range pill (DateRangePicker) shows only for the custom period.
 *
 * - A preset pick calls `onChange(key, from, to)` at once.
 * - Picking the custom option fires NOTHING: it opens the calendar. One
 *   `onChange(customKey, from, to)` follows on Apply, always with both dates.
 *   (Before slice 3 the pick itself reported `customKey` with no dates; the
 *   report page resolved that to its default period and the select snapped
 *   back.) Cancel / Escape / an outside press put the Period pill back on the
 *   previous period and fire nothing.
 * - After Apply the pills hold the applied range until the parent's props
 *   change (the report's router round trip is asynchronous).
 *
 * Period definitions (labels, how a key resolves to dates) stay with the
 * caller; this only renders them.
 */
export interface PeriodOption<K extends string> {
  value: K;
  label: string;
}

export interface PeriodPickerProps<K extends string> {
  options: readonly PeriodOption<K>[];
  value: K;
  /** The option that shows the From / To inputs. Omit for no custom range. */
  customKey?: K;
  from?: string;
  to?: string;
  onChange: (value: K, from?: string, to?: string) => void;
  /** Accessible name of the select. Default "Period". */
  ariaLabel?: string;
  className?: string;
}

interface Applied {
  from: string;
  to: string;
}

export function PeriodPicker<K extends string>({
  options,
  value,
  customKey,
  from,
  to,
  onChange,
  ariaLabel = 'Period',
  className,
}: PeriodPickerProps<K>) {
  const periodTriggerRef = React.useRef<HTMLButtonElement>(null);
  /** Custom was picked from a preset; the calendar is open and nothing has fired. */
  const [pendingCustom, setPendingCustom] = React.useState(false);
  const [rangeOpen, setRangeOpen] = React.useState(false);
  /** The range just applied, shown until the props change (R4). */
  const [applied, setApplied] = React.useState<Applied | null>(null);

  // Drop the held range as soon as the parent reports anything new.
  const propsKey = `${value}|${from ?? ''}|${to ?? ''}`;
  const [seenProps, setSeenProps] = React.useState(propsKey);
  if (seenProps !== propsKey) {
    setSeenProps(propsKey);
    setApplied(null);
  }

  const hasCustom = customKey !== undefined;
  const showingCustom = hasCustom && (applied !== null || pendingCustom || value === customKey);
  const shownValue = showingCustom ? (customKey as K) : value;
  const range = applied ?? { from, to };

  function pick(next: K) {
    if (hasCustom && next === customKey) {
      if (value !== customKey && applied === null) setPendingCustom(true);
      setRangeOpen(true);
      return;
    }
    setPendingCustom(false);
    setApplied(null);
    setRangeOpen(false);
    onChange(next, from, to);
  }

  return (
    <span data-slot="period-picker" className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      <Dropdown<K>
        variant="filter"
        ariaLabel={ariaLabel}
        options={options}
        value={shownValue}
        onChange={pick}
        searchable={false}
        triggerIcon={<Calendar className="h-4 w-4" />}
        triggerRef={periodTriggerRef}
      />
      {showingCustom ? (
        <DateRangePicker
          ariaLabel={options.find((o) => o.value === customKey)?.label ?? 'Custom range'}
          value={range}
          open={rangeOpen}
          onOpenChange={(next) => {
            setRangeOpen(next);
            if (!next) setPendingCustom(false);
          }}
          // A cancelled pending Custom removes this pill: send focus back to the Period pill.
          returnFocusRef={pendingCustom ? periodTriggerRef : undefined}
          onChange={(r) => {
            setApplied(r);
            setPendingCustom(false);
            onChange(customKey as K, r.from, r.to);
          }}
        />
      ) : null}
    </span>
  );
}
