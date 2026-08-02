/**
 * Support access — renderer service (BACKLOG-2393)
 *
 * The repo rule: components never call `window.api` directly. Everything the
 * Settings section needs goes through here.
 *
 * This layer also does the one bit of interpretation the UI must not get wrong:
 * distinguishing "the IPC call worked" from "your data was deleted". Those are
 * two different booleans on the delete response, and collapsing them is exactly
 * how a delete button starts lying.
 */

import type {
  SupportAccessDuration,
  SupportAccessDurationId,
  SupportAccessState,
  SupportReportListItem,
} from "../../electron/services/supportAccess/types";
import type {
  SupportLogScope,
  SupportLogScopeId,
} from "../../electron/services/supportAccess/scopes";

export type {
  SupportAccessDuration,
  SupportAccessDurationId,
  SupportAccessState,
  SupportReportListItem,
  SupportLogScope,
  SupportLogScopeId,
};

export interface SupportAccessDisclosure {
  id: string;
  text: string;
  hash: string;
}

export interface SupportAccessSnapshot {
  state: SupportAccessState;
  reports: SupportReportListItem[];
  durations: SupportAccessDuration[];
  defaultDurationId: SupportAccessDurationId;
  scopes: SupportLogScope[];
  defaultScopes: SupportLogScopeId[];
  disclosure: SupportAccessDisclosure;
  retentionDays: number;
}

export interface DeleteReportOutcome {
  deleted: boolean;
  error?: string;
  reports: SupportReportListItem[];
}

function bridge() {
  const api = window.api?.support?.access;
  if (!api) {
    throw new Error("Support access is unavailable in this build");
  }
  return api;
}

export async function getSnapshot(): Promise<SupportAccessSnapshot> {
  const result = await bridge().getState();
  if (!result.success || !result.state || !result.disclosure) {
    throw new Error(result.error || "Could not read support access settings");
  }
  return {
    state: result.state,
    reports: result.reports ?? [],
    durations: [...(result.durations ?? [])],
    defaultDurationId: result.defaultDurationId ?? "7d",
    scopes: result.scopes ?? [],
    defaultScopes: result.defaultScopes ?? [],
    disclosure: result.disclosure,
    retentionDays: result.retentionDays ?? 30,
  };
}

export async function grantAccess(params: {
  durationId: SupportAccessDurationId;
  scopes: SupportLogScopeId[];
  /** The wording that was on screen when the user confirmed. */
  disclosure: SupportAccessDisclosure;
}): Promise<SupportAccessState> {
  const result = await bridge().grant({
    durationId: params.durationId,
    scopes: params.scopes,
    disclosureId: params.disclosure.id,
    disclosureText: params.disclosure.text,
  });
  if (!result.success || !result.state) {
    throw new Error(result.error || "Could not turn on support access");
  }
  return result.state;
}

export async function revokeAccess(): Promise<SupportAccessState> {
  const result = await bridge().revoke();
  if (!result.success || !result.state) {
    throw new Error(result.error || "Could not turn off support access");
  }
  return result.state;
}

export async function listReports(): Promise<SupportReportListItem[]> {
  const result = await bridge().listReports();
  if (!result.success) {
    throw new Error(result.error || "Could not load diagnostic reports");
  }
  return result.reports ?? [];
}

export async function captureNow(): Promise<SupportReportListItem[]> {
  const result = await bridge().captureNow();
  if (!result.success) {
    throw new Error(result.error || "Could not capture a report");
  }
  return result.reports ?? [];
}

export async function sendReport(
  id: string
): Promise<SupportReportListItem[]> {
  const result = await bridge().sendNow(id);
  if (!result.success) {
    throw new Error(result.error || "Could not send the report");
  }
  return result.reports ?? [];
}

/**
 * Delete a report locally and on the server.
 *
 * Returns rather than throws on a server failure, because the caller needs both
 * halves: the fact that it failed *and* the refreshed list, which still
 * contains the row. The row must stay visible — a report that is still on the
 * server has to remain deletable.
 */
export async function deleteReport(id: string): Promise<DeleteReportOutcome> {
  const result = await bridge().deleteReport(id);
  if (!result.success) {
    throw new Error(result.error || "Could not delete the report");
  }
  return {
    deleted: result.deleted === true,
    error: result.deleted === true ? undefined : result.error,
    reports: result.reports ?? [],
  };
}

/** "7 days", "3 hours", "12 minutes" — whichever unit reads naturally. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "ended";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** "2 August 2026 at 17:04" — an actual date, not "in a while". */
export function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "an unknown date";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
