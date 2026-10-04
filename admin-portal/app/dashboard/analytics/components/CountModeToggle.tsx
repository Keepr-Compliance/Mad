'use client';

/**
 * CountModeToggle — how the analytics cards attribute a user to a bucket.
 *
 * ONE SHARED SETTING, TWO CONTROLS (BACKLOG-3201). Both the Version card and
 * the Platform card render this toggle, and both read and write the same `mode`
 * URL parameter. That is deliberate: a page that says "100% adoption" in one
 * card and ">100%" in the next, with no visible reason, is the confusion this
 * item exists to remove. Because there is a single source of truth in the URL,
 * the two controls cannot disagree, and neither can a card's chart and its
 * table — the server component refetches and re-renders both from one dataset.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import type { CountMode } from '@/lib/analytics-queries';

export const DEFAULT_COUNT_MODE: CountMode = 'recent';

const MODES: { mode: CountMode; label: string }[] = [
  { mode: 'recent', label: 'Most recent' },
  { mode: 'cumulative', label: 'Cumulative' },
];

/** Parse the `mode` search param, falling back to the default. */
export function parseCountMode(value: string | undefined): CountMode {
  return value === 'cumulative' ? 'cumulative' : DEFAULT_COUNT_MODE;
}

export function CountModeToggle({ activeMode }: { activeMode: CountMode }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const setMode = (mode: CountMode) => {
    const params = new URLSearchParams(searchParams.toString());
    if (mode === DEFAULT_COUNT_MODE) {
      params.delete('mode');
    } else {
      params.set('mode', mode);
    }
    const query = params.toString();
    router.push(query ? `?${query}` : '?', { scroll: false });
  };

  return (
    <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5 w-fit">
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          onClick={() => setMode(m.mode)}
          aria-pressed={activeMode === m.mode}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            activeMode === m.mode
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The one-line explanation that sits beside the toggle.
 *
 * The cumulative wording is precise on purpose: cumulative counts a user once
 * under EACH bucket they have an active device in, so two Macs are still one
 * macOS user while a Mac and a PC are one of each. "Every device counted" would
 * read better and be false.
 */
export function countModeCaption(mode: CountMode, unit: 'version' | 'platform'): string {
  return mode === 'cumulative'
    ? `Counting every ${unit} a user has an active device on — someone running two ${unit === 'version' ? 'versions' : 'platforms'} is counted under both, so the total can exceed 100%.`
    : `Counting each user once, under the ${unit} of their most recently seen active device.`;
}
