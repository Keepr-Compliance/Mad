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
 * Chart colors are the validated data-viz steps (single-series blue, status
 * critical red), checked against the white card surface: all six checks pass.
 */

import {
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  formatCount,
  formatMinutes,
  formatMinutesLabel,
  longestPhase,
  ratioToBaseline,
  STALL_THRESHOLD_MINUTES,
  type IphoneSyncReportModel,
  type OutcomeTone,
  type SyncRun,
} from '@/lib/reports/iphone-sync';

/** Validated against the white card surface — see BACKLOG-3441 notes. */
const BAR_COLOR = '#2a78d6';
const BAR_COLOR_CRITICAL = '#d03b3b';

const OUTCOME_ICON: Record<OutcomeTone, LucideIcon> = {
  good: CheckCircle2,
  critical: XCircle,
  warning: MinusCircle,
  neutral: MinusCircle,
};

const OUTCOME_CHIP: Record<OutcomeTone, string> = {
  good: 'text-green-700 bg-green-50 border-green-200',
  critical: 'text-red-700 bg-red-50 border-red-200',
  warning: 'text-amber-700 bg-amber-50 border-amber-200',
  neutral: 'text-gray-700 bg-gray-50 border-gray-200',
};

function OutcomeChip({ run }: { run: SyncRun }) {
  const Icon = OUTCOME_ICON[run.outcomeTone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${OUTCOME_CHIP[run.outcomeTone]}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {run.outcome}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{value}</p>
    </div>
  );
}

/**
 * Horizontal bar chart: one row per phase, one hue, value labelled on every
 * row (the durations are the data). Single series, so no legend — the row
 * label carries identity.
 */
function PhaseChart({ run }: { run: SyncRun }) {
  if (run.phases.length === 0) {
    return (
      <p className="mt-4 text-sm text-gray-500">
        No phase timings were recorded for this run — it ended before the first phase reported.
      </p>
    );
  }

  return (
    <div className="mt-4">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
        Where the time went
      </p>
      <div className="space-y-1.5">
        {run.phases.map((phase) => {
          const flagged = run.stalled && phase.isLast;
          return (
            <div
              key={`${run.id}-${phase.key}`}
              className="grid grid-cols-[minmax(0,14rem)_1fr_5.5rem] items-center gap-3"
            >
              <span className="truncate text-xs text-gray-700" title={phase.key}>
                {phase.label}
              </span>
              <div className="h-2.5 w-full rounded-sm bg-gray-100">
                <div
                  className="h-2.5 rounded-r-[4px]"
                  style={{
                    width: `${phase.widthPct}%`,
                    backgroundColor: flagged ? BAR_COLOR_CRITICAL : BAR_COLOR,
                  }}
                />
              </div>
              <span className="text-right text-xs tabular-nums text-gray-700">
                {phase.durationLabel}
                {phase.sharePct >= 10 ? (
                  <span className="ml-1 text-gray-400">{Math.round(phase.sharePct)}%</span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {run.stalled && run.lastPhaseLabel ? (
        <p className="mt-2 text-xs font-medium text-red-700">
          Stopped in: {run.lastPhaseLabel} — nothing after it ran.
        </p>
      ) : null}
    </div>
  );
}

function RunCard({ run }: { run: SyncRun }) {
  return (
    <div
      className={`rounded-lg border bg-white p-5 shadow-sm ${
        run.stalled ? 'border-red-300 border-l-4 border-l-red-500' : 'border-gray-200'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-gray-900">{run.userLabel}</span>
            <OutcomeChip run={run} />
            {run.stalled ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                Stalled
              </span>
            ) : null}
            {run.isDevBuild ? (
              <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs font-medium text-gray-600">
                dev build
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {run.whenUtc} · {run.deviceLabel} · {run.platform} · Keepr {run.appVersion}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tabular-nums text-gray-900">{run.durationLabel}</p>
          <p className="text-xs tabular-nums text-gray-500">
            {formatMinutesLabel(run.elapsedMs)}
          </p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-gray-500">Device used</dt>
          <dd className="tabular-nums text-gray-900">
            {run.deviceUsedGb == null ? '—' : `${run.deviceUsedGb.toFixed(1)} GB`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Minutes per GB</dt>
          <dd className="tabular-nums text-gray-900">{run.minPerGbLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Messages extracted</dt>
          <dd className="tabular-nums text-gray-900">
            {run.messagesExtracted == null || run.messagesExtracted === 0 ? (
              <span className={run.stalled ? 'font-medium text-red-700' : 'text-gray-900'}>none</span>
            ) : (
              formatCount(run.messagesExtracted)
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Backup written</dt>
          <dd className="tabular-nums text-gray-900">
            {run.backupUnmeasured
              ? 'not measured'
              : run.backupGb == null
                ? '—'
                : `${run.backupGb.toFixed(1)} GB`}
          </dd>
        </div>
      </dl>

      <PhaseChart run={run} />
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
              nothing. Runs that die without writing a row are not counted here — see the limits
              below.
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
