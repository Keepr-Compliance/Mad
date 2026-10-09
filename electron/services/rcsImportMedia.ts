/**
 * RCS import images — BACKLOG-3620.
 *
 * Stores one image (or GIF) the extension read from a Messages for Web message
 * and attaches it to that message, the same way iPhone sync stores attachments
 * (`iPhoneSyncStorageService.ts`):
 *
 * - bytes go to `<userData>/message-attachments/<sha256><ext>`, content-
 *   addressed; the file is written only when that hash is not already there;
 * - an `attachments` row via `insertAttachment` (INSERT OR IGNORE);
 * - dedup key `${message_id}:${filename}`, so the filename is deterministic:
 *   `gmweb-<msgId>-<index><ext>`. A re-sent chat adds no second row.
 *
 * Then the parent row is marked `has_attachments = 1`. That UPDATE is what
 * makes a message first stored WITHOUT its image (a text-only send, or a
 * failed image read) show the image later: `batchInsertMessages` is INSERT OR
 * IGNORE and never touches an existing row.
 *
 * Only images: PDFs and other files are out of scope (their name and size are
 * recorded on the message by `rcsImportStore.ts`).
 */

import * as crypto from "crypto";
import * as path from "path";

import { rcsExternalId } from "./rcsImportStore";

/** Raw bytes per image. The bridge's body cap is sized from this. */
export const RCS_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

/** SR C5 (CASA N21): the only image types Keepr accepts (others → 415). */
export const RCS_ALLOWED_IMAGE_MIME: ReadonlySet<string> = new Set(Object.keys(EXT_BY_MIME));
export const RCS_IMAGE_TYPE_REFUSED = "Keepr only keeps JPEG, PNG, GIF, WebP and HEIC photos.";

export interface RcsIncomingImage {
  conversationId: string;
  msgId: string;
  /** 0-based position of the image within its message. */
  index: number;
  mimeType: string;
  base64: string;
}

export interface RcsMediaDeps {
  attachmentsDir: () => string;
  getMessageIdMap: (userId: string) => Map<string, string>;
  getExistingAttachmentRecords: () => Set<string>;
  insertAttachment: (params: {
    id: string;
    messageId: string;
    externalMessageId: string;
    filename: string;
    mimeType: string;
    fileSizeBytes: number;
    storagePath: string;
  }) => void;
  markMessageHasAttachments: (messageId: string) => number;
  /** Runs the attachment row + has_attachments update as ONE transaction. */
  dbTransaction: <T>(fn: () => T) => T;
  fileExists: (filePath: string) => Promise<boolean>;
  /**
   * BACKLOG-3816: stores `data` at `filePath` as KEPRENC ciphertext
   * (atRest/attachmentWriter.sealBufferToFile). Never a plaintext write.
   */
  writeSealed: (filePath: string, data: Buffer) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

export type RcsImageResult =
  | { stored: true; alreadyPresent: boolean; filename: string; bytes: number }
  | { stored: false; reason: "message_not_found" | "not_an_image" | "too_large" | "empty" };

/** The file extension Keepr stores an image under (".img" when unknown). */
export function rcsImageExt(mimeType: string): string {
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? ".img";
}

export function rcsImageFilename(msgId: string, index: number, mimeType: string): string {
  return `gmweb-${msgId}-${index}${rcsImageExt(mimeType)}`;
}

/** Validate an untrusted image body, or return an error string. */
export function parseIncomingImage(body: unknown): RcsIncomingImage | string {
  if (!body || typeof body !== "object") return "Body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.conversationId !== "string" || b.conversationId.length === 0) return "conversationId is required";
  if (typeof b.msgId !== "string" || b.msgId.length === 0) return "msgId is required";
  if (typeof b.index !== "number" || !Number.isInteger(b.index) || b.index < 0 || b.index > 99) {
    return "index must be an integer 0-99";
  }
  if (typeof b.mimeType !== "string") return "mimeType is required";
  if (typeof b.base64 !== "string") return "base64 is required";
  return {
    conversationId: b.conversationId,
    msgId: b.msgId,
    index: b.index,
    mimeType: b.mimeType,
    base64: b.base64,
  };
}

/** Store one image and attach it to its (already stored) message. */
export async function storeImage(
  image: RcsIncomingImage,
  userId: string,
  deps: RcsMediaDeps,
  /** BACKLOG-3630: the chat's hash (rcsChatHash of its Details numbers). */
  chatHash: string,
): Promise<RcsImageResult> {
  const mimeType = image.mimeType.toLowerCase();
  if (!RCS_ALLOWED_IMAGE_MIME.has(mimeType)) return { stored: false, reason: "not_an_image" };

  const bytes = Buffer.from(image.base64, "base64");
  if (bytes.length === 0) return { stored: false, reason: "empty" };
  if (bytes.length > RCS_MAX_IMAGE_BYTES) return { stored: false, reason: "too_large" };

  const externalId = rcsExternalId(chatHash, image.msgId);
  const messageId = deps.getMessageIdMap(userId).get(externalId);
  if (!messageId) return { stored: false, reason: "message_not_found" };

  const filename = rcsImageFilename(image.msgId, image.index, mimeType);
  const alreadyPresent = deps.getExistingAttachmentRecords().has(`${messageId}:${filename}`);

  if (!alreadyPresent) {
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const dir = deps.attachmentsDir();
    const storagePath = path.join(dir, `${hash}${path.extname(filename)}`);
    await deps.mkdir(dir);
    if (!(await deps.fileExists(storagePath))) {
      await deps.writeSealed(storagePath, bytes);
    }
    const attachment = {
      id: crypto.randomUUID(),
      messageId,
      externalMessageId: externalId,
      filename,
      mimeType,
      fileSizeBytes: bytes.length,
      storagePath,
    };
    deps.dbTransaction(() => {
      deps.insertAttachment(attachment);
      // A row stored earlier without its image must now show it.
      deps.markMessageHasAttachments(messageId);
    });
  } else {
    // Already attached: still repair a row whose flag was never set.
    deps.markMessageHasAttachments(messageId);
  }

  return { stored: true, alreadyPresent, filename, bytes: bytes.length };
}
