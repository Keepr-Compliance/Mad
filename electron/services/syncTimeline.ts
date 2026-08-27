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

import log from "electron-log";

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

export class SyncTimeline {
  private phaseRecords: SyncPhaseRecord[] = [];
  private syncStartedAt: number | null = null;
  private readonly now: () => number;
  private readonly sink: TimelineSink;

  constructor(options: { now?: () => number; sink?: TimelineSink } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sink = options.sink ?? ((line: string) => log.info(line));
  }

  /** Start a sync. Clears any previous run's records. */
  beginSync(meta: TimelineMeta = {}): void {
    this.phaseRecords = [];
    this.syncStartedAt = this.now();
    const fields = formatFields(meta);
    this.sink(`[SyncTimeline] sync-start${fields ? " " + fields : ""}`);
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

  /** Close the open phase and end the sync. */
  endSync(outcome: "complete" | "cancelled" | "error", counts: PhaseCounts = {}): void {
    this.closeOpenPhase();
    const elapsedMs = this.syncStartedAt === null ? 0 : this.now() - this.syncStartedAt;
    const fields = formatFields(counts);
    this.sink(
      `[SyncTimeline] sync-end outcome=${outcome} elapsedMs=${elapsedMs}${fields ? " " + fields : ""}`,
    );
    this.syncStartedAt = null;
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
    this.phaseRecords = [];
    this.syncStartedAt = null;
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
