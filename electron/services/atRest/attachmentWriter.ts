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
import fs from "fs";
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

/*
 * SOURCE files (BACKLOG-3816 S1 fix-up, SR R1).
 *
 * A writer's source is never a Keepr file: it is an iPhone backup content file or
 * a ~/Library/Messages attachment, plaintext as Apple wrote it. Its bytes are read
 * RAW — never through openDecryptStream and never classified by its first bytes,
 * because an attachment's content is chosen by whoever sent it and may start with
 * "KEPRENC". An Apple-encrypted iPhone backup is decrypted upstream by
 * backupDecryptionService (backupService.ts: `finalBackupPath = decryptedPath`)
 * before storeAttachments sees a path; that is a plaintext copy too.
 *
 * S4 (a Keepr-encrypted kept backup) will decide from the backup's at-rest MARKER
 * (`readBackupMarker(udid).state`), not from file content, and route those reads
 * through the decrypting reader explicitly. Until S4 writes that marker no source
 * is KEPRENC.
 */

/** Encrypt the (raw, plaintext) file at `sourcePath` to `destPath`. Returns the plaintext size and SHA-256. */
export function sealFileFrom(
  sourcePath: string,
  destPath: string,
  files: FileCrypto = getAtRestFiles(),
): Promise<EncryptResult> {
  return guarded(async () => {
    const stream = fs.createReadStream(sourcePath);
    try {
      return await files.encryptStreamToFile(stream, destPath);
    } finally {
      stream.destroy();
    }
  });
}

/** SHA-256 (hex) and size of a SOURCE file's raw bytes. */
export async function hashSourceFile(sourcePath: string): Promise<{ sha256: string; size: number }> {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const piece of fs.createReadStream(sourcePath) as AsyncIterable<Buffer>) {
    hash.update(piece);
    size += piece.length;
  }
  return { sha256: hash.digest("hex"), size };
}

/** Size of a SOURCE file (raw stat — never header arithmetic). Throws when it does not exist. */
export async function sourceFileSize(sourcePath: string): Promise<number> {
  return (await fs.promises.stat(sourcePath)).size;
}

/**
 * Decrypt a STORED attachment fully into memory (all-or-nothing). A reader, so it
 * is NOT blocked by a remembered write refusal. Classification is structural
 * (fileCrypto "Detection"): a pre-migration plaintext file — including one whose
 * content starts with "KEPRENC" — is returned as-is; a real container is decrypted
 * and throws on a failed tag or a key that is not held.
 */
export function readAttachmentBytes(storagePath: string, files: FileCrypto = getAtRestFiles()): Promise<Buffer> {
  return files.readAllDecrypted(storagePath);
}
