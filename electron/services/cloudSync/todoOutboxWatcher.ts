/**
 * Keepr Cloud: a pass shortly after the user's own todo change — BACKLOG-4263 P0 (plan §11.8, todo part).
 *
 * Every 5 s while the pass timer runs, this checks whether `cloud_sync_todo_outbox` holds a change newer than
 * what it held when the last pass started, and if so asks for a pass through the service's existing `kick()`.
 * The user's own checklist change is then sent within about 5-15 s instead of up to 60 s.
 *
 * It only reads. It writes nothing, and it changes no statement, order, argument or retry of any send, pull,
 * delete or restore: the pass it asks for is the same pass the 60 s timer runs.
 *
 * "Newer" compares the outbox with itself, never with the JS clock: at each pass start the service records the
 * outbox's newest `edited_at` and `edit_seq`, and a later value above either one is a change made since. A row
 * the server keeps answering with a retry never changes, so it never asks again (no kick storm). A wall clock
 * that steps back can only hide a change from this check; the 60 s timer still sends it.
 *
 * Never asks while: offline, signed out, the database is not ready, a pass is running, or the last pass did not
 * end `done` (an allowlist: every other outcome, including P2's `other_computer` for a computer that is not the
 * account's active one, blocks it, and so does a fresh start until a pass ends `done`). At most one ask per 10 s
 * after any pass start; after failed passes 10 s, 20 s, 40 s, then only the 60 s timer until a pass ends `done`
 * with no failure.
 *
 * BACKLOG-4263 P2 removed the settings check (Keepr Cloud on here, no turn-off owed) that sat before the kick. No
 * test could make it matter (P0 review N1, mutation M7/M8 green; re-run on this branch's base, green): a turn-off
 * empties the user's outbox and the capture triggers queue nothing while enabled = 0, and sign-out forgets the
 * last outcome, so a different user gets no kick before their own pass ends `done`. A refused computer stays
 * enabled = 1, so that check would not have stopped it either; the allowlist does (control "W-4b").
 */
import type { SqlDb } from "../db/cloudSyncSqlDb";
import { OUTBOX_TOP_SQL } from "../db/cloudSyncTodoSql";
import { DIRTY_TOP_SQL } from "../db/cloudSyncSql";
import type { PassOutcome, PassSummary } from "./runner";

/** How often the watcher looks at the outbox. */
export const WATCH_INTERVAL_MS = 5_000;
/** At most one watcher kick this long after any pass start. */
export const MIN_KICK_GAP_MS = 10_000;
/** After 1, 2, 3 failed passes in a row; after more, the watcher waits for the 60 s timer. */
export const FAILED_PASS_GAPS_MS = [10_000, 20_000, 40_000] as const;


interface OutboxTop {
  at: string | null;
  seq: number | null;
  /** BACKLOG-4263 P5: the newest deal mark (cloud_sync_dirty.marked_at), compared only with its own earlier value. */
  dirtyAt: string | null;
}

export interface TodoOutboxWatcherDeps {
  db: () => SqlDb;
  dbReady: () => boolean;
  projectRef: string;
  isOnline: () => boolean;
  getAuthUserId: () => string | null;
  passRunning: () => boolean;
  kick: () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => Date;
}

/** The wait after `failures` failed passes in a row, or null when only the 60 s timer may run a pass. */
export function gapAfterFailures(failures: number): number | null {
  if (failures <= 0) return MIN_KICK_GAP_MS;
  return failures <= FAILED_PASS_GAPS_MS.length ? FAILED_PASS_GAPS_MS[failures - 1] : null;
}

/** A pass that failed for the watcher's back-off: a deal not saved, or a todo send that did not go through. */
export function passFailed(summary: PassSummary): boolean {
  return summary.failed > 0 || summary.todos?.outcome === "failed" || summary.todosAfterPull?.outcome === "failed";
}

export class TodoOutboxWatcher {
  private handle: unknown = null;
  private lastOutcome: PassOutcome | "threw" | null = null;
  private failures = 0;
  private lastPassStartMs: number | null = null;
  /** The outbox's newest values at the last pass start; null until a pass started (or the read failed). */
  private mark: OutboxTop | null = null;
  /** BACKLOG-4263 P5: the last pass ended done with its email and text budget used up and work left. */
  private continueWanted = false;

  constructor(private readonly deps: TodoOutboxWatcherDeps) {}

  get running(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.deps.setInterval(() => this.tick(), WATCH_INTERVAL_MS);
  }

  stop(): void {
    if (this.handle === null) return;
    this.deps.clearInterval(this.handle);
    this.handle = null;
  }

  /** Sign-out: forget the last pass and the mark, so the next user gets no kick until their own pass ends done. */
  forgetLastPass(): void {
    this.lastOutcome = null;
    this.continueWanted = false;
    this.failures = 0;
    this.lastPassStartMs = null;
    this.mark = null;
  }

  /** Called by the service right before a pass starts (never for a kick that only queues one). */
  passStarting(): void {
    this.lastPassStartMs = this.deps.now().getTime();
    this.mark = null;
    try {
      if (this.deps.dbReady()) this.mark = this.readTop();
    } catch {
      this.mark = null;
    }
  }

  /** Called by the service when a pass it awaited ended (null: the pass threw). A queued answer is not an end. */
  passEnded(summary: PassSummary | null): void {
    if (!summary) {
      this.lastOutcome = "threw";
      this.failures++;
      return;
    }
    if (summary.outcome === "queued") return;
    this.lastOutcome = summary.outcome;
    this.continueWanted = summary.outcome === "done" && summary.budgetExhausted === true;
    if (passFailed(summary)) this.failures++;
    else if (summary.outcome === "done") this.failures = 0;
  }

  /** One look. In-memory checks first; the outbox read only when a kick is otherwise allowed. */
  tick(): void {
    try {
      const { deps } = this;
      if (!deps.dbReady() || !deps.isOnline()) return;
      const userId = deps.getAuthUserId();
      if (!userId) return;
      if (deps.passRunning()) return;
      if (this.lastOutcome !== "done") return;
      const gap = gapAfterFailures(this.failures);
      if (gap === null) return;
      if (this.lastPassStartMs !== null && deps.now().getTime() - this.lastPassStartMs < gap) return;
      if (!this.mark) return;
      if (!this.continueWanted && !isNewer(this.readTop(), this.mark)) return;
      deps.kick();
    } catch {
      /* the next look, or the 60 s timer, tries again */
    }
  }

  private readTop(): OutboxTop {
    const row = this.deps.db().prepare(OUTBOX_TOP_SQL).get(this.deps.projectRef) as Partial<OutboxTop> | undefined;
    const dirty = this.deps.db().prepare(DIRTY_TOP_SQL).get() as { at?: unknown } | undefined;
    return {
      at: typeof row?.at === "string" ? row.at : null,
      seq: typeof row?.seq === "number" ? row.seq : null,
      dirtyAt: typeof dirty?.at === "string" ? dirty.at : null,
    };
  }
}

function isNewer(now: OutboxTop, mark: OutboxTop): boolean {
  if (now.seq !== null && (mark.seq === null || now.seq > mark.seq)) return true;
  if (now.dirtyAt !== null && (mark.dirtyAt === null || now.dirtyAt > mark.dirtyAt)) return true;
  return now.at !== null && (mark.at === null || now.at > mark.at);
}
