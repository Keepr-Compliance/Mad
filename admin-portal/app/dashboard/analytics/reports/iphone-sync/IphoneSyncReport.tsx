/**
 * iPhone Sync Performance — presentation (BACKLOG-3441)
 *
 * Deliberately a SYNCHRONOUS component with no data fetching, so the whole
 * report can be rendered to a string in a test and asserted on. The page
 * fetches; this renders.
 *
 * Nothing on this page is behind a click, a hover or a filter. The phase
 * breakdown — the field that actually diagnosed the 2026-09-16 incident — is
 * rendered expanded on every run.
 *
 * The per-run card and its phase chart live in `./RunCard`.
 */

import { AlertTriangle, ShieldCheck } from 'lucide-react';
import {
  formatMinutes,
  longestPhase,
  ratioToBaseline,
  STALL_THRESHOLD_MINUTES,
  type IphoneSyncReportModel,
} from '@/lib/reports/iphone-sync';
import { RunCard } from './RunCard';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{value}</p>
    </div>
  );
}

function StalledBanner({ report }: { report: IphoneSyncReportModel }) {
  const { stalled, baseline } = report;

  if (stalled.length === 0) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-green-700" aria-hidden="true" />
          <div>
            <h2 className="font-semibold text-green-900">No stalled runs on record</h2>
            <p className="mt-1 text-sm text-green-800">
              No recorded run lasted {STALL_THRESHOLD_MINUTES} minutes or longer and extracted
              nothing. Runs that have not reached an end are excluded rather than counted as
              though they had resolved — see the limits below.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const worst = stalled[0];

  return (
    <div className="rounded-lg border-2 border-red-300 bg-red-50 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-red-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-red-900">
            {stalled.length} {stalled.length === 1 ? 'run' : 'runs'} burned{' '}
            {STALL_THRESHOLD_MINUTES} minutes or more and extracted nothing
          </h2>
          <p className="mt-1 text-sm text-red-800">
            The worst ran <strong>{worst.durationLabel}</strong> and produced no messages.
          </p>

          <ul className="mt-4 space-y-3">
            {stalled.map((run) => {
              const ratio = ratioToBaseline(run, baseline);
              const worstPhase = longestPhase(run);
              return (
                <li key={run.id} className="rounded-md border border-red-200 bg-white p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-3xl font-bold tabular-nums text-red-700">
                      {run.durationLabel}
                    </span>
                    <span className="text-sm text-gray-600">
                      {run.userLabel} · {run.whenUtc} · {run.outcome}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-gray-800">
                    {run.elapsedMs == null ? '—' : `${formatMinutes(run.elapsedMs)} minutes`}
                    {run.deviceUsedGb == null
                      ? ' on a device of unknown size'
                      : ` for ${run.deviceUsedGb.toFixed(1)} GB on the phone`}
                    {run.minPerGb == null ? '' : ` — ${run.minPerGbLabel}`}
                    {ratio == null || baseline.medianMinPerGb == null
                      ? '.'
                      : `, ${ratio.toFixed(1)}× the ${baseline.medianMinPerGb.toFixed(
                          1
                        )} min/GB median of the ${baseline.sampleSize} completed ${
                          baseline.sampleSize === 1 ? 'run' : 'runs'
                        }.`}
                  </p>
                  {worstPhase ? (
                    <p className="mt-1 text-sm text-gray-800">
                      Last phase reached: <strong>{run.lastPhaseLabel}</strong>. Longest phase:{' '}
                      <strong>{worstPhase.label}</strong> at {worstPhase.durationLabel}.
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-gray-800">
                      No phase timings were recorded, so where the time went is not known for this
                      run.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

function LimitsCard({ report }: { report: IphoneSyncReportModel }) {
  const { baseline, totalRuns } = report;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900">
        What this report can and cannot tell you
      </h2>
      <ul className="mt-3 space-y-2 text-sm text-gray-700">
        <li>
          <strong>Only runs that reached an end are shown.</strong> Since BACKLOG-3440 a sync writes
          a row when it starts and keeps it current while it runs, so a sync that is killed, crashes
          or loses power does leave evidence — but that row stays{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">running</code> for good, and
          every number on this page reads a row as a finished run. Runs in flight are excluded here
          rather than counted as though they had resolved; showing them is separate work.
        </li>
        <li>
          <strong>{totalRuns} runs in total is too few for averages or percentiles.</strong> Counts
          and individual runs are shown on purpose; there is no trend line, no p95, and no average
          duration, because at this sample size those numbers would be decorative.
        </li>
        <li>
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
          )}
        </li>
        <li>
          <strong>A finished run is flagged when it lasted {STALL_THRESHOLD_MINUTES} minutes or more
          and extracted no messages.</strong> The rule ignores which end it reached on purpose: a run
          that says <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">complete</code> and
          produces nothing is just as broken as one that says{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">cancelled</code>. A sync still
          working is not judged by it — half an hour in with nothing stored yet is the normal shape
          of a first sync.
        </li>
      </ul>
    </div>
  );
}

export function IphoneSyncReport({ report }: { report: IphoneSyncReportModel }) {
  return (
    <div className="space-y-6">
      <StalledBanner report={report} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Finished runs" value={String(report.totalRuns)} />
        <Stat label="Completed" value={String(report.counts.complete)} />
        <Stat label="Cancelled" value={String(report.counts.cancelled)} />
        <Stat label="Errored" value={String(report.counts.error)} />
      </div>

      <LimitsCard report={report} />

      <section>
        <h2 className="mb-3 text-base font-semibold text-gray-900">
          Every finished run, newest first
        </h2>
        {report.runs.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-sm">
            <p className="font-medium text-gray-900">No iPhone syncs have reported yet</p>
            <p className="mx-auto mt-1 max-w-xl text-sm text-gray-500">
              Nothing has written a row to <code className="text-xs">sync_outcomes</code> from an
              iPhone backup. That means either no one has run one, or every attempt died before it
              could report.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {report.runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
