/**
 * BACKLOG-4115 PR-3: the device sync pill in the title bar, left of the
 * initials (mock v9). 28 px, rounded, 14 px phone icon, the label, then an
 * 8 px dot (or a 14 px spinning arc while a sync runs). The tooltip is the
 * `title`. Presentational: the state comes from syncPillState via
 * useTitleBarSync.
 *
 * It sits inside the global drag strip (BACKLOG-1790), so it carries
 * .no-drag-region like the initials (AccountButton). Always clickable
 * (PM decision 4): it opens the sync flow, which shows the progress.
 */
import React from "react";
import type { SyncPillState, SyncPillTone } from "./syncPillState";

const DOT: Record<Exclude<SyncPillTone, "arc">, string> = {
  success: "bg-success-600",
  warning: "bg-warning-600",
  danger: "bg-danger-600",
  neutral: "bg-warm-dot",
};

function PhoneIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  );
}

/** 14 px arc on the warm rail; spins (the percent, when known, sets its length). */
function Arc({ percent }: { percent?: number }) {
  const dash = percent === undefined ? 30 : Math.max(8, Math.min(100, percent));
  return (
    <span className="inline-flex h-3.5 w-3.5 shrink-0" data-tone="arc" data-testid="title-bar-sync-pill-indicator" aria-hidden="true">
      <svg viewBox="0 0 36 36" className="h-3.5 w-3.5 animate-spin">
        <circle cx="18" cy="18" r="15.9155" fill="none" strokeWidth={5} className="stroke-warm-line" />
        <circle cx="18" cy="18" r="15.9155" fill="none" strokeWidth={5} strokeLinecap="round" strokeDasharray={`${dash} 100`} className="stroke-primary-600" />
      </svg>
    </span>
  );
}

export function TitleBarSyncPill({ pill, onClick }: { pill: SyncPillState; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={pill.tooltip}
      aria-label={`${pill.label}: ${pill.tooltip}`}
      data-testid="title-bar-sync-pill"
      data-device={pill.device}
      data-tour={pill.device === "iphone" ? "sync-phone-card" : undefined}
      className="no-drag-region inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-warm-line bg-white pl-2 pr-2.5 text-xs font-medium text-ink-muted hover:border-warm-control focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
    >
      <PhoneIcon />
      <span>{pill.label}</span>
      {pill.tone === "arc" ? (
        <Arc percent={pill.progressPercent} />
      ) : (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${DOT[pill.tone]}`}
          data-tone={pill.tone}
          data-testid="title-bar-sync-pill-indicator"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
