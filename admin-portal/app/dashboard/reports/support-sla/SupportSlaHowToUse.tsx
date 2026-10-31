/**
 * Support SLA report — how to read it (BACKLOG-3721). Collapsed by default.
 *
 * BACKLOG-4086: the targets, the business window and the worked example are
 * rendered from the stored `support_sla_settings` row, never from literals.
 */

import {
  businessDayMinutes,
  firstResponseTargetLabel,
  resolutionTargetLabel,
  type SupportSlaSettings,
} from '@/lib/reports/support-sla';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Minute of the day -> "9:00 AM", "4:59 PM", "midnight". */
export function clockLabel(minuteOfDay: number): string {
  if (minuteOfDay === 0 || minuteOfDay === 1440) return 'midnight';
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** [1,2,3,4,5] -> "Monday to Friday"; [1,3,5] -> "Monday, Wednesday and Friday". */
export function daysLabel(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return 'every day';
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous && sorted.length >= 3) return `${DAY_NAMES[sorted[0]]} to ${DAY_NAMES[sorted[sorted.length - 1]]}`;
  const names = sorted.map((d) => DAY_NAMES[d]);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "America/Los_Angeles" -> "Pacific Time"; an unnamed zone falls back to its id. */
export function zoneLabel(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * The founder's example, from the settings: the last business day before a
 * gap, one minute before close, answered at the next business day's open.
 * With every day a business day there is no gap, so the days are not named.
 */
export function oneMinuteExample(settings: SupportSlaSettings): string {
  const days = new Set(settings.businessDays);
  const open = clockLabel(settings.businessDayStartMinute);
  const lastMinute = clockLabel(settings.businessDayEndMinute - 1);
  const last = [...days].sort((a, b) => a - b).find((d) => !days.has((d + 1) % 7));
  if (last === undefined) {
    return `A ticket opened at ${lastMinute} and answered the next day at ${open} has one minute on the clock.`;
  }
  let next = (last + 1) % 7;
  while (!days.has(next)) next = (next + 1) % 7;
  return `A ticket opened ${DAY_NAMES[last]} at ${lastMinute} and answered ${DAY_NAMES[next]} at ${open} has one minute on the clock.`;
}

/** "8h is one working day and 24h is three." */
function dayLengthSentence(settings: SupportSlaSettings): string {
  const day = businessDayMinutes(settings);
  const dayText = day % 60 === 0 ? `${day / 60}h` : `${Math.floor(day / 60)}h ${day % 60}m`;
  const words = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const n = 1440 / day;
  const tail = Number.isInteger(n) && n > 1 && n < words.length ? ` and 24h is ${words[n]}` : '';
  return `${dayText} is one working day${tail}.`;
}

export function SupportSlaHowToUse({ settings }: { settings: SupportSlaSettings | null }) {
  return (
    <details className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
      <summary className="cursor-pointer font-medium text-gray-900">How to use this report</summary>
      <ul className="mt-3 list-disc space-y-1.5 pl-5">
        {settings ? (
          <>
            <li data-howto="targets">
              Targets: first response within <strong>{firstResponseTargetLabel(settings)}</strong>, resolution
              within <strong>{resolutionTargetLabel(settings)}</strong>.
            </li>
            <li data-howto="window">
              Business hours are {daysLabel(settings.businessDays)}, {clockLabel(settings.businessDayStartMinute)} to{' '}
              {clockLabel(settings.businessDayEndMinute)} {zoneLabel(settings.timeZone)}; the clock pauses outside
              them. {oneMinuteExample(settings)} Holidays are not excluded.
            </li>
          </>
        ) : (
          <li data-howto="targets">The SLA targets could not be read, so times and target rates are not shown.</li>
        )}
        <li>
          <strong>Open now</strong> counts new, assigned, in progress and pending tickets, whatever
          the period. Deleted tickets are never counted anywhere.
        </li>
        <li>
          <strong>Created</strong> and <strong>Avg first response</strong> use tickets created in the
          period. A ticket with no reply yet is left out of the average.
        </li>
        <li>
          <strong>Resolved</strong> and <strong>Avg resolution</strong> use tickets resolved or closed
          in the period. A ticket closed without a resolved time counts at its closed time.
        </li>
        <li>
          The <strong>within target</strong> rates use tickets created in the period. A ticket with no
          reply, or not yet resolved, that is still inside its target is awaiting and left out of the
          rate; once past the target it counts as missed.
        </li>
        <li>
          A ticket resolved or closed with no agent reply has no first response and counts as missed.
          Internal notes are not replies.
        </li>
        <li data-howto="clock">
          Every time on this page is business time{settings ? `: ${dayLengthSentence(settings)}` : '.'} Median:
          half the tickets were at or under it; p90: nine in ten were.
        </li>
        <li>Tickets with no assignee count in the cards but have no agent row.</li>
        <li>Days are UTC (period bounds). This week starts on Monday.</li>
      </ul>
    </details>
  );
}
