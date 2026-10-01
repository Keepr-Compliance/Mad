/**
 * RCS extension bridge — BACKLOG-3619 (proof of concept).
 *
 * A small HTTP server on 127.0.0.1 that the Keepr Chrome extension's service
 * worker posts chats to. It holds at most ONE import session, opened from the
 * transaction's Messages tab, and every chat it receives is stored and
 * attached to that session's transaction.
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
 * - `POST /status` — bridge + session state. Diagnostics only; the extension's
 *   Send does not depend on it.
 * - `POST /chat`   — one chat. With no open session it answers 409 with
 *   {@link RCS_NO_SESSION_MESSAGE}: never a silent success.
 *
 * ## Sync jobs (BACKLOG-3620)
 * "Sync" in Keepr creates a job ({@link RcsJobRegistry}) and opens Messages for
 * Web with `#keepr-job=<jobId>`. Every job route names the job id, which is
 * random and doubles as the job's secret; the Origin pin applies too. Job
 * routes never read the manual-send session, so closing the Import panel does
 * not stop a running job.
 * - `POST /job/pending`         — an unclaimed job, for a page that lost the hash.
 * - `POST /job/:id/claim`       — claim; returns contact NAMES only. Once.
 * - `POST /job/:id/match`       — {conversationId, numbers[]} → matched contacts.
 *                                 The phone comparison happens here, in Keepr.
 * - `POST /job/:id/chat`        — a chat; 403 unless /match matched it.
 * - `POST /job/:id/attachment`  — one image; 403 unless matched; 413 over the cap.
 * - `POST /job/:id/progress`    — counts + stage for the Keepr panel.
 * - `POST /job/:id/finish`      — done; {notReached?[], notReachedMore?}: chats the
 *                                 page left out or imported in part. Keepr brings
 *                                 its window forward.
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

import * as crypto from "crypto";
import * as http from "http";

import {
  parseNotReached,
  RcsJobRegistry,
  type RcsJobContact,
  type RcsJobProgress,
  type RcsJobSnapshot,
} from "./rcsImportJob";
import { parseIncomingImage, RCS_MAX_IMAGE_BYTES, type RcsImageResult, type RcsIncomingImage } from "./rcsImportMedia";
import type { RcsImportResult, RcsIncomingChat } from "./rcsImportStore";
import { parseIncomingChat } from "./rcsImportStore";

export const RCS_BRIDGE_HOST = "127.0.0.1";
export const RCS_BRIDGE_PORT = 38619;
/** Derived from the public key in chrome-extension/manifest.json. */
export const RCS_EXTENSION_ID = "nlfohmjehedijceeelokclkglmjnlonj";
export const RCS_EXTENSION_ORIGIN = `chrome-extension://${RCS_EXTENSION_ID}`;
export const RCS_NO_SESSION_MESSAGE = "Open a transaction in Keepr and click Import first.";
/** BACKLOG-3657 (SR F1): how long a clear waits for writes in progress. */
export const RCS_DRAIN_TIMEOUT_MS = 15_000;
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

export interface RcsImportSession {
  sessionId: string;
  transactionId: string;
  chatsReceived: number;
  messagesReceived: number;
  messagesStored: number;
  startedAt: string;
}

export interface RcsBridgeStatus {
  bridge: RcsBridgeState;
  port: number;
  /** Why the bridge is unavailable, when it is. */
  reason?: string;
  session: RcsImportSession | null;
}

export interface RcsChatImportedEvent {
  sessionId: string;
  transactionId: string;
  conversationTitle: string;
  result: RcsImportResult;
  session: RcsImportSession;
}

export interface RcsBridgeLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface RcsExtensionBridgeOptions {
  importChat: (
    chat: RcsIncomingChat,
    transactionId: string,
    opts?: { participantKey?: string },
  ) => Promise<RcsImportResult>;
  onChatImported?: (event: RcsChatImportedEvent) => void;
  logger?: RcsBridgeLogger;
  /** Overridable for tests only. */
  allowedOrigin?: string;
  /** BACKLOG-3620: store one image of a matched chat. */
  importImage?: (image: RcsIncomingImage, transactionId: string) => Promise<RcsImageResult>;
  /** BACKLOG-3620: every job state/progress change. */
  onJobChanged?: (job: RcsJobSnapshot) => void;
  /** BACKLOG-3620: the job finished; Keepr brings its window forward. */
  onJobFinished?: (job: RcsJobSnapshot) => void;
  /** Overridable for tests only. */
  jobs?: RcsJobRegistry;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
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

const JOB_ROUTE = /^\/job\/([0-9a-fA-F-]{36})(?:\/(claim|match|chat|attachment|progress|finish|error))?$/;

const silentLogger: RcsBridgeLogger = { info: () => {}, warn: () => {}, error: () => {} };

export class RcsExtensionBridge {
  private server: http.Server | null = null;
  private state: RcsBridgeState = "stopped";
  private reason: string | undefined;
  private port = RCS_BRIDGE_PORT;
  private session: RcsImportSession | null = null;
  private readonly allowedOrigin: string;
  private readonly logger: RcsBridgeLogger;
  private readonly jobs: RcsJobRegistry;
  private unclaimedTimer: NodeJS.Timeout | null = null;
  /** BACKLOG-3657: see pauseWrites. */
  /** Re-entrant: overlapping clears each pause; writes reopen after the last resume. */
  private pauseCount = 0;
  private inFlightWrites = 0;
  private drainWaiters: Array<() => void> = [];

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
    options: { startDate?: string | null; unclaimedMs?: number } = {},
  ): RcsJobSnapshot {
    const unclaimedMs = options.unclaimedMs ?? 60_000;
    const job = this.jobs.create(transactionId, contacts, options.startDate ?? null);
    this.logger.info(`[RcsBridge] Sync job created for transaction ${transactionId} (${contacts.length} contacts)`);
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

  cancelJob(jobId?: string): void {
    this.jobs.cancelJob(jobId);
    const job = this.jobs.current();
    if (job) this.emitJob(job.snapshot());
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
    this.session = null;
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
      session: this.session ? { ...this.session } : null,
    };
  }

  /** Open (or replace) the one import session. */
  openSession(transactionId: string): RcsImportSession {
    this.session = {
      sessionId: crypto.randomUUID(),
      transactionId,
      chatsReceived: 0,
      messagesReceived: 0,
      messagesStored: 0,
      startedAt: new Date().toISOString(),
    };
    this.logger.info(`[RcsBridge] Import session opened for transaction ${transactionId}`);
    return { ...this.session };
  }

  /** Close the session if it is the one named (or any, when none is named). */
  closeSession(sessionId?: string): void {
    if (!this.session) return;
    if (sessionId && this.session.sessionId !== sessionId) return;
    this.logger.info(`[RcsBridge] Import session closed (${this.session.chatsReceived} chats)`);
    this.session = null;
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
          "Access-Control-Allow-Headers": "Content-Type",
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

      if (path === "/status") {
        const s = this.getStatus();
        sendJson(res, 200, {
          bridge: s.bridge,
          session: s.session
            ? { transactionId: s.session.transactionId, chatsReceived: s.session.chatsReceived }
            : null,
        });
        return;
      }

      // BACKLOG-3657: while Keepr clears the Google Messages for Web texts, no
      // chat or image may be written; writes already running are counted so
      // the clear can wait for them (no write lands between cancel and delete).
      const jobMatch = JOB_ROUTE.exec(path);
      const isWrite = path === "/chat" || (!!jobMatch && (jobMatch[2] === "chat" || jobMatch[2] === "attachment"));
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

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    jobRoute: RegExpExecArray | null,
  ): Promise<void> {
    {
      if (path === "/chat") {
        await this.handleChat(req, res);
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
        const contactIds = job.match(conversationId, shown);
        this.emitJob(job.snapshot());
        sendJson(res, 200, { matched: contactIds.length > 0, contactIds });
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
        // BACKLOG-3642: the participant key comes from the numbers THIS job's
        // /match saw (never from the page's /chat body), so a removal survives a
        // re-pair that changes the conversation id.
        const result = await this.options.importChat(chat, job.transactionId, {
          participantKey: job.participantKeyFor(chat.conversationId),
        });
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
        if (!this.options.importImage) {
          sendJson(res, 501, { error: "unsupported", message: "This Keepr build cannot store images." });
          return;
        }
        const result = await this.options.importImage(image, job.transactionId);
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
        job.finish(
          this.jobs.nowMs(),
          parseNotReached(body.notReached, body.notReachedMore),
          typeof body.notChecked === "number" ? body.notChecked : undefined,
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
            `matched ${p.matched}, skipped ${p.skipped}, not checked ${p.notChecked}; imported ${p.imported} chats, ` +
            `${p.messages} messages, ${p.removedNotRelinked} removed by you not re-added; ` +
            `${chats} chats not fully imported (${entries.length} entries${more > 0 ? `, +${more} more` : ""})`,
        );
        this.emitJob(snap);
        this.options.onJobFinished?.(snap);
        sendJson(res, 200, { ok: true });
        return;
      }
      case "error": {
        const code = typeof body.code === "string" ? body.code.slice(0, 60) : "failed";
        const message = typeof body.message === "string" ? body.message.slice(0, 300) : "The sync failed.";
        job.fail(code, message, this.jobs.nowMs());
        this.logger.warn(`[RcsBridge] Sync job failed: ${code}`);
        this.emitJob(job.snapshot());
        sendJson(res, 200, { ok: true });
        return;
      }
      default:
        sendJson(res, 404, { error: "not_found" });
    }
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.session;
    if (!session) {
      sendJson(res, 409, { error: "no_session", message: RCS_NO_SESSION_MESSAGE });
      return;
    }

    const read = await readJson(req, res);
    if (!read.ok) return;

    const chat = parseIncomingChat(read.body);
    if (typeof chat === "string") {
      sendJson(res, 400, { error: "bad_request", message: chat });
      return;
    }

    const result = await this.options.importChat(chat, session.transactionId);

    // The session may have been closed or replaced while the import ran; the
    // rows are stored and attached either way, so report success.
    if (this.session && this.session.sessionId === session.sessionId) {
      this.session.chatsReceived += 1;
      this.session.messagesReceived += result.received;
      this.session.messagesStored += result.stored;
    }
    const snapshot = this.session && this.session.sessionId === session.sessionId
      ? { ...this.session }
      : { ...session };

    this.options.onChatImported?.({
      sessionId: session.sessionId,
      transactionId: session.transactionId,
      conversationTitle: chat.title,
      result,
      session: snapshot,
    });

    sendJson(res, 200, { ok: true, ...result });
  }
}
