/**
 * What the desktop does with each cloud_todo_push answer — BACKLOG-4263 PR-4a.
 *
 * ONE table, keyed by the op's `status` (and, for `rejected` / `not_restorable`, its `reason`). Statuses
 * and reasons come from supabase/contracts/cloud-todo-change-v1.json (`statuses`, `ledger.not_kept`) and
 * `_cloud_todo_apply_op` in supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql.
 *
 *   confirm  the server decided the op: write its parts to the shadow (never to a lower rev), write the
 *            winning value of the op's own part(s) to the local row, and delete the outbox row if its
 *            generation is unchanged. `rebase`: when the row was re-edited during the send, its base_rev
 *            becomes the returned rev (the re-edit was made on top of a value the server now holds);
 *            without it (`lost`) the base stays, so the re-edit is still compared with the winner.
 *   retry    nothing was decided: the row stays as it is and is sent again with the SAME op_id. These
 *            are the answers the server does not keep in its replay ledger (contract `ledger.not_kept`),
 *            so the same op_id is evaluated again; an unknown status is treated the same way.
 *   final    the server kept a refusal that can never change for this op_id (an exact replay would
 *            return it forever): the outbox row is dropped (when its generation is unchanged) and a
 *            notice records it. Nothing is written to the shadow or the local row.
 *   stop     this install's online copy was removed elsewhere: persist the stop, send nothing more.
 */
export type AnswerAction =
  | { action: "confirm"; scope: "part" | "create" | "remove"; rebase: boolean }
  | { action: "retry" }
  | { action: "final"; notice: string }
  | { action: "stop" };

export const ANSWER_TABLE: Record<string, AnswerAction> = {
  applied: { action: "confirm", scope: "part", rebase: true },
  unchanged: { action: "confirm", scope: "part", rebase: true },
  applied_to_removed: { action: "confirm", scope: "part", rebase: true },
  lost: { action: "confirm", scope: "part", rebase: false },
  restored: { action: "confirm", scope: "part", rebase: true },
  not_removed: { action: "confirm", scope: "part", rebase: true },
  added: { action: "confirm", scope: "create", rebase: true },
  exists: { action: "confirm", scope: "create", rebase: true },
  mapped: { action: "confirm", scope: "create", rebase: true },
  already_added: { action: "confirm", scope: "create", rebase: true },
  removed: { action: "confirm", scope: "remove", rebase: true },
  already_removed: { action: "confirm", scope: "remove", rebase: true },
  // not kept by the server (contract ledger.not_kept): same op_id next pass
  not_found: { action: "retry" },
  locked: { action: "retry" },
  refused_removed: { action: "retry" },
  "rejected/parent_missing": { action: "retry" },
  "not_restorable/my_items_exists": { action: "retry" },
  // kept by the server: an exact replay would answer the same forever
  rejected: { action: "final", notice: "rejected" },
  not_allowed: { action: "final", notice: "not_allowed" },
  not_restorable: { action: "final", notice: "not_restorable" },
  install_removed: { action: "stop" },
};

const UNKNOWN: AnswerAction = { action: "retry" };

export function actionFor(answer: { status?: unknown; reason?: unknown } | null | undefined): AnswerAction {
  if (!answer || typeof answer.status !== "string") return UNKNOWN;
  const reason = typeof answer.reason === "string" ? answer.reason : "";
  return ANSWER_TABLE[`${answer.status}/${reason}`] ?? ANSWER_TABLE[answer.status] ?? UNKNOWN;
}
