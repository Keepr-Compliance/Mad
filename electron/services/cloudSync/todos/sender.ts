/**
 * Keepr Cloud todo sender — BACKLOG-4263 PR-4a (plan §2.2, §3.2; plan check R4; PR-2 review R4).
 *
 * Runs inside the runner's pass, after the deals (a todo op names its deal by cloud id). For the pinned user:
 *   1. one local transaction: seed the counter if absent (N1b), step the epoch (E2), drop ops of deals gone
 *      both here and online, read the waiting ops of deals that are online;
 *   2. order them (creates, parts, removals; wire.ts compareForSend) and cut them into calls of at most
 *      MAX_OPS_PER_CALL ops and MAX_BYTES_PER_CALL bytes;
 *   3. per call: step the epoch again, encode (wire.ts), send cloud_todo_push. Nothing is written locally
 *      before the call;
 *   4. per answer, one synchronous local transaction (confirmTodoAnswer), decided by answers.ts.
 *
 * Retries always reuse the outbox row's op_id: after a lost response the server replays a kept answer
 * exactly, and evaluates again an answer it did not keep (contract `ledger`). A row gets a new op_id only
 * when the user edits that part again (the capture trigger mints it), and then its generation changes, so the
 * old answer can no longer delete it.
 */
import type { CallResult, CloudClient } from "../cloudClient";
import type { JsonValue } from "../jcs";
import type { SqlDb } from "../../db/cloudSyncSqlDb";
import * as todos from "../../db/cloudSyncTodoDbService";
import { actionFor } from "./answers";
import { compareForSend, encodeOp, normOpId, type WireOp } from "./wire";

/** Contract `push.limits`: 200 ops and 1 MB per call; bytes kept below the cap. */
export const MAX_OPS_PER_CALL = 200;
export const MAX_BYTES_PER_CALL = 900 * 1024;

export type TodoSendOutcome = "idle" | "done" | "failed" | "install_removed";

export interface TodoSendDeps {
  db: SqlDb;
  client: CloudClient;
  projectRef: string;
  userId: string;
  installId: string;
  now: () => Date;
  /** The runner's synchronous check before every call (throws to stop the pass). */
  guard: () => void;
  /** The runner's shared stop codes (wrong_account, not_entitled, not_authorized; throws). */
  stopOn: (res: CallResult) => void;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}

export interface TodoSendSummary {
  outcome: TodoSendOutcome;
  sent: number;
  confirmed: number;
  retried: number;
  dropped: number;
  waiting: number;
  calls: number;
}

function chunks(ops: Array<{ op: WireOp; row: todos.SendableRow }>): Array<Array<{ op: WireOp; row: todos.SendableRow }>> {
  const out: Array<Array<{ op: WireOp; row: todos.SendableRow }>> = [];
  let cur: Array<{ op: WireOp; row: todos.SendableRow }> = [];
  let bytes = 2;
  for (const o of ops) {
    const size = Buffer.byteLength(JSON.stringify(o.op), "utf8") + 1;
    if (cur.length > 0 && (cur.length >= MAX_OPS_PER_CALL || bytes + size > MAX_BYTES_PER_CALL)) {
      out.push(cur);
      cur = [];
      bytes = 2;
    }
    cur.push(o);
    bytes += size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export async function sendTodos(deps: TodoSendDeps): Promise<TodoSendSummary> {
  const { db, projectRef, userId } = deps;
  const summary: TodoSendSummary = { outcome: "idle", sent: 0, confirmed: 0, retried: 0, dropped: 0, waiting: 0, calls: 0 };
  // R8 / D2 (persisted stop): a stopped user's pass returns before any call (runner.ts, before the state read), so
  // the sender never runs for that user; the stop is recorded below when a push itself answers install_removed.

  const read = db.transaction(() => {
    todos.seedTodoCounter(db, projectRef);
    const epoch = todos.stepTodoEpoch(db, projectRef, deps.now()) ?? 0;
    return { ...todos.readTodoOutbox(db, projectRef, userId), epoch };
  })();
  summary.dropped = read.dropped;
  summary.waiting = read.waiting;
  if (read.ready.length === 0) return summary;
  const ordered = [...read.ready].sort(compareForSend);

  // Sized with the epoch read above; each call re-encodes with the epoch at its send (same size).
  const sized: Array<{ op: WireOp; row: todos.SendableRow }> = [];
  for (const row of ordered) {
    const op = encodeOp(row, { cloudDealId: row.cloud_deal_id as string, currentEpoch: read.epoch, todoCloudId: row.todo_cloud_id, checklistCloudId: row.checklist_cloud_id });
    if (op) sized.push({ op, row });
  }
  for (const batch of chunks(sized)) {
    deps.guard();
    const epoch = todos.stepTodoEpoch(db, projectRef, deps.now()) ?? 0;
    const encoded: Array<{ op: WireOp; row: todos.SendableRow }> = [];
    for (const b of batch) {
      const op = encodeOp(b.row, { cloudDealId: b.row.cloud_deal_id as string, currentEpoch: epoch, todoCloudId: b.row.todo_cloud_id, checklistCloudId: b.row.checklist_cloud_id });
      if (op) encoded.push({ op, row: b.row });
    }
    if (encoded.length === 0) continue;
    const sentAt = deps.now().toISOString();
    const res = await deps.client.todoPush(userId, deps.installId, sentAt, encoded.map((e) => e.op as JsonValue));
    summary.calls++;
    deps.stopOn(res);
    if (res.kind === "refused" && res.code === "install_removed") {
      todos.recordInstallRemoved(db, projectRef, userId, deps.now());
      deps.log?.warn("[CloudSync] Todo changes not sent: this computer's online copy was removed", { code: res.code });
      return { ...summary, outcome: "install_removed" };
    }
    if (res.kind !== "ok") {
      // Transport failure or a batch refusal: nothing is known to be applied. Every row stays as it is and
      // is sent again next pass with the same op_id (a replay returns any answer the server did keep).
      deps.log?.warn("[CloudSync] Todo changes not sent (will retry)", { code: res.code });
      return { ...summary, outcome: "failed" };
    }
    summary.sent += encoded.length;
    const byOp = new Map<string, Record<string, unknown>>();
    for (const r of Array.isArray(res.body.results) ? (res.body.results as unknown[]) : []) {
      if (r && typeof r === "object" && !Array.isArray(r)) byOp.set(normOpId((r as Record<string, unknown>).op_id), r as Record<string, unknown>);
    }
    let stop = false;
    for (const e of encoded) {
      const answer = byOp.get(normOpId(e.row.op_id));
      const action = actionFor(answer);
      if (action.action === "stop") {
        stop = true;
        continue;
      }
      if (action.action === "retry" || !answer) {
        summary.retried++;
        continue;
      }
      todos.confirmTodoAnswer(db, e.row, answer, action, deps.now());
      summary.confirmed++;
    }
    if (stop) {
      todos.recordInstallRemoved(db, projectRef, userId, deps.now());
      return { ...summary, outcome: "install_removed" };
    }
  }
  summary.outcome = "done";
  return summary;
}
