/**
 * Keepr Cloud server state (`get_my_cloud_autosave_state`, shape v1) —
 * BACKLOG-4243 PR-1. Unknown keys are ignored; an unknown `reason` reads as
 * paused, never as turned off (contract `tolerance.unknown_state_reason`).
 */
import type { CallResult } from "./cloudClient";

export const LICENCE_REASONS = [
  "no_license",
  "assignment_lapsed",
  "member_inactive",
  "billing_off",
  "plan_disallows",
] as const;

export type ReasonClass = "entitled" | "not_enabled" | "notice_outdated" | "licence" | "unknown_reason";

export interface ServerState {
  userId: string | null;
  licensed: boolean;
  entitled: boolean;
  reason: string | null;
  reasonClass: ReasonClass;
  acceptedAt: string | null;
  currentNoticeVersion: number | null;
}

export type StateRead = { kind: "state"; state: ServerState } | { kind: "unknown"; code: string };

export function classifyReason(entitled: boolean, reason: string | null): ReasonClass {
  if (entitled && reason === null) return "entitled";
  if (reason === "not_enabled") return "not_enabled";
  if (reason === "notice_outdated") return "notice_outdated";
  if (reason !== null && (LICENCE_REASONS as readonly string[]).includes(reason)) return "licence";
  return "unknown_reason";
}

export function parseState(result: CallResult): StateRead {
  if (result.kind !== "ok") return { kind: "unknown", code: result.code };
  const b = result.body;
  if (b.schema_version !== 1) return { kind: "unknown", code: "schema_version" };
  const entitled = b.entitled === true;
  const reason = typeof b.reason === "string" ? b.reason : null;
  const settings = (b.settings && typeof b.settings === "object" ? b.settings : {}) as Record<string, unknown>;
  return {
    kind: "state",
    state: {
      userId: typeof b.user_id === "string" ? b.user_id : null,
      licensed: b.licensed === true,
      entitled,
      reason,
      reasonClass: classifyReason(entitled, reason),
      acceptedAt: typeof settings.accepted_at === "string" ? settings.accepted_at : null,
      currentNoticeVersion: typeof b.current_notice_version === "number" ? b.current_notice_version : null,
    },
  };
}
