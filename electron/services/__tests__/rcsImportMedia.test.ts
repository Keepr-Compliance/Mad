/**
 * @jest-environment node
 */
/**
 * BACKLOG-3620 — Control 5: an image sent AFTER its message was stored
 * text-only shows up (has_attachments = 1, one attachment row), and re-sending
 * it adds nothing.
 *
 * The fake mirrors the real storage: `batchInsertMessages` is INSERT OR IGNORE
 * (a stored row never changes), attachment dedup is the
 * `${message_id}:${filename}` set from `getExistingAttachmentRecords`, and
 * files are content-addressed by sha256.
 */

import * as crypto from "crypto";
import * as path from "path";

import { rcsImageFilename, storeImage, type RcsMediaDeps } from "../rcsImportMedia";
import { rcsChatHash, rcsExternalId } from "../rcsImportStore";

// BACKLOG-3630: an image finds its message by the chat's stable hash.
const HASH = rcsChatHash(["+15555550199"]);

const USER = "user-1";
const PNG_BYTES = Buffer.from("synthetic-png-bytes-for-a-test");
const PNG = PNG_BYTES.toString("base64");

function makeFake() {
  const messages = new Map<string, { id: string; hasAttachments: number }>();
  const attachments: Array<{ messageId: string; filename: string; storagePath: string; mimeType: string }> = [];
  const files = new Map<string, Buffer>();
  const deps: RcsMediaDeps = {
    attachmentsDir: () => "/fake/userData/message-attachments",
    getMessageIdMap: () => new Map([...messages.entries()].map(([ext, m]) => [ext, m.id])),
    getExistingAttachmentRecords: () => new Set(attachments.map((a) => `${a.messageId}:${a.filename}`)),
    insertAttachment: (p) => {
      attachments.push({ messageId: p.messageId, filename: p.filename, storagePath: p.storagePath, mimeType: p.mimeType });
    },
    markMessageHasAttachments: (id) => {
      for (const m of messages.values()) {
        if (m.id === id && m.hasAttachments === 0) {
          m.hasAttachments = 1;
          return 1;
        }
      }
      return 0;
    },
    dbTransaction: (fn) => fn(),
    fileExists: async (p) => files.has(p),
    writeSealed: async (p, data) => {
      files.set(p, data);
    },
    mkdir: async () => {},
  };
  return { messages, attachments, files, deps };
}

describe("storeImage (control 5)", () => {
  it("text stored first, image later: the row gets has_attachments = 1 and one attachment row; a re-send adds none", async () => {
    const f = makeFake();
    // The message was stored earlier WITHOUT its image (has_attachments 0).
    f.messages.set(rcsExternalId(HASH, "301"), { id: "msg-301", hasAttachments: 0 });

    const img = { conversationId: "conv-1", msgId: "301", index: 0, mimeType: "image/png", base64: PNG };
    const first = await storeImage(img, USER, f.deps, HASH);
    expect(first).toMatchObject({ stored: true, alreadyPresent: false, filename: "gmweb-301-0.png" });
    expect(f.messages.get(rcsExternalId(HASH, "301"))?.hasAttachments).toBe(1);
    expect(f.attachments).toHaveLength(1);
    const hash = crypto.createHash("sha256").update(PNG_BYTES).digest("hex");
    // path.join, as storeImage builds it:  on Windows, / elsewhere.
    expect(f.attachments[0].storagePath).toBe(path.join("/fake/userData/message-attachments", `${hash}.png`));
    expect(f.files.size).toBe(1);

    const again = await storeImage(img, USER, f.deps, HASH);
    expect(again).toMatchObject({ stored: true, alreadyPresent: true });
    expect(f.attachments).toHaveLength(1);
    expect(f.files.size).toBe(1);
  });

  it("a GIF keeps its type; the filename is deterministic per message and position", () => {
    expect(rcsImageFilename("7", 1, "image/gif")).toBe("gmweb-7-1.gif");
    expect(rcsImageFilename("7", 1, "image/gif")).toBe(rcsImageFilename("7", 1, "IMAGE/GIF"));
  });

  it("refuses a non-image (PDFs are out of scope) and an image for a message not stored", async () => {
    const f = makeFake();
    f.messages.set(rcsExternalId(HASH, "302"), { id: "msg-302", hasAttachments: 0 });
    await expect(
      storeImage({ conversationId: "conv-1", msgId: "302", index: 0, mimeType: "application/pdf", base64: PNG }, USER, f.deps, HASH),
    ).resolves.toEqual({ stored: false, reason: "not_an_image" });
    await expect(
      storeImage({ conversationId: "conv-1", msgId: "999", index: 0, mimeType: "image/png", base64: PNG }, USER, f.deps, HASH),
    ).resolves.toEqual({ stored: false, reason: "message_not_found" });
    expect(f.attachments).toHaveLength(0);
  });
});
