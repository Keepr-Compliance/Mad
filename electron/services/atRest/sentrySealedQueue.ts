/**
 * BACKLOG-4040 S3 — the Sentry offline queue, sealed at rest.
 *
 * `@sentry/electron`'s stock offline store writes every envelope that failed to
 * send as a plaintext file, `userData/sentry/queue/<uuid>` (no extension), plus a
 * `queue-v2.json` index. This module replaces that store through the PUBLIC
 * `createStore` option of `@sentry/core` `makeOfflineTransport`
 * (`installSentry.ts` passes it in `transportOptions`; the Electron wrapper spreads
 * user options after its own default, `electron-offline-net.js`).
 *
 * ## What is on disk
 *
 *   userData/sentry/sealed-queue/<13-digit ms>-<uuid>.sealed   KEPRENC containers
 *
 * Nothing else. There is no index file: the order and the age come from the file
 * name (a date and a random id, no content). The directory is separate from the
 * stock store's `queue/`, so {@link removeLegacySentryQueue} can delete that whole
 * directory without classifying anything.
 *
 * ## Before the file-data key is open
 *
 * The store never opens the key itself: the at-rest startup queue opens it after
 * the database (so the keychain is never asked before the user is told why), and
 * a refused key here must not trip the attachment writers' process-wide refusal.
 * Until {@link activateSentrySealedQueue} is called:
 *   - push / unshift keep envelopes IN MEMORY (at most {@link MAX_QUEUE_SIZE});
 *     they are sealed to disk when the key opens, and lost if the app quits first;
 *   - shift returns from memory, or undefined — it never reads, deletes or drops
 *     a sealed file on disk.
 * There is no plaintext fallback, ever.
 *
 * ## After
 *
 * push seals one file per envelope; shift opens the oldest, deletes it, returns it.
 * A file that is not a valid container (corrupt, or plaintext that something else
 * wrote) is deleted. A file whose key is not held on this computer is kept: it
 * expires by age (its name carries the date), never by a failed read.
 *
 * ## What this does NOT cover (stated, not hidden)
 *
 * `sentry/scope_v3.json` (minidump integration) and `sentry/session.json`
 * (sessions) are written by the library through a hard-coded `Store` with no
 * hook, so they cannot be sealed without patching the library. They stay
 * plaintext and are REDACTED instead: the user is sent as an id only, and every
 * main-process breadcrumb passes the scrub in `installSentry.ts`
 * (`sentryBreadcrumbScrub.ts`). `Crashpad/*.dmp` memory dumps cannot be sealed or
 * redacted; they exist only when "Send crash reports" is on.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { parseEnvelope, serializeEnvelope } from "@sentry/core";
import type { Envelope, OfflineStore } from "@sentry/core";
import { AtRestFormatError, AtRestIntegrityError, KENC_TMP_SUFFIX, type FileCrypto } from "./fileCrypto";

export const SENTRY_DIR_NAME = "sentry";
/** The stock store's directory (plaintext bodies + queue-v2.json), written by 2.41 and 2.42. */
export const LEGACY_QUEUE_DIR_NAME = "queue";
export const SEALED_QUEUE_DIR_NAME = "sealed-queue";
export const SEALED_SUFFIX = ".sealed";
/** Same limits as the stock store (offline-store.js). */
export const MAX_QUEUE_SIZE = 30;
export const MAX_AGE_DAYS = 30;
const MS_PER_DAY = 86_400_000;
const NAME_RE = /^(\d{13})-([0-9a-f]{32})\.sealed$/;

type Log = (level: "info" | "warn" | "error", message: string) => void;

interface QueueState {
  dir: string | null;
  files: FileCrypto | null;
  memory: Envelope[];
  lastShiftedMs: number | undefined;
  /** Serialises every operation (core may call push and shift concurrently). */
  chain: Promise<unknown>;
  onActivated: Array<() => void>;
  log: Log;
}

const state: QueueState = {
  dir: null,
  files: null,
  memory: [],
  lastShiftedMs: undefined,
  chain: Promise.resolve(),
  onActivated: [],
  log: () => undefined,
};

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = state.chain.then(fn, fn);
  state.chain = next.catch(() => undefined);
  return next;
}

export function sealedQueueDir(userData: string): string {
  return path.join(userData, SENTRY_DIR_NAME, SEALED_QUEUE_DIR_NAME);
}

/**
 * Delete the stock store's plaintext queue (`sentry/queue/`: event bodies with no
 * extension + `queue-v2.json`) left by 2.41 / 2.42. Synchronous, never throws.
 * Those envelopes are not sent. Returns how many files were removed.
 */
export function removeLegacySentryQueue(userData: string, log: Log = () => undefined): number {
  const dir = path.join(userData, SENTRY_DIR_NAME, LEGACY_QUEUE_DIR_NAME);
  let count = 0;
  try {
    count = fs.readdirSync(dir).length;
  } catch {
    return 0; // no legacy queue
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    log("info", `[Sentry] removed ${count} file(s) of the old offline queue`);
    return count;
  } catch (error) {
    log("warn", `[Sentry] could not remove the old offline queue: ${String(error)}`);
    return 0;
  }
}

function listSealed(dir: string): Array<{ name: string; ms: number }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; ms: number }> = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (m) out.push({ name, ms: Number(m[1]) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function unlinkQuiet(p: string): Promise<void> {
  await fs.promises.unlink(p).catch(() => undefined);
}

async function removeStale(dir: string, nowMs: number): Promise<void> {
  const cutOff = nowMs - MAX_AGE_DAYS * MS_PER_DAY;
  for (const f of listSealed(dir)) {
    if (f.ms < cutOff) await unlinkQuiet(path.join(dir, f.name));
  }
}

async function sealToDisk(files: FileCrypto, dir: string, env: Envelope, ms: number): Promise<void> {
  const data = serializeEnvelope(env);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `${String(Math.max(0, Math.floor(ms))).padStart(13, "0")}-${crypto.randomBytes(16).toString("hex")}${SEALED_SUFFIX}`;
  await files.encryptStreamToFile(Readable.from([bytes]), path.join(dir, name));
}

async function insert(env: Envelope, which: "push" | "unshift"): Promise<void> {
  const { files, dir } = state;
  if (!files || !dir) {
    if (which === "unshift") {
      state.memory.unshift(env);
      if (state.memory.length > MAX_QUEUE_SIZE) state.memory.pop();
    } else if (state.memory.length < MAX_QUEUE_SIZE) state.memory.push(env);
    return;
  }
  try {
    const now = Date.now();
    await removeStale(dir, now);
    if (which === "push" && listSealed(dir).length >= MAX_QUEUE_SIZE) return;
    const ms = which === "unshift" ? (state.lastShiftedMs ?? now) : now;
    await sealToDisk(files, dir, env, ms);
  } catch (error) {
    // Never plaintext. A failed seal loses this one envelope.
    state.log("warn", `[Sentry] could not seal a queued report: ${String(error)}`);
  }
}

async function shift(): Promise<Envelope | undefined> {
  if (state.memory.length > 0) return state.memory.shift();
  const { files, dir } = state;
  if (!files || !dir) return undefined; // key not open: leave sealed files alone
  await removeStale(dir, Date.now());
  for (const f of listSealed(dir)) {
    const p = path.join(dir, f.name);
    let raw: Buffer;
    try {
      raw = await files.readAllDecrypted(p, { requireEncrypted: true });
    } catch (error) {
      if (error instanceof AtRestFormatError || error instanceof AtRestIntegrityError) {
        await unlinkQuiet(p); // not a valid container: it can never be read
        continue;
      }
      // Key not held / not readable now: keep the file, try the next one.
      continue;
    }
    await unlinkQuiet(p);
    state.lastShiftedMs = f.ms;
    try {
      return parseEnvelope(raw);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The `createStore` given to `makeOfflineTransport`. The queue itself is module state. */
export function createSealedOfflineStore(): OfflineStore {
  return {
    push: (env) => serial(() => insert(env, "push")),
    unshift: (env) => serial(() => insert(env, "unshift")),
    shift: () => serial(() => shift()),
  };
}

/** Where the queue lives. Called by installSentry before `Sentry.init`. */
export function configureSentrySealedQueue(userData: string, log?: Log): void {
  state.dir = sealedQueueDir(userData);
  if (log) state.log = log;
}

/** Called once the queue is open, e.g. to ask the transport to flush. */
export function onSentrySealedQueueActivated(fn: () => void): void {
  state.onActivated.push(fn);
}

export function isSentrySealedQueueActive(): boolean {
  return state.files !== null;
}

/**
 * The file-data key is open: from now on envelopes are sealed to disk. Removes
 * anything in the queue directory that is not one of its sealed files (an
 * interrupted seal's temp file, or a file this store did not write), seals what
 * was held in memory, then notifies listeners.
 */
export function activateSentrySealedQueue(files: FileCrypto): Promise<void> {
  return serial(async () => {
    const dir = state.dir;
    if (!dir) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const p = path.join(dir, name);
      if (name.endsWith(KENC_TMP_SUFFIX) || !NAME_RE.test(name)) await unlinkQuiet(p);
      else if (!(await files.isEncrypted(p))) await unlinkQuiet(p);
    }
    state.files = files;
    const held = state.memory.splice(0);
    for (const env of held) await insert(env, "push");
  }).then(() => {
    for (const fn of state.onActivated) {
      try {
        fn();
      } catch {
        // a listener never breaks activation
      }
    }
  });
}

/** Tests only. */
export function resetSentrySealedQueueForTests(): void {
  state.dir = null;
  state.files = null;
  state.memory = [];
  state.lastShiftedMs = undefined;
  state.chain = Promise.resolve();
  state.onActivated = [];
  state.log = () => undefined;
}
