/**
 * Sealed desktop log files — the KEPRLOG v1 format (BACKLOG-3819).
 *
 * electron-log appends one line at a time, so the KEPRENC container in
 * fileCrypto.ts (fixed chunks, a final-chunk flag) cannot be appended to. This is
 * an append-friendly sibling: a header, then independently sealed records.
 *
 * ## Format (integers big-endian)
 *
 *   header (48 bytes, bound into every record as AAD)
 *     0..6    "KEPRLOG"   magic — deliberately NOT "KEPRENC", so the data-key
 *                         service's ciphertext-evidence scan does not treat a
 *                         14-day diagnostic log as data it must protect
 *     7       0x01        format version
 *     8..11   zero        reserved
 *     12..27  keyId       16 bytes — which data key this file is sealed under
 *     28..43  salt        16 random bytes — HKDF salt for the per-file key
 *     44..47  zero        reserved
 *
 *   records, back to back
 *     u32 length (bytes that follow: nonce + ciphertext + tag)
 *     nonce (12 random bytes) || AES-256-GCM ciphertext || tag (16 bytes)
 *
 * Per-file key = HKDF-SHA256(dataKey, salt, "keepr-at-rest/v1/log"). Each record's
 * AAD is header || u64 record index, so:
 *
 *   - a flipped byte in a record        -> that record fails authentication
 *   - a flipped header byte             -> every record fails
 *   - two records swapped               -> both fail (index differs)
 *   - a crash in the middle of a write  -> the length runs past end of file: "torn"
 *
 * ## Limit (stated, not hidden)
 *
 * Whole records removed from the END of the file are indistinguishable from a
 * crash before they were written. An append-only format with no external state
 * cannot detect that; reorder, mid-record cuts and altered bytes are detected.
 *
 * ## Crash behaviour
 *
 * Each record is written with one append call. A crash mid-write leaves a torn
 * final record; the reader reports it and returns everything before it, and the
 * appender cuts it off before appending again, so at most that one record is lost.
 *
 * ## Nonces
 *
 * Every record gets a fresh random 96-bit nonce (`crypto.randomBytes(12)`). There
 * is no counter, so nothing has to be persisted across restarts: a process that
 * appends to an existing file reuses its salt (and so its file key) and keeps
 * drawing random nonces. The file key is per file (random 16-byte HKDF salt), and
 * a file is rotated at 8 MB (logFileConfig.ts), so one key seals at most
 * 8 MB / 32 B (smallest record: 4 length + 12 nonce + 16 tag) = 262,144 records.
 * Birthday bound for a repeated nonce under one key: n^2 / 2^97 = 4.3e-19 at that
 * worst case (~56k typical records per 8 MB file: 2e-20). A whole-file reseal
 * draws a new salt, so a new key and a fresh nonce space.
 *
 * Pure: fs + crypto only. The key is always passed in — this module never opens
 * secure storage itself.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import type { AtRestKey } from "./fileCrypto";

export const LOG_MAGIC = Buffer.from("KEPRLOG", "ascii");
export const LOG_FORMAT_VERSION = 1;
export const LOG_HEADER_BYTES = 48;
const KEY_ID_BYTES = 16;
const SALT_BYTES = 16;
const LEN_BYTES = 4;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** Readers refuse a record that claims more than this — no huge allocation from a hostile length. */
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
/** Text larger than this is split (at line ends) into several records when a whole file is sealed. */
const SEAL_CHUNK_TEXT_BYTES = 64 * 1024;
const HKDF_INFO = Buffer.from("keepr-at-rest/v1/log", "ascii");

/** True when `head` starts with the KEPRLOG magic. Plaintext logs start with "[". */
export function isSealedLog(head: Buffer): boolean {
  return head.length >= LOG_MAGIC.length && head.subarray(0, LOG_MAGIC.length).equals(LOG_MAGIC);
}

/** Reads the first bytes of `file`; false for a missing or empty file. */
export function isSealedLogFile(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(LOG_MAGIC.length);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return isSealedLog(head.subarray(0, n));
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function deriveLogFileKey(dataKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", dataKey, salt, HKDF_INFO, 32));
}

export function buildLogHeader(keyIdHex: string, salt: Buffer): Buffer {
  const keyId = Buffer.from(keyIdHex, "hex");
  if (keyId.length !== KEY_ID_BYTES) throw new Error("key id must be 16 bytes");
  if (salt.length !== SALT_BYTES) throw new Error("salt must be 16 bytes");
  const header = Buffer.alloc(LOG_HEADER_BYTES, 0);
  LOG_MAGIC.copy(header, 0);
  header[7] = LOG_FORMAT_VERSION;
  keyId.copy(header, 12);
  salt.copy(header, 28);
  return header;
}

export interface ParsedLogHeader {
  raw: Buffer;
  keyId: string;
  salt: Buffer;
}

export function parseLogHeader(buf: Buffer): ParsedLogHeader | null {
  if (buf.length < LOG_HEADER_BYTES || !isSealedLog(buf)) return null;
  if (buf[7] !== LOG_FORMAT_VERSION) return null;
  const raw = Buffer.from(buf.subarray(0, LOG_HEADER_BYTES));
  return {
    raw,
    keyId: raw.subarray(12, 28).toString("hex"),
    salt: Buffer.from(raw.subarray(28, 44)),
  };
}

function aadFor(header: Buffer, index: number): Buffer {
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64BE(BigInt(index));
  return Buffer.concat([header, idx]);
}

/** One record, ready to append: u32 length || nonce || ciphertext || tag. */
export function sealLogRecord(fileKey: Buffer, header: Buffer, index: number, plaintext: Buffer): Buffer {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", fileKey, nonce);
  cipher.setAAD(aadFor(header, index));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const len = Buffer.alloc(LEN_BYTES);
  len.writeUInt32BE(NONCE_BYTES + ct.length + TAG_BYTES);
  return Buffer.concat([len, nonce, ct, tag]);
}

/**
 * Walk the length chain without decrypting. `validEnd` is the offset just past the
 * last complete record; anything after it is a torn write.
 */
export function walkLogRecords(buf: Buffer): { count: number; validEnd: number; torn: boolean } {
  let off = LOG_HEADER_BYTES;
  let count = 0;
  while (off < buf.length) {
    if (off + LEN_BYTES > buf.length) break;
    const len = buf.readUInt32BE(off);
    if (len < NONCE_BYTES + TAG_BYTES || len > MAX_RECORD_BYTES + NONCE_BYTES + TAG_BYTES) break;
    if (off + LEN_BYTES + len > buf.length) break;
    off += LEN_BYTES + len;
    count++;
  }
  return { count, validEnd: off, torn: off < buf.length };
}

export type LogProblemKind = "torn" | "integrity" | "format" | "key";

export interface LogProblem {
  kind: LogProblemKind;
  /** Byte offset of the first affected record (or 0 for the header). */
  offset: number;
  message: string;
}

export interface SealedLogReadResult {
  /** The authenticated text, in order. Records that failed are omitted, never emitted as bytes. */
  text: string;
  keyId: string | null;
  records: number;
  /** Records that failed authentication (altered, reordered, wrong key). */
  failedRecords: number;
  problems: LogProblem[];
}

export interface SealedRecordStep {
  /** The authenticated plaintext of one record, or null when this step is a problem. */
  text: Buffer | null;
  problem?: LogProblem;
  /** True when the problem ends the walk (torn tail, impossible length). */
  fatal?: boolean;
}

/**
 * Walk and decrypt a sealed log's records one at a time, in order. A record that
 * fails authentication yields a problem and the walk continues; a torn tail or an
 * impossible length yields a fatal problem and ends it. Lets a caller do the work
 * in slices (see logScrub.trimSealedLogAsync).
 */
export function* sealedLogRecords(buf: Buffer, header: Buffer, fileKey: Buffer): Generator<SealedRecordStep> {
  let off = LOG_HEADER_BYTES;
  let index = 0;
  while (off < buf.length) {
    if (off + LEN_BYTES > buf.length) {
      yield { text: null, fatal: true, problem: { kind: "torn", offset: off, message: "incomplete final record (write interrupted)" } };
      return;
    }
    const len = buf.readUInt32BE(off);
    if (len < NONCE_BYTES + TAG_BYTES || len > MAX_RECORD_BYTES + NONCE_BYTES + TAG_BYTES) {
      yield {
        text: null,
        fatal: true,
        problem: { kind: "integrity", offset: off, message: `record length ${len} is impossible; rest of file unreadable` },
      };
      return;
    }
    if (off + LEN_BYTES + len > buf.length) {
      yield { text: null, fatal: true, problem: { kind: "torn", offset: off, message: "incomplete final record (write interrupted)" } };
      return;
    }
    const body = buf.subarray(off + LEN_BYTES, off + LEN_BYTES + len);
    const nonce = body.subarray(0, NONCE_BYTES);
    const tag = body.subarray(body.length - TAG_BYTES);
    const ct = body.subarray(NONCE_BYTES, body.length - TAG_BYTES);
    let text: Buffer | null = null;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", fileKey, nonce);
      decipher.setAAD(aadFor(header, index));
      decipher.setAuthTag(tag);
      text = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      text = null;
    }
    if (text) yield { text };
    else
      yield {
        text: null,
        problem: { kind: "integrity", offset: off, message: `record ${index} failed authentication (altered, reordered or wrong key)` },
      };
    off += LEN_BYTES + len;
    index++;
  }
}

/**
 * Decrypt a sealed log. Every record is authenticated before its text is used;
 * a record that fails is reported and skipped (the length chain is still
 * walked), so a reader gets "corruption at offset N", never garbage.
 */
export function openSealedLog(buf: Buffer, keyFor: (keyId: string) => Buffer | null): SealedLogReadResult {
  const header = parseLogHeader(buf);
  if (!header) {
    return {
      text: "",
      keyId: null,
      records: 0,
      failedRecords: 0,
      problems: [{ kind: "format", offset: 0, message: "not a KEPRLOG v1 file" }],
    };
  }
  const dataKey = keyFor(header.keyId);
  if (!dataKey) {
    return {
      text: "",
      keyId: header.keyId,
      records: 0,
      failedRecords: 0,
      problems: [
        {
          kind: "key",
          offset: 0,
          message: `sealed under data key ${header.keyId}, which this computer does not hold`,
        },
      ],
    };
  }
  const fileKey = deriveLogFileKey(dataKey, header.salt);
  const parts: Buffer[] = [];
  const problems: LogProblem[] = [];
  let records = 0;
  let failed = 0;
  for (const step of sealedLogRecords(buf, header.raw, fileKey)) {
    if (step.text) {
      parts.push(step.text);
      records++;
    } else if (step.problem) {
      if (step.problem.kind === "integrity" && !step.fatal) failed++;
      problems.push(step.problem);
    }
  }
  return { text: Buffer.concat(parts).toString("utf8"), keyId: header.keyId, records, failedRecords: failed, problems };
}

/**
 * The text of the FIRST record only, reading the header and that one record —
 * not the file. Used at launch to find a sealed log's oldest timestamp without
 * decrypting the whole file. Null when the file is missing, empty of records,
 * under a key not held, or the record does not authenticate.
 */
export function readFirstSealedRecord(file: string, keyFor: (keyId: string) => Buffer | null): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(LOG_HEADER_BYTES + LEN_BYTES);
    if (fs.readSync(fd, head, 0, head.length, 0) < head.length) return null;
    const len = head.readUInt32BE(LOG_HEADER_BYTES);
    if (len < NONCE_BYTES + TAG_BYTES || len > MAX_RECORD_BYTES + NONCE_BYTES + TAG_BYTES) return null;
    const rec = Buffer.alloc(len);
    if (fs.readSync(fd, rec, 0, len, head.length) < len) return null;
    const read = openSealedLog(Buffer.concat([head, rec]), keyFor);
    return read.problems.length === 0 && read.records === 1 ? read.text : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Split text into record-sized pieces, cutting after a newline where possible. */
function splitForRecords(text: string): Buffer[] {
  const all = Buffer.from(text, "utf8");
  const out: Buffer[] = [];
  let start = 0;
  while (start < all.length) {
    let end = Math.min(start + SEAL_CHUNK_TEXT_BYTES, all.length);
    if (end < all.length) {
      const nl = all.lastIndexOf(0x0a, end - 1);
      if (nl >= start) end = nl + 1;
    }
    out.push(all.subarray(start, end));
    start = end;
  }
  return out;
}

/** A whole sealed file (header + records) holding `text`. Empty text = header only. */
export function sealLogText(text: string, key: AtRestKey): Buffer {
  const salt = crypto.randomBytes(SALT_BYTES);
  const header = buildLogHeader(key.keyId, salt);
  const fileKey = deriveLogFileKey(key.key, salt);
  const records = splitForRecords(text).map((pt, i) => sealLogRecord(fileKey, header, i, pt));
  return Buffer.concat([header, ...records]);
}

/**
 * Replace `file` with a sealed file holding `text`: temp file in the same
 * directory, then rename. Mode 0600. A crash leaves the original in place.
 */
export function replaceWithSealedLogSync(file: string, text: string, key: AtRestKey): void {
  const tmp = `${file}.seal-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, sealLogText(text, key), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created */
    }
    throw err;
  }
}

/**
 * Replace `file` with a sealed file whose records are `pieces` (each piece one or
 * more records), under a fresh salt — like {@link replaceWithSealedLogSync}, but
 * the sealing is done in slices: whenever `shouldYield()` is true the batch so far
 * is written to the temp file and `yieldFn()` is awaited. The rename is one
 * synchronous step at the end; a failure leaves the original in place. When
 * `shouldAbort()` turns true (checked after each yield and before the rename) the
 * temp file is deleted, the original is left as it is, and "aborted" is returned.
 */
export async function replaceWithSealedRecordsAsync(
  file: string,
  pieces: Buffer[],
  key: AtRestKey,
  slice: { shouldYield: () => boolean; yieldFn: () => Promise<void>; shouldAbort?: () => boolean },
): Promise<"replaced" | "aborted"> {
  const tmp = `${file}.seal-${process.pid}-${Date.now()}.tmp`;
  try {
    const salt = crypto.randomBytes(SALT_BYTES);
    const header = buildLogHeader(key.keyId, salt);
    const fileKey = deriveLogFileKey(key.key, salt);
    fs.writeFileSync(tmp, header, { mode: 0o600 });
    let index = 0;
    let batch: Buffer[] = [];
    for (const pt of pieces) {
      for (let start = 0; start < pt.length; start += MAX_RECORD_BYTES) {
        batch.push(sealLogRecord(fileKey, header, index++, pt.subarray(start, Math.min(start + MAX_RECORD_BYTES, pt.length))));
      }
      if (slice.shouldYield()) {
        fs.appendFileSync(tmp, Buffer.concat(batch));
        batch = [];
        await slice.yieldFn();
        if (slice.shouldAbort?.()) {
          fs.unlinkSync(tmp);
          return "aborted";
        }
      }
    }
    if (batch.length) fs.appendFileSync(tmp, Buffer.concat(batch));
    if (slice.shouldAbort?.()) {
      fs.unlinkSync(tmp);
      return "aborted";
    }
    fs.renameSync(tmp, file);
    return "replaced";
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created */
    }
    throw err;
  }
}

/** Leftover temp files from an interrupted {@link replaceWithSealedLogSync}. */
export const SEAL_TMP_RE = /\.seal-\d+-\d+\.tmp$/;

interface OpenFile {
  header: Buffer;
  fileKey: Buffer;
  nextIndex: number;
  size: number;
}

export interface SealedLogAppenderOptions {
  key: AtRestKey;
  /**
   * A plaintext file found where a sealed one is expected (written before this
   * build, or by a fallback). Returns the text to carry into the sealed file —
   * normally the redacted content. Default: carry it over unchanged.
   */
  migratePlaintext?: (text: string) => string;
  /** Notices about repairs (torn tail cut, foreign key set aside). Never content. */
  notice?: (message: string) => void;
}

/**
 * Appends sealed records to log files. One append call per record; no
 * descriptor is held between writes (like electron-log's own file transport).
 *
 * On first touch of a path it validates the file: an empty file gets a header; a
 * torn tail is cut; a file sealed under a different key is set aside as
 * `<name>.old<ext>`; a plaintext file is never appended to — it is sealed first.
 */
export class SealedLogAppender {
  private readonly files = new Map<string, OpenFile>();

  constructor(private readonly opts: SealedLogAppenderOptions) {}

  get keyId(): string {
    return this.opts.key.keyId;
  }

  /** Current size of `file` on disk as this appender knows it (opens it if needed). */
  size(file: string): number {
    return this.open(file).size;
  }

  /** Drop cached state after the file was renamed or replaced from outside. */
  forget(file: string): void {
    this.files.delete(path.resolve(file));
  }

  append(file: string, text: string): void {
    const st = this.open(file);
    const pt = Buffer.from(text, "utf8");
    // Text larger than one record is split; each piece is its own record.
    const pieces: Buffer[] = [];
    for (let start = 0; start < pt.length; start += MAX_RECORD_BYTES) {
      pieces.push(pt.subarray(start, Math.min(start + MAX_RECORD_BYTES, pt.length)));
    }
    const abs = path.resolve(file);
    for (const piece of pieces) {
      const rec = sealLogRecord(st.fileKey, st.header, st.nextIndex, piece);
      try {
        fs.appendFileSync(abs, rec, { mode: 0o600 });
      } catch (err) {
        // A failed append (disk full, I/O error) may have written part of the
        // record. Cut the file back to the last complete record so later records
        // are not stranded behind a broken length, and drop the cached state so
        // the next append re-validates the file from disk. Best effort: if the
        // cut fails too, the next append's validation cuts the torn tail.
        try {
          fs.truncateSync(abs, st.size);
        } catch {
          /* re-validated on next append */
        }
        this.files.delete(abs);
        throw err;
      }
      st.nextIndex++;
      st.size += rec.length;
    }
  }

  private fresh(abs: string): OpenFile {
    const salt = crypto.randomBytes(SALT_BYTES);
    const header = buildLogHeader(this.opts.key.keyId, salt);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, header, { mode: 0o600 });
    return { header, fileKey: deriveLogFileKey(this.opts.key.key, salt), nextIndex: 0, size: header.length };
  }

  private open(file: string): OpenFile {
    const abs = path.resolve(file);
    const cached = this.files.get(abs);
    if (cached) return cached;
    const st = this.validate(abs);
    this.files.set(abs, st);
    return st;
  }

  private validate(abs: string): OpenFile {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return this.fresh(abs);
      throw err;
    }
    if (buf.length === 0) return this.fresh(abs);

    if (!isSealedLog(buf)) {
      // Never append sealed bytes behind plaintext: seal what is there first.
      const carried = (this.opts.migratePlaintext ?? ((t: string) => t))(buf.toString("utf8"));
      replaceWithSealedLogSync(abs, carried, this.opts.key);
      this.opts.notice?.(`[SealedLog] sealed an existing plaintext log (${path.basename(abs)})`);
      return this.validate(abs);
    }

    const header = parseLogHeader(buf);
    if (!header || header.keyId !== this.opts.key.keyId) {
      const parsed = path.parse(abs);
      const aside = path.join(parsed.dir, `${parsed.name}.old${parsed.ext}`);
      fs.renameSync(abs, aside);
      this.opts.notice?.(
        `[SealedLog] ${parsed.base} was ${header ? "sealed under another data key" : "not a readable sealed log"}; moved to ${path.basename(aside)}`,
      );
      return this.fresh(abs);
    }

    const walk = walkLogRecords(buf);
    if (walk.torn) {
      fs.truncateSync(abs, walk.validEnd);
      this.opts.notice?.(
        `[SealedLog] cut an incomplete final record from ${path.basename(abs)} (${buf.length - walk.validEnd} bytes)`,
      );
    }
    return {
      header: header.raw,
      fileKey: deriveLogFileKey(this.opts.key.key, header.salt),
      nextIndex: walk.count,
      size: walk.validEnd,
    };
  }
}
