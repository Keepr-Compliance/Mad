/**
 * BACKLOG-3666: pairing the extension with the signed-in Keepr app — Keepr's
 * side. Pure (no Electron): the protocol (chrome-extension/pair-protocol.js,
 * SPAKE2 on P-256) and the pairing store are injected.
 *
 *   link*            C1 (reversed linking): the popup's 6-digit code, typed
 *                    in Keepr; SPAKE2 → the pairing, bound to the signed-in
 *                    user; replaces that user's earlier one.
 *   verify(...)      every signed request: the pairing id → its key; the
 *                    timestamp window (±60 s) BEFORE the nonce lookup; the
 *                    signature; the nonce (120 s, at most 10 000 per pairing);
 *                    the bound user = the signed-in user, else "re_pair".
 */

export interface PairProtocol {
  /** C1: the 6-digit link code as typed in Keepr (digits only), or null. */
  normalizeLinkCode(text: string): string | null;
  respondB(code: string, pAHex: string): { pB: string; cB: string; expectCA: string; ke: string };
  sessionKey(keHex: string, pairId: string): string;
  requestString(method: string, path: string, ts: number | string, nonce: string, bodyText: string): string;
  replyString(status: number, path: string, nonce: string, bodyText: string): string;
  sign(keyHex: string, text: string): string;
  safeEqual(a: string, b: string): boolean;
  newNonce(): string;
}

export interface RcsPairing {
  pairId: string;
  userId: string;
  keyHex: string;
}

export interface PairingStore {
  get(pairId: string): RcsPairing | null;
  /**
   * Saves the pairing and removes the user's earlier ones (re-pair replaces)
   * — in ONE transaction (SR: a failed save never leaves the user unlinked).
   */
  save(pairing: RcsPairing): void;
  existsForUser(userId: string): boolean;
  deleteForUser(userId: string): void;
}

export const PAIR_TS_WINDOW_MS = 60 * 1000;
export const PAIR_NONCE_TTL_MS = 120 * 1000;
export const PAIR_NONCE_CAP = 10_000;
/** C1 (reversed linking): the popup's code lives 2 minutes, from the popup's /link/start. */
export const LINK_TTL_MS = 2 * 60 * 1000;
/** C1: wrong codes typed in Keepr before the session is dropped. */
export const LINK_MAX_TRIES = 5;
/** C1 (SR): at most this many /link/start a minute; more locks linking for a minute. */
export const LINK_STARTS_PER_MIN = 5;
export const LINK_LOCKOUT_MS = 60 * 1000;
export const LINK_INTERRUPTED_MESSAGE = "Pairing interrupted, try again";
/**
 * Live (B1, founder 2026-10-03): Keepr says "linked" only when the extension
 * PROVED it — a signed call (or the link itself) within this long. A row
 * alone is not proof (the extension may have lost its key: removed and
 * loaded again, browser data cleared, another Chrome profile).
 */
export const LINK_PROOF_MS = 24 * 60 * 60 * 1000;

export const LINK_INTRUSION_MESSAGE = "Another app tried to link — check for unknown software";
/** C1: Keepr's link screen, from Keepr's state (never anything the page could see). */
export type LinkState =
  | { state: "none"; intrusion: boolean }
  | { state: "waiting"; expiresAt: number; triesLeft: number; intrusion: boolean }
  | { state: "answered"; expiresAt: number; triesLeft: number; intrusion: boolean }
  | { state: "locked"; until: number; intrusion: boolean };

export const PAIR_HEADERS = {
  pair: "x-keepr-pair",
  ts: "x-keepr-ts",
  nonce: "x-keepr-nonce",
  sig: "x-keepr-sig",
} as const;

type Reply = { status: number; body: Record<string, unknown>; signWith?: { keyHex: string; nonce: string } };

export type VerifyResult =
  | { ok: true; pairing: RcsPairing; nonce: string }
  /** keyHex present → the error reply is signed (every error except an unknown pairing). */
  | { ok: false; status: number; error: string; keyHex?: string; nonce?: string };

/** Live (B3): the ONE line for "not linked", in Keepr and in the extension. */
const NOT_PAIRED_MESSAGE = "Not linked. Click the Keepr icon in Chrome's toolbar to link.";

export class RcsPairingAuth {
  /** C1: the ONE pending reversed-link session (the popup's code). */
  private link: {
    sessionId: string;
    pA: string;
    expiresAt: number;
    tries: number;
    /** Keepr's answer to the code typed in Keepr (cleared after a wrong code). */
    answer: { pB: string; cB: string; expectCA: string; ke: string; userId: string } | null;
  } | null = null;
  private linkStarts: number[] = [];
  /** B1: when each user's link was last proven (a signed call, or the link itself). In memory. */
  private readonly proven = new Map<string, number>();
  /**
   * SR (B1): when an extension last said, unsigned, "no link here". It only
   * changes what Keepr SHOWS — it never deletes a link (anyone on this
   * computer can send it, and a second, unlinked Chrome profile sends it too).
   */
  private unlinkedReportAt: number | null = null;
  private linkLockedUntil = 0;
  /** C1 (SR): too many /link/start in a minute — said in Keepr's link screen. */
  private linkIntrusion = false;
  private readonly nonces = new Map<string, Map<string, number>>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private loaded: PairProtocol | null = null;

  /** `protocol` may be a loader: Keepr loads pair-protocol.js from the shipped extension folder on first use. */
  constructor(
    private readonly protocolSource: PairProtocol | (() => PairProtocol),
    private readonly store: PairingStore,
    opts: { now?: () => number; randomId?: () => string } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.randomId = opts.randomId ?? (() => this.protocol.newNonce());
  }

  private get protocol(): PairProtocol {
    if (!this.loaded) this.loaded = typeof this.protocolSource === "function" ? this.protocolSource() : this.protocolSource;
    return this.loaded;
  }

  /**
   * B1: linked AND proven by the extension recently (what Keepr shows as
   * "Linked"), and no extension has said "no link here" since that proof.
   */
  isLinkProven(userId: string): boolean {
    const at = this.proven.get(userId);
    if (at === undefined || this.now() - at > LINK_PROOF_MS) return false;
    if (this.unlinkedReportAt !== null && this.unlinkedReportAt >= at) return false;
    return this.isPaired(userId);
  }

  /** SR (B1): an unsigned "no link here" (/hello linked:false) — display only, never a delete. */
  noteExtensionUnlinked(): void {
    this.unlinkedReportAt = this.now();
  }

  /** SR (B1): Keepr's own "Forget link" — the user's link goes. */
  forgetLink(userId: string): void {
    this.revoke(userId);
  }

  isPaired(userId: string): boolean {
    return this.store.existsForUser(userId);
  }

  /** Sign-out / user switch: the user's pairing goes. */
  revoke(userId: string): void {
    this.store.deleteForUser(userId);
    this.proven.delete(userId);
  }

  /**
   * SR S1: what the HEADERS alone can settle, before any body is read: the
   * pairing is known, the timestamp is in the window, the nonce well formed.
   */
  precheck(headers: Record<string, string | string[] | undefined>): VerifyResult | { ok: true; pairing: RcsPairing } {
    const h = (k: string): string => {
      const v = headers[k];
      return typeof v === "string" ? v : "";
    };
    const pairId = h(PAIR_HEADERS.pair);
    const pairing = pairId ? this.store.get(pairId) : null;
    if (!pairing) return { ok: false, status: 401, error: "unknown_pair" };
    const nonce = h(PAIR_HEADERS.nonce);
    const ts = Number(h(PAIR_HEADERS.ts));
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > PAIR_TS_WINDOW_MS) {
      return { ok: false, status: 401, error: "stale", keyHex: pairing.keyHex, nonce };
    }
    if (!/^[0-9a-f]{16,64}$/.test(nonce)) return { ok: false, status: 400, error: "bad_nonce", keyHex: pairing.keyHex, nonce };
    return { ok: true, pairing };
  }

  /** A signed request (headers lower-cased by Node). */
  verify(
    headers: Record<string, string | string[] | undefined>,
    method: string,
    path: string,
    bodyText: string,
    currentUserId: string | null | undefined,
  ): VerifyResult {
    const h = (k: string): string => {
      const v = headers[k];
      return typeof v === "string" ? v : "";
    };
    const pairId = h(PAIR_HEADERS.pair);
    const pairing = pairId ? this.store.get(pairId) : null;
    // The one unsigned error: Keepr has no key to sign with.
    if (!pairing) return { ok: false, status: 401, error: "unknown_pair" };
    const nonce = h(PAIR_HEADERS.nonce);
    const err = (status: number, error: string): VerifyResult => ({ ok: false, status, error, keyHex: pairing.keyHex, nonce });
    const ts = Number(h(PAIR_HEADERS.ts));
    // The timestamp window FIRST: an old request never reaches the nonce store.
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > PAIR_TS_WINDOW_MS) return err(401, "stale");
    if (!/^[0-9a-f]{16,64}$/.test(nonce)) return err(400, "bad_nonce");
    const expected = this.protocol.sign(pairing.keyHex, this.protocol.requestString(method, path, ts, nonce, bodyText));
    if (!this.protocol.safeEqual(h(PAIR_HEADERS.sig), expected)) return err(401, "bad_signature");
    const seen = this.noncesFor(pairId);
    if (seen.has(nonce)) return err(401, "replay");
    if (seen.size >= PAIR_NONCE_CAP) return err(429, "busy");
    seen.set(nonce, this.now());
    if (currentUserId !== undefined && pairing.userId !== currentUserId) return err(401, "re_pair");
    this.proven.set(pairing.userId, this.now());
    return { ok: true, pairing, nonce };
  }

  // ==========================================================================
  // C1 (UX redesign, founder 2026-10-03): REVERSED linking. The popup makes
  // a 6-digit code (never sent) and starts a session; the user types the code
  // into Keepr; the popup polls for Keepr's answer and confirms. One pending
  // session (a second start aborts both), 2 minutes, 5 wrong codes, at most
  // 5 starts a minute (then a 1-minute lockout, said in Keepr). One linked
  // browser per user: a new link revokes the old one.
  // ==========================================================================

  /** POST /link/start {pA} — the popup. */
  linkStart(body: unknown): Reply {
    const now = this.now();
    this.linkStarts = this.linkStarts.filter((t) => now - t < 60_000);
    if (now < this.linkLockedUntil) return { status: 429, body: { error: "locked", message: LINK_INTRUSION_MESSAGE } };
    this.linkStarts.push(now);
    if (this.linkStarts.length > LINK_STARTS_PER_MIN) {
      this.linkLockedUntil = now + LINK_LOCKOUT_MS;
      this.linkIntrusion = true;
      this.link = null;
      return { status: 429, body: { error: "locked", message: LINK_INTRUSION_MESSAGE } };
    }
    // One pending session: a second start (another popup — or another app)
    // aborts BOTH; the user starts again.
    if (this.link && now <= this.link.expiresAt) {
      this.link = null;
      return { status: 409, body: { error: "interrupted", message: LINK_INTERRUPTED_MESSAGE } };
    }
    const pA = body && typeof body === "object" ? (body as Record<string, unknown>).pA : undefined;
    if (typeof pA !== "string" || pA.length === 0 || pA.length > 200) return { status: 400, body: { error: "bad_request" } };
    const sessionId = this.randomId();
    this.link = { sessionId, pA, expiresAt: now + LINK_TTL_MS, tries: 0, answer: null };
    return { status: 200, body: { sessionId, expiresInMs: LINK_TTL_MS } };
  }

  /** Keepr's link screen: the code the user typed (from the popup). Never throws. */
  linkEnterCode(userId: string, typed: string): { ok: true } | { ok: false; reason: "no_session" | "expired" | "bad_shape" | "bad_code" } {
    const l = this.link;
    if (!l) return { ok: false, reason: "no_session" };
    if (this.now() > l.expiresAt) {
      this.link = null;
      return { ok: false, reason: "expired" };
    }
    const code = this.protocol.normalizeLinkCode(typed);
    if (!code) return { ok: false, reason: "bad_shape" };
    try {
      const a = this.protocol.respondB(code, l.pA);
      l.answer = { pB: a.pB, cB: a.cB, expectCA: a.expectCA, ke: a.ke, userId };
      return { ok: true };
    } catch {
      return { ok: false, reason: "bad_code" };
    }
  }

  /** POST /link/poll {sessionId} — the popup waits for Keepr's answer. */
  linkPoll(body: unknown): Reply {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const l = this.link;
    if (!l || b.sessionId !== l.sessionId) return { status: 404, body: { error: "no_session" } };
    if (this.now() > l.expiresAt) {
      this.link = null;
      return { status: 410, body: { error: "expired" } };
    }
    if (!l.answer) return { status: 200, body: { state: "waiting", triesLeft: LINK_MAX_TRIES - l.tries } };
    return { status: 200, body: { state: "answered", pB: l.answer.pB, cB: l.answer.cB } };
  }

  /**
   * POST /link/finish {sessionId, cA, nonce} — the popup's confirmation. A
   * wrong code (the popup reports one it caught, cA "wrong") counts a try and
   * waits for the next code typed in Keepr; the 5th drops the session.
   * Success: the user's earlier link is revoked, the new one saved, the reply
   * signed with the new key.
   */
  linkFinish(body: unknown): Reply {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const l = this.link;
    if (!l || b.sessionId !== l.sessionId) return { status: 404, body: { error: "no_session" } };
    if (this.now() > l.expiresAt) {
      this.link = null;
      return { status: 410, body: { error: "expired" } };
    }
    if (!l.answer) return { status: 409, body: { error: "waiting" } };
    if (typeof b.cA !== "string" || !this.protocol.safeEqual(b.cA, l.answer.expectCA)) {
      l.tries += 1;
      l.answer = null;
      if (l.tries >= LINK_MAX_TRIES) {
        this.link = null;
        return { status: 429, body: { error: "too_many_tries" } };
      }
      return { status: 403, body: { error: "bad_code", triesLeft: LINK_MAX_TRIES - l.tries } };
    }
    const keyHex = this.protocol.sessionKey(l.answer.ke, l.sessionId);
    // One linked browser per user: the store replaces the user's old link
    // with the new one in ONE transaction (SR) — the old one's requests
    // become "unknown"; a failed save leaves the old link as it was.
    this.store.save({ pairId: l.sessionId, userId: l.answer.userId, keyHex });
    this.proven.set(l.answer.userId, this.now());
    this.link = null;
    this.linkIntrusion = false;
    return { status: 200, body: { ok: true, linked: true }, signWith: { keyHex, nonce: typeof b.nonce === "string" ? b.nonce : "" } };
  }

  /** Keepr's link screen. */
  linkState(): LinkState {
    const now = this.now();
    if (now < this.linkLockedUntil) return { state: "locked", until: this.linkLockedUntil, intrusion: this.linkIntrusion };
    const l = this.link;
    if (!l || now > l.expiresAt) return { state: "none", intrusion: this.linkIntrusion };
    return { state: l.answer ? "answered" : "waiting", expiresAt: l.expiresAt, triesLeft: LINK_MAX_TRIES - l.tries, intrusion: this.linkIntrusion };
  }

  /** The user dismissed the intrusion warning in Keepr. */
  clearLinkIntrusion(): void {
    this.linkIntrusion = false;
  }

  /** The reply signature header value. */
  signReply(keyHex: string, status: number, path: string, nonce: string, bodyText: string): string {
    return this.protocol.sign(keyHex, this.protocol.replyString(status, path, nonce, bodyText));
  }

  /** The pairing's nonces, with those older than PAIR_NONCE_TTL_MS evicted. */
  private noncesFor(pairId: string): Map<string, number> {
    let m = this.nonces.get(pairId);
    if (!m) {
      m = new Map();
      this.nonces.set(pairId, m);
    }
    const cutoff = this.now() - PAIR_NONCE_TTL_MS;
    for (const [n, at] of m) {
      if (at >= cutoff) break; // insertion order = time order
      m.delete(n);
    }
    return m;
  }
}

export { NOT_PAIRED_MESSAGE };
