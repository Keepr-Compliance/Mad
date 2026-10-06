/**
 * RCS import job — BACKLOG-3620.
 *
 * "Sync" on a transaction starts a JOB: Keepr opens Messages for Web in the
 * browser with `#keepr-job=<jobId>`, the extension claims the job, scans the
 * conversation list for chats whose name looks like a transaction contact,
 * reads each candidate's phone numbers from its Details panel and asks Keepr
 * whether they match. Only a chat Keepr has matched may be imported.
 *
 * This module is the job's state, and nothing else: pure, no I/O, `now()`
 * injected. The bridge (`rcsExtensionBridge.ts`) calls it for every job route.
 *
 * ## Rules it enforces
 * - One job at a time. Its id is `crypto.randomUUID()` and doubles as the
 *   per-job secret: every job route names it, and a wrong id is refused.
 * - A job is claimed once. A second claim is refused ("already running").
 * - A job nobody claims within {@link RCS_JOB_UNCLAIMED_MS} fails with
 *   {@link RCS_JOB_NOT_OPENED_MESSAGE} — the default browser was not Chrome
 *   with the extension, or the page never saw the job.
 * - The phone gate: a chat matches a contact only when one of the numbers the
 *   page shows and one of the contact's numbers are EQUAL after `toE164`.
 *   Deliberately not `phoneNumbersMatch`: its last-10-digit fallback would
 *   let a foreign number sharing ten digits through the only real gate.
 * - A chat or image is accepted only for a conversation this job matched.
 * - The job is independent of the manual-send session: closing the Import
 *   panel's session does not touch a running job.
 */

import * as crypto from "crypto";

import { toE164 } from "../utils/phoneNormalization";

export const RCS_JOB_UNCLAIMED_MS = 60_000;
export const RCS_JOB_NOT_OPENED_MESSAGE =
  "Messages for Web didn't open in Chrome with the Keepr extension. Open it in Chrome and click Sync again.";
export const RCS_NOT_SIGNED_IN_MESSAGE =
  "Sign in to Google Messages, then click Sync in Keepr again";

export type RcsJobState =
  | "created"
  | "running"
  | "finished"
  | "failed"
  | "cancelled";

/**
 * BACKLOG-3658: the cache of all recent chats — the only kind (founder,
 * 2026-10-05: the per-transaction Sync was removed; it can come back later).
 */
export type RcsJobKind = "cache";

/** BACKLOG-3658: the label every Sync button shows for a cache job. */
export const RCS_CACHE_JOB_LABEL = "all Android texts";
/** SR (2026-10-02): at most this many deal chats in a claim's must-see list (the page checks at most 300 chats). */
export const RCS_DEAL_CHATS_MAX = 300;

export interface RcsJobProgress {
  listed: number;
  candidates: number;
  checked: number;
  matched: number;
  imported: number;
  messages: number;
  images: number;
  reactions: number;
  skipped: number;
  /** BACKLOG-3645: chats in the list the page did not check (over the cap). */
  notChecked: number;
  /** BACKLOG-3664: AI assistant chats (Gemini) skipped — not text conversations. */
  notText: number;
  /** Chats that have no messages yet (e.g. a new group), reported with /finish. */
  noMessagesYet: number;
  /** BACKLOG-3642: messages stored but not linked again — the user removed them. */
  removedNotRelinked: number;
  /** BACKLOG-3658: cache images not kept (the chat has no transaction contact). */
  imagesSkipped: number;
  /** BACKLOG-3658 P3c: chats not synced because the user switched them off. */
  notSynced: number;
}

/**
 * BACKLOG-3629: a chat the page left out of the import, or imported only in
 * part. Names only (never numbers). `count` is the number of images that
 * failed, for `images_failed`.
 */
export interface RcsJobNotReached {
  name: string;
  reason: string;
  count?: number;
}

/** At most this many {@link RcsJobNotReached} entries are kept per job. */
export const RCS_NOT_REACHED_CAP = 20;

/**
 * Validate the page's `/finish` list: keep well-formed entries up to the cap;
 * the rest (plus the page's own "more" count) go into `more`.
 */
export function parseNotReached(
  list: unknown,
  moreFromPage: unknown,
): { entries: RcsJobNotReached[]; more: number } {
  const entries: RcsJobNotReached[] = [];
  let more =
    typeof moreFromPage === "number" && Number.isFinite(moreFromPage) && moreFromPage > 0
      ? Math.floor(moreFromPage)
      : 0;
  if (Array.isArray(list)) {
    for (const item of list as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.name !== "string" || typeof rec.reason !== "string") continue;
      if (entries.length >= RCS_NOT_REACHED_CAP) {
        more += 1;
        continue;
      }
      const entry: RcsJobNotReached = { name: rec.name.slice(0, 120), reason: rec.reason.slice(0, 40) };
      if (typeof rec.count === "number" && Number.isFinite(rec.count)) entry.count = Math.floor(rec.count);
      entries.push(entry);
    }
  }
  return { entries, more };
}

export interface RcsJobSnapshot {
  /** Founder (2026-10-02): "user_page" when Stop sync on the page ended it. */
  endedBy?: "user_page";
  jobId: string;
  state: RcsJobState;
  stage: string;
  progress: RcsJobProgress;
  error?: { code: string; message: string };
  createdAt: string;
  finishedAt?: string;
  /** BACKLOG-3661: what is syncing. */
  label?: string;
  /** BACKLOG-3658: always "cache". */
  kind?: RcsJobKind;
  /** BACKLOG-3663: this cache run reads down to the floor again (older texts). */
  readingOlder?: boolean;
  /** BACKLOG-3629: chats left out or imported in part (sent with /finish). */
  notReached?: RcsJobNotReached[];
  /** Entries beyond {@link RCS_NOT_REACHED_CAP}. */
  notReachedMore?: number;
  /**
   * A finished cache job: what Keepr SAVED (after the commit's limits), or
   * null when the save failed. Absent while it is still saving.
   */
  saved?: RcsCacheSaved | null;
  /** L2: how the page's list scan stopped (from /finish). */
  listStop?: string;
  /** SR: the phone was gone at some point (the page said so at /finish). */
  phoneDisconnected?: boolean;
}

/** What a cache job's commit saved: the counts the done screens show. */
export interface RcsCacheSaved {
  /** Chats with at least one message saved (a chat all below the floor is not counted). */
  chats: number;
  /** Messages saved (new + already in Keepr). */
  messages: number;
  /** Of those, new to Keepr. */
  newMessages: number;
  /** BACKLOG-3658 #14: reactions (tapbacks) saved (new + already in Keepr). Counts only. */
  reactions?: number;
  /** Live (0.3.18): of those, new to Keepr (as newMessages for messages). */
  newReactions?: number;
  /** Storyboard A10/A11: photos in Keepr for this Sync (stored + already there). */
  photos?: number;
}

/** What the page receives when it claims a job: no names, no numbers. */
export interface RcsJobClaim {
  jobId: string;
  /** The history floor (the same as `since`). */
  startDate: string | null;
  /** BACKLOG-3658: load each chat back to `since`. */
  kind: RcsJobKind;
  /** Live (0.3.15): the full floor, and chats switched back on — read to it whatever their age. Ids only. */
  floor?: string;
  pendingConversationIds?: string[];
  /**
   * SR (2026-10-02): chats on a live deal not yet read back to their deal's
   * audit start — the list scan goes past the settings floor until it has
   * seen them, never past `dealFloor` (the oldest such start). Ids only.
   */
  dealConversationIds?: string[];
  dealFloor?: string;
  since?: string;
}

/**
 * BACKLOG-3642: a chat's participant set as one key — the sorted, de-duplicated
 * E.164 numbers joined by ",". Numbers that do not normalize to "+…" are
 * dropped; an empty set gives "" (never a match).
 */
export function participantKey(numbers: readonly string[]): string {
  const set = new Set<string>();
  for (const n of numbers) {
    const e = toE164(n);
    if (e && e.startsWith("+")) set.add(e);
  }
  return Array.from(set).sort().join(",");
}

/**
 * `transactions.started_at` as the job's history floor: the value when it
 * parses as a date, otherwise null ("no date floor").
 */
export function jobStartDate(startedAt: string | null | undefined): string | null {
  if (typeof startedAt !== "string") return null;
  const v = startedAt.trim();
  if (!v || Number.isNaN(Date.parse(v))) return null;
  return v;
}

export type RcsJobCheck =
  | { ok: true; job: RcsImportJob }
  | { ok: false; status: 403 | 404 | 409 | 410; error: string; message: string };

const EMPTY_PROGRESS: RcsJobProgress = {
  listed: 0,
  candidates: 0,
  checked: 0,
  matched: 0,
  imported: 0,
  messages: 0,
  images: 0,
  reactions: 0,
  skipped: 0,
  notChecked: 0,
  notText: 0,
  noMessagesYet: 0,
  removedNotRelinked: 0,
  imagesSkipped: 0,
  notSynced: 0,
};

export class RcsImportJob {
  readonly jobId: string;
  readonly createdAtMs: number;
  state: RcsJobState = "created";
  stage = "Waiting for Messages for Web to open in Chrome";
  progress: RcsJobProgress = { ...EMPTY_PROGRESS };
  error?: { code: string; message: string };
  finishedAtMs?: number;
  /** BACKLOG-3629: set from the page's /finish (see RcsJobNotReached). */
  notReached: RcsJobNotReached[] = [];
  notReachedMore = 0;
  /** A finished cache job's saved result (undefined: still saving; null: failed). */
  saved?: RcsCacheSaved | null;
  /** L2: how the page's list scan stopped (since | stable | max_items | max_time), from /finish. */
  listStop: string | null = null;
  /** SR: the page says the phone was gone at some point in this run. */
  phoneDisconnected = false;
  /** BACKLOG-3661: what is syncing, for "Syncing: <label>". */
  label: string | null = null;
  /** BACKLOG-3658: the job kind; the user it was started for (rows go to that user only). */
  readonly kind: RcsJobKind = "cache";
  /** BACKLOG-3663: a cache run reading down to its floor again. */
  readingOlder = false;
  /** Live (0.3.15): the full floor, and the chats switched back on (read to it whatever their age). */
  floorISO: string | null = null;
  pendingConversationIds: string[] = [];
  dealConversationIds: string[] = [];
  dealFloorISO: string | null = null;
  /** Storyboard H03: a Try again run (it skips the chats the failed one saved). */
  retrying = false;
  userId: string | null = null;
  /** BACKLOG-3658: own numbers known before this job (persisted), excluded from the first chat. */
  seededOwnNumbers = new Set<string>();
  /** History floor sent to the page on claim (see RcsJobClaim.startDate). */
  readonly startDate: string | null;
  /** The conversations checked and kept (a number on their Details). */
  private readonly matched = new Set<string>();
  /** conversationId -> the normalized E.164 numbers its Details showed (BACKLOG-3630). */
  private readonly participantNumbers = new Map<string, string[]>();

  constructor(nowMs: number, jobId?: string, startDate: string | null = null) {
    this.jobId = jobId ?? crypto.randomUUID();
    this.startDate = jobStartDate(startDate);
    this.createdAtMs = nowMs;
  }

  get isActive(): boolean {
    return this.state === "created" || this.state === "running";
  }

  snapshot(): RcsJobSnapshot {
    return {
      jobId: this.jobId,
      state: this.state,
      stage: this.stage,
      progress: { ...this.progress },
      ...(this.error ? { error: { ...this.error } } : {}),
      createdAt: new Date(this.createdAtMs).toISOString(),
      ...(this.finishedAtMs !== undefined
        ? { finishedAt: new Date(this.finishedAtMs).toISOString() }
        : {}),
      ...(this.label ? { label: this.label } : {}),
      kind: this.kind,
      ...(this.readingOlder ? { readingOlder: true } : {}),
      ...(this.notReached.length > 0 || this.notReachedMore > 0
        ? { notReached: this.notReached.map((e) => ({ ...e })), notReachedMore: this.notReachedMore }
        : {}),
      ...(this.saved !== undefined ? { saved: this.saved ? { ...this.saved } : null } : {}),
      ...(this.listStop ? { listStop: this.listStop } : {}),
      ...(this.phoneDisconnected ? { phoneDisconnected: true } : {}),
      ...(this.endedBy ? { endedBy: this.endedBy } : {}),
    };
  }

  /** A finished cache job's saved result (null: the save failed). Once. */
  setSaved(saved: RcsCacheSaved | null): void {
    if (this.state !== "finished" || this.saved !== undefined) return;
    this.saved = saved ? { ...saved } : null;
  }

  /**
   * SR (live): an extension said, unsigned, "no link here" while this job
   * waited. A hint only (a second, unlinked Chrome profile says it too, and
   * the linked profile may still claim): if the job then expires unclaimed it
   * ends as keepr_refused with this message instead of not_opened.
   */
  private unlinkedHint: string | null = null;

  markUnlinkedHint(message: string): void {
    if (this.state === "created") this.unlinkedHint = message;
  }

  /** Expire an unclaimed job. Returns true when this call expired it. */
  expireIfUnclaimed(nowMs: number): boolean {
    if (this.state !== "created") return false;
    if (nowMs - this.createdAtMs < RCS_JOB_UNCLAIMED_MS) return false;
    if (this.unlinkedHint !== null) this.fail("keepr_refused", this.unlinkedHint, nowMs);
    else this.fail("not_opened", RCS_JOB_NOT_OPENED_MESSAGE, nowMs);
    return true;
  }

  claim(nowMs: number): RcsJobClaim | { error: string; message: string; status: 409 | 410 } {
    this.expireIfUnclaimed(nowMs);
    if (this.state === "running") {
      return { status: 409, error: "already_running", message: "This Keepr sync is already running in another tab." };
    }
    if (this.state !== "created") {
      return { status: 410, error: "job_over", message: "This Keepr sync has ended. Click Sync in Keepr again." };
    }
    this.state = "running";
    // BACKLOG-3658: no names; history back to `since`.
    this.stage = "Saving your recent chats";
    return {
      jobId: this.jobId,
      kind: "cache",
      startDate: this.startDate,
      since: this.startDate ?? undefined,
      ...(this.floorISO ? { floor: this.floorISO } : {}),
      ...(this.pendingConversationIds.length > 0 ? { pendingConversationIds: [...this.pendingConversationIds] } : {}),
      ...(this.dealConversationIds.length > 0 && this.dealFloorISO
        ? { dealConversationIds: [...this.dealConversationIds], dealFloor: this.dealFloorISO }
        : {}),
      ...(this.retrying ? { retrying: true } : {}),
    };
  }

  /**
   * BACKLOG-3642: the participant key of a chat this job matched, from the
   * numbers its Details showed ("" when unknown). Stored with the chat's rows
   * so a later removal can be recognised after a re-pair changes the id.
   */
  /**
   * The chat's numbers for its key (BACKLOG-3630), minus a likely OWN number
   * (SR optional): the page skips a Details row named "You", but if the user's
   * row is not labelled so, their number would make keys inconsistent. A chat
   * never keeps zero numbers. Limit: chats imported before the second chat was
   * checked keep the number (no evidence yet).
   */
  numbersFor(conversationId: string): string[] {
    const numbers = this.participantNumbers.get(conversationId) ?? [];
    const own = this.likelyOwnNumbers();
    const kept = numbers.filter((n) => !own.has(n));
    return kept.length > 0 ? kept : [...numbers];
  }

  /**
   * A number shown in EVERY checked chat's Details — only once 2+ chats were
   * checked, and only when every checked chat showed 2+ numbers (the user's
   * own row always sits beside someone else's; a contact shown alone in a 1:1
   * chat is never dropped).
   */
  private likelyOwnNumbers(): Set<string> {
    const detected = this.commonNumbers(2);
    for (const n of this.seededOwnNumbers) detected.add(n);
    return detected;
  }

  /** Numbers in every checked chat — at least `minChats` chats, each with 2+ numbers. */
  private commonNumbers(minChats: number): Set<string> {
    const lists = Array.from(this.participantNumbers.values()).filter((l) => l.length > 0);
    if (lists.length < minChats || lists.some((l) => l.length < 2)) return new Set();
    let common = new Set(lists[0]);
    for (const l of lists.slice(1)) common = new Set(l.filter((n) => common.has(n)));
    return common;
  }

  /**
   * BACKLOG-3658: the user's own number, to remember for the next job — only
   * when 3+ checked chats agree on exactly one common number.
   */
  detectedOwnNumber(): string | null {
    const common = this.commonNumbers(3);
    return common.size === 1 ? Array.from(common)[0] : null;
  }

  /**
   * BACKLOG-3658: record a checked chat's numbers. Every chat with a number is
   * kept (no contact gate); the numbers recorded here are the ONLY numbers its
   * /chat and images use. P3b: with the contacts-only flag on, `cacheAllow`
   * keeps only chats with a transaction contact.
   */
  match(conversationId: string, numbers: string[], cacheAllow?: (numbers: string[]) => boolean): void {
    this.participantNumbers.set(conversationId, participantKey(numbers.slice(0, 50)).split(",").filter(Boolean));
    this.progress.checked += 1;
    const recorded = this.participantNumbers.get(conversationId) ?? [];
    if (recorded.length > 0 && (!cacheAllow || cacheAllow(recorded))) {
      if (!this.matched.has(conversationId)) this.progress.matched += 1;
      this.matched.add(conversationId);
    }
  }

  isMatched(conversationId: string): boolean {
    return this.matched.has(conversationId);
  }

  updateProgress(patch: Partial<RcsJobProgress> & { stage?: string }): void {
    const { stage, ...counts } = patch;
    if (typeof stage === "string" && stage.length > 0) this.stage = stage;
    for (const key of Object.keys(EMPTY_PROGRESS) as Array<keyof RcsJobProgress>) {
      const v = counts[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) this.progress[key] = v;
    }
  }

  finish(
    nowMs: number,
    notReached?: { entries: RcsJobNotReached[]; more: number },
    notChecked?: number,
    notText?: number,
    noMessagesYet?: number,
    listStop?: string,
    phoneDisconnected?: boolean,
  ): void {
    if (!this.isActive) return;
    if (phoneDisconnected === true) this.phoneDisconnected = true;
    if (typeof listStop === "string" && /^(since|stable|max_items|max_time)$/.test(listStop)) this.listStop = listStop;
    if (typeof noMessagesYet === "number" && Number.isFinite(noMessagesYet) && noMessagesYet >= 0) {
      this.progress.noMessagesYet = Math.min(Math.floor(noMessagesYet), 100_000);
    }
    if (typeof notText === "number" && Number.isFinite(notText) && notText >= 0) {
      this.progress.notText = Math.min(Math.floor(notText), 100_000);
    }
    if (typeof notChecked === "number" && Number.isFinite(notChecked) && notChecked >= 0) {
      this.progress.notChecked = Math.floor(notChecked);
    }
    if (notReached) {
      this.notReached = notReached.entries.slice(0, RCS_NOT_REACHED_CAP);
      this.notReachedMore = notReached.more;
    }
    this.state = "finished";
    this.stage = "Done";
    this.finishedAtMs = nowMs;
  }

  fail(code: string, message: string, nowMs: number): void {
    if (!this.isActive) return;
    this.state = "failed";
    this.error = { code, message };
    this.stage = message;
    this.finishedAtMs = nowMs;
  }

  /** Founder (2026-10-02): who ended a cancelled job ("user_page": Stop sync on the page). */
  endedBy: "user_page" | undefined;

  cancel(nowMs: number, endedBy?: "user_page"): void {
    if (!this.isActive) return;
    if (endedBy) this.endedBy = endedBy;
    this.state = "cancelled";
    this.stage = "Cancelled";
    this.finishedAtMs = nowMs;
  }
}

/**
 * Holds the one job and authorises each request against it.
 */
export class RcsJobRegistry {
  private job: RcsImportJob | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * BACKLOG-3658: the cache job — all recent chats for `userId`, history back
   * to `since`. Same one-at-a-time slot as a transaction Sync.
   */
  createCache(
    userId: string,
    since: string,
    ownNumbers: readonly string[] = [],
    readingOlder = false,
    full: {
      floorISO?: string;
      pendingConversationIds?: readonly string[];
      dealConversationIds?: readonly string[];
      dealFloorISO?: string | null;
      retrying?: boolean;
    } = {},
  ): RcsImportJob {
    const running = this.active();
    if (running) return running;
    const job = new RcsImportJob(this.now(), undefined, since);
    job.userId = userId;
    job.label = RCS_CACHE_JOB_LABEL;
    job.readingOlder = readingOlder;
    job.floorISO = full.floorISO ?? null;
    job.pendingConversationIds = [...(full.pendingConversationIds ?? [])].slice(0, 500);
    job.dealConversationIds = [...(full.dealConversationIds ?? [])].slice(0, RCS_DEAL_CHATS_MAX);
    job.dealFloorISO = full.dealFloorISO ?? null;
    job.retrying = full.retrying === true;
    for (const n of participantKey(ownNumbers).split(",").filter(Boolean)) job.seededOwnNumbers.add(n);
    this.job = job;
    return job;
  }

  /** The created or running job, if any. */
  active(): RcsImportJob | null {
    const job = this.current();
    return job && job.isActive ? job : null;
  }

  current(): RcsImportJob | null {
    if (this.job) this.job.expireIfUnclaimed(this.now());
    return this.job;
  }

  /** The job named by `jobId`, if it is the current one and still active. */
  check(jobId: string): RcsJobCheck {
    const job = this.current();
    if (!job || job.jobId !== jobId) {
      return { ok: false, status: 404, error: "no_job", message: "This Keepr sync is not known. Click Sync in Keepr again." };
    }
    if (!job.isActive) {
      return { ok: false, status: 410, error: "job_over", message: "This Keepr sync has ended. Click Sync in Keepr again." };
    }
    return { ok: true, job };
  }

  /** An unclaimed job under the time limit, for a page whose URL lost the hash. */
  pending(): RcsImportJob | null {
    const job = this.current();
    return job && job.state === "created" ? job : null;
  }

  cancelJob(jobId?: string): void {
    if (!this.job) return;
    if (jobId && this.job.jobId !== jobId) return;
    this.job.cancel(this.now());
  }

  nowMs(): number {
    return this.now();
  }
}
