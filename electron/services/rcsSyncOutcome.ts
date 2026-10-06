/**
 * BACKLOG-3671 P2 — Google Messages Syncs in the sync_outcomes corpus.
 *
 * One row per Sync (source 'google-messages'), written through the same
 * fire-and-forget writer as the iPhone Sync (syncOutcomeSupabase):
 *   start      at the page's claim;
 *   heartbeat  on /progress, throttled, and ONLY while the row is running
 *              (a late heartbeat can never touch a finished row);
 *   terminal   when the run ends — a finished cache Sync after the save's
 *              result (the existing /finish wait), so the row has what Keepr
 *              SAVED; failed / stopped at once;
 *   follow-up  anything that arrives after the terminal row updates
 *              source_metrics ONLY (never outcome, never reason_code).
 * An unclaimed Sync that expired (never opened) has no start row: it gets a
 * terminal row of its own (error / not_opened).
 *
 * PRIVACY: counts, timings, codes and version strings only. No names, no
 * numbers, no conversation ids, no salted tags. `buildRcsSourceMetrics` is
 * the ONLY writer of source_metrics: named keys, finite numbers ≥ 0 (clamped),
 * enums from fixed sets — anything else is dropped. Raw arrays never arrive
 * (the extension computes p50 / p90 / slowest itself).
 */

import { randomUUID } from "crypto";
import type { SyncOutcomeRow, SyncOutcomePhase, SyncRunState } from "./syncTimeline";
import type { RcsCacheSaved, RcsJobSnapshot } from "./rcsImportJob";

export const RCS_SYNC_OUTCOME_SOURCE = "google-messages";
/** A live run refreshes its row at most this often. */
export const RCS_HEARTBEAT_MS = 60_000;
/** How long a finished cache Sync waits for the save before its terminal row (the /finish wait). */
export const RCS_TERMINAL_SAVE_WAIT_MS = 30_000;

/** What kind of Sync this was (typed column run_kind). */
export const RCS_RUN_KINDS = ["sync", "retry", "older", "transaction"] as const;
export type RcsRunKind = (typeof RCS_RUN_KINDS)[number];

/** A version string: "0.3.52", "141.0.7390.55". */
export const VERSION_PATTERN = /^\d+(\.\d+){1,3}$/;

const MAX_MS = 7 * 24 * 3600_000; // a week
const MAX_COUNT = 10_000_000;
const MAX_BYTES = 1e13; // 10 TB

/** A finite number ≥ 0, clamped and rounded; anything else is dropped. */
function n(v: unknown, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return Math.round(Math.min(v, max));
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
/** Only the keys that were established (absent stays absent). */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
export function cleanVersion(v: unknown): string | undefined {
  return typeof v === "string" && v.length <= 32 && VERSION_PATTERN.test(v) ? v : undefined;
}
export function cleanRunKind(v: unknown): RcsRunKind | undefined {
  return typeof v === "string" && (RCS_RUN_KINDS as readonly string[]).includes(v) ? (v as RcsRunKind) : undefined;
}

/** What the extension sends with /finish, /error and /cancel (camelCase, numbers only). */
export interface RcsExtensionMetrics {
  finding?: { ms?: number; chatsFound?: number; chatsInRange?: number; chatsSkippedHidden?: number; chatsSkippedDisabled?: number };
  reading?: {
    ms?: number; chatsRead?: number; chatsSkipped?: number; chatsFailed?: number; chatsAlreadySaved?: number;
    messagesRead?: number; photosRead?: number; bytesRead?: number;
    perChatP50Ms?: number; perChatP90Ms?: number; perChatSlowestMs?: number;
    /** Chats opened and finished with (any result); the per-chat times are over these. ≥ chatsRead. */
    chatsOpened?: number;
    /** Live A/B (visible vs hidden tab): run totals of each step (ms), and the slowest photo. */
    detailsMs?: number; historyMs?: number; settleMs?: number; commitMs?: number;
    photoReadMs?: number; photoUploadMs?: number; photoReadMaxMs?: number; photoUploadMaxMs?: number;
  };
  hidden?: { ms?: number; spells?: number };
  chromeVersion?: string;
}

/** Keepr's own saving numbers (the commit's result). */
export interface RcsSavingMetrics {
  ms?: number;
  messagesSaved?: number;
  messagesNew?: number;
  photosSaved?: number;
  bytesSaved?: number;
}

/** The end of a run, as source_metrics records it. */
export interface RcsEndMetrics {
  outcome?: string;
  reasonCode?: string;
  totalMs?: number;
}

const OUTCOMES = new Set(["running", "complete", "cancelled", "error"]);
/** A failure / stop code: lower snake case, short. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * THE ONLY WRITER of sync_outcomes.source_metrics. Named keys only; numbers
 * finite, ≥ 0 and clamped; enums from fixed sets. Unknown keys, non-finite
 * numbers, negative numbers, bad enums and any string that is not a code
 * are dropped.
 */
export function buildRcsSourceMetrics(input: {
  runKind?: unknown;
  extension?: unknown;
  saving?: unknown;
  end?: unknown;
}): Record<string, unknown> {
  const ext = obj(input.extension);
  const f = obj(ext.finding);
  const r = obj(ext.reading);
  const h = obj(ext.hidden);
  const s = obj(input.saving);
  const e = obj(input.end);
  const finding = defined({
    ms: n(f.ms, MAX_MS),
    chats_found: n(f.chatsFound, MAX_COUNT),
    chats_in_range: n(f.chatsInRange, MAX_COUNT),
    chats_skipped_hidden: n(f.chatsSkippedHidden, MAX_COUNT),
    chats_skipped_disabled: n(f.chatsSkippedDisabled, MAX_COUNT),
  });
  const reading = defined({
    ms: n(r.ms, MAX_MS),
    chats_read: n(r.chatsRead, MAX_COUNT),
    chats_skipped: n(r.chatsSkipped, MAX_COUNT),
    chats_failed: n(r.chatsFailed, MAX_COUNT),
    chats_already_saved: n(r.chatsAlreadySaved, MAX_COUNT),
    messages_read: n(r.messagesRead, MAX_COUNT),
    photos_read: n(r.photosRead, MAX_COUNT),
    bytes_read: n(r.bytesRead, MAX_BYTES),
    per_chat_p50_ms: n(r.perChatP50Ms, MAX_MS),
    per_chat_p90_ms: n(r.perChatP90Ms, MAX_MS),
    per_chat_slowest_ms: n(r.perChatSlowestMs, MAX_MS),
    // chats_read: chats whose messages were sent to Keepr (≥ 1 message);
    // chats_opened: chats opened and finished with, any result (the per-chat
    // times' sample). Live 0.3.57: an unnamed "count" next to chats_read read
    // as a contradiction.
    chats_opened: n(r.chatsOpened, MAX_COUNT),
    details_ms: n(r.detailsMs, MAX_MS),
    history_ms: n(r.historyMs, MAX_MS),
    settle_ms: n(r.settleMs, MAX_MS),
    commit_ms: n(r.commitMs, MAX_MS),
    photo_read_ms: n(r.photoReadMs, MAX_MS),
    photo_upload_ms: n(r.photoUploadMs, MAX_MS),
    photo_read_max_ms: n(r.photoReadMaxMs, MAX_MS),
    photo_upload_max_ms: n(r.photoUploadMaxMs, MAX_MS),
  });
  const saving = defined({
    ms: n(s.ms, MAX_MS),
    messages_saved: n(s.messagesSaved, MAX_COUNT),
    messages_new: n(s.messagesNew, MAX_COUNT),
    photos_saved: n(s.photosSaved, MAX_COUNT),
    bytes_saved: n(s.bytesSaved, MAX_BYTES),
  });
  const end = defined({
    outcome: typeof e.outcome === "string" && OUTCOMES.has(e.outcome) ? e.outcome : undefined,
    reason_code: typeof e.reasonCode === "string" && CODE_PATTERN.test(e.reasonCode) ? e.reasonCode : undefined,
    total_ms: n(e.totalMs, MAX_MS),
    hidden_ms: n(h.ms, MAX_MS),
    hidden_spells: n(h.spells, MAX_COUNT),
  });
  return defined({
    v: 1,
    run_kind: cleanRunKind(input.runKind),
    finding: Object.keys(finding).length > 0 ? finding : undefined,
    reading: Object.keys(reading).length > 0 ? reading : undefined,
    saving: Object.keys(saving).length > 0 ? saving : undefined,
    end: Object.keys(end).length > 0 ? end : undefined,
  });
}

/** The job's end → the corpus outcome and reason code. */
export function rcsOutcomeFor(snap: Pick<RcsJobSnapshot, "state" | "error" | "endedBy">): {
  outcome: SyncRunState;
  reasonCode?: string;
  endedBy?: string;
} {
  switch (snap.state) {
    case "finished":
      return { outcome: "complete" };
    case "failed": {
      const code = snap.error?.code;
      return { outcome: "error", reasonCode: typeof code === "string" && CODE_PATTERN.test(code) ? code : "unknown" };
    }
    case "cancelled":
      return snap.endedBy === "user_page"
        ? { outcome: "cancelled", reasonCode: "user_stop", endedBy: "user_page" }
        : { outcome: "cancelled", reasonCode: "keepr_cancel", endedBy: "keepr" };
    default:
      return { outcome: "running" };
  }
}

/** The writer (syncOutcomeSupabase); injectable for tests. */
export interface RcsOutcomeWriter {
  start(row: SyncOutcomeRow): void;
  heartbeat(row: SyncOutcomeRow): void;
  /** May return the settled write: a follow-up is chained after it. */
  terminal(row: SyncOutcomeRow): void | Promise<void>;
  metrics(row: SyncOutcomeRow): void;
}

interface RunState {
  runId: string;
  startedAt: number;
  runKind: RcsRunKind;
  claimed: boolean;
  lastBeat: number;
  extension?: unknown;
  saving?: RcsSavingMetrics;
  finishAt?: number;
  terminal?: { outcome: SyncRunState; reasonCode?: string; endedBy?: string; endedAt: number };
  terminalWritten: boolean;
  /** Settles once the terminal write has landed or been dropped (never rejects). */
  terminalDone?: Promise<void>;
  waitTimer?: ReturnType<typeof setTimeout>;
  bytesSaved: number;
}

/**
 * The per-Sync bookkeeping. Every method is synchronous, void and never
 * throws into the Sync (the writer fires and forgets).
 */
export class RcsSyncOutcomeTracker {
  private runs = new Map<string, RunState>();
  private extensionVersion: string | undefined;

  constructor(
    private readonly writer: RcsOutcomeWriter,
    private readonly opts: { now?: () => number; heartbeatMs?: number; saveWaitMs?: number; newId?: () => string } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** /hello: the extension's version (a version string only). */
  hello(version: unknown): void {
    const v = cleanVersion(version);
    if (v) this.extensionVersion = v;
  }

  /** A job was created: what kind of Sync it is. */
  created(jobId: string, runKind: RcsRunKind): void {
    if (this.runs.has(jobId)) return;
    this.runs.set(jobId, {
      runId: this.opts.newId ? this.opts.newId() : randomUUID(),
      startedAt: this.now(),
      runKind,
      claimed: false,
      lastBeat: 0,
      terminalWritten: false,
      bytesSaved: 0,
    });
  }

  private run(jobId: string): RunState {
    let r = this.runs.get(jobId);
    if (!r) {
      this.created(jobId, "sync");
      r = this.runs.get(jobId) as RunState;
    }
    return r;
  }

  /** The page claimed the job: the row exists from now on. */
  claimed(snap: RcsJobSnapshot): void {
    const r = this.run(snap.jobId);
    r.claimed = true;
    r.startedAt = this.now();
    r.lastBeat = r.startedAt;
    this.writer.start(this.row(snap.jobId, snap, "running"));
  }

  /** /progress: a throttled heartbeat (only while the row is running). */
  progress(snap: RcsJobSnapshot): void {
    const r = this.runs.get(snap.jobId);
    if (!r || !r.claimed || r.terminal) return;
    const t = this.now();
    if (t - r.lastBeat < (this.opts.heartbeatMs ?? RCS_HEARTBEAT_MS)) return;
    r.lastBeat = t;
    this.writer.heartbeat(this.row(snap.jobId, snap, "running"));
  }

  /** A stored photo's size (bytes saved; a number only). */
  photoStored(jobId: string, bytes: number): void {
    const r = this.runs.get(jobId);
    if (r && Number.isFinite(bytes) && bytes > 0) r.bytesSaved += bytes;
  }

  /** The extension's numbers (with /finish, /error or /cancel). */
  extensionMetrics(jobId: string, raw: unknown): void {
    const r = this.runs.get(jobId);
    if (r && raw && typeof raw === "object") r.extension = raw;
  }

  /** /finish arrived: the save starts now (its time is measured by Keepr). */
  finishing(jobId: string): void {
    const r = this.runs.get(jobId);
    if (r) r.finishAt = this.now();
  }

  /** The job ended (onJobEnded). A finished cache Sync waits for its save. */
  ended(snap: RcsJobSnapshot): void {
    const r = this.runs.get(snap.jobId);
    const end = rcsOutcomeFor(snap);
    if (!r) return;
    if (r.terminal) return;
    r.terminal = { ...end, endedAt: this.now() };
    // Never claimed: only an expiry (never opened) is worth a row.
    if (!r.claimed && !(snap.state === "failed" && snap.error?.code === "not_opened")) {
      this.runs.delete(snap.jobId);
      return;
    }
    if (snap.state === "finished" && snap.kind === "cache" && r.saving === undefined) {
      r.waitTimer = setTimeout(() => this.writeTerminal(snap), this.opts.saveWaitMs ?? RCS_TERMINAL_SAVE_WAIT_MS);
      r.waitTimer.unref?.();
      return;
    }
    this.writeTerminal(snap);
  }

  /** The cache save's result (recordCacheSaved). After the terminal row: a follow-up. */
  saved(snap: RcsJobSnapshot, saved: RcsCacheSaved | null): void {
    const r = this.runs.get(snap.jobId);
    if (!r) return;
    r.saving = {
      ms: r.finishAt !== undefined ? this.now() - r.finishAt : undefined,
      messagesSaved: saved?.messages,
      messagesNew: saved?.newMessages,
      photosSaved: saved?.photos,
      bytesSaved: r.bytesSaved,
    };
    if (r.terminalWritten) {
      // SR: strictly AFTER the terminal upsert resolves, never concurrently —
      // otherwise the terminal row (no saving block) could land last and
      // overwrite this one.
      const followUp = this.row(snap.jobId, snap, r.terminal?.outcome ?? "complete");
      const after = r.terminalDone ?? Promise.resolve();
      void after.then(() => this.writer.metrics(followUp)).catch(() => undefined);
      this.runs.delete(snap.jobId);
      return;
    }
    if (r.terminal) {
      if (r.waitTimer) clearTimeout(r.waitTimer);
      this.writeTerminal(snap);
    }
  }

  private writeTerminal(snap: RcsJobSnapshot): void {
    const r = this.runs.get(snap.jobId);
    if (!r || r.terminalWritten || !r.terminal) return;
    r.terminalWritten = true;
    r.terminalDone = Promise.resolve(this.writer.terminal(this.row(snap.jobId, snap, r.terminal.outcome))).catch(() => undefined);
    // A finished cache Sync whose save has not answered yet keeps its entry
    // for the follow-up; everything else is done.
    if (!(snap.state === "finished" && snap.kind === "cache" && r.saving === undefined)) this.runs.delete(snap.jobId);
  }

  /** The row for this run, built only from named values. */
  private row(jobId: string, snap: RcsJobSnapshot, outcome: SyncRunState): SyncOutcomeRow {
    const r = this.run(jobId);
    const ext = obj(r.extension);
    const endAt = r.terminal?.endedAt ?? this.now();
    const elapsedMs = Math.max(0, endAt - r.startedAt);
    const phases: SyncOutcomePhase[] = [];
    for (const name of ["finding", "reading"] as const) {
      const ms = n(obj(ext[name]).ms, MAX_MS);
      if (ms !== undefined) phases.push({ phase: name, elapsedMs: ms } as SyncOutcomePhase);
    }
    if (r.saving?.ms !== undefined) phases.push({ phase: "saving", elapsedMs: r.saving.ms } as SyncOutcomePhase);
    const reasonCode = r.terminal?.reasonCode;
    const p = snap.progress;
    const sourceMetrics = buildRcsSourceMetrics({
      runKind: r.runKind,
      extension: r.extension ?? {
        // Before the extension's own numbers arrive: the bridge's counts.
        finding: { chatsFound: p?.listed, chatsInRange: p?.candidates },
        reading: { chatsRead: p?.imported, messagesRead: p?.messages, photosRead: p?.images },
      },
      saving: r.saving,
      end: outcome === "running" ? undefined : { outcome, reasonCode, totalMs: elapsedMs },
    });
    const chrome = cleanVersion(ext.chromeVersion);
    return {
      source: RCS_SYNC_OUTCOME_SOURCE,
      outcome,
      elapsedMs,
      phases,
      runId: r.runId,
      startedAt: r.startedAt,
      sourceMetrics,
      fields: defined({
        runKind: r.runKind,
        extensionVersion: this.extensionVersion,
        chromeVersion: chrome,
        reasonCode,
        endedBy: r.terminal?.endedBy,
        lastPhase: outcome === "running" ? ((p?.candidates ?? 0) > 0 ? "reading" : "finding") : undefined,
      }) as SyncOutcomeRow["fields"],
    };
  }
}
