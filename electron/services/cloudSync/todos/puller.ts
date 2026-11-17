/**
 * Keepr Cloud todo puller — BACKLOG-4263 PR-4b (plan §2.2 `cloud_todo_pull`, §3.2 "Pull page", §3.4; contract
 * supabase/contracts/cloud-todo-change-v1.json `pull`; PR-2 review R1 / DR1).
 *
 * Runs inside the runner's pass, after the sender (push before pull, plan W26). For the pinned user:
 *   1. read the cursor (last_seq, horizon, full_pull_owed); no cursor row → nothing to pull;
 *   2. per page: the runner's guard, one cloud_todo_pull call (p_horizon only after a stored page), then the
 *      page applied with its (next_after, horizon) in ONE synchronous local transaction (cloudSyncTodoPullDb);
 *   3. a short page ends the pull (the last page also ends a full pull and runs the scan in its transaction);
 *   4. resync_required (or horizon_required): nothing of that answer is applied; the cursor goes back to a full
 *      pull from 0 with no horizon, and the pull starts again (at most twice per pass).
 * A transport failure or refusal leaves the cursor where the last applied page put it.
 */
import type { CallResult, CloudClient } from "../cloudClient";
import type { SqlDb } from "../../db/cloudSyncSqlDb";
import { getTodoCursor } from "../../db/cloudSyncTodoDbService";
import {
  applyTodoPage,
  resetTodoCursorForFullPull,
  type PageCounts,
} from "../../db/cloudSyncTodoPullDb";

/** Contract `pull.limit`. */
export const PULL_PAGE_SIZE = 500;
/** Pages per pass; a longer pull continues on the next pass from the stored cursor. */
export const PULL_MAX_PAGES = 100;
/** Restarts after resync_required within one pass. */
export const PULL_MAX_RESTARTS = 2;

export type TodoPullOutcome = "idle" | "done" | "partial" | "failed";

export interface TodoPullDeps {
  db: SqlDb;
  client: CloudClient;
  projectRef: string;
  userId: string;
  installId: string;
  now: () => Date;
  guard: () => void;
  stopOn: (res: CallResult) => void;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
  pageSize?: number;
}

export interface TodoPullSummary {
  outcome: TodoPullOutcome;
  pages: number;
  rows: number;
  resyncs: number;
  fullPullDone: boolean;
  scanned: number;
  localWrites: number;
  parked: number;
  held: number;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

export async function pullTodos(deps: TodoPullDeps): Promise<TodoPullSummary> {
  const { db, projectRef, userId } = deps;
  const limit = deps.pageSize ?? PULL_PAGE_SIZE;
  const summary: TodoPullSummary = {
    outcome: "idle",
    pages: 0,
    rows: 0,
    resyncs: 0,
    fullPullDone: false,
    scanned: 0,
    localWrites: 0,
    parked: 0,
    held: 0,
  };
  const add = (c: PageCounts) => {
    summary.localWrites += c.localWrites;
    summary.parked += c.parked;
    summary.held += c.held;
    summary.scanned += c.scanned;
    if (c.fullPullDone) summary.fullPullDone = true;
  };
  for (;;) {
    // The start pair, read in one transaction: a stored last_seq without its horizon (never written by this
    // build) cannot be sent (horizon_required), so it becomes a full pull from 0.
    const start = db.transaction(() => {
      const cur = getTodoCursor(db, projectRef, userId);
      if (!cur) return null;
      if (
        cur.last_seq > 0 &&
        (cur.horizon === null || cur.horizon === undefined)
      ) {
        resetTodoCursorForFullPull(db, projectRef, userId, deps.now());
        return { after: 0, horizon: null as number | null };
      }
      return {
        after: cur.last_seq,
        horizon: cur.last_seq > 0 ? (cur.horizon as number) : null,
      };
    })();
    if (!start) return summary;
    let after = start.after;
    let horizon = start.horizon;
    let restart = false;
    for (let page = 0; page < PULL_MAX_PAGES; page++) {
      deps.guard();
      const res = await deps.client.todoPull(
        userId,
        deps.installId,
        after,
        limit,
        horizon,
      );
      deps.stopOn(res);
      const resync = res.kind === "ok" && res.body.resync_required === true;
      const horizonRequired =
        res.kind === "refused" && res.code === "horizon_required";
      if (resync || horizonRequired) {
        // Contract: apply nothing from this answer, drop the cursor, start a full pull.
        resetTodoCursorForFullPull(db, projectRef, userId, deps.now());
        summary.resyncs++;
        restart = true;
        break;
      }
      if (res.kind !== "ok") {
        deps.log?.warn("[CloudSync] Todo changes not fetched (will retry)", {
          code: res.code,
        });
        return { ...summary, outcome: "failed" };
      }
      const rows = Array.isArray(res.body.rows)
        ? (res.body.rows as Array<Record<string, unknown>>)
        : [];
      const nextAfter = int(res.body.next_after);
      const nextHorizon = int(res.body.horizon);
      if (nextAfter === null || nextHorizon === null) {
        deps.log?.warn(
          "[CloudSync] Todo changes not applied: unexpected page",
          { code: "bad_page" },
        );
        return { ...summary, outcome: "failed" };
      }
      const counts = applyTodoPage(
        db,
        { projectRef, userId, installId: deps.installId, now: deps.now() },
        {
          rows,
          next_after: nextAfter,
          horizon: nextHorizon,
          install_max_edit_seq: int(res.body.install_max_edit_seq),
        },
        limit,
      );
      summary.pages++;
      summary.rows += rows.length;
      add(counts);
      if (counts.complete) return { ...summary, outcome: "done" };
      after = nextAfter;
      horizon = nextHorizon;
    }
    if (!restart) return { ...summary, outcome: "partial" };
    if (summary.resyncs > PULL_MAX_RESTARTS) {
      deps.log?.warn("[CloudSync] Todo pull restarted too often this pass", {
        code: "resync_loop",
      });
      return { ...summary, outcome: "failed" };
    }
  }
}
