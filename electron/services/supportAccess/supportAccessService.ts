/**
 * Support access service (BACKLOG-2393)
 *
 * Owns the window: when it opened, when it closes, and what the user agreed to.
 * Every other part of the feature asks this one question — `isActive()` — and
 * does nothing if the answer is no.
 *
 * ## Why there is no timer
 *
 * The obvious implementation is `setTimeout(revoke, durationMs)`. It is wrong
 * in a way that is invisible until it matters: timers do not survive a quit, a
 * crash, or a laptop suspended for four days. A window that silently resets on
 * relaunch is worse than no window at all, because you would believe you were
 * collecting when you were not — and, worse, a 30-day grant restarted on every
 * launch never ends.
 *
 * So expiry is *derived*, not scheduled. We persist an absolute `expiresAt` and
 * compare it to the clock on every read. Restarts are not a special case
 * because there is no state that a restart could lose.
 *
 * ## Why the clock is injected
 *
 * `deps.now()` rather than `Date.now()` so tests can drive four different
 * durations across simulated restarts without sleeping, and so the negative
 * control (break the expiry comparison, watch the tests go red) is meaningful.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  DEFAULT_SUPPORT_ACCESS_DURATION,
  findDuration,
  type SupportAccessDurationId,
  type SupportAccessEndReason,
  type SupportAccessState,
  type SupportConsentRecord,
} from "./types";
import {
  DEFAULT_SUPPORT_LOG_SCOPES,
  normaliseScopes,
  type SupportLogScopeId,
} from "./scopes";
import {
  SUPPORT_ACCESS_DISCLOSURE_ID,
  currentDisclosure,
  currentDisclosureHash,
  hashDisclosure,
} from "./disclosure";

/** How many past grants we keep. Enough for an audit trail, not a log file. */
const MAX_HISTORY = 20;

const STATE_FILENAME = "state.json";

interface PersistedState {
  version: 1;
  current: SupportConsentRecord | null;
  history: SupportConsentRecord[];
}

export interface SupportAccessServiceDeps {
  /** Injected clock. Milliseconds since epoch. */
  now: () => number;
  /** Directory for support-access state. Created on demand. */
  baseDir: string;
  /** App version recorded on the consent record. */
  appVersion: () => string;
  /** Optional logging sink; kept minimal so tests stay quiet. */
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface GrantOptions {
  durationId: SupportAccessDurationId;
  scopes?: SupportLogScopeId[];
  /**
   * The disclosure the renderer actually rendered. Passed back so we record
   * what was on screen rather than what main *assumes* was on screen.
   *
   * It is verified, not merely stored: `grant()` hashes it and compares against
   * the shipped wording, and refuses the grant on a mismatch. The comment here
   * used to claim divergence "is caught" while nothing compared anything. With
   * PII scrubbing deferred, this consent record is the only thing protecting the
   * user, so it has to be an artifact main can actually stand behind.
   */
  disclosureId?: string;
  disclosureText?: string;
}

export type SupportAccessChangeListener = (state: SupportAccessState) => void;

/**
 * Notified whenever a window ends, for any reason. Awaited, so a listener that
 * clears data has finished before the grant is reported as over.
 */
export type SupportAccessEndListener = (
  reason: SupportAccessEndReason,
  consent: SupportConsentRecord,
) => Promise<void> | void;

/** Thrown when the wording a renderer says it displayed is not the shipped wording. */
export class DisclosureMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisclosureMismatchError";
  }
}

export class SupportAccessService {
  private deps: SupportAccessServiceDeps;
  private state: PersistedState = { version: 1, current: null, history: [] };
  private loaded = false;
  private listeners = new Set<SupportAccessChangeListener>();
  private endListeners = new Set<SupportAccessEndListener>();
  /** Serialises writes so two rapid grants cannot interleave a rename. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(deps: SupportAccessServiceDeps) {
    this.deps = deps;
  }

  private get statePath(): string {
    return path.join(this.deps.baseDir, STATE_FILENAME);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.deps.log?.(level, message);
  }

  /**
   * Read persisted state from disk. Safe to call repeatedly; only the first
   * call touches the filesystem.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.state = this.coerce(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // A corrupt state file must not open a window that was never granted.
        // Failing closed is the only safe direction here.
        this.log(
          "warn",
          `Support access state unreadable, starting closed: ${String(error)}`,
        );
      }
      this.state = { version: 1, current: null, history: [] };
    }

    // Must run after coercion, because it is coercion that can empty the scope
    // list — see below.
    await this.endIfNothingLeftToCollect();
  }

  /**
   * End a window whose every granted scope has since been removed from the app
   * (BACKLOG-2428).
   *
   * `coerceRecord` re-normalises persisted scopes on every load, so a grant
   * that named only scopes this build no longer offers arrives here with an
   * empty list. `isActive()` keys on `expiresAt`, not on scopes, so without
   * this the window stayed open — the banner said "Support access is on until
   * 9 August" over a panel reading "0 areas", collecting nothing.
   *
   * It failed safe on data and badly on trust: the app asserting that
   * something is happening when nothing is. That is the same defect as the
   * scope BACKLOG-2428 removed, which promised a capability that did not
   * exist.
   *
   * This is not a new policy. `grant()` has always refused a window with no
   * scopes (see below) on the grounds that a grant collecting nothing is not a
   * grant. `load()` simply never had the equivalent check. Ending here also
   * runs the end listeners, so the scoped log is cleared exactly as expiry
   * clears it.
   */
  private async endIfNothingLeftToCollect(): Promise<void> {
    const current = this.state.current;
    if (!current || current.endedAt) return;
    if (current.scopes.length > 0) return;

    this.log(
      "warn",
      `Support access ended: the areas this grant selected are no longer offered by this version of Keepr (granted ${current.grantedAt}, would have run to ${current.expiresAt})`,
    );
    await this.end("scopes-unavailable");
  }

  /**
   * Defend against a hand-edited or partially written state file. Anything we
   * cannot understand is discarded rather than trusted.
   */
  private coerce(parsed: unknown): PersistedState {
    const empty: PersistedState = { version: 1, current: null, history: [] };
    if (!parsed || typeof parsed !== "object") return empty;
    const obj = parsed as Record<string, unknown>;
    const current = this.coerceRecord(obj.current);
    const history = Array.isArray(obj.history)
      ? obj.history
          .map((entry) => this.coerceRecord(entry))
          .filter((entry): entry is SupportConsentRecord => entry !== null)
          .slice(0, MAX_HISTORY)
      : [];
    return { version: 1, current, history };
  }

  private coerceRecord(value: unknown): SupportConsentRecord | null {
    if (!value || typeof value !== "object") return null;
    const r = value as Record<string, unknown>;
    const expiresAt = typeof r.expiresAt === "string" ? r.expiresAt : null;
    const grantedAt = typeof r.grantedAt === "string" ? r.grantedAt : null;
    if (!expiresAt || !grantedAt) return null;
    if (Number.isNaN(Date.parse(expiresAt))) return null;
    const durationId = r.durationId as SupportAccessDurationId;
    if (!findDuration(durationId)) return null;
    return {
      id: typeof r.id === "string" ? r.id : randomUUID(),
      grantedAt,
      expiresAt,
      durationId,
      appVersion: typeof r.appVersion === "string" ? r.appVersion : "unknown",
      disclosureId:
        typeof r.disclosureId === "string"
          ? r.disclosureId
          : SUPPORT_ACCESS_DISCLOSURE_ID,
      disclosureHash:
        typeof r.disclosureHash === "string" ? r.disclosureHash : "",
      disclosureText:
        typeof r.disclosureText === "string" ? r.disclosureText : "",
      scopes: normaliseScopes(r.scopes),
      endedAt: typeof r.endedAt === "string" ? r.endedAt : undefined,
      endedReason:
        r.endedReason === "expired" ||
        r.endedReason === "revoked" ||
        r.endedReason === "scopes-unavailable"
          ? r.endedReason
          : undefined,
    };
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    const target = this.statePath;
    const tmp = `${target}.${process.pid}.tmp`;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(this.deps.baseDir, { recursive: true });
        await fs.writeFile(tmp, snapshot, "utf8");
        // Atomic swap: a crash mid-write leaves the previous state intact
        // rather than a truncated file that would fail closed and silently
        // drop an active grant.
        await fs.rename(tmp, target);
      });
    return this.writeChain;
  }

  /**
   * The guard. Synchronous and pure so it can sit in hot logging paths without
   * awaiting anything.
   */
  isActive(): boolean {
    const current = this.state.current;
    if (!current) return false;
    if (current.endedAt) return false;
    return this.deps.now() < Date.parse(current.expiresAt);
  }

  /** True when `scope` is both granted and inside the window. */
  isScopeActive(scope: SupportLogScopeId): boolean {
    if (!this.isActive()) return false;
    return this.state.current?.scopes.includes(scope) === true;
  }

  /** Scopes currently in force. Empty when the window is closed. */
  activeScopes(): SupportLogScopeId[] {
    return this.isActive() ? [...(this.state.current?.scopes ?? [])] : [];
  }

  msRemaining(): number {
    const current = this.state.current;
    if (!current || current.endedAt) return 0;
    return Math.max(0, Date.parse(current.expiresAt) - this.deps.now());
  }

  /**
   * The current consent record, whether or not the window is still open. Used
   * to answer "what wording did this person agree to?" after the fact.
   */
  getConsentRecord(): SupportConsentRecord | null {
    return this.state.current ? { ...this.state.current } : null;
  }

  getConsentHistory(): SupportConsentRecord[] {
    return this.state.history.map((entry) => ({ ...entry }));
  }

  /**
   * Retrieve a grant by id from either the current slot or history — a consent
   * record must stay reachable after the window it authorised has closed,
   * otherwise reports uploaded under it become unattributable.
   */
  findConsent(id: string): SupportConsentRecord | null {
    if (this.state.current?.id === id) return { ...this.state.current };
    const found = this.state.history.find((entry) => entry.id === id);
    return found ? { ...found } : null;
  }

  getState(): SupportAccessState {
    const active = this.isActive();
    return {
      active,
      consent: this.state.current ? { ...this.state.current } : null,
      msRemaining: this.msRemaining(),
      history: this.getConsentHistory(),
      everGranted: this.state.current !== null || this.state.history.length > 0,
    };
  }

  /**
   * Close the window if the clock has passed it, recording *why*. Call from any
   * periodic tick; `isActive()` is already correct without it, so this is
   * bookkeeping and notification rather than enforcement.
   */
  async reconcile(): Promise<boolean> {
    const current = this.state.current;
    if (!current || current.endedAt) return false;
    if (this.deps.now() < Date.parse(current.expiresAt)) return false;
    await this.end("expired");
    return true;
  }

  async grant(options: GrantOptions): Promise<SupportConsentRecord> {
    await this.load();

    const durationId = findDuration(options.durationId)
      ? options.durationId
      : DEFAULT_SUPPORT_ACCESS_DURATION;
    const duration = findDuration(durationId);
    /* istanbul ignore next -- defensive; findDuration is total over the union */
    if (!duration) throw new Error(`Unknown duration: ${durationId}`);

    const scopes = options.scopes
      ? normaliseScopes(options.scopes)
      : [...DEFAULT_SUPPORT_LOG_SCOPES];
    if (scopes.length === 0) {
      // A grant with nothing to collect is almost certainly a bug in the
      // caller, and silently accepting it would produce empty reports that
      // look like "we found nothing" rather than "we recorded nothing".
      throw new Error("At least one logging scope must be selected");
    }

    // Record the wording that was actually on screen — and check it.
    //
    // The renderer is handed this exact text by `support-access:get-state` and
    // hands it straight back, so a mismatch means the screen showed something
    // other than the shipped disclosure. That is not a case to record and carry
    // on with: the consent record would then attest to wording nobody approved,
    // and it is the only safeguard in place while scrubbing is deferred.
    // Omitting the text is still fine — programmatic callers get the shipped
    // wording, which is by definition what they agreed to.
    const shipped = currentDisclosure();
    if (
      options.disclosureText !== undefined &&
      hashDisclosure(options.disclosureText) !== currentDisclosureHash()
    ) {
      this.log(
        "error",
        "Support access grant refused: the disclosure shown does not match the shipped wording",
      );
      throw new DisclosureMismatchError(
        "The consent wording shown does not match this version of Keepr. Support access was not turned on.",
      );
    }
    if (
      options.disclosureId !== undefined &&
      options.disclosureId !== shipped.id
    ) {
      throw new DisclosureMismatchError(
        `The consent record is for a different disclosure (${options.disclosureId}). Support access was not turned on.`,
      );
    }
    const disclosureText = options.disclosureText ?? shipped.text;
    const disclosureId = options.disclosureId ?? shipped.id;

    const now = this.deps.now();
    const record: SupportConsentRecord = {
      id: randomUUID(),
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + duration.ms).toISOString(),
      durationId,
      appVersion: this.deps.appVersion(),
      disclosureId,
      disclosureHash: hashDisclosure(disclosureText),
      disclosureText,
      scopes,
    };

    // Re-granting while a window is open supersedes it rather than stacking.
    if (this.state.current) {
      const superseded: SupportConsentRecord = this.state.current.endedAt
        ? this.state.current
        : {
            ...this.state.current,
            endedAt: new Date(now).toISOString(),
            endedReason: "revoked",
          };
      this.state.history = [superseded, ...this.state.history].slice(
        0,
        MAX_HISTORY,
      );
    }
    this.state.current = record;
    await this.persist();
    this.log(
      "info",
      `Support access granted for ${duration.label}, expires ${record.expiresAt} (scopes: ${scopes.join(", ")})`,
    );
    this.emit();
    return { ...record };
  }

  async revoke(): Promise<void> {
    await this.load();
    if (!this.state.current || this.state.current.endedAt) return;
    await this.end("revoked");
  }

  /**
   * The single place a window ends.
   *
   * Every reason comes through here — revoking, simply running out, and a
   * grant whose scopes this build no longer offers. That matters: revoke used
   * to clear the scoped log while expiry did not, so a
   * window that lapsed left its contacts on disk to be swept into the *next*
   * grant's first report months later, attributed to a consent given long after
   * the data was collected. End listeners are awaited here so the cleanup has
   * actually happened before anything observes the window as closed.
   */
  private async end(reason: SupportAccessEndReason): Promise<void> {
    const current = this.state.current;
    if (!current || current.endedAt) return;
    const ended: SupportConsentRecord = {
      ...current,
      endedAt: new Date(this.deps.now()).toISOString(),
      endedReason: reason,
    };
    this.state.current = ended;
    await this.persist();
    this.log("info", `Support access ${reason} at ${ended.endedAt}`);
    await this.notifyEnded(reason, ended);
    this.emit();
  }

  private async notifyEnded(
    reason: SupportAccessEndReason,
    consent: SupportConsentRecord,
  ): Promise<void> {
    for (const listener of this.endListeners) {
      try {
        await listener(reason, { ...consent });
      } catch (error) {
        // A failed cleanup must not leave the window looking open. The data the
        // listener would have removed is still excluded from future reports by
        // the consent-id filter in supportLogStore.snapshot, which is why that
        // filter is the guarantee and this is the hygiene.
        this.log(
          "error",
          `Support access end listener failed (${reason}): ${String(error)}`,
        );
      }
    }
  }

  onChange(listener: SupportAccessChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Register cleanup that must run whenever a window ends, however it ends. */
  onEnd(listener: SupportAccessEndListener): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.log("warn", `Support access listener threw: ${String(error)}`);
      }
    }
  }

  /** Test seam: drop in-memory state and force a re-read from disk. */
  async _reloadForTests(): Promise<void> {
    this.loaded = false;
    this.state = { version: 1, current: null, history: [] };
    await this.load();
  }
}
