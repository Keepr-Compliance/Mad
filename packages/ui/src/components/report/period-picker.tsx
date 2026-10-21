'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Report kit — the period select, with From / To date inputs that appear
 * ONLY while the custom period is selected (BACKLOG-3502a).
 *
 * The date inputs commit, they do not stream: `onChange` fires when an input
 * holds a complete date (YYYY-MM-DD) or when it loses focus — never for the
 * empty / partial values a browser reports while someone is still typing.
 * A period change usually re-queries the server, so a call per keystroke
 * would be a round trip per keystroke.
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

const CONTROL =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500';

const COMPLETE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function DateInput({
  label,
  committed,
  onCommit,
}: {
  label: string;
  committed: string | undefined;
  onCommit: (value: string | undefined) => void;
}) {
  const [draft, setDraft] = React.useState(committed ?? '');
  React.useEffect(() => setDraft(committed ?? ''), [committed]);

  function commit(next: string) {
    const normalised = next.length > 0 ? next : undefined;
    if (normalised !== committed) onCommit(normalised);
  }

  return (
    <input
      type="date"
      aria-label={label}
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (COMPLETE_DATE.test(next)) commit(next);
      }}
      onBlur={() => commit(draft)}
      className={CONTROL}
    />
  );
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
  const custom = customKey !== undefined && value === customKey;
  return (
    <span data-slot="period-picker" className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value as K, from, to)}
        className={CONTROL}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {custom ? (
        <span className="flex items-center gap-2">
          <DateInput label="From" committed={from} onCommit={(next) => onChange(customKey, next, to)} />
          <span className="text-sm text-gray-400">to</span>
          <DateInput label="To" committed={to} onCommit={(next) => onChange(customKey, from, next)} />
        </span>
      ) : null}
    </span>
  );
}
