/**
 * At-rest file encryption — the KEPRENC v1 container (BACKLOG-3816 S0).
 *
 * Every file Keepr writes that carries customer content goes through this module.
 * Nothing here knows WHICH files those are; the writers (S1), readers (S2) and the
 * migration (S3) decide that. This module only guarantees that a file it wrote can
 * be read back exactly, and that a file which has been altered is refused.
 *
 * ## Format (all integers big-endian)
 *
 *   header (60 bytes, bound into every chunk tag as AAD)
 *     0..6    "KEPRENC"         magic
 *     7       0x01              format version
 *     8       0x01              algorithm: HKDF-SHA256 per-file key + AES-256-GCM
 *     9..11   0x00 0x00 0x00    reserved, must be zero
 *     12..27  keyId             16 bytes — which data key wrapped this file
 *     28..43  salt              16 random bytes — HKDF salt for the per-file key
 *     44..47  chunkSize         u32, plaintext bytes per chunk (1 MiB by default)
 *     48..59  reserved          must be zero
 *
 *   chunks, back to back
 *     ciphertext (chunkSize bytes, or fewer for the final chunk) || tag (16 bytes)
 *
 * The per-file key is HKDF-SHA256(dataKey, salt, "keepr-at-rest/v1/file"). Because
 * every file has its own random salt, and so its own key, the nonce can simply be
 * the chunk index. Each chunk's AAD is header || u64 index || u8 isFinal, so:
 *
 *   - a flipped byte anywhere in a chunk          -> that chunk's tag fails
 *   - a flipped header byte                       -> every tag fails
 *   - two chunks swapped                          -> the index in the AAD differs
 *   - the file cut at a chunk boundary            -> the new last chunk was sealed
 *                                                    with isFinal = 0, its tag fails
 *   - the file cut inside a chunk                 -> that chunk's tag fails
 *
 * There is no length field. Every chunk but the last is exactly `chunkSize`, so the
 * plaintext size is a pure function of the ciphertext size (see {@link layoutFor}).
 * An empty plaintext is one chunk of zero bytes plus its tag, so even an empty file
 * carries a final-chunk tag and cannot be confused with a truncated one.
 *
 * ## Verify before emit — and its limit
 *
 * A chunk's plaintext is released only after its tag has verified. That is a
 * per-CHUNK guarantee. A streaming read of a multi-chunk file that is damaged at
 * chunk k has already emitted chunks 0..k-1 by the time chunk k fails. Consumers
 * that need all-or-nothing use {@link FileCrypto.readAllDecrypted} or
 * {@link FileCrypto.decryptToFile}, which release nothing until the last tag has
 * verified. A Range read that ends before the final chunk does not read the final
 * chunk, so it cannot see a truncation — only damage inside the range it read.
 *
 * ## Residual
 *
 * `isEncrypted` is a magic check. A plaintext file whose first seven bytes happen to
 * be "KEPRENC" reads as encrypted and is then refused at header validation; it is
 * never served as if it were plaintext.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

export const MAGIC = Buffer.from("KEPRENC", "ascii");
export const FORMAT_VERSION = 1;
export const ALGORITHM_ID = 1;
export const HEADER_BYTES = 60;
export const TAG_BYTES = 16;
export const SALT_BYTES = 16;
export const KEY_ID_BYTES = 16;
export const DATA_KEY_BYTES = 32;
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
/** Readers refuse a header that claims more than this — no 4 GiB allocations from a hostile file. */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** Suffix of every temp file this module creates. The temp sweep (S6) removes stale ones. */
export const KENC_TMP_SUFFIX = ".kenc-tmp"; // single source; S6 tempSweep re-exports it

const HKDF_INFO = Buffer.from("keepr-at-rest/v1/file", "ascii");

/** The current data key, as the key service hands it out. `keyId` is 32 hex chars. */
export interface AtRestKey {
  keyId: string;
  key: Buffer;
}

export interface KeyResolver {
  /** The key new files are sealed with. */
  currentKey(): Promise<AtRestKey>;
  /** The key a file names in its header. Throws when it is not held. */
  keyFor(keyId: string): Promise<Buffer>;
}

/** The file is not a KEPRENC v1 container, or its byte layout is impossible. */
export class AtRestFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtRestFormatError";
  }
}

/** A chunk failed authentication: the file was altered, truncated, reordered, or the key is wrong. */
export class AtRestIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtRestIntegrityError";
  }
}

interface ParsedHeader {
  raw: Buffer;
  keyId: string;
  salt: Buffer;
  chunkSize: number;
}

interface Layout {
  chunkCount: number;
  plaintextSize: number;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function buildHeader(keyIdHex: string, salt: Buffer, chunkSize: number): Buffer {
  const keyId = Buffer.from(keyIdHex, "hex");
  if (keyId.length !== KEY_ID_BYTES) {
    throw new AtRestFormatError("key id must be 16 bytes");
  }
  const header = Buffer.alloc(HEADER_BYTES, 0);
  MAGIC.copy(header, 0);
  header[7] = FORMAT_VERSION;
  header[8] = ALGORITHM_ID;
  keyId.copy(header, 12);
  salt.copy(header, 28);
  header.writeUInt32BE(chunkSize, 44);
  return header;
}

function parseHeader(raw: Buffer): ParsedHeader {
  if (raw.length < HEADER_BYTES || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new AtRestFormatError("not a KEPRENC file");
  }
  if (raw[7] !== FORMAT_VERSION) {
    throw new AtRestFormatError(`unsupported KEPRENC version ${raw[7]}`);
  }
  if (raw[8] !== ALGORITHM_ID) {
    throw new AtRestFormatError(`unsupported KEPRENC algorithm ${raw[8]}`);
  }
  for (const i of [9, 10, 11]) {
    if (raw[i] !== 0) throw new AtRestFormatError("reserved header bytes are not zero");
  }
  for (let i = 48; i < HEADER_BYTES; i++) {
    if (raw[i] !== 0) throw new AtRestFormatError("reserved header bytes are not zero");
  }
  const chunkSize = raw.readUInt32BE(44);
  if (chunkSize < 1 || chunkSize > MAX_CHUNK_BYTES) {
    throw new AtRestFormatError(`chunk size ${chunkSize} is out of range`);
  }
  return {
    raw: Buffer.from(raw.subarray(0, HEADER_BYTES)),
    keyId: raw.subarray(12, 28).toString("hex"),
    salt: Buffer.from(raw.subarray(28, 44)),
    chunkSize,
  };
}

/**
 * Plaintext size and chunk count from the file size alone.
 *
 * Every chunk but the last holds exactly `chunkSize` plaintext bytes, and the last
 * holds 0..chunkSize. So body = (n-1)·(chunkSize+16) + (lastLen+16) with lastLen ≥ 0,
 * which has exactly one solution for n — or none, which means the file is malformed.
 */
export function layoutFor(fileSize: number, chunkSize: number): Layout {
  const body = fileSize - HEADER_BYTES;
  if (body < TAG_BYTES) {
    throw new AtRestFormatError("file is shorter than one chunk tag");
  }
  const stride = chunkSize + TAG_BYTES;
  const chunkCount = Math.ceil(body / stride);
  const lastBytes = body - (chunkCount - 1) * stride;
  if (lastBytes < TAG_BYTES) {
    throw new AtRestFormatError("final chunk is shorter than its tag");
  }
  return { chunkCount, plaintextSize: body - chunkCount * TAG_BYTES };
}

function deriveFileKey(dataKey: Buffer, salt: Buffer): Buffer {
  if (dataKey.length !== DATA_KEY_BYTES) {
    throw new AtRestFormatError("data key must be 32 bytes");
  }
  return Buffer.from(crypto.hkdfSync("sha256", dataKey, salt, HKDF_INFO, 32));
}

function nonceFor(index: number): Buffer {
  const nonce = Buffer.alloc(12, 0);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
}

function aadFor(header: Buffer, index: number, isFinal: boolean): Buffer {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(index), 0);
  tail[8] = isFinal ? 1 : 0;
  return Buffer.concat([header, tail]);
}

function sealChunk(
  fileKey: Buffer,
  header: Buffer,
  index: number,
  isFinal: boolean,
  plaintext: Buffer,
): Buffer {
  const cipher = crypto.createCipheriv("aes-256-gcm", fileKey, nonceFor(index));
  cipher.setAAD(aadFor(header, index, isFinal));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/** Returns the chunk's plaintext ONLY after its tag verified. */
function openChunk(
  fileKey: Buffer,
  header: Buffer,
  index: number,
  isFinal: boolean,
  sealed: Buffer,
): Buffer {
  if (sealed.length < TAG_BYTES) {
    throw new AtRestIntegrityError(`chunk ${index} is shorter than its tag`);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", fileKey, nonceFor(index));
  decipher.setAAD(aadFor(header, index, isFinal));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  const out = decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES));
  try {
    decipher.final();
  } catch {
    throw new AtRestIntegrityError(`chunk ${index} failed authentication`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Durable file primitives
// ---------------------------------------------------------------------------

const RETRYABLE_RENAME_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * rename(2) with retries for the transient locks antivirus and indexers take on
 * Windows (EBUSY / EPERM / EACCES). Anything else fails at once.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  attempts = 6,
  baseDelayMs = 50,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= attempts - 1) throw error;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

/**
 * Best-effort fsync of a directory so a completed rename or link survives power loss.
 *
 * No-op on Windows: Node cannot open a directory handle there (`open(dir)` fails with
 * EISDIR/EPERM), so there is no directory fsync to call. NTFS journals its metadata,
 * so a completed rename/link is not left half-applied by a crash, but the journal is
 * flushed lazily — a power cut shortly after can still roll the directory entry back.
 * Callers that cannot tolerate a lost entry must detect that case on the next launch
 * (dataKeyService does: a missing key store next to existing ciphertext is refused).
 */
export async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(dir, "r");
    await handle.sync();
  } catch {
    // Some filesystems refuse a directory fsync; the rename itself still happened.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function tmpPathFor(target: string): string {
  return `${target}.${crypto.randomBytes(6).toString("hex")}${KENC_TMP_SUFFIX}`;
}

/**
 * Write `data` to `target` atomically: temp file (mode 0600) → fsync → rename.
 * Used for small metadata files (key store, markers). The temp is removed on failure.
 */
export async function writeFileAtomic(target: string, data: Buffer | string): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = tmpPathFor(target);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tmp, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(tmp, target);
    await fsyncDir(path.dirname(target));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

async function readExactly(
  handle: fs.promises.FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buf, offset, length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== length) {
    throw new AtRestIntegrityError("file ended early");
  }
  return buf;
}

async function readMagic(filePath: string): Promise<{ encrypted: boolean; size: number }> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size < MAGIC.length) return { encrypted: false, size };
    const head = Buffer.alloc(MAGIC.length);
    await handle.read(head, 0, MAGIC.length, 0);
    return { encrypted: head.equals(MAGIC), size };
  } finally {
    await handle.close();
  }
}

export interface DecryptStreamOptions {
  /** First plaintext byte, inclusive. Default 0. */
  start?: number;
  /** Last plaintext byte, INCLUSIVE (same convention as fs.createReadStream). Default size-1. */
  end?: number;
  /**
   * true = a file that is not a KEPRENC container is refused (AtRestFormatError)
   * instead of being passed through as plaintext. For readers of scopes that have
   * finished migrating. Default false (pre-migration plaintext passes through).
   */
  requireEncrypted?: boolean;
}

export interface DecryptStreamResult {
  stream: Readable;
  /** false = the file is still plaintext (pre-migration) and is passed through unchanged. */
  encrypted: boolean;
  /** Total plaintext size of the whole file. */
  size: number;
  /** The inclusive plaintext byte range the stream covers. end < start means empty. */
  start: number;
  end: number;
}

export interface EncryptResult {
  plaintextSize: number;
  /** SHA-256 (hex) of the PLAINTEXT — what dedupe and integrity checks must hash. */
  sha256: string;
}

export interface FileCryptoOptions {
  /** Plaintext bytes per chunk for files this instance WRITES. Readers use the header's value. */
  chunkSize?: number;
}

export interface FileCrypto {
  isEncrypted(filePath: string): Promise<boolean>;
  statPlaintext(filePath: string): Promise<{ encrypted: boolean; size: number }>;
  /** Encrypt a plaintext stream into a new file at `destPath` (tmp → fsync → verify → rename). */
  encryptStreamToFile(
    source: AsyncIterable<Buffer | string | Uint8Array>,
    destPath: string,
    opts?: { verify?: boolean },
  ): Promise<EncryptResult>;
  /**
   * Replace a plaintext file with its encrypted form. The encrypted temp is decrypted
   * and its SHA-256 compared with the source BEFORE the rename; on any mismatch the
   * source is left untouched. A file that is already encrypted is left alone.
   */
  encryptFileInPlace(filePath: string): Promise<EncryptResult & { alreadyEncrypted: boolean }>;
  openDecryptStream(filePath: string, opts?: DecryptStreamOptions): Promise<DecryptStreamResult>;
  /** All-or-nothing: returns nothing unless every chunk verified. */
  readAllDecrypted(filePath: string): Promise<Buffer>;
  /** All-or-nothing: `destPath` appears only after every chunk verified. Plaintext sources are copied. */
  decryptToFile(srcPath: string, destPath: string): Promise<{ size: number; encrypted: boolean }>;
}

export function createFileCrypto(keys: KeyResolver, options: FileCryptoOptions = {}): FileCrypto {
  const writeChunkSize = options.chunkSize ?? DEFAULT_CHUNK_BYTES;
  if (writeChunkSize < 1 || writeChunkSize > MAX_CHUNK_BYTES) {
    throw new AtRestFormatError(`chunk size ${writeChunkSize} is out of range`);
  }

  async function openEncrypted(filePath: string): Promise<{
    handle: fs.promises.FileHandle;
    header: ParsedHeader;
    layout: Layout;
    fileKey: Buffer;
  }> {
    const handle = await fs.promises.open(filePath, "r");
    try {
      const { size } = await handle.stat();
      if (size < HEADER_BYTES) throw new AtRestFormatError("file is shorter than a KEPRENC header");
      const header = parseHeader(await readExactly(handle, HEADER_BYTES, 0));
      const layout = layoutFor(size, header.chunkSize);
      const dataKey = await keys.keyFor(header.keyId);
      return { handle, header, layout, fileKey: deriveFileKey(dataKey, header.salt) };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /** Yields verified plaintext for chunks first..last. Closes the handle when done or abandoned. */
  async function* chunkPlaintexts(
    opened: Awaited<ReturnType<typeof openEncrypted>>,
    first: number,
    last: number,
  ): AsyncGenerator<{ index: number; plaintext: Buffer }> {
    const { handle, header, layout, fileKey } = opened;
    const stride = header.chunkSize + TAG_BYTES;
    try {
      for (let index = first; index <= last; index++) {
        const isFinal = index === layout.chunkCount - 1;
        const position = HEADER_BYTES + index * stride;
        const length = isFinal
          ? layout.plaintextSize - index * header.chunkSize + TAG_BYTES
          : stride;
        const sealed = await readExactly(handle, length, position);
        yield { index, plaintext: openChunk(fileKey, header.raw, index, isFinal, sealed) };
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Encrypts into `tmp` (created exclusively). Does not rename. */
  async function writeEncrypted(
    source: AsyncIterable<Buffer | string | Uint8Array>,
    tmp: string,
  ): Promise<EncryptResult> {
    const { keyId, key } = await keys.currentKey();
    const salt = crypto.randomBytes(SALT_BYTES);
    const header = buildHeader(keyId, salt, writeChunkSize);
    const fileKey = deriveFileKey(key, salt);
    const hash = crypto.createHash("sha256");
    let plaintextSize = 0;
    let index = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;

    await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
    const handle = await fs.promises.open(tmp, "wx", 0o600);
    try {
      await handle.write(header);
      for await (const piece of source) {
        const buf = typeof piece === "string" ? Buffer.from(piece) : Buffer.from(piece);
        hash.update(buf);
        plaintextSize += buf.length;
        pending.push(buf);
        pendingBytes += buf.length;
        // Strictly greater: a buffer of exactly chunkSize may still be the final chunk.
        while (pendingBytes > writeChunkSize) {
          const all = Buffer.concat(pending);
          await handle.write(
            sealChunk(fileKey, header, index++, false, all.subarray(0, writeChunkSize)),
          );
          const rest = all.subarray(writeChunkSize);
          pending = [rest];
          pendingBytes = rest.length;
        }
      }
      await handle.write(sealChunk(fileKey, header, index, true, Buffer.concat(pending)));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { plaintextSize, sha256: hash.digest("hex") };
  }

  /** Decrypts the whole file, hashing as it goes. Throws on any chunk failure. */
  async function hashDecrypted(filePath: string): Promise<{ size: number; sha256: string }> {
    const opened = await openEncrypted(filePath);
    const hash = crypto.createHash("sha256");
    let size = 0;
    for await (const { plaintext } of chunkPlaintexts(opened, 0, opened.layout.chunkCount - 1)) {
      hash.update(plaintext);
      size += plaintext.length;
    }
    return { size, sha256: hash.digest("hex") };
  }

  async function verifyTmp(tmp: string, expected: EncryptResult): Promise<void> {
    const actual = await hashDecrypted(tmp);
    if (actual.size !== expected.plaintextSize || actual.sha256 !== expected.sha256) {
      throw new AtRestIntegrityError("encrypted copy did not decrypt to the source bytes");
    }
  }

  const api: FileCrypto = {
    async isEncrypted(filePath) {
      return (await readMagic(filePath)).encrypted;
    },

    async statPlaintext(filePath) {
      const { encrypted, size } = await readMagic(filePath);
      if (!encrypted) return { encrypted: false, size };
      const handle = await fs.promises.open(filePath, "r");
      try {
        const header = parseHeader(await readExactly(handle, HEADER_BYTES, 0));
        return { encrypted: true, size: layoutFor(size, header.chunkSize).plaintextSize };
      } finally {
        await handle.close();
      }
    },

    async encryptStreamToFile(source, destPath, opts = {}) {
      const tmp = tmpPathFor(destPath);
      try {
        const result = await writeEncrypted(source, tmp);
        if (opts.verify !== false) await verifyTmp(tmp, result);
        await renameWithRetry(tmp, destPath);
        await fsyncDir(path.dirname(destPath));
        return result;
      } catch (error) {
        await fs.promises.unlink(tmp).catch(() => undefined);
        throw error;
      }
    },

    async encryptFileInPlace(filePath) {
      const before = await readMagic(filePath);
      if (before.encrypted) {
        const { size } = await api.statPlaintext(filePath);
        return { alreadyEncrypted: true, plaintextSize: size, sha256: "" };
      }
      const statBefore = await fs.promises.stat(filePath);
      const tmp = tmpPathFor(filePath);
      try {
        const result = await writeEncrypted(fs.createReadStream(filePath), tmp);
        await verifyTmp(tmp, result);
        const statAfter = await fs.promises.stat(filePath);
        if (
          statAfter.size !== statBefore.size ||
          statAfter.mtimeMs !== statBefore.mtimeMs ||
          result.plaintextSize !== statBefore.size
        ) {
          throw new AtRestIntegrityError("source file changed while it was being encrypted");
        }
        await renameWithRetry(tmp, filePath);
        await fsyncDir(path.dirname(filePath));
        return { ...result, alreadyEncrypted: false };
      } catch (error) {
        await fs.promises.unlink(tmp).catch(() => undefined);
        throw error;
      }
    },

    async openDecryptStream(filePath, opts = {}) {
      const magic = await readMagic(filePath);
      if (!magic.encrypted) {
        if (opts.requireEncrypted) {
          throw new AtRestFormatError("file is not encrypted and the caller requires an encrypted file");
        }
        const { start, end } = resolveRange(opts, magic.size);
        const stream =
          end < start
            ? Readable.from([])
            : fs.createReadStream(filePath, { start, end });
        return { stream, encrypted: false, size: magic.size, start, end };
      }
      const opened = await openEncrypted(filePath);
      const size = opened.layout.plaintextSize;
      let range: { start: number; end: number };
      try {
        range = resolveRange(opts, size);
      } catch (error) {
        await opened.handle.close().catch(() => undefined);
        throw error;
      }
      const { start, end } = range;
      const chunkSize = opened.header.chunkSize;
      // An empty file still has one (final, empty) chunk; reading it verifies its tag.
      const first = size === 0 ? 0 : Math.floor(start / chunkSize);
      const last = size === 0 ? 0 : Math.floor(end / chunkSize);
      async function* sliced(): AsyncGenerator<Buffer> {
        for await (const { index, plaintext } of chunkPlaintexts(opened, first, last)) {
          const chunkStart = index * chunkSize;
          const from = Math.max(0, start - chunkStart);
          const to = Math.min(plaintext.length, end - chunkStart + 1);
          if (to > from) yield plaintext.subarray(from, to);
        }
      }
      return { stream: Readable.from(sliced()), encrypted: true, size, start, end };
    },

    async readAllDecrypted(filePath) {
      const magic = await readMagic(filePath);
      if (!magic.encrypted) return fs.promises.readFile(filePath);
      const opened = await openEncrypted(filePath);
      const parts: Buffer[] = [];
      for await (const { plaintext } of chunkPlaintexts(opened, 0, opened.layout.chunkCount - 1)) {
        parts.push(plaintext);
      }
      return Buffer.concat(parts);
    },

    async decryptToFile(srcPath, destPath) {
      const { stream, encrypted, size } = await api.openDecryptStream(srcPath);
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      const tmp = tmpPathFor(destPath);
      let handle: fs.promises.FileHandle | null = null;
      try {
        handle = await fs.promises.open(tmp, "wx", 0o600);
        for await (const piece of stream) {
          await handle.write(piece as Buffer);
        }
        await handle.sync();
        await handle.close();
        handle = null;
        await renameWithRetry(tmp, destPath);
        return { size, encrypted };
      } catch (error) {
        stream.destroy();
        await handle?.close().catch(() => undefined);
        await fs.promises.unlink(tmp).catch(() => undefined);
        throw error;
      }
    },
  };
  return api;
}

function resolveRange(opts: DecryptStreamOptions, size: number): { start: number; end: number } {
  const start = opts.start ?? 0;
  const end = Math.min(opts.end ?? size - 1, size - 1);
  if (!Number.isInteger(start) || start < 0 || (opts.end !== undefined && !Number.isInteger(opts.end))) {
    throw new RangeError("invalid byte range");
  }
  if (size === 0) {
    if (start > 0) throw new RangeError("range starts beyond the end of the file");
    return { start: 0, end: -1 };
  }
  if (start > end) {
    throw new RangeError("range starts beyond the end of the file");
  }
  return { start, end };
}
