/**
 * The per-file work of sealing the kept iPhone backup (BACKLOG-3816, seal throughput).
 *
 * Runs inside worker threads (sealWorker.ts) with SYNCHRONOUS file I/O. Two reasons:
 *
 *  - The main process stays responsive: no AES, no hashing and no blocking call runs
 *    on the main thread while a 67 GB / 573k-file backup is sealed.
 *  - libuv's thread pool (4 threads) is shared by the whole process. The async version
 *    of this work kept that pool saturated with fsync-bound operations, so every other
 *    file operation in the app queued behind it. Sync calls in a worker use the worker's
 *    own thread and never touch the pool; N workers = N files in flight.
 *
 * Every container this writes is byte-for-byte the KEPRENC v1 format of fileCrypto.ts,
 * built from the same primitives, and is read back by the same readers.
 *
 * ## Per file (one open of the source)
 *
 *   open → fstat → read the first ≤60 bytes → classify
 *     empty      0 bytes: nothing to protect (unchanged rule)
 *     sealed     structurally a KEPRENC container: left alone
 *     damaged    KEPRENC magic but not a valid container: left alone, counted
 *     plaintext  sealed as below (mode "seal"), or only reported (mode "classify")
 *
 *   seal: temp `<file>.<rand>.kenc-tmp` beside the file (mode 0600, exclusive create)
 *     for each chunk: read exactly its bytes → seal → OPEN THE SEALED CHUNK AGAIN IN
 *       MEMORY and compare it byte-for-byte with the source chunk → write
 *     fsync the temp → its size must equal the exact container size
 *     close the source → the file must be unchanged (size, mtime, inode) → rename
 *
 * ## What replaced the old "decrypt the temp from disk" verify, and why it is equivalent
 *
 * The old path re-opened the temp right after its fsync and decrypted it. Those reads
 * are served from the page cache, i.e. from the very bytes this process just handed to
 * write(): they proved "the bytes written decrypt to the source", not "the disk holds
 * them". The in-memory open of each sealed chunk proves the same thing against the
 * same bytes (it is the buffer passed to write), byte-for-byte rather than by SHA-256,
 * and the temp's size check after fsync catches a short or lost write. Durability is
 * unchanged: the temp is fsynced BEFORE the rename replaces the plaintext.
 *
 * ## Directory fsync, once per directory instead of once per file
 *
 * The data fsync before the rename is what guarantees the plaintext is never lost. A
 * directory fsync only makes the rename itself durable. If power is lost before the
 * rename reaches the disk, the rename rolls back: the ORIGINAL plaintext file is still
 * there (not lost), plus an orphaned `.kenc-tmp` that the next pass deletes, and the
 * next pass seals the file again. So the directories touched by a pass are fsynced
 * once, after the pass, before the `encrypted` marker is written (backupAtRest.ts).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import {
  AtRestFormatError,
  AtRestIntegrityError,
  buildHeader,
  DEFAULT_CHUNK_BYTES,
  deriveFileKey,
  HEADER_BYTES,
  layoutFor,
  MAGIC,
  MAX_CHUNK_BYTES,
  openChunk,
  parseHeader,
  SALT_BYTES,
  sealChunk,
  TAG_BYTES,
  tmpPathFor,
} from "./fileCrypto";

export type SealMode = "seal" | "classify";

/**
 * sealed-now  this call sealed it
 * sealed      already a valid container
 * plaintext   (classify mode only) not sealed
 * gone        deleted while the pass ran (ENOENT)
 * failed      gave up after retries; `code` says why (errno code or INTEGRITY)
 */
export type FileVerdict = "sealed-now" | "sealed" | "plaintext" | "empty" | "damaged" | "gone" | "failed";

export interface FileOutcome {
  v: FileVerdict;
  code?: string;
}

export interface EngineKey {
  keyId: string;
  key: Buffer;
}

export interface SealEngineOptions {
  chunkSize?: number;
  /** Attempts for a transient lock (EBUSY/EPERM/EACCES) or a file that changed underneath. */
  attempts?: number;
  /** Base back-off between attempts; doubles each time. */
  retryDelayMs?: number;
  /**
   * MEASUREMENT ONLY (the benchmark's --no-fsync): skip the temp's data fsync to show what
   * it costs. The app never sets it — without it a power cut can leave a renamed but empty
   * container where the plaintext was.
   */
  skipDataFsyncForMeasurement?: boolean;
  /** Test seam (in-process only): called before a plaintext file is sealed; throw to fail it. */
  beforeSeal?: (filePath: string) => void;
}

export interface BatchResult {
  /** One per file processed, in order. Shorter than the input when the pass was stopped. */
  outcomes: FileOutcome[];
  /** Directories in which a rename happened (fsynced once at the end of the pass). */
  touchedDirs: string[];
  stopped: boolean;
}

export const SEAL_ATTEMPTS = 3;
const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

/** The source changed while it was being sealed (retryable; the temp is discarded). */
export class SourceChangedError extends AtRestIntegrityError {
  constructor() {
    super("source file changed while it was being encrypted");
    this.name = "SourceChangedError";
  }
}

/** Same mapping as backupAtRest's errCode (kept here so a worker needs nothing else). */
export function engineErrCode(error: unknown): string {
  if (error instanceof AtRestIntegrityError) return "INTEGRITY";
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string") return code;
  if (error instanceof Error && error.name === "DataKeyUnavailableError") return "KEY_MISSING";
  return error instanceof Error ? error.name : "UNKNOWN";
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readFully(fd: number, buf: Buffer, length: number, position: number): number {
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, position + off);
    if (n === 0) break;
    off += n;
  }
  return off;
}

function writeFully(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    off += fs.writeSync(fd, buf, off, buf.length - off);
  }
}

/** Classification from the first ≤60 bytes and the size — no key needed (same rules as fileCrypto's probe). */
export function classifyHead(head: Buffer, size: number): "empty" | "plaintext" | "sealed" | "damaged" {
  if (size === 0) return "empty";
  if (head.length < MAGIC.length || !head.subarray(0, MAGIC.length).equals(MAGIC)) return "plaintext";
  if (size < HEADER_BYTES || head.length < HEADER_BYTES) return "damaged";
  try {
    const header = parseHeader(head);
    layoutFor(size, header.chunkSize);
    return "sealed";
  } catch (error) {
    if (error instanceof AtRestFormatError) return "damaged";
    throw error;
  }
}

/**
 * rename(temp → file). On Windows a rename cannot replace a READ-ONLY file (EPERM), and
 * a backup keeps the phone's own file modes, so some files arrive read-only. Such a file
 * could never be sealed: every pass left it plaintext and the chain never reached
 * `encrypted` (BACKLOG-3816, founder QA on the PC — MECHANISM INFERRED from 2 of 1,076
 * files staying plaintext; see the handoff). The file's write bit is set and the rename
 * tried once more. A writable target that still refuses is a lock (antivirus), which the
 * caller retries.
 */
export function renameOver(tmp: string, target: string): void {
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    let mode: number;
    try {
      mode = fs.statSync(target).mode;
    } catch {
      throw error;
    }
    if ((mode & 0o200) !== 0) throw error;
    fs.chmodSync(target, 0o600);
    fs.renameSync(tmp, target);
  }
}

export interface SealEngine {
  /** Process `files` in order; `shouldStop` is checked before each file (a safe point). */
  runBatch(files: readonly string[], mode: SealMode, shouldStop?: () => boolean): BatchResult;
  /** Overwrite the key bytes this engine holds. */
  dispose(): void;
}

export function createSealEngine(key: EngineKey, options: SealEngineOptions = {}): SealEngine {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_BYTES;
  if (chunkSize < 1 || chunkSize > MAX_CHUNK_BYTES) {
    throw new AtRestFormatError(`chunk size ${chunkSize} is out of range`);
  }
  const attempts = Math.max(1, options.attempts ?? SEAL_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? 100;
  const dataKey = Buffer.from(key.key);
  const plainBuf = Buffer.allocUnsafe(chunkSize);
  const head = Buffer.alloc(HEADER_BYTES);

  /** Seal an open plaintext source. Closes `fd` (Windows cannot rename over an open file). */
  function sealOpen(filePath: string, fd: number, st: fs.Stats): void {
    const size = st.size;
    const salt = crypto.randomBytes(SALT_BYTES);
    const header = buildHeader(key.keyId, salt, chunkSize);
    const fileKey = deriveFileKey(dataKey, salt);
    const chunkCount = Math.max(1, Math.ceil(size / chunkSize));
    const expectedSize = HEADER_BYTES + size + chunkCount * TAG_BYTES;
    const tmp = tmpPathFor(filePath);
    let tfd: number | null = fs.openSync(tmp, "wx", 0o600);
    let sourceOpen = true;
    try {
      writeFully(tfd, header);
      for (let index = 0; index < chunkCount; index++) {
        const length = Math.min(chunkSize, size - index * chunkSize);
        const got = readFully(fd, plainBuf, length, index * chunkSize);
        if (got !== length) throw new SourceChangedError();
        const plain = plainBuf.subarray(0, length);
        const isFinal = index === chunkCount - 1;
        const sealed = sealChunk(fileKey, header, index, isFinal, plain);
        // Verify before it can replace anything: the bytes about to be written open
        // under the file key to exactly the source bytes.
        if (!openChunk(fileKey, header, index, isFinal, sealed).equals(plain)) {
          throw new AtRestIntegrityError("encrypted copy did not decrypt to the source bytes");
        }
        writeFully(tfd, sealed);
      }
      if (!options.skipDataFsyncForMeasurement) fs.fsyncSync(tfd);
      if (fs.fstatSync(tfd).size !== expectedSize) {
        throw new AtRestIntegrityError("encrypted copy is not the expected size");
      }
      fs.closeSync(tfd);
      tfd = null;
      fs.closeSync(fd);
      sourceOpen = false;
      // Nothing may have written to the source since it was read: same size (it did not
      // grow or shrink), same mtime (not rewritten in place), same inode (not replaced).
      const after = fs.statSync(filePath);
      if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || (st.ino !== 0 && after.ino !== st.ino)) {
        throw new SourceChangedError();
      }
      renameOver(tmp, filePath);
    } catch (error) {
      if (tfd !== null) {
        try {
          fs.closeSync(tfd);
        } catch {
          // already failing
        }
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        // never created, or already renamed
      }
      throw error;
    } finally {
      if (sourceOpen) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      fileKey.fill(0);
    }
  }

  function once(filePath: string, mode: SealMode): FileOutcome {
    let fd: number;
    try {
      fd = fs.openSync(filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { v: "gone" };
      throw error;
    }
    let handedOff = false;
    try {
      const st = fs.fstatSync(fd);
      const want = Math.min(HEADER_BYTES, st.size);
      const got = want > 0 ? readFully(fd, head, want, 0) : 0;
      const cls = classifyHead(head.subarray(0, got), st.size);
      if (cls !== "plaintext") return { v: cls };
      if (mode === "classify") return { v: "plaintext" };
      options.beforeSeal?.(filePath);
      handedOff = true;
      sealOpen(filePath, fd, st);
      return { v: "sealed-now" };
    } finally {
      if (!handedOff) fs.closeSync(fd);
    }
  }

  function processFile(filePath: string, mode: SealMode, touched: Set<string>): FileOutcome {
    for (let attempt = 0; ; attempt++) {
      try {
        const outcome = once(filePath, mode);
        if (outcome.v === "sealed-now") touched.add(path.dirname(filePath));
        return outcome;
      } catch (error) {
        const code = engineErrCode(error);
        const retryable = RETRYABLE_CODES.has(code) || error instanceof SourceChangedError;
        if (code === "ENOENT") return { v: "gone" };
        if (!retryable || attempt >= attempts - 1) return { v: "failed", code };
        sleepSync(retryDelayMs * 2 ** attempt);
      }
    }
  }

  return {
    runBatch(files, mode, shouldStop) {
      const outcomes: FileOutcome[] = [];
      const touched = new Set<string>();
      for (const f of files) {
        if (shouldStop?.()) return { outcomes, touchedDirs: [...touched], stopped: true };
        outcomes.push(processFile(f, mode, touched));
      }
      return { outcomes, touchedDirs: [...touched], stopped: false };
    },
    dispose() {
      dataKey.fill(0);
    },
  };
}
