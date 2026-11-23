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
  /**
   * BACKLOG-4263 P2: the account's active computer (migration 20261123100000, marker STATE:active, :682), or null.
   */
  activeInstallId: string | null;
  /**
   * BACKLOG-4263 P2: the release switches (marker STATE:switches, :683-685). Null when the answer has no `switches`
   * key: a server without migration 20261123100000, which has no one-computer rule (S1's state function always
   * sends the key). The desktop then claims nothing and turns off with the 3-argument call.
   */
  switches: { oneComputer: boolean; messagesUpload: boolean } | null;
}

export type StateRead = { kind: "state"; state: ServerState } | { kind: "unknown"; code: string };

export function classifyReason(entitled: boolean, reason: string | null): ReasonClass {
  if (entitled && reason === null) return "entitled";
  if (reason === "not_enabled") return "not_enabled";
  if (reason === "notice_outdated") return "notice_outdated";
  if (reason !== null && (LICENCE_REASONS as readonly string[]).includes(reason)) return "licence";
  return "unknown_reason";
}

/**
 * BACKLOG-4263 P2: another computer is the account's active one and the rule is on, so this computer sends nothing.
 * A null active computer is not "another" here: the desktop claims it first (runner), and the server refuses every
 * write until it does.
 */
export function otherComputerActive(state: ServerState, installId: string | null): boolean {
  return state.switches?.oneComputer === true && state.activeInstallId !== null && state.activeInstallId !== installId;
}

export function parseState(result: CallResult): StateRead {
  if (result.kind !== "ok") return { kind: "unknown", code: result.code };
  const b = result.body;
  if (b.schema_version !== 1) return { kind: "unknown", code: "schema_version" };
  const entitled = b.entitled === true;
  const reason = typeof b.reason === "string" ? b.reason : null;
  const settings = (b.settings && typeof b.settings === "object" ? b.settings : {}) as Record<string, unknown>;
  const sw = b.switches && typeof b.switches === "object" && !Array.isArray(b.switches) ? (b.switches as Record<string, unknown>) : null;
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
      activeInstallId: typeof b.active_install_id === "string" ? b.active_install_id : null,
      switches: sw ? { oneComputer: sw.one_computer === true, messagesUpload: sw.messages_upload === true } : null,
    },
  };
}
