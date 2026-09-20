/**
 * "How to use this report" (BACKLOG-3450)
 *
 * One collapsed `<details>` in the LimitsCard style, holding what used to be a
 * standing banner plus the limits. The prose is the founder's, transcribed
 * from the approved mockup via the PM answers on BACKLOG-3450 (Q7).
 *
 * The stall headline is NOT here any more — it is the live Stalled tile, which
 * shows its period and its denominator and leads to the rows.
 */

import { STALL_THRESHOLD_MINUTES, type Baseline } from '@/lib/reports/iphone-sync';

function Para({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-700">{children}</p>;
}

export function HowToUse({ baseline, totalRuns }: { baseline: Baseline; totalRuns: number }) {
  return (
    <details className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <summary className="cursor-pointer px-6 py-4 text-base font-semibold text-gray-900">
        How to use this report
      </summary>
      <div className="space-y-3 border-t border-gray-100 px-6 py-4">
        <Para>
          <strong>Stalled</strong> counts finished runs in the period that ran{' '}
          {STALL_THRESHOLD_MINUTES} minutes or more and extracted nothing. It is live, computed from
          the same rows as the table. Click the tile to show only those runs; click a run to see
          which phase ate the time.
        </Para>
        <Para>
          <strong>Filters</strong> narrow the tiles, both charts and the table together. Type,
          Outcome and Platform are multi-select. A run that ended before the backup mode was known
          (most cancels in the first minute) has its type recorded as &ldquo;not recorded&rdquo;.
        </Para>
        <Para>
          <strong>The two charts</strong> follow the period and type you pick. Average duration per
          day shows when syncs started taking longer; failed syncs per day shows when errors or
          cancels started clustering. Hover a day for its runs.
        </Para>
        <Para>
          <strong>Cards are all live:</strong> the five default cards, both charts and the table
          follow the filters. Your own cards come from Views, the same way the PM backlog pins a
          saved view as a gauge: save the current filters with a name, pick a column and a function
          (count, average, sum, min, max), and it appears as a dashed card that follows whichever
          period is selected. Click a card to apply its filters; up to five pinned.
        </Para>
        <Para>
          <strong>Rate</strong> is the backup size divided by the transfer phase, in MB per second,
          where 1 MB is 1,048,576 bytes. The Backup and Device columns count a GB as 1,000,000,000
          bytes, the way the phone does — so dividing one column by the other will not give you the
          Rate column exactly. Only runs that wrote a backup have one today; from 2.38.1 the byte
          counter gives a rate to cancelled and stalled runs too, which is how a slow phone or cable
          will show up.
        </Para>
        <Para>
          <strong>Periods and times.</strong> Weeks start Monday, and every time on this page is
          UTC. A run is counted on the day it <em>ended</em>, so one that crosses midnight lands on
          the later day. From 2.38.1 a run writes its row when it starts rather than when it ends,
          so runs recorded by that build onwards are counted on the day they <em>began</em> — the
          two conventions sit side by side in the same chart with nothing to mark the change.
        </Para>

        <div>
          <p className="mt-2 text-sm font-semibold text-gray-900">What this report can tell you</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-700">
            <li>
              How long each phase took: backup start, waiting for the phone, transferring,
              extracting messages.
            </li>
            <li>
              Whether a run was a first sync or an incremental one, and how much it moved.
            </li>
            <li>
              Which users hit errors or cancels repeatedly, on which app version and platform.
            </li>
          </ul>
        </div>

        <div>
          <p className="mt-2 text-sm font-semibold text-gray-900">What it cannot tell you yet</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-700">
            <li>
              <strong>Runs that died without writing a row.</strong> Until a build with the
              start-of-run record (2.38.1) reaches users, a killed app leaves nothing here.
            </li>
            <li>
              <strong>Whether bytes were still moving during a long transfer.</strong> The byte
              clock ships in 2.38.1.
            </li>
            <li>
              <strong>Why a run failed.</strong> The device&rsquo;s own error code is recorded from
              2.38.1; before that, only the outcome.
            </li>
            <li>
              <strong>Runs still in progress.</strong> They are excluded rather than counted as
              though they had resolved.
            </li>
          </ul>
        </div>

        <Para>
          <strong>Minutes per GB is an observation, not a verdict.</strong> It is whole-run elapsed
          time divided by the bytes the phone reports as used — a proxy for how much there was to
          move, not a measurement of it.{' '}
          {baseline.spread && baseline.sampleSize > 0 ? (
            <>
              The {baseline.sampleSize} completed{' '}
              {baseline.sampleSize === 1 ? 'run spans' : 'runs span'}{' '}
              {baseline.spread.min.toFixed(1)}–{baseline.spread.max.toFixed(1)} min/GB, so treat the
              median as a rough marker rather than an expected value.
            </>
          ) : (
            <>No completed run has both numbers yet, so there is no baseline to compare against.</>
          )}{' '}
          {totalRuns} runs in the selected period is still few enough that counts and individual
          runs are the honest presentation; there is no p95 here on purpose.
        </Para>
      </div>
    </details>
  );
}
