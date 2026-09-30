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

export interface RcsJobContact {
  contactId: string;
  displayName: string;
  /** E.164 numbers from contact_phones. Never sent to the page. */
  phonesE164: string[];
}

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
}

export interface RcsJobSnapshot {
  jobId: string;
  transactionId: string;
  state: RcsJobState;
  stage: string;
  progress: RcsJobProgress;
  /** Contacts that have no phone number: they can never match. */
  contactsWithoutPhone: string[];
  error?: { code: string; message: string };
  createdAt: string;
  finishedAt?: string;
}

/** What the page receives when it claims a job: names only, never numbers. */
export interface RcsJobClaim {
  jobId: string;
  contacts: Array<{ contactId: string; displayName: string }>;
  /**
   * The transaction's audit start date (`transactions.started_at`), or null
   * when it has none. The page loads each matched chat's history back past
   * this date before extracting (BACKLOG-3620).
   */
  startDate: string | null;
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
};

/**
 * True when two numbers are the same after `toE164`. Empty on either side is
 * never a match; email handles never match.
 */
export function phonesMatchExactly(a: string, b: string): boolean {
  const ea = toE164(a);
  const eb = toE164(b);
  if (!ea || !eb) return false;
  if (!ea.startsWith("+") || !eb.startsWith("+")) return false;
  return ea === eb;
}

export class RcsImportJob {
  readonly jobId: string;
  readonly transactionId: string;
  readonly createdAtMs: number;
  state: RcsJobState = "created";
  stage = "Waiting for Messages for Web to open in Chrome";
  progress: RcsJobProgress = { ...EMPTY_PROGRESS };
  error?: { code: string; message: string };
  finishedAtMs?: number;
  readonly contacts: RcsJobContact[];
  /** History floor sent to the page on claim (see RcsJobClaim.startDate). */
  readonly startDate: string | null;
  /** conversationId -> matched contact ids. */
  private readonly matched = new Map<string, string[]>();

  constructor(
    transactionId: string,
    contacts: RcsJobContact[],
    nowMs: number,
    jobId?: string,
    startDate: string | null = null,
  ) {
    this.jobId = jobId ?? crypto.randomUUID();
    this.transactionId = transactionId;
    this.contacts = contacts;
    this.startDate = jobStartDate(startDate);
    this.createdAtMs = nowMs;
  }

  get isActive(): boolean {
    return this.state === "created" || this.state === "running";
  }

  snapshot(): RcsJobSnapshot {
    return {
      jobId: this.jobId,
      transactionId: this.transactionId,
      state: this.state,
      stage: this.stage,
      progress: { ...this.progress },
      contactsWithoutPhone: this.contacts
        .filter((c) => c.phonesE164.length === 0)
        .map((c) => c.displayName),
      ...(this.error ? { error: { ...this.error } } : {}),
      createdAt: new Date(this.createdAtMs).toISOString(),
      ...(this.finishedAtMs !== undefined
        ? { finishedAt: new Date(this.finishedAtMs).toISOString() }
        : {}),
    };
  }

  /** Expire an unclaimed job. Returns true when this call expired it. */
  expireIfUnclaimed(nowMs: number): boolean {
    if (this.state !== "created") return false;
    if (nowMs - this.createdAtMs < RCS_JOB_UNCLAIMED_MS) return false;
    this.fail("not_opened", RCS_JOB_NOT_OPENED_MESSAGE, nowMs);
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
    this.stage = "Looking for this transaction's chats";
    return {
      jobId: this.jobId,
      contacts: this.contacts
        .filter((c) => c.phonesE164.length > 0)
        .map((c) => ({ contactId: c.contactId, displayName: c.displayName })),
      startDate: this.startDate,
    };
  }

  /**
   * The phone gate. Records the conversation as matched when any number shown
   * on the page equals any number of any transaction contact.
   */
  match(conversationId: string, numbers: string[]): string[] {
    const hits: string[] = [];
    for (const contact of this.contacts) {
      const hit = contact.phonesE164.some((own) =>
        numbers.some((shown) => phonesMatchExactly(shown, own)),
      );
      if (hit) hits.push(contact.contactId);
    }
    this.progress.checked += 1;
    if (hits.length > 0) {
      if (!this.matched.has(conversationId)) this.progress.matched += 1;
      this.matched.set(conversationId, hits);
    }
    return hits;
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

  finish(nowMs: number): void {
    if (!this.isActive) return;
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

  cancel(nowMs: number): void {
    if (!this.isActive) return;
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

  create(transactionId: string, contacts: RcsJobContact[], startDate: string | null = null): RcsImportJob {
    // A new job replaces any other; a running one is cancelled first.
    if (this.job && this.job.isActive) this.job.cancel(this.now());
    this.job = new RcsImportJob(transactionId, contacts, this.now(), undefined, startDate);
    return this.job;
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
