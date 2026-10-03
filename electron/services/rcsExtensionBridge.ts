/**
 * RCS extension bridge — BACKLOG-3619 (proof of concept).
 *
 * A small HTTP server on 127.0.0.1 that the Keepr Chrome extension's service
 * worker talks to. Chats arrive only through a Sync job Keepr started (a
 * transaction Sync, or the cache Sync of BACKLOG-3658); the manual Send and
 * its import session are gone (BACKLOG-3662).
 *
 * ## What it accepts
 * - Loopback only: bound to 127.0.0.1, never 0.0.0.0 or the LAN address.
 * - Only `Origin: chrome-extension://<pinned id>`. A request with any other
 *   Origin — or none — is refused with 403 before anything else is read. The
 *   id is derived from the public key in `chrome-extension/manifest.json`
 *   ("key"), so an unpacked copy of the extension always has this id.
 *   The content script never calls the bridge (its requests would carry the
 *   messages.google.com origin); only the service worker does.
 *
 * ## Endpoints
 * - `POST /status` — bridge state. Diagnostics only.
 *
 * ## Sync jobs (BACKLOG-3620)
 * "Sync" in Keepr creates a job ({@link RcsJobRegistry}) and opens Messages for
 * Web with `#keepr-job=<jobId>`. Every job route names the job id, which is
 * random and doubles as the job's secret; the Origin pin applies too.
 * - `POST /job/pending`         — an unclaimed job, for a page that lost the hash.
 * - `POST /job/:id/claim`       — claim; returns contact NAMES only. Once.
 * - `POST /job/:id/match`       — {conversationId, numbers[]} → matched contacts.
 *                                 The phone comparison happens here, in Keepr.
 * - `POST /job/:id/chat`        — a chat; 403 unless /match matched it.
 * - `POST /job/:id/attachment`  — one image; 403 unless matched; 413 over the cap.
 * - `POST /job/:id/progress`    — counts + stage for the Keepr panel.
 * - `POST /job/:id/finish`      — done; {notReached?[], notReachedMore?}: chats the
 *                                 page left out or imported in part. Keepr brings
 *                                 its window forward. A cache job answers once
 *                                 Keepr has saved it: {ok, saved} (what was SAVED;
 *                                 absent if the save outlasts RCS_FINISH_SAVE_WAIT_MS).
 * - `POST /focus`                — "Open Keepr" on the page: Keepr brings itself forward.
 * - `POST /job/:id/error`       — {code, message}; the job fails with it.
 *
 * ## POST only, exact Host (BACKLOG-3628)
 * Every route is POST. Chrome on Windows (Chrome 154) sends a GET from the
 * extension service worker WITHOUT an Origin header, so a GET can never pass
 * the Origin pin; any GET answers 405, so a future GET caller fails loudly on
 * every OS instead of only on Windows. The Origin pin stays strict: a missing
 * Origin is always refused. The `Host` header must be exactly
 * `127.0.0.1:<bound port>` (DNS-rebinding guard).
 *
 * ## Port
 * Fixed at {@link RCS_BRIDGE_PORT} so the extension knows where to post. If the
 * port is taken (EADDRINUSE) the bridge logs it and reports "unavailable"; the
 * app keeps running and the Import panel says the bridge is unavailable.
 */

import * as http from "http";

import {
  parseNotReached,
  participantKey,
  RcsJobRegistry,
  type RcsCacheSaved,
  type RcsImportJob,
  type RcsJobKind,
  type RcsJobContact,
  type RcsJobProgress,
  type RcsJobSnapshot,
} from "./rcsImportJob";
import { parseIncomingImage, RCS_MAX_IMAGE_BYTES, type RcsImageResult, type RcsIncomingImage } from "./rcsImportMedia";
import { NOT_PAIRED_MESSAGE, PAIR_HEADERS, type RcsPairingAuth } from "./rcsPairingAuth";
import { isConversationId, RCS_EXCLUSIONS_MAX } from "./rcsExclusions";
import type { RcsImportResult, RcsIncomingChat } from "./rcsImportStore";
import {
  parseIncomingChat,
  peopleFrom,
  rcsChatHash,
  RCS_NO_NUMBER_MESSAGE,
  type RcsChatPeople,
} from "./rcsImportStore";

export const RCS_BRIDGE_HOST = "127.0.0.1";
export const RCS_BRIDGE_PORT = 38619;
/** Derived from the public key in chrome-extension/manifest.json. */
export const RCS_EXTENSION_ID = "nlfohmjehedijceeelokclkglmjnlonj";
export const RCS_EXTENSION_ORIGIN = `chrome-extension://${RCS_EXTENSION_ID}`;
/** BACKLOG-3658 */
export const RCS_USER_CHANGED_MESSAGE = "Another Keepr user signed in: this Sync was stopped.";
export const RCS_IMAGE_NOT_A_CONTACT_MESSAGE = "Images are kept only for chats with a transaction contact.";
/** BACKLOG-3657 (SR F1): how long a clear waits for writes in progress. */
export const RCS_DRAIN_TIMEOUT_MS = 15_000;

/** A cache job's /finish waits this long for Keepr's save before answering without it. */
export const RCS_FINISH_SAVE_WAIT_MS = 30_000;
export const RCS_BUSY_MESSAGE = "Keepr is busy importing — try again in a moment.";

/** A clear could not start: a write was still in progress after the drain timeout. */
export class RcsBusyError extends Error {
  constructor() {
    super(RCS_BUSY_MESSAGE);
    this.name = "RcsBusyError";
  }
}

/** BACKLOG-3657: the reply while Keepr clears the Google Messages for Web texts. */
export const RCS_CLEARING_MESSAGE = "Keepr is clearing imported texts. Try again in a moment.";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** One image as base64 (4/3 of the raw cap) plus JSON framing. */
export const MAX_ATTACHMENT_BODY_BYTES = Math.ceil((RCS_MAX_IMAGE_BYTES * 4) / 3) + 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super("Body too large");
  }
}

export type RcsBridgeState = "stopped" | "listening" | "unavailable";

export interface RcsBridgeStatus {
  bridge: RcsBridgeState;
  port: number;
  /** Why the bridge is unavailable, when it is. */
  reason?: string;
}

export interface RcsBridgeLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** BACKLOG-3658: what POST /hello reports (never echoed back). */
export interface RcsHello {
  version?: string;
  paired?: boolean;
}

/** BACKLOG-3658: a job that just ended. */
export interface RcsJobEnded {
  snapshot: RcsJobSnapshot;
  kind: RcsJobKind;
  userId: string | null;
  /** The user's own number when 3+ checked chats agreed on it. */
  detectedOwnNumber: string | null;
}

export interface RcsExtensionBridgeOptions {
  importChat: (
    chat: RcsIncomingChat,
    transactionId: string,
    people: RcsChatPeople,
  ) => Promise<RcsImportResult>;
  logger?: RcsBridgeLogger;
  /** Overridable for tests only. */
  allowedOrigin?: string;
  /** BACKLOG-3620: store one image of a matched chat. */
  importImage?: (image: RcsIncomingImage, transactionId: string, chatHash: string) => Promise<RcsImageResult>;
  /** BACKLOG-3620: every job state/progress change. */
  onJobChanged?: (job: RcsJobSnapshot) => void;
  /** BACKLOG-3620: the job finished; Keepr brings its window forward. */
  onJobFinished?: (job: RcsJobSnapshot) => void;
  /** BACKLOG-3641: the page's "Open Keepr" button (POST /focus). */
  onFocusRequested?: () => void;
  /** BACKLOG-3658: POST /hello — the extension is installed ({version}) / the page is paired. */
  onHello?: (hello: RcsHello) => void;
  /**
   * BACKLOG-3658: a cache chat for `userId` (no transaction, no link). Keepr
   * STAGES it under `jobId`; only a finished job commits (atomic import).
   */
  importCacheChat?: (chat: RcsIncomingChat, userId: string, people: RcsChatPeople, jobId: string) => Promise<RcsImportResult>;
  /**
   * BACKLOG-3658: a cache chat's image, staged under `jobId`. Kept only when
   * the chat's numbers match a live transaction contact; otherwise
   * { stored: false, reason: "not_a_contact" }.
   */
  importCacheImage?: (
    image: RcsIncomingImage,
    userId: string,
    chatHash: string,
    numbers: string[],
    jobId: string,
  ) => Promise<RcsImageResult | { stored: false; reason: "not_a_contact" }>;
  /**
   * BACKLOG-3658 P3b: the contacts-only flag (off by default). When given, a
   * cache job keeps only the chats it allows (numbers in E.164).
   */
  cacheChatAllowed?: (jobId: string, userId: string, numbers: string[]) => boolean;
  /**
   * BACKLOG-3658 P3c: is this chat switched off ("Don't sync")? By its hash or
   * its conversation id; records the hash on a pending exclusion. Applies to
   * every Sync; a refused chat is counted (progress.notSynced).
   */
  chatExcluded?: (userId: string, chatHash: string, conversationId: string) => boolean;
  /** P3c: POST /exclusions/list — the conversation ids switched off (ids only). */
  listExclusions?: (userId: string) => string[];
  /** P3c: POST /exclusions/set — the eye on a row. */
  setExclusion?: (userId: string, conversationId: string, excluded: boolean) => void;
  /**
   * SR M: does Keepr keep this cache chat's photos / videos (E.164 numbers)?
   * Replied to /match as keepPhotos / keepVideos (+ keepImages = keepPhotos
   * for an older extension). Booleans only.
   */
  cacheMediaKept?: (jobId: string, userId: string, numbers: string[]) => { photos: boolean; videos: boolean };
  /**
   * SR (2026-10-02): this cache chat's own history floor (epoch ms) when it
   * is on a live deal older than the settings floor and not yet read back to
   * it — replied to /match as floorMs. null = the job's floor. Computed in
   * Keepr from the numbers this job saw; the page never sends a floor.
   */
  cacheChatFloor?: (jobId: string, userId: string, conversationId: string, numbers: string[]) => number | null;
  /**
   * 3671 P3 "Try again": a chat the failed run already finished is skipped —
   * replied to /match as skip: true (a boolean). Computed in Keepr.
   */
  cacheChatSkip?: (jobId: string, userId: string, conversationId: string, numbers: string[]) => boolean;
  /** SR M: the photo / video bubbles a finished Sync counted (counts only). */
  onMediaCounts?: (userId: string, counts: { photosSeen: number; videosSeen: number }) => void;
  /** BACKLOG-3658: the signed-in user now; a job of another user is cancelled. */
  currentUserId?: () => Promise<string | null>;
  /** BACKLOG-3658: a job ended (finished, failed or cancelled). Once per job. */
  onJobEnded?: (ended: RcsJobEnded) => void;
  /** Overridable for tests only. */
  jobs?: RcsJobRegistry;
  /** Overridable for tests only (default RCS_FINISH_SAVE_WAIT_MS). */
  finishSaveWaitMs?: number;
  /**
   * BACKLOG-3666: pairing. With it, ONE auth gate runs before routing: every
   * request is signed (except /hello and /pair/*; and, in "dual" mode for one
   * release, the routes an older extension needs that start no job:
   * /status, /focus, /exclusions/*), every reply to a signed request is
   * signed, and job routes are refused until paired.
   */
  pairing?: RcsPairingAuth;
  pairingMode?: "dual" | "required";
}

/** BACKLOG-3666: requests whose body the auth gate already read (it signs the body). */
const prereadBodies = new WeakMap<http.IncomingMessage, string>();
/** BACKLOG-3666: replies to sign, with what the signature binds. */
const replySigners = new WeakMap<http.ServerResponse, { sign: (status: number, body: string) => string }>();

/** Routes that never need a signature. */
const PAIR_OPEN_ROUTES = new Set(["/hello", "/pair/start", "/pair/finish"]);
/** "dual" mode only (one release): what an older, unpaired extension still needs. Never a job route. */
const PAIR_DUAL_ROUTES = new Set(["/status", "/focus", "/exclusions/list", "/exclusions/set"]);
/** SR B1: an unsigned request although this user's extension is paired. */
const SIGNATURE_REQUIRED_MESSAGE = "This extension is paired with Keepr: its requests must be signed. Update or reload the Keepr extension.";

function signHeaders(res: http.ServerResponse, status: number, payload: string): Record<string, string> {
  const signer = replySigners.get(res);
  return signer ? { "X-Keepr-Sig": signer.sign(status, payload) } : {};
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...signHeaders(res, status, payload),
  });
  res.end(payload);
}

/**
 * Read the body up to `limit` bytes. Over the limit it rejects with
 * {@link BodyTooLargeError} and stops collecting, WITHOUT destroying the
 * socket: the caller replies 413 first and closes afterwards (see
 * {@link sendTooLarge}), so the extension sees "too large", not "not reachable".
 */
function readBody(req: http.IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<string> {
  const preread = prereadBodies.get(req);
  if (preread !== undefined) {
    return Buffer.byteLength(preread) > limit ? Promise.reject(new BodyTooLargeError()) : Promise.resolve(preread);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    let settled = false;
    req.on("end", () => {
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      settled = true;
      reject(err);
    });
    // BACKLOG-3657 (SR F1): a client that stalls or goes away must not leave
    // this read (and so a counted write) open forever.
    const gone = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error("The request was closed before its body arrived"));
    };
    req.on("aborted", gone);
    req.on("close", gone);
  });
}

/** Reply 413, then close the connection once the reply is written. */
function sendTooLarge(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
  const payload = JSON.stringify({ error: "too_large", message });
  res.writeHead(413, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    Connection: "close",
    ...signHeaders(res, 413, payload),
  });
  res.end(payload, () => req.destroy());
}

async function readJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limit: number = MAX_BODY_BYTES,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: JSON.parse(await readBody(req, limit)) };
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendTooLarge(req, res, "This item is too large to send to Keepr.");
    } else {
      sendJson(res, 400, { error: "bad_request", message: err instanceof Error ? err.message : "Invalid body" });
    }
    return { ok: false };
  }
}

const JOB_ROUTE = /^\/job\/([0-9a-fA-F-]{36})(?:\/(claim|match|chat|attachment|progress|finish|error|cancel))?$/;

const silentLogger: RcsBridgeLogger = { info: () => {}, warn: () => {}, error: () => {} };

export class RcsExtensionBridge {
  private server: http.Server | null = null;
  private state: RcsBridgeState = "stopped";
  private reason: string | undefined;
  private port = RCS_BRIDGE_PORT;
  private readonly allowedOrigin: string;
  private readonly logger: RcsBridgeLogger;
  private readonly jobs: RcsJobRegistry;
  private unclaimedTimer: NodeJS.Timeout | null = null;
  /** BACKLOG-3657: see pauseWrites. */
  /** Re-entrant: overlapping clears each pause; writes reopen after the last resume. */
  private pauseCount = 0;
  private inFlightWrites = 0;
  private drainWaiters: Array<() => void> = [];
  /** BACKLOG-3658: jobs whose end was already announced (onJobEnded). */
  private readonly endedAnnounced = new Set<string>();
  /** /finish requests of cache jobs waiting for Keepr's save, by job id. */
  private readonly savedWaiters = new Map<string, Array<() => void>>();

  constructor(private readonly options: RcsExtensionBridgeOptions) {
    this.allowedOrigin = options.allowedOrigin ?? RCS_EXTENSION_ORIGIN;
    this.logger = options.logger ?? silentLogger;
    this.jobs = options.jobs ?? new RcsJobRegistry();
  }

  // ---------------------------------------------------------------------------
  // Sync jobs (BACKLOG-3620)
  // ---------------------------------------------------------------------------

  /** Create the one sync job (cancelling any other). */
  createJob(
    transactionId: string,
    contacts: RcsJobContact[],
    options: { startDate?: string | null; unclaimedMs?: number; label?: string | null; userId?: string | null } = {},
  ): RcsJobSnapshot | null {
    // BACKLOG-3661: one Sync at a time — while a job is active nothing is
    // created (null); the running job is left untouched. Callers check
    // activeJob() first to tell the user what is running.
    if (this.jobs.active()) return null;
    const unclaimedMs = options.unclaimedMs ?? 60_000;
    const job = this.jobs.create(
      transactionId, contacts, options.startDate ?? null, options.label ?? null, options.userId ?? null,
    );
    this.logger.info(`[RcsBridge] Sync job created for transaction ${transactionId} (${contacts.length} contacts)`);
    return this.armJob(job, options.unclaimedMs ?? 60_000);
  }

  /**
   * BACKLOG-3658: the cache job — all recent chats of `userId`, back to
   * `since`. null while any job runs (one at a time, BACKLOG-3661).
   */
  createCacheJob(
    userId: string,
    options: {
      since: string;
      ownNumbers?: readonly string[];
      unclaimedMs?: number;
      readingOlder?: boolean;
      floorISO?: string;
      pendingConversationIds?: readonly string[];
      dealConversationIds?: readonly string[];
      dealFloorISO?: string | null;
    },
  ): RcsJobSnapshot | null {
    if (this.jobs.active()) return null;
    const job = this.jobs.createCache(userId, options.since, options.ownNumbers ?? [], options.readingOlder === true, {
      floorISO: options.floorISO,
      pendingConversationIds: options.pendingConversationIds,
      dealConversationIds: options.dealConversationIds,
      dealFloorISO: options.dealFloorISO,
    });
    this.logger.info("[RcsBridge] Cache job created");
    return this.armJob(job, options.unclaimedMs ?? 60_000);
  }

  private armJob(job: RcsImportJob, unclaimedMs: number): RcsJobSnapshot {
    if (this.unclaimedTimer) clearTimeout(this.unclaimedTimer);
    this.unclaimedTimer = setTimeout(() => {
      this.unclaimedTimer = null;
      const current = this.jobs.current();
      if (current && current.jobId === job.jobId && current.state === "failed") {
        this.emitJob(current.snapshot());
      }
    }, unclaimedMs + 50);
    this.unclaimedTimer.unref?.();
    const snap = job.snapshot();
    this.emitJob(snap);
    return snap;
  }

  /** Tell the owner, once, that a job ended (BACKLOG-3658). */
  private announceEnded(job: RcsImportJob): void {
    if (job.isActive || this.endedAnnounced.has(job.jobId)) return;
    this.endedAnnounced.add(job.jobId);
    this.options.onJobEnded?.({
      snapshot: job.snapshot(),
      kind: job.kind,
      userId: job.userId,
      detectedOwnNumber: job.detectedOwnNumber(),
    });
  }

  /**
   * BACKLOG-3658: rows go to the user the job was started for. If someone
   * else is signed in now, the job is cancelled and nothing is written.
   */
  private async stillSameUser(job: RcsImportJob): Promise<boolean> {
    if (!this.options.currentUserId || !job.userId) return true;
    const current = await this.options.currentUserId();
    if (current === job.userId) return true;
    this.logger.warn("[RcsBridge] The signed-in user changed: the Sync was cancelled");
    this.cancelJob(job.jobId);
    return false;
  }

  /** BACKLOG-3658: the user the running job was started for, if any. */
  activeJobUserId(): string | null {
    return this.jobs.active()?.userId ?? null;
  }

  /** BACKLOG-3661: the created or running job, if any. */
  activeJob(): RcsJobSnapshot | null {
    const job = this.jobs.active();
    return job ? job.snapshot() : null;
  }

  cancelJob(jobId?: string): void {
    this.jobs.cancelJob(jobId);
    const job = this.jobs.current();
    if (job) {
      this.emitJob(job.snapshot());
      this.announceEnded(job);
    }
  }

  /**
   * A finished cache job was saved (or the save failed: null). The done
   * screens show these counts; a /finish waiting for them is answered.
   */
  recordCacheSaved(jobId: string, saved: RcsCacheSaved | null): void {
    const job = this.jobs.current();
    if (job && job.jobId === jobId) {
      job.setSaved(saved);
      this.emitJob(job.snapshot());
    }
    const waiters = this.savedWaiters.get(jobId) ?? [];
    this.savedWaiters.delete(jobId);
    for (const w of waiters) w();
  }

  /** Resolves once {@link recordCacheSaved} ran for the job, or after `ms`. */
  private waitForSaved(job: RcsImportJob, ms: number): Promise<void> {
    if (job.saved !== undefined) return Promise.resolve();
    return new Promise((resolve) => {
      const jobId = job.jobId;
      const waiters = this.savedWaiters;
      const timer = setTimeout(() => {
        // SR minor: a timed-out waiter leaves no entry behind.
        const left = (waiters.get(jobId) ?? []).filter((w) => w !== done);
        if (left.length > 0) waiters.set(jobId, left);
        else waiters.delete(jobId);
        done();
      }, ms);
      timer.unref?.();
      const list = waiters.get(jobId) ?? [];
      list.push(done);
      waiters.set(jobId, list);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /** /finish requests still waiting for the job's save (diagnostics, tests). */
  pendingSavedWaiters(jobId: string): number {
    return this.savedWaiters.get(jobId)?.length ?? 0;
  }

  getJob(): RcsJobSnapshot | null {
    const job = this.jobs.current();
    return job ? job.snapshot() : null;
  }

  /**
   * BACKLOG-3657: stop every write before Keepr clears the Google Messages for
   * Web texts. Refuses new chats/images (manual session or job) with 503,
   * cancels the running job, then resolves once the writes already in progress
   * have finished — so nothing is written between the cancel and the delete.
   * Pair with {@link resumeWrites} in a `finally`.
   */
  async pauseWrites(drainTimeoutMs = RCS_DRAIN_TIMEOUT_MS): Promise<void> {
    this.pauseCount += 1;
    this.cancelJob();
    if (this.inFlightWrites === 0) return;
    // Bounded (SR F1): a write that never finishes must not hang the clear.
    let waiter: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;
    const drained = await new Promise<boolean>((resolve) => {
      waiter = () => resolve(true);
      this.drainWaiters.push(waiter);
      timer = setTimeout(() => resolve(false), drainTimeoutMs);
    });
    if (timer) clearTimeout(timer);
    if (!drained) {
      this.drainWaiters = this.drainWaiters.filter((w) => w !== waiter);
      throw new RcsBusyError();
    }
  }

  /** Undo one pauseWrites (also after it threw). Writes reopen at zero. */
  resumeWrites(): void {
    this.pauseCount = Math.max(0, this.pauseCount - 1);
  }

  get writesArePaused(): boolean {
    return this.pauseCount > 0;
  }

  private releaseDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }

  private emitJob(snapshot: RcsJobSnapshot): void {
    this.options.onJobChanged?.(snapshot);
  }

  /**
   * Start listening. Never rejects: a port already in use leaves the bridge
   * "unavailable" and the rest of the app unaffected.
   */
  start(port: number = RCS_BRIDGE_PORT): Promise<RcsBridgeState> {
    if (this.server) return Promise.resolve(this.state);
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      const onError = (err: NodeJS.ErrnoException): void => {
        this.server = null;
        this.state = "unavailable";
        this.reason =
          err.code === "EADDRINUSE"
            ? `Port ${port} is already in use`
            : `Could not listen on port ${port}: ${err.code ?? err.message}`;
        this.logger.warn(`[RcsBridge] ${this.reason}; import bridge unavailable`);
        resolve(this.state);
      };
      server.once("error", onError);
      server.listen(port, RCS_BRIDGE_HOST, () => {
        server.removeListener("error", onError);
        server.on("error", (err) => this.logger.error(`[RcsBridge] Server error: ${err.message}`));
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : port;
        this.server = server;
        this.state = "listening";
        this.reason = undefined;
        this.logger.info(`[RcsBridge] Listening on ${RCS_BRIDGE_HOST}:${this.port}`);
        resolve(this.state);
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.state = "stopped";
    if (this.unclaimedTimer) clearTimeout(this.unclaimedTimer);
    this.unclaimedTimer = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  getStatus(): RcsBridgeStatus {
    return {
      bridge: this.state,
      port: this.port,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // BACKLOG-3628: DNS-rebinding guard. The bound port, not the constant,
      // so a test bridge on port 0 is checked the same way.
      const host = req.headers.host;
      if (host !== `${RCS_BRIDGE_HOST}:${this.port}`) {
        this.logger.warn(`[RcsBridge] Refused request with host ${host === undefined ? "(none)" : host.slice(0, 80)}`);
        sendJson(res, 403, { error: "forbidden_host" });
        return;
      }

      // Strict: a missing Origin is refused too (see "POST only" above).
      const origin = req.headers.origin;
      if (origin !== this.allowedOrigin) {
        this.logger.warn(`[RcsBridge] Refused request with origin ${origin ?? "(none)"}`);
        sendJson(res, 403, { error: "forbidden_origin" });
        return;
      }

      const path = (req.url ?? "").split("?")[0];

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": this.allowedOrigin,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type, X-Keepr-Pair, X-Keepr-Ts, X-Keepr-Nonce, X-Keepr-Sig",
        });
        res.end();
        return;
      }

      // BACKLOG-3628: POST only. A GET from the service worker arrives with no
      // Origin on Windows Chrome and was refused above; any other method (or a
      // GET that somehow carries the Origin) gets a clear 405.
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed", message: "Keepr's bridge accepts POST only." });
        return;
      }

      // BACKLOG-3666: the ONE auth gate, before routing.
      let signedPairing: { pairId: string; userId: string } | null = null;
      if (this.options.pairing) {
        const gate = await this.authGate(req, res, path);
        if (gate === "handled") return;
        signedPairing = gate;
      }

      // BACKLOG-3641: the page's "Open Keepr" button. Same Host/Origin checks as
      // every route (above); no body, no data — Keepr brings itself forward.
      // BACKLOG-3658: the extension says it is installed / the page is paired.
      // Works signed out; nothing is sent back.
      if (path === "/hello") {
        const read = await readJson(req, res, 4096);
        if (!read.ok) return;
        const b = (read.body && typeof read.body === "object" ? read.body : {}) as Record<string, unknown>;
        const hello: RcsHello = {};
        if (typeof b.version === "string") hello.version = b.version.slice(0, 40);
        if (b.paired === true) hello.paired = true;
        this.options.onHello?.(hello);
        // BACKLOG-3666: only "paired: yes / no" (yes = a valid signature of a
        // pairing bound to the signed-in user).
        sendJson(res, 200, this.options.pairing ? { ok: true, paired: signedPairing !== null } : { ok: true });
        return;
      }

      if (path === "/focus") {
        if (!this.options.onFocusRequested) {
          sendJson(res, 501, { error: "unsupported" });
          return;
        }
        this.options.onFocusRequested();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === "/status") {
        const s = this.getStatus();
        sendJson(res, 200, { bridge: s.bridge });
        return;
      }

      // BACKLOG-3657: while Keepr clears the Google Messages for Web texts, no
      // chat or image may be written; writes already running are counted so
      // the clear can wait for them (no write lands between cancel and delete).
      const jobMatch = JOB_ROUTE.exec(path);
      const isWrite = (!!jobMatch && (jobMatch[2] === "chat" || jobMatch[2] === "attachment"));
      if (isWrite && this.writesArePaused) {
        sendJson(res, 503, { error: "busy", message: RCS_CLEARING_MESSAGE });
        return;
      }
      if (isWrite) this.inFlightWrites += 1;
      try {
        await this.route(req, res, path, jobMatch);
      } finally {
        if (isWrite) {
          this.inFlightWrites -= 1;
          if (this.inFlightWrites === 0) this.releaseDrainWaiters();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[RcsBridge] Request failed: ${message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal", message: "Keepr could not save this chat." });
    }
  }

  /**
   * BACKLOG-3666: the auth gate. Reads the body once (the signature covers
   * it), handles /pair/*, verifies a signed request (and signs its reply,
   * errors included except "unknown pairing"), refuses an unsigned one
   * outside the open (and, in dual mode, the dual) routes. → the verified
   * pairing, null (unsigned, allowed), or "handled" (replied).
   */
  /** SR B1: does the signed-in user have an active pairing? */
  private async signedInUserIsPaired(): Promise<boolean> {
    const userId = this.options.currentUserId ? await this.options.currentUserId() : null;
    return !!userId && !!this.options.pairing?.isPaired(userId);
  }

  private async authGate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ): Promise<{ pairId: string; userId: string } | null | "handled"> {
    const pairing = this.options.pairing as RcsPairingAuth;
    const signed = typeof req.headers[PAIR_HEADERS.pair] === "string";
    const refuse = (status: number, error: string, keyHex?: string, nonce?: string): "handled" => {
      if (keyHex) replySigners.set(res, { sign: (st, body) => pairing.signReply(keyHex, st, path, nonce ?? "", body) });
      this.logger.warn(`[RcsBridge] Refused a request: ${error}`);
      const message = error === "re_pair" || error === "unknown_pair" || error === "not_paired"
        ? NOT_PAIRED_MESSAGE
        : error === "signature_required" ? SIGNATURE_REQUIRED_MESSAGE : undefined;
      // Refused before its body was read: the connection closes after the reply (the body is never drained).
      res.setHeader("Connection", "close");
      sendJson(res, status, { error, ...(message ? { message } : {}) });
      return "handled";
    };
    // SR S1: what the HEADERS settle comes first — no body is read for an
    // unknown pairing, a stale timestamp, a malformed nonce, or an unsigned
    // call that is not allowed.
    if (signed) {
      const pre = pairing.precheck(req.headers);
      if (!pre.ok) return refuse(pre.status, pre.error, pre.keyHex, pre.nonce);
    } else if (!PAIR_OPEN_ROUTES.has(path)) {
      // SR B1: the dual routes go unsigned ONLY while the signed-in user has
      // no pairing; once paired, everything must be signed.
      if ((this.options.pairingMode ?? "dual") !== "dual" || !PAIR_DUAL_ROUTES.has(path)) return refuse(401, "not_paired");
      if (await this.signedInUserIsPaired()) return refuse(401, "signature_required");
    }
    // SR S1: then the body, with its route's cap (the large one only for an image).
    const cap = JOB_ROUTE.exec(path)?.[2] === "attachment" ? MAX_ATTACHMENT_BODY_BYTES : MAX_BODY_BYTES;
    let raw: string;
    try {
      raw = await readBody(req, cap);
    } catch (err) {
      if (err instanceof BodyTooLargeError) sendTooLarge(req, res, "This item is too large to send to Keepr.");
      else sendJson(res, 400, { error: "bad_request" });
      return "handled";
    }
    prereadBodies.set(req, raw);
    const json = (): unknown => {
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        return null;
      }
    };
    if (path === "/pair/start" || path === "/pair/finish") {
      const r = path === "/pair/start" ? pairing.start(json()) : pairing.finish(json());
      if (r.signWith) {
        const w = r.signWith;
        replySigners.set(res, { sign: (status, body) => pairing.signReply(w.keyHex, status, path, w.nonce, body) });
        this.logger.info("[RcsBridge] Extension paired");
      } else if (r.status !== 200) {
        this.logger.warn(`[RcsBridge] Pairing refused: ${String(r.body.error)}`);
      }
      sendJson(res, r.status, r.body);
      return "handled";
    }
    if (!signed) return null;
    const userId = this.options.currentUserId ? await this.options.currentUserId() : undefined;
    const v = pairing.verify(req.headers, req.method ?? "POST", path, raw, userId);
    if (!v.ok) {
      if (v.keyHex) {
        const keyHex = v.keyHex;
        const nonce = v.nonce ?? "";
        replySigners.set(res, { sign: (status, body) => pairing.signReply(keyHex, status, path, nonce, body) });
      }
      this.logger.warn(`[RcsBridge] Refused a signed request: ${v.error}`);
      sendJson(res, v.status, { error: v.error, ...(v.error === "re_pair" || v.error === "unknown_pair" ? { message: NOT_PAIRED_MESSAGE } : {}) });
      return "handled";
    }
    const { keyHex } = v.pairing;
    replySigners.set(res, { sign: (status, body) => pairing.signReply(keyHex, status, path, v.nonce, body) });
    return { pairId: v.pairing.pairId, userId: v.pairing.userId };
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    jobRoute: RegExpExecArray | null,
  ): Promise<void> {
    {
      // BACKLOG-3658 P3c: the eye on each conversation row. Ids only — never
      // names or numbers; a signed-in user; a capped list.
      if (path === "/exclusions/list" || path === "/exclusions/set") {
        await this.handleExclusions(req, res, path);
        return;
      }

      if (path === "/job/pending") {
        const job = this.jobs.pending();
        if (!job) {
          sendJson(res, 404, { error: "no_job", message: "No Keepr sync is waiting." });
          return;
        }
        sendJson(res, 200, { jobId: job.jobId });
        return;
      }

      if (jobRoute) {
        await this.handleJob(req, res, jobRoute[1], jobRoute[2] ?? null);
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    }
  }

  private async handleJob(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    jobId: string,
    action: string | null,
  ): Promise<void> {
    // The attachment cap is checked from the header BEFORE the job lookup or
    // any read, so an oversize image gets a real 413 reply.
    if (action === "attachment") {
      const declared = Number(req.headers["content-length"] ?? NaN);
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BODY_BYTES) {
        sendTooLarge(req, res, "This image is too large to send to Keepr.");
        return;
      }
    }

    const check = this.jobs.check(jobId);
    if (!check.ok) {
      sendJson(res, check.status, { error: check.error, message: check.message });
      return;
    }
    const job = check.job;

    // The bare job URL was the old GET claim (BACKLOG-3628): nothing lives there.
    if (action === null) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed", message: "Keepr's bridge accepts POST only." });
      return;
    }

    // BACKLOG-3658: the page's Cancel. Only this job; unknown → 404, over → 410
    // (both answered by the check above).
    if (action === "cancel") {
      // Founder (2026-10-02): "Stop sync" on the page says so (ended_by=user_page).
      let endedBy: "user_page" | undefined;
      try {
        const raw = await readBody(req, 4096);
        const b = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (b && b.endedBy === "user_page") endedBy = "user_page";
      } catch {
        endedBy = undefined;
      }
      if (endedBy) {
        job.cancel(this.jobs.nowMs(), endedBy);
        this.logger.info("[RcsBridge] Sync stopped on the page (ended_by=user_page)");
      }
      this.cancelJob(job.jobId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (action === "claim") {
      const claim = job.claim(this.jobs.nowMs());
      if ("error" in claim) {
        sendJson(res, claim.status, { error: claim.error, message: claim.message });
        return;
      }
      this.emitJob(job.snapshot());
      sendJson(res, 200, claim);
      return;
    }

    // /error is accepted before the claim: a page that is not signed in
    // reports that without claiming.
    if (job.state !== "running" && action !== "error") {
      sendJson(res, 409, { error: "not_claimed", message: "This Keepr sync has not started." });
      return;
    }

    const read = await readJson(req, res, action === "attachment" ? MAX_ATTACHMENT_BODY_BYTES : MAX_BODY_BYTES);
    if (!read.ok) return;
    const body = (read.body && typeof read.body === "object" ? read.body : {}) as Record<string, unknown>;

    switch (action) {
      case "match": {
        const conversationId = body.conversationId;
        const numbers = body.numbers;
        if (typeof conversationId !== "string" || conversationId.length === 0 || !Array.isArray(numbers)) {
          sendJson(res, 400, { error: "bad_request", message: "conversationId and numbers[] are required" });
          return;
        }
        const shown = (numbers as unknown[]).filter((n): n is string => typeof n === "string").slice(0, 50);
        // P3c: a chat the user switched off is never synced (any Sync), counted.
        if (this.options.chatExcluded) {
          const normalized = participantKey(shown).split(",").filter(Boolean);
          const userId = job.userId ?? (this.options.currentUserId ? await this.options.currentUserId() : null);
          if (normalized.length > 0 && userId && this.options.chatExcluded(userId, rcsChatHash(normalized), conversationId)) {
            job.progress.checked += 1;
            job.progress.notSynced += 1;
            this.emitJob(job.snapshot());
            sendJson(res, 200, { matched: false, contactIds: [], excluded: true });
            return;
          }
        }
        const allow = job.kind === "cache" && job.userId && this.options.cacheChatAllowed
          ? (n: string[]) => this.options.cacheChatAllowed!(job.jobId, job.userId as string, n)
          : undefined;
        const contactIds = job.match(conversationId, shown, allow);
        this.emitJob(job.snapshot());
        // A cache job keeps every chat with a number (BACKLOG-3658).
        const matched = job.kind === "cache" ? job.isMatched(conversationId) : contactIds.length > 0;
        // History v2: whether Keepr keeps this chat's images, so the page runs
        // its image pass only where it matters (a boolean — no names, no numbers).
        if (job.kind === "cache" && matched && this.options.cacheMediaKept && job.userId) {
          const normalized = participantKey(shown).split(",").filter(Boolean);
          const kept = this.options.cacheMediaKept(job.jobId, job.userId, normalized);
          const floorMs = this.options.cacheChatFloor
            ? this.options.cacheChatFloor(job.jobId, job.userId, conversationId, normalized)
            : null;
          const skip = this.options.cacheChatSkip
            ? this.options.cacheChatSkip(job.jobId, job.userId, conversationId, normalized) === true
            : false;
          sendJson(res, 200, {
            matched, contactIds, keepPhotos: kept.photos, keepVideos: kept.videos, keepImages: kept.photos,
            ...(typeof floorMs === "number" && Number.isFinite(floorMs) ? { floorMs } : {}),
            ...(skip ? { skip: true } : {}),
          });
          return;
        }
        sendJson(res, 200, { matched, contactIds });
        return;
      }
      case "chat": {
        const chat = parseIncomingChat(body);
        if (typeof chat === "string") {
          sendJson(res, 400, { error: "bad_request", message: chat });
          return;
        }
        if (!job.isMatched(chat.conversationId)) {
          sendJson(res, 403, { error: "not_matched", message: "Keepr did not match this chat to a transaction contact." });
          return;
        }
        // BACKLOG-3630: the chat's numbers are the ones THIS job's /match saw
        // (never the page's /chat body); the body only names them, for group
        // senders.
        const people = peopleFrom(body.participants, job.numbersFor(chat.conversationId));
        if (people.numbers.length === 0) {
          sendJson(res, 400, { error: "no_number", message: RCS_NO_NUMBER_MESSAGE });
          return;
        }
        if (!(await this.stillSameUser(job))) {
          sendJson(res, 409, { error: "user_changed", message: RCS_USER_CHANGED_MESSAGE });
          return;
        }
        let result: RcsImportResult;
        if (job.kind === "cache") {
          if (!this.options.importCacheChat || !job.userId) {
            sendJson(res, 501, { error: "unsupported", message: "This Keepr build cannot save chats." });
            return;
          }
          // A Cancel (or the user switch) can land while the user was checked:
          // an ended job stages nothing (BACKLOG-3658 atomic import).
          if (!job.isActive) {
            sendJson(res, 410, { error: "job_over", message: "This Sync is over." });
            return;
          }
          result = await this.options.importCacheChat(chat, job.userId, people, job.jobId);
        } else {
          result = await this.options.importChat(chat, job.transactionId, people);
        }
        job.progress.imported += 1;
        job.progress.messages += result.received;
        job.progress.reactions += result.reactions;
        job.progress.removedNotRelinked += result.removedByUser ?? 0;
        this.emitJob(job.snapshot());
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      case "attachment": {
        const image = parseIncomingImage(body);
        if (typeof image === "string") {
          sendJson(res, 400, { error: "bad_request", message: image });
          return;
        }
        if (!job.isMatched(image.conversationId)) {
          sendJson(res, 403, { error: "not_matched", message: "Keepr did not match this chat to a transaction contact." });
          return;
        }
        if (job.kind !== "cache" && !this.options.importImage) {
          sendJson(res, 501, { error: "unsupported", message: "This Keepr build cannot store images." });
          return;
        }
        const imageNumbers = job.numbersFor(image.conversationId);
        if (imageNumbers.length === 0) {
          sendJson(res, 400, { error: "no_number", message: RCS_NO_NUMBER_MESSAGE });
          return;
        }
        if (!(await this.stillSameUser(job))) {
          sendJson(res, 409, { error: "user_changed", message: RCS_USER_CHANGED_MESSAGE });
          return;
        }
        let result: RcsImageResult | { stored: false; reason: "not_a_contact" };
        if (job.kind === "cache") {
          if (!this.options.importCacheImage || !job.userId) {
            sendJson(res, 501, { error: "unsupported", message: "This Keepr build cannot store images." });
            return;
          }
          if (!job.isActive) {
            sendJson(res, 410, { error: "job_over", message: "This Sync is over." });
            return;
          }
          result = await this.options.importCacheImage(image, job.userId, rcsChatHash(imageNumbers), imageNumbers, job.jobId);
          if (!result.stored && result.reason === "not_a_contact") {
            // Counted and reported, never silent (BACKLOG-3658): the page lists
            // it as "images not imported".
            job.progress.imagesSkipped += 1;
            this.emitJob(job.snapshot());
            sendJson(res, 422, { error: "not_a_contact", message: RCS_IMAGE_NOT_A_CONTACT_MESSAGE });
            return;
          }
        } else {
          if (!this.options.importImage) return;
          result = await this.options.importImage(image, job.transactionId, rcsChatHash(imageNumbers));
        }
        if (!result.stored) {
          const status = result.reason === "too_large" ? 413 : result.reason === "message_not_found" ? 409 : 400;
          job.progress.skipped += 1;
          this.emitJob(job.snapshot());
          sendJson(res, status, { error: result.reason, message: `Image not stored: ${result.reason}` });
          return;
        }
        job.progress.images += 1;
        this.emitJob(job.snapshot());
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      case "progress": {
        const patch: Partial<RcsJobProgress> & { stage?: string } = {};
        for (const key of ["listed", "candidates", "checked", "skipped", "notChecked"] as const) {
          if (typeof body[key] === "number") patch[key] = body[key] as number;
        }
        if (typeof body.stage === "string") patch.stage = body.stage.slice(0, 200);
        job.updateProgress(patch);
        this.emitJob(job.snapshot());
        sendJson(res, 200, { ok: true });
        return;
      }
      case "finish": {
        // SR M: the media counts (numbers only) for the video storage estimate.
        const media = body.media && typeof body.media === "object" ? (body.media as Record<string, unknown>) : null;
        const seen = (k: string): number | null => {
          const m = media && media[k] && typeof media[k] === "object" ? (media[k] as Record<string, unknown>) : null;
          return m && typeof m.seen === "number" && Number.isFinite(m.seen) && m.seen >= 0 ? Math.floor(m.seen) : null;
        };
        // Founder (2026-10-03): time the tab was hidden and the history loaded
        // meanwhile (numbers only) — are hidden / minimized runs slower?
        const hidden = body.hidden && typeof body.hidden === "object" ? (body.hidden as Record<string, unknown>) : null;
        const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
        if (hidden) {
          this.logger.info(
            `[RcsBridge] Hidden tab: ${Math.round(n(hidden.ms) / 1000)}s in ${n(hidden.spells)} spells; ` +
              `${n(hidden.batches)} history batches in ${n(hidden.chats)} chats loaded while hidden`,
          );
        }
        if (job.kind === "cache" && job.userId && this.options.onMediaCounts && seen("photos") !== null && seen("videos") !== null) {
          this.options.onMediaCounts(job.userId, { photosSeen: seen("photos") as number, videosSeen: seen("videos") as number });
        }
        job.finish(
          this.jobs.nowMs(),
          parseNotReached(body.notReached, body.notReachedMore),
          typeof body.notChecked === "number" ? body.notChecked : undefined,
          typeof body.notText === "number" ? body.notText : undefined,
          typeof body.noMessagesYet === "number" ? body.noMessagesYet : undefined,
          typeof body.listStop === "string" ? body.listStop : undefined,
        );
        const snap = job.snapshot();
        // Counts only: chat names never go to the log. One chat can have two
        // entries (e.g. history truncated AND images failed), so chats are
        // counted by distinct name; entries past the cap are counted apart.
        const entries = snap.notReached ?? [];
        const chats = new Set(entries.map((e) => e.name)).size;
        const more = snap.notReachedMore ?? 0;
        const p = snap.progress;
        // BACKLOG-3641: the scan counts, so a 0-chat run can be explained.
        this.logger.info(
          `[RcsBridge] Sync job finished: listed ${p.listed}, candidates ${p.candidates}, checked ${p.checked}, ` +
            `matched ${p.matched}, skipped ${p.skipped}, not checked ${p.notChecked}, not text ${p.notText}, ` +
            `not synced (switched off) ${p.notSynced}; imported ${p.imported} chats, ` +
            `${p.messages} messages, ${p.removedNotRelinked} removed by you not re-added; ` +
            `${chats} chats not fully imported (${entries.length} entries${more > 0 ? `, +${more} more` : ""})`,
        );
        this.emitJob(snap);
        this.options.onJobFinished?.(snap);
        this.announceEnded(job);
        if (job.kind === "cache") {
          // The page shows what Keepr SAVED, not what it sent (the commit
          // drops what is below the months setting).
          await this.waitForSaved(job, this.options.finishSaveWaitMs ?? RCS_FINISH_SAVE_WAIT_MS);
          sendJson(res, 200, job.saved !== undefined ? { ok: true, saved: job.saved } : { ok: true });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      case "error": {
        const code = typeof body.code === "string" ? body.code.slice(0, 60) : "failed";
        const message = typeof body.message === "string" ? body.message.slice(0, 300) : "The sync failed.";
        job.fail(code, message, this.jobs.nowMs());
        this.logger.warn(`[RcsBridge] Sync job failed: ${code}`);
        this.emitJob(job.snapshot());
        this.announceEnded(job);
        sendJson(res, 200, { ok: true });
        return;
      }
      default:
        sendJson(res, 404, { error: "not_found" });
    }
  }

  /** BACKLOG-3658 P3c: POST /exclusions/list | /exclusions/set (ids only). */
  private async handleExclusions(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    if (!this.options.listExclusions || !this.options.setExclusion || !this.options.currentUserId) {
      sendJson(res, 501, { error: "unsupported" });
      return;
    }
    const read = await readJson(req, res, 4096);
    if (!read.ok) return;
    const userId = await this.options.currentUserId();
    if (!userId) {
      sendJson(res, 403, { error: "signed_out", message: "Sign in to Keepr first." });
      return;
    }
    if (path === "/exclusions/list") {
      sendJson(res, 200, { conversationIds: this.options.listExclusions(userId).slice(0, RCS_EXCLUSIONS_MAX) });
      return;
    }
    const b = (read.body && typeof read.body === "object" ? read.body : {}) as Record<string, unknown>;
    if (!isConversationId(b.conversationId) || typeof b.excluded !== "boolean") {
      sendJson(res, 400, { error: "bad_request", message: "conversationId and excluded are required" });
      return;
    }
    this.options.setExclusion(userId, b.conversationId, b.excluded);
    sendJson(res, 200, { ok: true });
  }
}
