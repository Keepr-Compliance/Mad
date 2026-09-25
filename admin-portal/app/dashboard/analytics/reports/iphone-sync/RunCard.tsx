/**
 * iPhone Sync Performance — the per-run detail card (BACKLOG-3441, BACKLOG-3450)
 *
 * Extracted verbatim from `IphoneSyncReport.tsx` so the run table's row detail
 * and any future consumer share ONE definition of what a run looks like. No
 * data fetching and no state: hand it a `SyncRun` and it renders.
 */

import { AlertTriangle, CheckCircle2, MinusCircle, XCircle, type LucideIcon } from 'lucide-react';
import {
  endedByLabel,
  formatCount,
  formatGb,
  formatMinutesLabel,
  formatUtc,
  phaseLabel,
  reasonCodeLabel,
  type OutcomeTone,
  type SyncRun,
} from '@/lib/reports/iphone-sync';

/** Validated against the white card surface — see BACKLOG-3441 notes. */
export const BAR_COLOR = '#2a78d6';
export const BAR_COLOR_CRITICAL = '#d03b3b';

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

export function OutcomeChip({ run }: { run: SyncRun }) {
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

export function StalledChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700">
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      Stalled
    </span>
  );
}

/**
 * Horizontal bar chart: one row per phase, one hue, value labelled on every
 * row (the durations are the data). Single series, so no legend — the row
 * label carries identity.
 */
export function PhaseChart({ run }: { run: SyncRun }) {
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

export function RunCard({ run }: { run: SyncRun }) {
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
            {run.stalled ? <StalledChip /> : null}
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
          <p className="text-xs tabular-nums text-gray-500">{formatMinutesLabel(run.elapsedMs)}</p>
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
          <dt className="text-xs text-gray-500">Rate</dt>
          <dd className="tabular-nums text-gray-900">{run.rateLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Sync type</dt>
          <dd className="text-gray-900">{run.syncTypeLabel}</dd>
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

      <RunEvidence run={run} />

      <PhaseChart run={run} />
    </div>
  );
}

/**
 * The BACKLOG-3440 run-evidence fields, rendered ONLY when present.
 *
 * Five of the six are on zero rows until 2.38.1 reaches users, so an empty
 * value here is the normal case and must render NOTHING — not an em dash, not
 * "unknown", both of which read as "we looked and there was none" rather than
 * "this build does not report it yet".
 */
function RunEvidence({ run }: { run: SyncRun }) {
  const items: { label: string; value: string; raw?: string }[] = [];
  if (run.startedAtIso) items.push({ label: 'Started', value: formatUtc(run.startedAtIso) });
  if (run.bytesTransferred != null) {
    items.push({ label: 'Bytes moved', value: formatGb(run.bytesTransferred) });
  }
  if (run.bytesLastIncreasedAtIso) {
    items.push({ label: 'Bytes last increased', value: formatUtc(run.bytesLastIncreasedAtIso) });
  }
  // Founder QA 2026-09-19: these three arrived as raw codes —
  // `backup:waiting-for-device`, `INSUFFICIENT_SPACE` — beside a phase chart
  // already saying "Waiting for device". They are read by people, so they are
  // written for people; the raw code stays in `title` for anyone matching this
  // against a log or a database row.
  if (run.lastPhaseRaw) {
    items.push({
      label: 'Last phase',
      value: phaseLabel(run.lastPhaseRaw),
      raw: run.lastPhaseRaw,
    });
  }
  if (run.endedBy) {
    items.push({ label: 'Ended by', value: endedByLabel(run.endedBy), raw: run.endedBy });
  }
  if (run.reasonCode) {
    items.push({ label: 'Reason', value: reasonCodeLabel(run.reasonCode), raw: run.reasonCode });
  }

  if (items.length === 0) return null;

  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-gray-100 pt-3 text-sm sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs text-gray-500">{item.label}</dt>
          <dd
            className={item.raw ? 'text-gray-900' : 'tabular-nums text-gray-900'}
            title={item.raw}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
