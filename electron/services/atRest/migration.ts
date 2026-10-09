/**
 * At-rest migration of files saved before 2.40 (BACKLOG-3816 S3).
 *
 * On the first launch after the update, every plaintext file Keepr saved under
 * the two attachment scopes is replaced by its encrypted form, in the background,
 * while the app stays usable:
 *
 *   scope id            directory under userData
 *   ─────────────────   ────────────────────────
 *   message-attachments message-attachments   (iPhone / macOS Messages / RCS)
 *   email-attachments   attachments           (Gmail / Outlook)
 *
 * ## Per launch, per scope
 *
 *  1. Open the data key FIRST. If it is unavailable, nothing is written — not even
 *     the scope state, because S0's key-creation path reads `migrating` / `done` as
 *     proof ciphertext exists (ciphertextEvidence.ts).
 *  2. Walk the directory: regular files only (lstat; symlinks are not followed),
 *     `*.kenc-tmp` skipped (an orphaned temp from a killed run is ciphertext and
 *     must count neither as a candidate nor as "encrypted"; S6 sweeps them).
 *  3. Candidates = plaintext files whose mtime is at least SETTLE_MS before this
 *     run started. Newer plaintext files are deferred to the next launch.
 *  4. Per candidate: free-space check (file size + 1 GB; the first check uses the
 *     largest candidate) → pause with a plain message and recheck every minute.
 *     Then `encryptFileInPlace` (S0): encrypted temp → fsync → decrypt and compare
 *     SHA-256 with the source → rename. A locked file (EBUSY / EPERM / EACCES) or a
 *     file that changed during encryption is retried, then skipped and retried on
 *     the next launch. The scope stays `migrating`.
 *  5. Full header scan of the scope. `done` is written ONLY when it finds zero
 *     plaintext files. A scope with no files at all is left as it is (`pending` /
 *     absent): writing `done` there would claim ciphertext exists when none does,
 *     and S0 would then refuse to create a key if the key store were ever lost.
 *
 * Resumable by header presence: a file that already carries the KEPRENC header is
 * done. A kill at any point leaves either the plaintext original (rename not yet
 * reached; the orphaned temp is skipped) or the encrypted file (rename is atomic).
 * There is no in-progress record to get out of step with the files.
 *
 * ## A write landing between the header check and the rename (SR 39166ab7 A4)
 *
 * The mechanism, in order of strength:
 *  - `encryptFileInPlace` stats the source before and after encrypting it and
 *    refuses to rename if size or mtime moved (the temp is deleted, the source is
 *    untouched, the file is retried later).
 *  - Both scopes are content-addressed: a file's name is the SHA-256 of its
 *    plaintext (iPhoneSyncStorageService, emailAttachmentService). A writer that
 *    targets the same name in the remaining stat→rename window writes the same
 *    bytes, so the encrypted file still holds exactly that content.
 *  - S1 writers write new files already encrypted, through temp + rename; a rename
 *    of theirs racing ours replaces ciphertext with ciphertext of the same bytes.
 *  - On Windows a rename over a file another process holds open fails with
 *    EBUSY / EPERM; that is retried and then skipped.
 *  - Defence in depth only: files modified less than SETTLE_MS before this run
 *    started are not touched until the next launch. This is NOT the mechanism —
 *    Windows CopyFileW keeps the source's mtime, so a pre-S1 copy can land with an
 *    old mtime; it is then encrypted under the checks above.
 * Residual, stated: a file deleted by the app in the stat→rename window is put back
 * as an orphaned encrypted file (no row points at it). No content is lost.
 *
 * ## Logs and telemetry
 *
 * Counts only: files, bytes, milliseconds, skipped, deferred. Never a path or file
 * name — Node's fs error messages embed the full path, so per-file errors are
 * reduced to their `code` here and never escape the job.
 *
 * This module is electron-free; the job wiring injects paths, key, logger and
 * window broadcast.
 */
import fs from "fs";
import path from "path";

import { hostAppPaths } from "../../capabilities/appPathsProvider";
import { hostLogger } from "../../capabilities/loggerProvider";
import { hostWindows } from "../../capabilities/windowsProvider";
import {
  AT_REST_STATUS_CHANNEL,
  type AtRestMigrationStatus,
} from "../../types/ipc/window-api-at-rest";
import { getAtRestFiles, getDataKeyService } from "./dataKeyService";
import {
  ALGORITHM_ID,
  AtRestIntegrityError,
  FORMAT_VERSION,
  HEADER_BYTES,
  KENC_TMP_SUFFIX,
  MAGIC,
  MAX_CHUNK_BYTES,
  layoutFor,
  type FileCrypto,
} from "./fileCrypto";
import { getMarkerStore, SCOPE_EMAIL_ATTACHMENTS, SCOPE_MESSAGE_ATTACHMENTS, type MarkerStore } from "./markers";

export type MigrationScopeId = typeof SCOPE_MESSAGE_ATTACHMENTS | typeof SCOPE_EMAIL_ATTACHMENTS;

export const MIGRATION_SCOPES: ReadonlyArray<{ id: MigrationScopeId; dir: string }> = [
  { id: SCOPE_MESSAGE_ATTACHMENTS, dir: "message-attachments" },
  { id: SCOPE_EMAIL_ATTACHMENTS, dir: "attachments" },
];

/** Free space kept in reserve beyond the file being encrypted. */
export const DISK_HEADROOM_BYTES = 1024 * 1024 * 1024;
/** Files modified this recently before the run started are left for the next launch. */
export const SETTLE_MS = 5_000;
export const RETRY_ATTEMPTS = 3;
export const DISK_RECHECK_MS = 60_000;

const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

type LogFn = (level: "info" | "warn" | "error", message: string) => void;

export interface MigrationDeps {
  files: () => FileCrypto;
  markers: () => MarkerStore;
  userData: () => string;
  /** Throws when the data key cannot be opened or created. */
  ensureKey: () => Promise<void>;
  /** Bytes available to this user on the volume holding `dir`. */
  freeBytes?: (dir: string) => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: LogFn;
  broadcast?: (status: AtRestMigrationStatus) => void;
  /** Schedules the disk-space recheck; returns nothing the caller needs. */
  setTimer?: (fn: () => void, ms: number) => void;
}

export interface ScopeRunResult {
  scope: MigrationScopeId;
  outcome: "key-unavailable" | "empty" | "done" | "incomplete" | "paused-disk";
  files: number;
  bytes: number;
  skipped: number;
  deferred: number;
  /** Files that start with the KEPRENC marker but fail the header check; never touched. */
  skippedDamaged: number;
  ms: number;
}

export interface AtRestMigration {
  runScope(scope: MigrationScopeId): Promise<ScopeRunResult>;
  getStatus(): AtRestMigrationStatus;
}

interface Candidate {
  path: string;
  size: number;
}

interface WalkResult {
  candidates: Candidate[];
  plaintext: number;
  deferred: number;
  regular: number;
  damaged: number;
}

/**
 * Marker present AND full-header structural check fails (C-S3a). Such a file is not
 * plaintext we can safely encrypt: re-encrypting would wrap the damage in a valid
 * container and bury it for good. TODO(S1 merged): call S1's exported header check
 * instead of this local copy of the structural rules.
 */
export function looksLikeDamagedKeprenc(buf: Buffer, fileSize: number): boolean {
  if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return false;
  if (buf.length < HEADER_BYTES) return true;
  if (buf[7] !== FORMAT_VERSION || buf[8] !== ALGORITHM_ID) return true;
  for (const i of [9, 10, 11]) if (buf[i] !== 0) return true;
  for (let i = 48; i < HEADER_BYTES; i++) if (buf[i] !== 0) return true;
  const chunkSize = buf.readUInt32BE(44);
  if (chunkSize < 1 || chunkSize > MAX_CHUNK_BYTES) return true;
  try {
    layoutFor(fileSize, chunkSize);
  } catch {
    return true;
  }
  return false;
}

async function isDamagedKeprenc(file: string, size: number): Promise<boolean> {
  const handle = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEADER_BYTES, 0);
    return looksLikeDamagedKeprenc(buf.subarray(0, bytesRead), size);
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string {
  if (error instanceof AtRestIntegrityError) return "INTEGRITY";
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "UNKNOWN";
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await fs.promises.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export function createAtRestMigration(deps: MigrationDeps): AtRestMigration {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log: LogFn = deps.log ?? ((level, message) => hostLogger[level](message));
  const freeBytes = deps.freeBytes ?? defaultFreeBytes;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms) as { unref?: () => void };
      handle.unref?.();
    });

  const status: AtRestMigrationStatus = {
    phase: "idle",
    done: 0,
    total: 0,
    minutesLeft: null,
    encryptedThisLaunch: 0,
  };
  /** Candidates counted per scope, so a re-run does not double the total. */
  const plannedPerScope = new Map<MigrationScopeId, { files: number; bytes: number }>();
  let rateStartedAt: number | null = null;
  let bytesDone = 0;
  let bytesTotal = 0;
  let filesInUse = false;
  const pausedForDisk = new Set<MigrationScopeId>();
  const running = new Set<MigrationScopeId>();
  /** Scopes that have run at least once this launch; "done" waits for all of them. */
  const attempted = new Set<MigrationScopeId>();

  function emit(): void {
    const snapshot = { ...status };
    try {
      deps.broadcast?.(snapshot);
    } catch {
      // No window to receive it is ordinary.
    }
  }

  function setPhase(): void {
    const scopesStillToRun = attempted.size < MIGRATION_SCOPES.length && status.total > 0;
    if (running.size > 0 || (scopesStillToRun && pausedForDisk.size === 0)) {
      status.phase = "running";
      delete status.pauseReason;
    } else if (pausedForDisk.size > 0) {
      status.phase = "paused";
      status.pauseReason = "disk-space";
    } else if (filesInUse) {
      status.phase = "paused";
      status.pauseReason = "files-in-use";
    } else if (status.total > 0) {
      status.phase = "done";
      delete status.pauseReason;
    } else {
      status.phase = "idle";
      delete status.pauseReason;
    }
  }

  function updateEta(): void {
    if (rateStartedAt === null || bytesDone <= 0) {
      status.minutesLeft = null;
      return;
    }
    const elapsed = now() - rateStartedAt;
    const remaining = Math.max(0, bytesTotal - bytesDone);
    status.minutesLeft = Math.ceil((elapsed / bytesDone) * remaining / 60_000);
  }

  async function walk(dir: string, cutoffMs: number, files: FileCrypto): Promise<WalkResult> {
    const result: WalkResult = { candidates: [], plaintext: 0, deferred: 0, regular: 0, damaged: 0 };
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile() || entry.name.endsWith(KENC_TMP_SUFFIX)) continue;
        let st: fs.Stats;
        try {
          st = await fs.promises.lstat(full);
          if (!st.isFile()) continue;
          result.regular++;
          // Checked before isEncrypted: a damaged-header file may read as either.
          if (await isDamagedKeprenc(full, st.size)) {
            result.damaged++;
            continue;
          }
          if (await files.isEncrypted(full)) continue;
        } catch (error) {
          if (errorCode(error) === "ENOENT") continue;
          // Unreadable right now: counts as plaintext, so the scope is not marked done.
          result.plaintext++;
          continue;
        }
        result.plaintext++;
        if (st.mtimeMs > cutoffMs) {
          result.deferred++;
          continue;
        }
        result.candidates.push({ path: full, size: st.size });
      }
    }
    return result;
  }

  async function hasRoomFor(dir: string, bytes: number): Promise<boolean> {
    try {
      return (await freeBytes(dir)) >= bytes + DISK_HEADROOM_BYTES;
    } catch {
      // Cannot measure (unsupported filesystem): do not block on it.
      return true;
    }
  }

  async function encryptWithRetry(
    files: FileCrypto,
    file: Candidate,
  ): Promise<"encrypted" | "already" | "gone" | "skipped"> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await files.encryptFileInPlace(file.path);
        return r.alreadyEncrypted ? "already" : "encrypted";
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") return "gone";
        const retryable = RETRYABLE_CODES.has(code) || code === "INTEGRITY";
        if (!retryable || attempt >= RETRY_ATTEMPTS - 1) {
          log("warn", `[AtRest] migration skipped a file (${code}); it is retried next launch`);
          return "skipped";
        }
        await sleep(200 * 2 ** attempt);
      }
    }
  }

  async function runScope(scope: MigrationScopeId): Promise<ScopeRunResult> {
    const started = now();
    const result: ScopeRunResult = {
      scope,
      outcome: "incomplete",
      files: 0,
      bytes: 0,
      skipped: 0,
      deferred: 0,
      skippedDamaged: 0,
      ms: 0,
    };
    const finish = (outcome: ScopeRunResult["outcome"]): ScopeRunResult => {
      result.outcome = outcome;
      result.ms = now() - started;
      log(
        "info",
        `[AtRest] migration ${scope}: outcome=${outcome} files=${result.files} bytes=${result.bytes} ` +
          `ms=${result.ms} skipped=${result.skipped} deferred=${result.deferred} ` +
          `skippedDamaged=${result.skippedDamaged}`,
      );
      return result;
    };
    if (running.has(scope)) return finish("incomplete");

    const spec = MIGRATION_SCOPES.find((s) => s.id === scope);
    if (!spec) throw new Error(`unknown at-rest migration scope ${scope}`);
    const dir = path.join(deps.userData(), spec.dir);

    try {
      await deps.ensureKey();
    } catch (error) {
      log("error", `[AtRest] migration ${scope}: data key unavailable (${errorCode(error)}); nothing changed`);
      return finish("key-unavailable");
    }

    const files = deps.files();
    const markers = deps.markers();
    attempted.add(scope);
    running.add(scope);
    pausedForDisk.delete(scope);
    setPhase();
    try {
      const plan = await walk(dir, started - SETTLE_MS, files);
      result.deferred = plan.deferred;
      result.skippedDamaged = plan.damaged;
      if (plan.damaged > 0) {
        log("warn", `[AtRest] migration ${scope}: ${plan.damaged} file(s) with a damaged header left untouched (reason=HEADER_INVALID)`);
      }
      if (plan.regular === 0) {
        return finish("empty");
      }

      // A re-run (after a disk-space pause) re-plans the same files: count each scope once.
      const plannedBytes = plan.candidates.reduce((n, c) => n + c.size, 0);
      const previous = plannedPerScope.get(scope);
      if (!previous) {
        plannedPerScope.set(scope, { files: plan.candidates.length, bytes: plannedBytes });
        status.total += plan.candidates.length;
        bytesTotal += plannedBytes;
      }
      if (rateStartedAt === null && plan.candidates.length > 0) rateStartedAt = now();
      emit();

      if (plan.plaintext > 0) {
        await markers.setScope(scope, "migrating", {
          candidates: plan.candidates.length,
          deferred: plan.deferred,
        });
      }

      if (plan.candidates.length > 0) {
        const largest = plan.candidates.reduce((m, c) => Math.max(m, c.size), 0);
        if (!(await hasRoomFor(dir, largest))) {
          return pauseForDisk(scope, result, finish);
        }
      }

      let lastEmit = 0;
      for (const candidate of plan.candidates) {
        if (!(await hasRoomFor(dir, candidate.size))) {
          return pauseForDisk(scope, result, finish);
        }
        const outcome = await encryptWithRetry(files, candidate);
        if (outcome === "skipped") {
          result.skipped++;
          filesInUse = true;
        } else {
          if (outcome === "encrypted") {
            result.files++;
            result.bytes += candidate.size;
            status.encryptedThisLaunch++;
          }
          status.done++;
        }
        bytesDone += candidate.size;
        updateEta();
        if (now() - lastEmit >= 250) {
          lastEmit = now();
          emit();
        }
      }

      // "done" only after a fresh scan of the whole scope finds zero plaintext.
      const scan = await walk(dir, Number.POSITIVE_INFINITY, files);
      if (scan.plaintext === 0) {
        // Done = no plaintext left. Damaged-header files are not plaintext; they stay
        // as found and are recorded here. Readers refuse them (requireEncrypted).
        await markers.setScope(scope, "done", { files: scan.regular, skippedDamaged: scan.damaged });
        return finish("done");
      }
      return finish("incomplete");
    } catch (error) {
      // Never let an fs error (which carries a path) out of the job.
      log("error", `[AtRest] migration ${scope} stopped (${errorCode(error)}); it resumes next launch`);
      return finish("incomplete");
    } finally {
      running.delete(scope);
      setPhase();
      updateEta();
      emit();
    }
  }

  function pauseForDisk(
    scope: MigrationScopeId,
    result: ScopeRunResult,
    finish: (o: ScopeRunResult["outcome"]) => ScopeRunResult,
  ): ScopeRunResult {
    pausedForDisk.add(scope);
    log("warn", `[AtRest] migration ${scope} paused: not enough free disk space`);
    setTimer(() => {
      void runScope(scope);
    }, DISK_RECHECK_MS);
    return finish("paused-disk");
  }

  return {
    runScope,
    getStatus: () => ({ ...status }),
  };
}

let instance: AtRestMigration | null = null;

/** The process-wide migration, wired to the real key, markers, paths and windows. */
export function getAtRestMigration(): AtRestMigration {
  if (!instance) {
    instance = createAtRestMigration({
      files: () => getAtRestFiles(),
      markers: () => getMarkerStore(),
      userData: () => hostAppPaths.userData(),
      ensureKey: async () => {
        await getDataKeyService().currentKey();
      },
      broadcast: (s) => hostWindows.broadcast(AT_REST_STATUS_CHANNEL, s),
    });
  }
  return instance;
}
