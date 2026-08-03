/**
 * Encryption at rest for support-access data (BACKLOG-2393)
 *
 * The founder's requirement was "data at rest and in transit secure". In transit
 * is TLS. At rest was gzip — which is compression, not encryption: `gunzipSync`
 * with no key at all recovered a client's name and phone number straight off
 * disk. That is below the bar this app already sets for itself, since the SQLite
 * database is SQLCipher-encrypted.
 *
 * PII scrubbing is deliberately deferred (BACKLOG-2397), so these files contain
 * real client names and phone numbers. That makes this the only thing standing
 * between a stolen laptop and that data.
 *
 * ## Envelope, not direct keychain calls
 *
 * `safeStorage` encrypts strings. The report payload is gzipped binary and the
 * log is written a frame at a time, so calling it directly would mean base64ing
 * every write and a keychain round-trip per log line.
 *
 * Instead: one 32-byte data key, generated once, sealed by the OS keychain and
 * parked next to the data. Everything else is AES-256-GCM under that key. One
 * keychain operation per launch, binary handled natively, and authentication
 * (GCM) rather than just confidentiality — a tampered log frame is rejected
 * rather than silently decrypted into something else.
 *
 * ## Fails closed
 *
 * If the key cannot be produced — keychain gate still locked, `safeStorage`
 * unavailable, keyfile unreadable — every operation *rejects*. It never falls
 * back to plaintext. A quiet plaintext fallback is precisely the broken promise
 * this file exists to remove; the caller surfaces the failure instead.
 */

import { promises as fs } from "fs";
import * as path from "path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "crypto";

/** Format byte, so a future algorithm change is detectable rather than garbage. */
const FORMAT_V1 = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

const KEY_FILENAME = "cipher-key.bin";

export interface SupportCipher {
  /** Seal plaintext. Rejects when this machine cannot protect data at rest. */
  seal(plaintext: Buffer | string): Promise<Buffer>;
  /** Open a sealed buffer. Rejects on a wrong key, a truncated file, or tampering. */
  open(sealed: Buffer): Promise<Buffer>;
}

/** Resolves the 32-byte data key. Rejects rather than returning a weak default. */
export type SupportKeyProvider = () => Promise<Buffer>;

export class SupportCipherUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportCipherUnavailableError";
  }
}

/**
 * AES-256-GCM over an injected key.
 *
 * Layout: `[1 byte format][12 byte iv][16 byte tag][ciphertext]`. The tag is
 * stored ahead of the ciphertext so a frame can be validated without seeking to
 * the end of a variable-length body.
 */
export function createAesGcmCipher(getKey: SupportKeyProvider): SupportCipher {
  return {
    async seal(plaintext: Buffer | string): Promise<Buffer> {
      const key = await getKey();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([
        cipher.update(
          typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext,
        ),
        cipher.final(),
      ]);
      return Buffer.concat([
        Buffer.from([FORMAT_V1]),
        iv,
        cipher.getAuthTag(),
        body,
      ]);
    },

    async open(sealed: Buffer): Promise<Buffer> {
      if (sealed.length < HEADER_BYTES) {
        throw new Error("Sealed payload is truncated");
      }
      if (sealed[0] !== FORMAT_V1) {
        throw new Error(`Unsupported sealed payload format: ${sealed[0]}`);
      }
      const key = await getKey();
      const iv = sealed.subarray(1, 1 + IV_BYTES);
      const tag = sealed.subarray(1 + IV_BYTES, HEADER_BYTES);
      const body = sealed.subarray(HEADER_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      // `final()` throws when the tag does not verify. That is the point: a
      // modified log frame must not open into plausible-looking JSON.
      return Buffer.concat([decipher.update(body), decipher.final()]);
    },
  };
}

export interface KeychainKeyProviderDeps {
  /** Directory the sealed key lives in. Created on demand. */
  baseDir: string;
  /** True when the OS can protect a secret right now. */
  isEncryptionAvailable: () => boolean;
  /** Seal a string with the OS keychain (macOS Keychain / Windows DPAPI). */
  sealString: (plaintext: string) => Buffer;
  /** Open a string sealed by `sealString`. */
  openString: (sealed: Buffer) => string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * Generate-once, keychain-sealed data key.
 *
 * Cached in memory after the first successful read, so the keychain is touched
 * once per launch rather than once per log line.
 *
 * A key that exists but cannot be opened is **not** replaced. Regenerating would
 * quietly orphan every report already on disk — the user would see rows they can
 * no longer send, with no explanation. Failing loudly leaves the data recoverable
 * if whatever broke the keychain is fixed.
 */
export function createKeychainKeyProvider(
  deps: KeychainKeyProviderDeps,
): SupportKeyProvider {
  let cached: Buffer | null = null;
  let inFlight: Promise<Buffer> | null = null;
  const keyPath = path.join(deps.baseDir, KEY_FILENAME);

  const resolve = async (): Promise<Buffer> => {
    if (!deps.isEncryptionAvailable()) {
      throw new SupportCipherUnavailableError(
        "This Mac cannot protect diagnostic data at rest right now (secure storage is unavailable), so support access cannot record anything.",
      );
    }

    let sealed: Buffer | null = null;
    try {
      sealed = await fs.readFile(keyPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        throw new SupportCipherUnavailableError(
          `Could not read the support diagnostics key: ${String(error)}`,
        );
      }
    }

    if (sealed) {
      let opened: string;
      try {
        opened = deps.openString(sealed);
      } catch (error) {
        throw new SupportCipherUnavailableError(
          `The support diagnostics key could not be unlocked: ${String(error)}. Existing reports cannot be read; deleting them from Settings will clear this.`,
        );
      }
      const key = Buffer.from(opened, "base64");
      if (key.length !== KEY_BYTES) {
        throw new SupportCipherUnavailableError(
          "The support diagnostics key is malformed",
        );
      }
      return key;
    }

    const key = randomBytes(KEY_BYTES);
    const wrapped = deps.sealString(key.toString("base64"));
    await fs.mkdir(deps.baseDir, { recursive: true });
    const tmp = `${keyPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, wrapped, { mode: 0o600 });
    await fs.rename(tmp, keyPath);
    deps.log?.("info", "Generated a support diagnostics encryption key");

    // Read back through the same path we will use on every later launch. If the
    // keychain seal did not round-trip, better to find out now than to discover
    // it when a user is trying to send the report support asked them for.
    const verify = Buffer.from(deps.openString(await fs.readFile(keyPath)), "base64");
    if (verify.length !== key.length || !timingSafeEqual(verify, key)) {
      throw new SupportCipherUnavailableError(
        "The support diagnostics key did not survive a write/read round-trip",
      );
    }
    return key;
  };

  return async function getKey(): Promise<Buffer> {
    if (cached) return cached;
    if (!inFlight) {
      inFlight = resolve()
        .then((key) => {
          cached = key;
          return key;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}

/**
 * Length-prefixed framing, so an append-only file can hold many independently
 * sealed records.
 *
 * A single sealed blob per file would mean rewriting the whole log on every
 * line. Framing keeps appends O(1) and keeps the existing size caps meaningful,
 * because the bytes on disk are still the bytes being counted.
 */
export const FRAME_HEADER_BYTES = 4;

export function frame(sealed: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(sealed.length, 0);
  return Buffer.concat([header, sealed]);
}

export interface FramedRecord {
  sealed: Buffer;
}

/**
 * Walk framed records out of a buffer.
 *
 * Stops at the first malformed length rather than throwing: a file truncated by
 * a crash mid-append should yield everything written before it, not nothing.
 * The count of recovered records is what the caller uses to say how much it has.
 */
export function unframe(buffer: Buffer): FramedRecord[] {
  const out: FramedRecord[] = [];
  let offset = 0;
  while (offset + FRAME_HEADER_BYTES <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const start = offset + FRAME_HEADER_BYTES;
    const end = start + length;
    if (length === 0 || end > buffer.length) break;
    out.push({ sealed: buffer.subarray(start, end) });
    offset = end;
  }
  return out;
}
