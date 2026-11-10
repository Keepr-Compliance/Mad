/**
 * The active sender rule set — BACKLOG-4175 PR4 (portable store).
 *
 * Every consumer (address pass, detector, Learn mode) reads its rules through
 * `getActiveSenderRules()`: synchronous, never throws, never waits on the
 * network. The download itself lives in `senderRuleSetRefresher.ts`
 * (main process only); this module must load without Electron, Sentry or
 * supabaseService (it is in PORTABLE, scripts/ci/check-native-capabilities.mjs,
 * and in coreLoadsWithoutElectron.test.ts).
 *
 * Selection (pure, `selectActiveRuleSet`):
 *   1. A valid server answer always wins, whatever its version (the server
 *      decides what an org runs; unpinning a canary takes effect at the next
 *      fetch).
 *   2. Otherwise the newer of the cache and the bundled set; a tie goes to the
 *      bundled set.
 * Only the most recent attempt counts: after a later failure, an earlier valid
 * answer competes as the cache.
 *
 * Identity: an answer or cache fetched for user A counts as absent once the
 * session is known to be user B. The rules carry no user data; this keeps one
 * account's canary from following another account in the same profile.
 *
 * Rule values are never constants here: they come from the server, the cache
 * file, or bundledRules.ts. The numbers below are timings only.
 */
import fs from "fs";
import path from "path";

import { getAppPaths } from "../capabilities/appPathsProvider";
import { getErrorReporter } from "../capabilities/errorReporterProvider";
import logService from "./logService";
import { writeFileAtomic } from "./atRest/fileCrypto";
import { parseSenderRuleSet } from "../utils/senderFilter/ruleSetSchema";
import { BUNDLED_SENDER_RULES, type SenderRuleSet } from "../utils/senderFilter/bundledRules";
import type { SenderRulesProvenance, SenderRulesSource } from "../utils/senderFilter/ruleSetSource";

const MODULE = "SenderRuleSetStore";

/** File name under userData. */
export const SENDER_RULES_CACHE_FILE = "sender-rules.json";
/** Cache file format. */
const CACHE_FORMAT = 1;
/** The consumer-driven trigger (session read, then the per-user throttle) runs at most this often. */
export const IDENTITY_CHECK_MS = 60_000;
/** Re-ask after an answer, a missing RPC, an error or a refusal. */
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Re-ask after offline or a timeout. */
export const RETRY_AFTER_OFFLINE_MS = 5 * 60 * 1000;
/** A selected cache older than this is logged (once per process), never discarded. */
export const STALE_CACHE_MS = 14 * 24 * 60 * 60 * 1000;

export type NoneReason = "no_session" | "timeout" | "rpc_missing" | "offline" | "rpc_error" | "empty";
export type RejectReason = "not_object" | "shape" | "version_mismatch";

export type ServerOutcome =
  | { kind: "valid"; rules: SenderRuleSet }
  | { kind: "rejected"; reason: RejectReason; version: number | null }
  | { kind: "none"; reason: NoneReason; code?: string };

export interface ActiveSenderRules extends SenderRulesProvenance {
  rules: SenderRuleSet;
}

/** What `rpc()` resolves to (supabase-js / postgrest-js), as far as this module reads it. */
export interface RpcAnswer {
  data: unknown;
  error: { code?: unknown } | null;
  status?: number;
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Classify one `sender_rule_set_current()` call. Never throws.
 * A network failure RESOLVES (`status: 0`, `error.code: ""`), it does not reject.
 */
export function classifyServerAnswer(answer: RpcAnswer | null, timedOut: boolean): ServerOutcome {
  if (timedOut || !answer) return { kind: "none", reason: "timeout" };
  const { data, error } = answer;
  if (error) {
    const code = typeof error.code === "string" ? error.code : "";
    if (code === "PGRST202") return { kind: "none", reason: "rpc_missing" };
    if (answer.status === 0 && !code) return { kind: "none", reason: "offline" };
    return { kind: "none", reason: "rpc_error", code: code.slice(0, 16) };
  }
  if (data === null || data === undefined) return { kind: "none", reason: "empty" };
  if (!isPlainObject(data)) return { kind: "rejected", reason: "not_object", version: null };
  const version = typeof data.version === "number" ? data.version : null;
  const rules = parseSenderRuleSet(data.content);
  if (!rules) return { kind: "rejected", reason: "shape", version };
  if (data.version !== rules.version) return { kind: "rejected", reason: "version_mismatch", version };
  return { kind: "valid", rules };
}

/** Truth table: server valid > (cache if newer than bundled) > bundled. */
export function selectActiveRuleSet(
  server: ServerOutcome | null,
  cache: SenderRuleSet | null,
  bundled: SenderRuleSet,
): ActiveSenderRules {
  if (server?.kind === "valid") {
    return { rules: server.rules, version: server.rules.version, source: "download", downloadRejected: false };
  }
  const downloadRejected = server?.kind === "rejected";
  if (cache && cache.version > bundled.version) {
    return { rules: cache, version: cache.version, source: "cache", downloadRejected };
  }
  return { rules: bundled, version: bundled.version, source: "bundled", downloadRejected };
}

/** `cache`, or `cache (download rejected)`. */
export function formatSenderRulesSource(p: { source: SenderRulesSource; downloadRejected: boolean }): string {
  return p.downloadRejected ? `${p.source} (download rejected)` : p.source;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CacheEntry {
  rules: SenderRuleSet;
  fetchedAt: number;
  userId: string | null;
}

interface Attempt {
  userId: string | null | undefined;
  at: number;
  reason: "valid" | "rejected" | NoneReason;
}

type Listener = (active: ActiveSenderRules) => void;
type RefreshTrigger = (reason: "lazy") => unknown;

let initialized = false;
let cache: CacheEntry | null = null;
let lastOutcome: { outcome: ServerOutcome; userId: string | null | undefined } | null = null;
/** undefined = not read yet; null = signed out. */
let sessionUser: string | null | undefined = undefined;
let lastAttempt: Attempt | null = null;
let trigger: RefreshTrigger | null = null;
let lastTriggerAt = Number.NEGATIVE_INFINITY;
let lastKey: string | null = null;
let staleWarned = false;
let missingLogged = false;
const listeners = new Set<Listener>();

function cachePath(): string {
  return path.join(getAppPaths().userData(), SENDER_RULES_CACHE_FILE);
}

function readCacheFile(): CacheEntry | null {
  let file: string;
  try {
    file = cachePath();
  } catch {
    return null; // no host paths installed: no cache
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") void logService.warn("Sender rules cache unreadable", MODULE, { code: String(code ?? "") });
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.format !== CACHE_FORMAT) throw new Error("format");
    const rules = parseSenderRuleSet(parsed.content);
    if (!rules || parsed.version !== rules.version) throw new Error("content");
    const fetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0;
    const userId = typeof parsed.userId === "string" ? parsed.userId : null;
    return { rules, fetchedAt, userId };
  } catch {
    void logService.warn("Sender rules cache_invalid", MODULE, {});
    return null;
  }
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  cache = readCacheFile();
}

function differentUser(stamp: string | null | undefined): boolean {
  return typeof sessionUser === "string" && stamp !== sessionUser;
}

function compute(): ActiveSenderRules {
  const server = lastOutcome && !(lastOutcome.outcome.kind === "valid" && differentUser(lastOutcome.userId))
    ? lastOutcome.outcome
    : null;
  const cached = cache && !differentUser(cache.userId) ? cache : null;
  const active = selectActiveRuleSet(server, cached?.rules ?? null, BUNDLED_SENDER_RULES);
  if (active.source === "cache" && cached && !staleWarned) {
    const ageMs = Date.now() - cached.fetchedAt;
    if (ageMs > STALE_CACHE_MS) {
      staleWarned = true;
      void logService.warn("Sender rules cache is stale", MODULE, {
        version: cached.rules.version,
        ageDays: Math.floor(ageMs / 86_400_000),
      });
    }
  }
  return active;
}

function keyOf(a: ActiveSenderRules): string {
  return `${a.version}|${a.source}|${a.downloadRejected}`;
}

function notify(): void {
  const active = compute();
  const key = keyOf(active);
  if (key === lastKey) return;
  lastKey = key;
  for (const l of listeners) {
    try {
      l(active);
    } catch {
      // a listener never breaks the store
    }
  }
}

function fireTrigger(): void {
  if (!trigger) return;
  const t = Date.now();
  if (t - lastTriggerAt < IDENTITY_CHECK_MS) return;
  lastTriggerAt = t;
  try {
    void Promise.resolve(trigger("lazy")).catch(() => undefined);
  } catch {
    // fire-and-forget
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** The rule set every consumer runs. Synchronous; never throws; never waits on the network. */
export function getActiveSenderRules(): ActiveSenderRules {
  ensureInit();
  fireTrigger();
  return compute();
}

/** The refresher reports who is signed in (null = signed out). */
export function noteSessionUser(userId: string | null): void {
  ensureInit();
  if (sessionUser === userId) return;
  sessionUser = userId;
  notify();
}

/** Per-user throttle: whether a fetch for `userId` is due. */
export function shouldFetch(userId: string): boolean {
  if (!lastAttempt || lastAttempt.userId !== userId) return true;
  const wait =
    lastAttempt.reason === "offline" || lastAttempt.reason === "timeout" ? RETRY_AFTER_OFFLINE_MS : REFRESH_INTERVAL_MS;
  return Date.now() - lastAttempt.at >= wait;
}

/**
 * Record one attempt. A valid answer replaces the in-memory cache first, then
 * the file; a failed write is reported and the memory copy stays. A refused
 * answer never touches the cache. Resolves once the write (if any) is done;
 * never rejects.
 */
export async function applyServerOutcome(outcome: ServerOutcome, attemptUserId: string | null | undefined): Promise<void> {
  ensureInit();
  if (outcome.kind === "none" && outcome.reason === "no_session") return;
  const now = Date.now();
  lastAttempt = { userId: attemptUserId, at: now, reason: outcome.kind === "none" ? outcome.reason : outcome.kind };
  lastOutcome = { outcome, userId: attemptUserId };

  if (outcome.kind === "valid") {
    cache = { rules: outcome.rules, fetchedAt: now, userId: attemptUserId ?? null };
    notify();
    try {
      await writeFileAtomic(
        cachePath(),
        JSON.stringify({
          format: CACHE_FORMAT,
          fetchedAt: now,
          userId: attemptUserId ?? null,
          version: outcome.rules.version,
          content: outcome.rules,
        }),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      void logService.warn("Sender rules cache write failed", MODULE, { code: String(code ?? "") });
      try {
        getErrorReporter().captureException(err, { tags: { service: "sender-rules" } });
      } catch {
        // reporting never breaks the store
      }
    }
    return;
  }

  if (outcome.kind === "rejected") {
    void logService.warn("Sender rules download rejected", MODULE, { version: outcome.version, reason: outcome.reason });
  } else if (outcome.reason === "rpc_missing") {
    if (!missingLogged) {
      missingLogged = true;
      void logService.info("Sender rules RPC not available; using local rules", MODULE, {});
    }
  } else if (outcome.reason === "rpc_error") {
    void logService.warn("Sender rules fetch failed", MODULE, { code: outcome.code ?? "" });
  }
  notify();
}

/** Called on every change of the active version / source. Returns an unsubscribe. */
export function subscribe(listener: Listener): () => void {
  ensureInit();
  if (lastKey === null) lastKey = keyOf(compute());
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Installed by the refresher (main process). `null` removes it. */
export function setRefreshTrigger(fn: RefreshTrigger | null): void {
  trigger = fn;
  lastTriggerAt = Number.NEGATIVE_INFINITY;
}

/** Tests only. */
export function __resetForTests(): void {
  initialized = false;
  cache = null;
  lastOutcome = null;
  sessionUser = undefined;
  lastAttempt = null;
  trigger = null;
  lastTriggerAt = Number.NEGATIVE_INFINITY;
  lastKey = null;
  staleWarned = false;
  missingLogged = false;
  listeners.clear();
}
