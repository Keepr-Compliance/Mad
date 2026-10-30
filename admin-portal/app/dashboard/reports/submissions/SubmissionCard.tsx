/**
 * Submissions report — status chip and per-attempt detail card (BACKLOG-3715).
 * Markup copied from the iPhone Sync RunCard. No state, no fetching.
 */

import { AlertTriangle, CheckCircle2, Clock, MinusCircle, XCircle, type LucideIcon } from 'lucide-react';
import {
  countLabel,
  formatCountCell,
  type StatusTone,
  type Submission,
} from '@/lib/reports/submissions';

const TONE_CHIP: Record<StatusTone, string> = {
  good: 'text-green-700 bg-green-50 border-green-200',
  critical: 'text-red-700 bg-red-50 border-red-200',
  warning: 'text-amber-700 bg-amber-50 border-amber-200',
  neutral: 'text-gray-700 bg-gray-50 border-gray-200',
};

function iconFor(s: Submission): LucideIcon {
  if (s.status === 'running') return Clock;
  if (s.status === 'stalled') return AlertTriangle;
  if (s.tone === 'good') return CheckCircle2;
  if (s.tone === 'critical') return XCircle;
  return MinusCircle;
}

export function StatusChip({ submission }: { submission: Submission }) {
  const Icon = iconFor(submission);
  return (
    <span
      data-status={submission.status}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CHIP[submission.tone]}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {submission.statusLabel}
    </span>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900">{value}</dd>
    </div>
  );
}

export function SubmissionCard({ submission: s }: { submission: Submission }) {
  const countKeys = Object.keys(s.counts).sort();
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip submission={s} />
        {s.isResubmit ? (
          <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs text-gray-700">
            Resubmit
          </span>
        ) : null}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Field label="Started" value={s.whenUtc} />
        <Field label="Duration" value={s.durationLabel} />
        <Field label="Agent" value={s.agentLabel} />
        <Field label="Organization" value={s.orgLabel} />
        <Field label="Stopped at" value={s.stageLabel} />
        <Field label="Reason" value={s.reasonLabel} />
        <Field label="Retries" value={String(s.retryCount)} />
        <Field label="App · Platform" value={`${s.appVersion} · ${s.platform}`} />
        <Field label="Submission id" value={s.submissionId} />
      </dl>

      <p className="mt-5 mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Counts</p>
      {countKeys.length === 0 ? (
        <p className="text-sm text-gray-500">This attempt recorded no counts.</p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2" data-counts="">
          {countKeys.map((key) => (
            <div key={key} className="flex justify-between gap-3 border-b border-gray-100 py-1" data-count-key={key}>
              <dt className="text-sm text-gray-700">{countLabel(key)}</dt>
              <dd className="text-sm tabular-nums text-gray-900">{formatCountCell(s.counts[key])}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
