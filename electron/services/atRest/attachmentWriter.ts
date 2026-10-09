/**
 * BACKLOG-3816 S1 — the one way attachment writers put bytes on disk.
 *
 * Every attachment writer (iPhone sync, macOS Messages import, RCS media + cache
 * staging, email attachments) stores the KEPRENC ciphertext produced by
 * {@link FileCrypto.encryptStreamToFile}. Nothing here ever falls back to a
 * plaintext write.
 *
 * Refusal: when the file-data key cannot be produced (DataKeyUnavailableError —
 * secure storage unavailable, store unreadable, or a missing store next to
 * existing ciphertext), the write is refused with {@link AtRestWriteRefusedError}.
 * The refusal is REMEMBERED for the rest of the process: it is logged once, and
 * every later write refuses immediately instead of re-running the evidence scan
 * (SR N3). Ingest paths rethrow it out of their per-item loops so the import or
 * sync stops and reports {@link AtRestWriteRefusedError.userMessage}.
 * `getAtRestWriteRefusal()` lets a UI surface (S3) show the state.
 */
import crypto from "crypto";
import { Readable } from "stream";
import { hostLogger } from "../../capabilities/loggerProvider";
import { DataKeyUnavailableError, getAtRestFiles } from "./dataKeyService";
import type { EncryptResult, FileCrypto } from "./fileCrypto";

export const AT_REST_WRITE_REFUSED = "AT_REST_WRITE_REFUSED";

export const AT_REST_WRITE_REFUSED_MESSAGE =
  "Keepr could not open the key it uses to protect attachments saved on this computer, " +
  "so it has stopped saving new attachments. Messages already saved are not affected. " +
  "Restart Keepr; if this keeps happening, contact support.";

/** A write was refused because the file-data key is unavailable. Never retried as plaintext. */
export class AtRestWriteRefusedError extends Error {
  readonly code = AT_REST_WRITE_REFUSED;
  readonly userMessage = AT_REST_WRITE_REFUSED_MESSAGE;
  /** Why the key was unavailable (no key material, paths relative to userData). */
  readonly reason: string;
  constructor(reason: string) {
    super(`${AT_REST_WRITE_REFUSED_MESSAGE} (${reason})`);
    this.name = "AtRestWriteRefusedError";
    this.reason = reason;
  }
}

export function isAtRestWriteRefused(error: unknown): error is AtRestWriteRefusedError {
  return error instanceof AtRestWriteRefusedError;
}

export interface AtRestWriteRefusal {
  /** ISO time of the first refusal in this process. */
  at: string;
  reason: string;
}

let refusal: AtRestWriteRefusal | null = null;

/** The remembered refusal for this process, or null when writes are allowed. */
export function getAtRestWriteRefusal(): AtRestWriteRefusal | null {
  return refusal;
}

/** Tests only. */
export function resetAtRestWriteRefusalForTests(): void {
  refusal = null;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  if (refusal) throw new AtRestWriteRefusedError(refusal.reason);
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DataKeyUnavailableError) {
      if (!refusal) {
        refusal = { at: new Date().toISOString(), reason: error.message };
        hostLogger.error(`[AtRest] attachment writes refused for this session: ${error.message}`);
      }
      throw new AtRestWriteRefusedError(error.message);
    }
    throw error;
  }
}

/** Encrypt an in-memory buffer to `destPath`. Returns the PLAINTEXT size and SHA-256. */
export function sealBufferToFile(
  destPath: string,
  data: Buffer,
  files: FileCrypto = getAtRestFiles(),
): Promise<EncryptResult> {
  return guarded(() => files.encryptStreamToFile(Readable.from([data]), destPath));
}

/**
 * Encrypt the file at `sourcePath` to `destPath`. The source is read through
 * openDecryptStream, so it may itself be plaintext or KEPRENC (an encrypted
 * iPhone backup). Returns the PLAINTEXT size and SHA-256.
 */
export function sealFileFrom(
  sourcePath: string,
  destPath: string,
  files: FileCrypto = getAtRestFiles(),
): Promise<EncryptResult> {
  return guarded(async () => {
    const { stream } = await files.openDecryptStream(sourcePath);
    try {
      return await files.encryptStreamToFile(stream as AsyncIterable<Buffer>, destPath);
    } finally {
      stream.destroy();
    }
  });
}

/** SHA-256 (hex) and size of a file's PLAINTEXT, whether the file is plaintext or KEPRENC. */
export function hashPlaintext(
  sourcePath: string,
  files: FileCrypto = getAtRestFiles(),
): Promise<{ sha256: string; size: number }> {
  return guarded(async () => {
    const { stream } = await files.openDecryptStream(sourcePath);
    const hash = crypto.createHash("sha256");
    let size = 0;
    for await (const piece of stream as AsyncIterable<Buffer>) {
      hash.update(piece);
      size += piece.length;
    }
    return { sha256: hash.digest("hex"), size };
  });
}

/** Plaintext size of a file (header arithmetic for KEPRENC; stat for plaintext). */
export function plaintextSize(sourcePath: string, files: FileCrypto = getAtRestFiles()): Promise<number> {
  return files.statPlaintext(sourcePath).then((s) => s.size);
}

/**
 * Decrypt a stored attachment fully into memory (all-or-nothing). A reader, so it
 * is NOT blocked by a remembered write refusal: a pre-migration plaintext file
 * still reads, and a KEPRENC file throws DataKeyUnavailableError on its own.
 */
export function readAttachmentBytes(storagePath: string, files: FileCrypto = getAtRestFiles()): Promise<Buffer> {
  return files.readAllDecrypted(storagePath);
}
