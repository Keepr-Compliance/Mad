/**
 * BACKLOG-3658 (founder, live): a Google Messages cache Sync on the dashboard's
 * ONE sync indicator (SyncStatusIndicator, via the orchestrator queue), like
 * iPhone Sync (TASK-2119) — so a minimized Sync is still visible and can be
 * reopened. Pure: what the orchestrator is told for each job update.
 */

import type { RcsJobInfo } from "../../electron/types/ipc/window-api-rcs-import";

/** The orchestrator's type for this source. */
export const GOOGLE_MESSAGES_SYNC_TYPE = "google-messages" as const;

/** The page's paused stage (chrome-extension/job.js PAUSED_TEXT starts with this). */
const PAUSED_PREFIX = "Keep this Chrome window visible";
export const GM_PAUSED_PHASE = "Keep the Messages tab on screen";

export type GoogleMessagesOrchestratorStep =
  | { kind: "progress"; progress: number; phase: string; indeterminate: boolean }
  | { kind: "saving" }
  | { kind: "complete"; summary: string }
  | { kind: "error"; error: string }
  | { kind: "cancelled" }
  | { kind: "ignore" };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What one job update means for the dashboard indicator. */
export function orchestratorStepFor(job: RcsJobInfo): GoogleMessagesOrchestratorStep {
  if (job.kind !== "cache") return { kind: "ignore" };
  if (job.state === "cancelled") return { kind: "cancelled" };
  if (job.state === "failed") return { kind: "error", error: job.error?.message || "The Google Messages Sync did not finish." };
  if (job.state === "finished") {
    if (job.saved === undefined) return { kind: "saving" };
    if (job.saved === null) return { kind: "error", error: "Keepr could not save the Google Messages Sync. Nothing was imported." };
    const s = job.saved;
    return {
      kind: "complete",
      summary: `Google Messages: saved ${plural(s.chats, "chat", "chats")} · ${plural(s.messages, "message", "messages")} (${s.newMessages} new)`,
    };
  }
  const stage = job.stage || "";
  if (stage.startsWith(PAUSED_PREFIX)) return { kind: "progress", progress: 0, phase: GM_PAUSED_PHASE, indeterminate: true };
  const m = /(\d+) of (\d+)/.exec(stage);
  if (m && Number(m[2]) > 0) {
    const n = Number(m[1]);
    const of = Number(m[2]);
    return { kind: "progress", progress: Math.min(100, Math.round((n / of) * 100)), phase: `chat ${n} of ${of}`, indeterminate: false };
  }
  return { kind: "progress", progress: 0, phase: stage ? stage.slice(0, 80) : "starting", indeterminate: true };
}
