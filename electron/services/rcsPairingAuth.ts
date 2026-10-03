/**
 * BACKLOG-3666: pairing the extension with the signed-in Keepr app — Keepr's
 * side. Pure (no Electron): the protocol (chrome-extension/pair-protocol.js,
 * SPAKE2 on P-256) and the pairing store are injected.
 *
 *   issueCode(user)  a one-time code (8 base32 characters): 5 minutes, 5
 *                    tries (each /pair/start is one), single use.
 *   start(pA)        Keepr's SPAKE2 answer {pairId, pB, cB}; the exchange is
 *                    held 60 s for /pair/finish.
 *   finish(id, cA)   the extension's confirmation → the pairing, bound to the
 *                    user who issued the code; replaces that user's earlier one.
 *   verify(...)      every signed request: the pairing id → its key; the
 *                    timestamp window (±60 s) BEFORE the nonce lookup; the
 *                    signature; the nonce (120 s, at most 10 000 per pairing);
 *                    the bound user = the signed-in user, else "re_pair".
 */

export interface PairProtocol {
  newCode(): string;
  normalizeCode(text: string): string | null;
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
  /** Saves the pairing and removes the user's earlier ones (re-pair replaces). */
  save(pairing: RcsPairing): void;
  existsForUser(userId: string): boolean;
  deleteForUser(userId: string): void;
}

export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
export const PAIR_CODE_MAX_TRIES = 5;
export const PAIR_EXCHANGE_TTL_MS = 60 * 1000;
export const PAIR_TS_WINDOW_MS = 60 * 1000;
export const PAIR_NONCE_TTL_MS = 120 * 1000;
export const PAIR_NONCE_CAP = 10_000;

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

const NOT_PAIRED_MESSAGE = "Pair the extension with Keepr: open Keepr › Settings › Google Messages.";
/** SR: 5 wrong tries burned the code — worth saying plainly (it can be an attack). */
export const CODE_BURNED_MESSAGE = "Code used up by wrong attempts — get a new code.";
const NO_CODE_MESSAGE = "Show a new pairing code in Keepr first.";

/** The code Keepr shows, as it stands now (Keepr's API; the UI is the founder's next spec). */
export type PairCodeState = "none" | "active" | "expired" | "burned";

export class RcsPairingAuth {
  private pending: { code: string; userId: string; expiresAt: number; tries: number } | null = null;
  /** SR: the last code was burned by wrong tries (cleared by a new code). */
  private burned = false;
  /** The last code ran out of time (cleared by a new code): later attempts say so. */
  private expired = false;
  private readonly exchanges = new Map<string, { userId: string; expectCA: string; ke: string; expiresAt: number }>();
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
   * A new code for `userId`. Founder (live, 0.3.25): starting a (re-)pair
   * REVOKES the user's current pairing at once — the old pair id is unknown
   * from now on, so the extension forgets it at its next call and offers the
   * code field (never "paired" to a pairing Keepr is replacing). Any
   * earlier code is dropped.
   */
  issueCode(userId: string): { code: string; expiresAt: number } {
    this.revoke(userId);
    const code = this.protocol.newCode();
    const expiresAt = this.now() + PAIR_CODE_TTL_MS;
    this.pending = { code, userId, expiresAt, tries: 0 };
    this.exchanges.clear();
    this.burned = false;
    this.expired = false;
    return { code, expiresAt };
  }

  /**
   * The code is dropped (cancelled in Keepr, or used). With `code`: only if
   * it is still the code pending (live: a second panel closing must not
   * drop the code the first one shows).
   */
  cancelCode(code?: string): void {
    if (code !== undefined && (!this.pending || this.pending.code !== code)) return;
    this.pending = null;
    this.exchanges.clear();
  }

  /** SR: the code shown was used up by wrong attempts. */
  codeBurned(): boolean {
    return this.burned;
  }

  /**
   * Live (E): the code's state NOW — expiry is measured from when Keepr made
   * the code (5 minutes; attempts never extend it), evaluated here, not only
   * at the next /pair/start.
   */
  codeState(): PairCodeState {
    if (this.pending) return this.now() > this.pending.expiresAt ? "expired" : "active";
    if (this.burned) return "burned";
    if (this.expired) return "expired";
    return "none";
  }

  isPaired(userId: string): boolean {
    return this.store.existsForUser(userId);
  }

  /** Sign-out / user switch: the user's pairing goes. */
  revoke(userId: string): void {
    this.store.deleteForUser(userId);
  }

  /** POST /pair/start {pA}. */
  start(body: unknown): Reply {
    const p = this.pending;
    // Live (E): an attempt against a burned or expired code gets that reason
    // (error code), not "no code".
    if (p && this.now() > p.expiresAt) {
      this.pending = null;
      this.exchanges.clear();
      this.expired = true;
    }
    if (!this.pending) {
      if (this.burned) return { status: 429, body: { error: "too_many_tries", message: CODE_BURNED_MESSAGE } };
      if (this.expired) return { status: 410, body: { error: "expired", message: NO_CODE_MESSAGE } };
      return { status: 404, body: { error: "no_code", message: NO_CODE_MESSAGE } };
    }
    if (!p) return { status: 404, body: { error: "no_code", message: NO_CODE_MESSAGE } };
    p.tries += 1;
    if (p.tries > PAIR_CODE_MAX_TRIES) {
      this.cancelCode();
      this.burned = true;
      return { status: 429, body: { error: "too_many_tries", message: CODE_BURNED_MESSAGE } };
    }
    const pA = body && typeof body === "object" ? (body as Record<string, unknown>).pA : undefined;
    if (typeof pA !== "string" || pA.length > 200) return { status: 400, body: { error: "bad_request" } };
    let answer: ReturnType<PairProtocol["respondB"]>;
    try {
      answer = this.protocol.respondB(p.code, pA);
    } catch {
      return { status: 400, body: { error: "bad_request" } };
    }
    const pairId = this.randomId();
    this.exchanges.set(pairId, { userId: p.userId, expectCA: answer.expectCA, ke: answer.ke, expiresAt: this.now() + PAIR_EXCHANGE_TTL_MS });
    // A count only: the tries this code has left after this one.
    return { status: 200, body: { pairId, pB: answer.pB, cB: answer.cB, triesLeft: Math.max(0, PAIR_CODE_MAX_TRIES - p.tries) } };
  }

  /** POST /pair/finish {pairId, cA}. Success is signed with the new key. */
  finish(body: unknown): Reply {
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const pairId = typeof b.pairId === "string" ? b.pairId : "";
    const ex = this.exchanges.get(pairId);
    if (!ex || this.now() > ex.expiresAt) {
      this.exchanges.delete(pairId);
      return { status: 404, body: { error: "no_exchange" } };
    }
    this.exchanges.delete(pairId);
    if (typeof b.cA !== "string" || !this.protocol.safeEqual(b.cA, ex.expectCA)) {
      // Live (E): a wrong code (the extension reports one it caught itself,
      // too). The 5th wrong try uses the code up AT ONCE (it was only burned
      // at a 6th attempt); before it, the tries left (a count).
      const p = this.pending;
      const left = p ? Math.max(0, PAIR_CODE_MAX_TRIES - p.tries) : 0;
      if (p && left === 0) {
        this.cancelCode();
        this.burned = true;
        return { status: 429, body: { error: "too_many_tries", message: CODE_BURNED_MESSAGE } };
      }
      return { status: 403, body: { error: "bad_code", message: "That code didn't match. Check it and try again.", ...(p ? { triesLeft: left } : {}) } };
    }
    const keyHex = this.protocol.sessionKey(ex.ke, pairId);
    this.store.save({ pairId, userId: ex.userId, keyHex });
    this.cancelCode(); // single use
    return { status: 200, body: { ok: true, paired: true }, signWith: { keyHex, nonce: typeof b.nonce === "string" ? b.nonce : "" } };
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
    return { ok: true, pairing, nonce };
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
