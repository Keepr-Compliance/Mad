/**
 * BACKLOG-2898 — SYNC PHASE TIMELINE: back-end step boundaries, with durations.
 *
 * The founder asked to "report on new prompts being rendered for the user or
 * new steps being done in the back end". This is the back-end half: one record
 * per phase, carrying when it started, when it ended, how long it took, and
 * the counts that phase produced.
 *
 * Deliberately NOT per item. A per-file or per-message event is exactly the
 * storm that BACKLOG-2897 is about (unthrottled per-file progress IPC) and
 * that filled 80.7% of the founder's support log. A whole 24-minute backup of
 * 64,000 files contributes TWO lines here, not 64,000.
 *
 * BACKLOG-2894 (per-step duration/size telemetry, so the app can tell a user
 * how long their sync will take) should consume `records()` rather than
 * re-instrument the same boundaries: every record already carries phase,
 * startedAt, endedAt, elapsedMs and counts. This module is the collection
 * point; 2894 owns where the data is persisted and how an estimate is derived.
 *
 * PRIVACY: records carry phase names, timings and NUMBERS only. No file paths,
 * no message content, no contact identifiers — nothing that could put user
 * data into a support log.
 */

import crypto from "crypto";
import log from "electron-log";
import { reportSyncOutcome } from "./syncOutcomeReporter";

/**
 * What a phase produced — e.g. `{ messages: 663000, conversations: 2337 }`.
 * Booleans are allowed for the facts that decide a support question rather
 * than measure one: `incremental=false` on the backup phase is exactly the
 * line BACKLOG-2896 went looking for and could not find.
 */
export type PhaseCounts = Record<string, number | boolean>;

/** One phase of one sync. */
export interface SyncPhaseRecord {
  /** Phase name, e.g. "backup", "parsing-messages", "storing:attachments". */
  phase: string;
  /** Epoch ms when the phase was entered. */
  startedAt: number;
  /** Epoch ms when the phase was left; null while it is still open. */
  endedAt: number | null;
  /** Wall-clock duration in ms; null while the phase is still open. */
  elapsedMs: number | null;
  /** What the phase produced. */
  counts: PhaseCounts;
}

/** Where formatted lines go. Defaults to the electron-log file transport. */
export type TimelineSink = (line: string) => void;

/** Scalars only — never user content. */
export type TimelineMeta = Record<string, string | number | boolean>;

function formatFields(fields: TimelineMeta | PhaseCounts): string {
  return Object.keys(fields)
    .map((key) => `${key}=${String(fields[key])}`)
    .join(" ");
}

/** `[SyncTimeline] phase-start phase=backup atMs=1200` */
export function formatPhaseStart(record: SyncPhaseRecord, sinceSyncStartMs: number): string {
  return `[SyncTimeline] phase-start phase=${record.phase} atMs=${sinceSyncStartMs}`;
}

/** `[SyncTimeline] phase-end phase=backup elapsedMs=1464312 files=64213` */
export function formatPhaseEnd(record: SyncPhaseRecord): string {
  const counts = formatFields(record.counts);
  return `[SyncTimeline] phase-end phase=${record.phase} elapsedMs=${record.elapsedMs}${counts ? " " + counts : ""}`;
}

/**
 * BACKLOG-2914 (built as FIX 4 of BACKLOG-2911): THE ONE ROW PER SYNC.
 *
 * Before this, "grep the founder's whole session for `Sync completed` / `Backup
 * Successful` / a total" returned NOTHING. The phases ended and the run simply
 * stopped. A count of failures with no count of successes is not a rate, and every
 * consumer of this data (2894's duration estimate, 2952's per-source failure
 * uptick, 2914's own per-release regression) needs the denominator first.
 *
 * `source` is first-class from day one and not an afterthought, because 2952
 * EXTENDS this event rather than defining a second one: macOS Messages, address
 * books, Outlook, Gmail, Google Contacts, the Android companion and email
 * attachments all have to fit the same row.
 *
 * SCOPE, originally: THE DURATION AXIS ONLY. No `reason_code`, no failure taxonomy,
 * because BACKLOG-2909 and BACKLOG-2903 were open and a failure rate computed over
 * them would have been confidently wrong.
 *
 * BACKLOG-3440 WIDENS THAT, and only because the machinery already existed. The
 * backup path parses the device's own error code (`DEVICE_LOCKED` from
 * MBErrorDomain/208, `CONNECTION_LOST` from a broken usbmuxd pipe, `BACKUP_TIMEOUT`
 * from the 30-minute watchdog) and the orchestrator then forwarded only the human
 * sentence, dropping the code. Carrying it is plumbing, not a new taxonomy. What is
 * still NOT computed here is a failure RATE — that remains 2909/2903's problem.
 *
 * PRIVACY: scalars only, and the same rule as the phase records — model
 * identifiers, versions, byte counts and durations. Never a UDID, never a device
 * NAME (the founder's is a personal nickname), never a path under a user's home.
 */
export type SyncOutcome = "complete" | "cancelled" | "error";

/**
 * BACKLOG-3440: what a row can say about a run, INCLUDING one that has not finished.
 *
 * `running` is deliberately NOT a member of {@link SyncOutcome}, so `endSync` — whose
 * parameter is `SyncOutcome` — physically cannot end a sync as `running`. The
 * distinction is the type system doing the work: only `beginSync` and the heartbeat
 * produce this state, and only the start write carries it to the row.
 */
export type SyncRunState = SyncOutcome | "running";

/**
 * BACKLOG-3440: how often a live run refreshes its row.
 *
 * Two minutes. ~90 writes on a three-hour run, against ~5 sync runs a day across all
 * users — negligible. The alternative considered was 5 minutes (~36 writes), and the
 * resolution is worth more than the saved rows when the thing being timed is a stall:
 * "it stopped somewhere in the last five minutes" is a materially worse answer than
 * "it stopped at 14:22, give or take two".
 */
export const SYNC_RUN_HEARTBEAT_MS = 120_000;

/**
 * The one dimension that separates BACKLOG-2952's other sources from this one.
 * Exported so the transport and its tests name the same string the row does.
 */
export const SYNC_OUTCOME_SOURCE = "iphone-backup";

/** One phase's contribution to the row, in the order the phases ran. */
export interface SyncOutcomePhase {
  phase: string;
  elapsedMs: number;
}

/**
 * BACKLOG-2914 (transport): the outcome row as DATA rather than as a formatted line.
 *
 * `emitOutcome` used to build a string and hand it to the logger, which is why the row
 * never left the machine. It now builds this, hands it to a reporter, AND logs the same
 * line it always did.
 *
 * `phases` is an ORDERED ARRAY, not a `Record<string, number>`. `enter()` deliberately
 * creates a new record when a phase is re-entered ("a phase that runs twice is two
 * durations, never one doubled"), and a keyed map would silently collapse the second
 * into the first. It is also why the durable column for this is jsonb.
 */
export interface SyncOutcomeRow {
  source: string;
  outcome: SyncRunState;
  elapsedMs: number;
  phases: SyncOutcomePhase[];
  /** Every dimension established for this run: context + end counts. Scalars only. */
  fields: TimelineMeta;
  /**
   * BACKLOG-3440: the identity of THIS run, generated on the client at `beginSync`.
   *
   * It is what lets three separate writes — start, heartbeat, terminal — land on one
   * row. Generated here rather than taken from the database because the first write
   * can be dropped (offline) and the row must still be amendable when it isn't.
   */
  runId: string;
  /**
   * BACKLOG-3440: epoch ms at `beginSync`, sent on EVERY write.
   *
   * Not derivable from the database's own `created_at`: if the start write is dropped
   * offline and the terminal write creates the row, `created_at` is the END time. The
   * one number this instrument exists to produce would then be wrong on exactly the
   * runs that had a bad network.
   */
  startedAt: number;
}

/**
 * Where the outcome row goes BESIDES the log. Synchronous and void-returning on
 * purpose: `endSync` is on the sync's critical path and must never await a network
 * call. A reporter that needs I/O fires and forgets.
 */
export type SyncOutcomeReporter = (row: SyncOutcomeRow) => void;

/**
 * BACKLOG-3440: where a run reports that it has STARTED and that it is STILL ALIVE.
 *
 * Separate from {@link SyncOutcomeReporter}, and deliberately not the same function.
 * The outcome reporter fans out to Sentry as well as Postgres; a `running` event per
 * sync plus one every two minutes would be both quota and noise against a sink whose
 * entire value here is that a sync FAILURE stands out. These two writes go to the
 * durable corpus only.
 */
export interface SyncRunReporter {
  /** Called once, from `beginSync`, before anything else can happen to the run. */
  start(row: SyncOutcomeRow): void;
  /** Called on a timer while the run is alive, and once whenever the end reason is known. */
  heartbeat(row: SyncOutcomeRow): void;
}

/**
 * BACKLOG-3440: the production live-run sink, resolved lazily.
 *
 * Required at call time rather than imported at module load, exactly as
 * `syncOutcomeReporter` does for the same module: a static import would drag
 * `supabaseService` — and with it the Supabase client — into every suite that so much
 * as touches a phase name. Every failure here is swallowed, because this is telemetry
 * on the critical path of an operation that can take a user an hour.
 */
const defaultRunReporter: SyncRunReporter = {
  start(row) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("./syncOutcomeSupabase") as {
        recordSyncRunStart: (r: SyncOutcomeRow) => void;
      };
      m.recordSyncRunStart(row);
    } catch (error) {
      log.warn("[SyncTimeline] run-start sink unavailable; sync unaffected:", error);
    }
  },
  heartbeat(row) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("./syncOutcomeSupabase") as {
        recordSyncRunProgress: (r: SyncOutcomeRow) => void;
      };
      m.recordSyncRunProgress(row);
    } catch (error) {
      log.warn("[SyncTimeline] heartbeat sink unavailable; sync unaffected:", error);
    }
  },
};

export class SyncTimeline {
  private phaseRecords: SyncPhaseRecord[] = [];
  private syncStartedAt: number | null = null;
  private readonly now: () => number;
  private readonly sink: TimelineSink;
  /**
   * Facts about THIS run, accumulated as they become known and emitted once with
   * the outcome row. Cleared by `beginSync` — without that, run N's device model
   * and first-sync flag would ride along into run N+1's row, which is worse than
   * having no dimensions at all because it looks like data.
   */
  private context: TimelineMeta = {};

  /**
   * BACKLOG-2914 (transport): where the outcome row goes besides the log.
   *
   * Defaults to the real Sentry + Supabase reporter, and that default is the whole
   * point — this item's own first attempt built a complete row and wired it to
   * nothing, so a seam that has to be opted into would reproduce the defect. Tests
   * inject; production does not.
   */
  private readonly reporter: SyncOutcomeReporter;

  /**
   * BACKLOG-3440: the live-run state. All of it is per-run and all of it is cleared by
   * `beginSync`, for the same reason the context is: run N's byte count riding along
   * into run N+1's row is worse than no byte count, because it looks like data.
   */
  private runId: string | null = null;
  private bytesTransferred: number | null = null;
  private bytesLastIncreasedAt: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly runReporter: SyncRunReporter | null;
  private readonly heartbeatMs: number;
  private readonly newRunId: () => string;

  constructor(
    options: {
      now?: () => number;
      sink?: TimelineSink;
      reporter?: SyncOutcomeReporter;
      runReporter?: SyncRunReporter | null;
      heartbeatMs?: number;
      newRunId?: () => string;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.sink = options.sink ?? ((line: string) => log.info(line));
    this.reporter = options.reporter ?? reportSyncOutcome;
    this.heartbeatMs = options.heartbeatMs ?? SYNC_RUN_HEARTBEAT_MS;
    this.newRunId = options.newRunId ?? (() => crypto.randomUUID());
    // A TEST THAT INJECTS `reporter` GETS NO LIVE-RUN SINK UNLESS IT ASKS FOR ONE.
    //
    // Injecting a reporter is how ~40 suites say "do not touch the network from this
    // timeline". Defaulting the live-run sink unconditionally would have re-opened that
    // door behind their backs — a start write and a heartbeat every two minutes,
    // reaching for a Supabase client those suites never mock. Production constructs the
    // singleton with no options at all and is unaffected.
    this.runReporter =
      options.runReporter !== undefined
        ? options.runReporter
        : options.reporter
          ? null
          : defaultRunReporter;
  }

  /** Start a sync. Clears any previous run's records AND context. */
  beginSync(meta: TimelineMeta = {}): void {
    this.stopHeartbeat();
    this.phaseRecords = [];
    this.context = {};
    this.bytesTransferred = null;
    this.bytesLastIncreasedAt = null;
    this.syncStartedAt = this.now();
    this.runId = this.newRunId();
    const fields = formatFields(meta);
    this.sink(`[SyncTimeline] sync-start${fields ? " " + fields : ""}`);

    // BACKLOG-3440: THE ROW EXISTS BEFORE THE RUN DOES.
    //
    // This is the whole item. Until now the row was assembled at the end, so a run with
    // no end had no record: on 2026-09-16 a user lost three hours to a sync that never
    // finished and left NOTHING behind — not a failure row, no row at all. Every other
    // improvement to this data only covers runs that already report.
    if (this.runReporter) {
      const row = this.buildRow("running", 0, {});
      try {
        this.runReporter.start(row);
      } catch (error) {
        log.warn("[SyncTimeline] run-start reporter threw; sync unaffected:", error);
      }
      this.startHeartbeat();
    }
  }

  /**
   * BACKLOG-3440: the byte count the backup reported, kept as a high-water mark.
   *
   * THE FIELD THE INCIDENT NEEDED. A 169-minute transfer was recorded that nobody could
   * classify, because the record said how long it ran and not whether anything moved:
   * 57 GB slowly and 2 GB then dead are different defects with different fixes.
   *
   * NOT a duplicate of the existing 30-minute no-progress watchdog, which counts STREAM
   * activity — any stdout chunk plus a curated stderr signal list — and is silent about
   * bytes. Its NOT firing during those 169 minutes is itself the evidence that the
   * process was alive and chattering the whole time.
   *
   * STRICTLY INCREASING, and `>` rather than `>=` is load-bearing: the timestamp means
   * "the last time this went UP". With `>=`, a flat run — the exact thing being
   * detected — would refresh the timestamp on every repeated sample and read as healthy.
   *
   * The emitted count can also go DOWN: `backupService` composes it as
   * `completedFiles + currentFileBytes` and the per-file part resets, which its own
   * docblock records as a known trap. `Math.max` is why a dip cannot rewind the mark.
   */
  recordBytesTransferred(bytes: number): void {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return;
    const previous = this.bytesTransferred ?? 0;
    // First reading establishes the mark even when it is zero — "the transfer has
    // reported in, and it has moved nothing yet" is a fact worth having.
    if (this.bytesTransferred === null) this.bytesTransferred = bytes;
    if (bytes > previous) {
      this.bytesTransferred = bytes;
      this.bytesLastIncreasedAt = this.now();
    }
  }

  /**
   * BACKLOG-3440: record WHICH ACT is ending this run, and write it out immediately.
   *
   * `cancelled` has never meant "the user pressed Cancel". It means the abort signal was
   * set, and that also happens via `forceReset()` — which fires when a user clicks Sync
   * or Try Again while a run is already going. "I cancelled it" and "it hung so I hit
   * Try Again" are different reports from a user and they produced the same row.
   *
   * THE IMMEDIATE FLUSH IS THE POINT, not a nicety. A restart-while-running is followed
   * within milliseconds by a new `beginSync`, which clears this context — and the
   * abandoned run's own terminal write is suppressed by the orchestrator's `isRunning`
   * guard, so it may never emit at all. Writing the reason now means the abandoned row
   * says `outcome=running, ended_by=restart-while-running`, which is exactly what
   * happened, instead of staying an unexplained open row.
   */
  noteEndedBy(reason: string): void {
    this.setContext({ endedBy: reason });
    this.flushHeartbeat();
  }

  /**
   * Write the current state of a live run to the corpus. NEVER carries `outcome` —
   * see `syncOutcomeSupabase.buildSyncRunProgressRow` for why that is structural.
   */
  private flushHeartbeat(): void {
    if (!this.runReporter || this.runId === null || this.syncStartedAt === null) return;
    const row = this.buildRow("running", this.now() - this.syncStartedAt, {});
    try {
      this.runReporter.heartbeat(row);
    } catch (error) {
      log.warn("[SyncTimeline] heartbeat reporter threw; sync unaffected:", error);
    }
  }

  private startHeartbeat(): void {
    // A REAL TIMER, not a piggyback on the progress stream, and that choice is what
    // makes the instrument able to answer the question. A heartbeat driven by progress
    // events stops when the progress events stop — so a process that is alive but
    // moving nothing and a process that is GONE would leave identical rows. With a
    // timer: both timestamps advancing = moving data; `updated_at` alone advancing =
    // alive and stalled; neither advancing = killed or quit.
    const timer = setInterval(() => this.flushHeartbeat(), this.heartbeatMs);
    // Node's timer only; jsdom's returns a number. Telemetry must never be the reason
    // the main process refuses to exit.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.heartbeatTimer = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * BACKLOG-2914: add facts to the outcome row, from wherever they become known.
   *
   * Merges, so the orchestrator can contribute the device and the prior-backup
   * verdict while the backup service contributes the mode the device reported.
   * Scalars only — the type is the guard, because an object here would stringify
   * to "[object Object]" and a path would put a user's home directory in a log.
   */
  setContext(fields: TimelineMeta): void {
    for (const [key, value] of Object.entries(fields)) {
      // `undefined` renders as the literal string "undefined" through `formatFields`,
      // and a row reading `deviceCapacityBytes=undefined` is indistinguishable from a
      // capacity of zero once it is parsed back out. Caught by
      // `deviceSyncOrchestrator.outcomeDimensions-2914.test.ts` on a producer whose
      // field names had drifted: the value was absent, the row said it was present.
      //
      // Same rule as `BackupSizeReading` and `BackupSizeEstimate` elsewhere in this
      // sync path: a value that was not established is ABSENT, never a stand-in.
      if (value === undefined || value === null) continue;
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      this.context[key] = value;
    }
  }

  /** What the outcome row will carry. Exposed for tests and for support dumps. */
  contextSnapshot(): TimelineMeta {
    return { ...this.context };
  }

  /**
   * BACKLOG-2914: close the open phase WITHOUT opening another.
   *
   * Terminal states are not phases, so `setPhase("complete")` opened nothing — and
   * that left the last real phase OPEN across the IPC handoff to persistence,
   * where it was finally closed by the first `storing:*` enter. Measured on the
   * founder's 2026-08-28 run: `phase=cleanup elapsedMs=246270`, four minutes
   * attributed to closing two SQLite parsers. Almost all of it belonged to the
   * message write that had not been entered yet.
   *
   * A phase that ends must be closed where it ends. Time between phases is then
   * visible as unattributed rather than charged to whichever phase happened to
   * bracket it — the exact warning in this item's spec, observed in production.
   */
  closePhase(): void {
    this.closeOpenPhase();
  }

  /**
   * Enter a phase: closes whichever phase is open (emitting its duration and
   * counts) and opens this one. Re-entering a phase creates a NEW record, so a
   * phase that runs twice is two durations, never one doubled.
   */
  enter(phase: string): void {
    if (this.syncStartedAt === null) this.beginSync();
    this.closeOpenPhase();

    const record: SyncPhaseRecord = {
      phase,
      startedAt: this.now(),
      endedAt: null,
      elapsedMs: null,
      counts: {},
    };
    this.phaseRecords.push(record);
    this.sink(formatPhaseStart(record, record.startedAt - (this.syncStartedAt ?? record.startedAt)));
  }

  /**
   * Attach counts to a phase — the most recent record with that name, whether
   * it is still open or already closed. Merges, so several call sites can each
   * contribute what they know.
   */
  annotate(phase: string, counts: PhaseCounts): void {
    for (let i = this.phaseRecords.length - 1; i >= 0; i--) {
      if (this.phaseRecords[i].phase === phase) {
        Object.assign(this.phaseRecords[i].counts, counts);
        return;
      }
    }
  }

  /**
   * Close the open phase and end the sync.
   *
   * BACKLOG-2914: THE SINGLE CHOKE POINT. Six call sites across the orchestrator and
   * `syncHandlers` reach this, and every one of them now produces an outcome row —
   * success included. That is deliberate: the success row is the denominator, and a
   * second emit site would be a second thing to forget. If a seventh path is ever
   * added that ends a sync without calling this, it will be invisible to every
   * consumer, so end syncs here.
   */
  endSync(outcome: SyncOutcome, counts: PhaseCounts = {}): void {
    this.closeOpenPhase();
    const wasOpen = this.syncStartedAt !== null;
    const elapsedMs = this.syncStartedAt === null ? 0 : this.now() - this.syncStartedAt;
    const fields = formatFields(counts);
    this.sink(
      `[SyncTimeline] sync-end outcome=${outcome} elapsedMs=${elapsedMs}${fields ? " " + fields : ""}`,
    );
    // ONE ROW PER SYNC, and `wasOpen` is what enforces the "one".
    //
    // Six call sites reach `endSync`, across the orchestrator and `syncHandlers`, and
    // they are mutually exclusive TODAY — the orchestrator's `errorResult` paths never
    // emit "complete", so the handler that ends the sync never runs for them. Before
    // this change a second `endSync` cost a duplicate log line, which is noise. Now it
    // would cost a duplicate OUTCOME row, which is a corrupted denominator — the exact
    // number this whole addition exists to produce.
    //
    // The `sync-end` line above is deliberately NOT guarded: it is BACKLOG-2898's
    // contract and a duplicate there is still only noise.
    if (wasOpen) this.emitOutcome(outcome, elapsedMs, counts);
    // BACKLOG-3440: the run is over, so nothing may write to its row again. A heartbeat
    // still firing after the terminal write is the single most likely way this whole
    // instrument could produce a NEW false signal — a completed sync left reading
    // `running` forever. The timer is stopped here; the heartbeat payload also carries
    // no `outcome` at all, so the two guards are independent.
    this.stopHeartbeat();
    this.syncStartedAt = null;
    this.runId = null;
    this.bytesTransferred = null;
    this.bytesLastIncreasedAt = null;
    this.context = {};
  }

  /**
   * BACKLOG-2914 / BACKLOG-3440: the row every consumer reads, at any point in the run.
   *
   * ONE BUILDER, THREE VERBS. The start write, every heartbeat and the terminal write
   * all describe the same run from the same state, so they are the same shape built by
   * the same function — which is also why an abandoned run's row carries its phase
   * breakdown, its device, its prior-backup verdict and its byte counts rather than only
   * a start time. BACKLOG-2914's own measurement was that 5 of 5 `cancelled` runs had no
   * `incremental` and no `backup_mode_source`, because the row was assembled at the end;
   * building it from live state is what fixes that class of gap rather than field by
   * field.
   */
  private buildRow(state: SyncRunState, elapsedMs: number, counts: PhaseCounts): SyncOutcomeRow {
    const closed = this.phaseRecords.filter(
      (r): r is SyncPhaseRecord & { elapsedMs: number } => r.elapsedMs !== null,
    );
    const phases = closed.map((r) => `${r.phase}:${r.elapsedMs}`).join(",");
    // WHERE IT GOT TO. On an abandoned row this is the answer to "where did it stop" —
    // the open phase if one is open, otherwise the last one that closed.
    const lastPhase = this.phaseRecords[this.phaseRecords.length - 1]?.phase;

    const fields: TimelineMeta = {
      // 2952 extends this row rather than defining a second one, so the dimension
      // that separates the sources is present even while there is only one.
      source: SYNC_OUTCOME_SOURCE,
      outcome: state,
      elapsedMs,
      ...this.context,
      ...counts,
      ...(phases ? { phases } : {}),
      ...(lastPhase ? { lastPhase } : {}),
      ...(this.bytesTransferred !== null ? { bytesTransferred: this.bytesTransferred } : {}),
      ...(this.bytesLastIncreasedAt !== null
        ? { bytesLastIncreasedAt: this.bytesLastIncreasedAt }
        : {}),
    };

    return {
      source: SYNC_OUTCOME_SOURCE,
      outcome: state,
      elapsedMs,
      phases: closed.map((r) => ({ phase: r.phase, elapsedMs: r.elapsedMs })),
      fields,
      runId: this.runId ?? "",
      startedAt: this.syncStartedAt ?? this.now(),
    };
  }

  /**
   * BACKLOG-2914: the terminal row. Every dimension that was established, plus the
   * per-phase durations so a regression can be attributed to a phase rather than to
   * "syncs got slower".
   *
   * THREE destinations, and the log line is only the first. PR #2422 shipped the row
   * to `log.info` alone, which meant it never left the user's machine and the
   * per-release question stayed unanswerable. It now also goes to Sentry (an event,
   * for grouping and per-release comparison) and to Supabase (Postgres, for the
   * duration corpus BACKLOG-2894 will fit a model against). See syncOutcomeReporter.
   */
  private emitOutcome(outcome: SyncOutcome, elapsedMs: number, counts: PhaseCounts): void {
    const row = this.buildRow(outcome, elapsedMs, counts);

    // THE LOG LINE STAYS, AND STAYS FIRST. It is what made the 2026-08-28 diagnosis
    // possible on a machine with no network, and it is the only sink that works when
    // the user is signed out. Byte-identical to what BACKLOG-2898's consumers parse.
    this.sink(`[SyncTimeline] sync-outcome ${formatFields(row.fields)}`);

    // BACKLOG-2914 (transport): and now it also LEAVES THE MACHINE.
    //
    // Guarded because a reporter is I/O-adjacent and this is the sync's critical path.
    // A telemetry sink that can fail a user's 52-minute sync is worse than no telemetry
    // sink: the reporters are best-effort internally as well, and this catch is the
    // second wall, not the first.
    try {
      this.reporter(row);
    } catch (error) {
      log.warn("[SyncTimeline] outcome reporter threw; sync unaffected:", error);
    }
  }

  /**
   * Record a decision that is not a phase — a branch taken, a value chosen.
   *
   * BACKLOG-2896 needed exactly this and could not get it: whether the backup
   * ran incrementally was decided by which size-estimate branch was taken, and
   * the two `log.info` lines that recorded it had rotated out of BOTH the
   * founder's main.log AND main.old.log. They appear zero times across the
   * complete retained history of that incident, so the question is permanently
   * unanswerable for it. A mark is one short line, emitted at a decision point,
   * that makes the NEXT sync answerable.
   */
  mark(name: string, fields: TimelineMeta = {}): void {
    const formatted = formatFields(fields);
    this.sink(`[SyncTimeline] mark name=${name}${formatted ? " " + formatted : ""}`);
  }

  /** Every phase of the current (or just-finished) sync, in order. */
  records(): SyncPhaseRecord[] {
    return this.phaseRecords.map((r) => ({ ...r, counts: { ...r.counts } }));
  }

  /** Drop all state without emitting. */
  reset(): void {
    this.stopHeartbeat();
    this.phaseRecords = [];
    this.syncStartedAt = null;
    this.runId = null;
    this.bytesTransferred = null;
    this.bytesLastIncreasedAt = null;
    this.context = {};
  }

  private closeOpenPhase(): void {
    const open = this.phaseRecords[this.phaseRecords.length - 1];
    if (!open || open.endedAt !== null) return;
    open.endedAt = this.now();
    open.elapsedMs = open.endedAt - open.startedAt;
    this.sink(formatPhaseEnd(open));
  }
}

/**
 * The process-wide timeline. One sync runs at a time (the orchestrator refuses
 * a second: "Sync already in progress"), so a single instance is correct.
 */
export const syncTimeline = new SyncTimeline();
