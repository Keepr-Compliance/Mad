/**
 * @jest-environment node
 *
 * BACKLOG-1870: unit tests for the sync-time attachment METADATA path in
 * attachmentDbService — idempotent upsert (no duplicate rows on re-sync) and
 * reconcile-with-download (a later download fills storage on the SAME row).
 *
 * The native SQLite driver is mocked project-wide, so we inject a faithful
 * in-memory fake table via a mocked `ensureDb` and exercise the real SQL routing.
 */

const mockEnsureDb = jest.fn();
jest.mock("../core/dbConnection", () => ({
  ensureDb: (...a: unknown[]) => mockEnsureDb(...a),
}));

import {
  upsertEmailAttachmentMetadata,
  getEmailAttachmentByFilename,
  setEmailAttachmentStorage,
} from "../attachmentDbService";

interface Row {
  id: string;
  email_id: string | null;
  external_message_id: string | null;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

/** A stateful fake `attachments` table that routes by SQL substring. */
function makeFakeTable() {
  const rows: Row[] = [];
  const db = {
    prepare(sql: string) {
      // Order matters: the more specific SELECT is checked first.
      if (sql.includes("SELECT id, storage_path FROM attachments")) {
        return {
          get: (emailId: string, filename: string) => {
            const r = rows.find(
              (x) => x.email_id === emailId && x.filename === filename,
            );
            return r ? { id: r.id, storage_path: r.storage_path } : undefined;
          },
          all: () => [],
        };
      }
      if (sql.includes("SELECT id FROM attachments")) {
        return {
          get: (emailId: string, filename: string) => {
            const r = rows.find(
              (x) => x.email_id === emailId && x.filename === filename,
            );
            return r ? { id: r.id } : undefined;
          },
          all: () => [],
        };
      }
      if (sql.includes("INSERT INTO attachments")) {
        return {
          run: (
            id: string,
            emailId: string,
            ext: string | null,
            filename: string,
            mime: string | null,
            size: number | null,
          ) => {
            rows.push({
              id,
              email_id: emailId,
              external_message_id: ext,
              filename,
              mime_type: mime,
              file_size_bytes: size,
              storage_path: null,
            });
          },
        };
      }
      if (sql.includes("SET mime_type = COALESCE")) {
        return {
          run: (mime: string | null, size: number | null, id: string) => {
            const r = rows.find((x) => x.id === id);
            if (r) {
              r.mime_type = r.mime_type ?? mime;
              r.file_size_bytes = r.file_size_bytes ?? size;
            }
          },
        };
      }
      if (sql.includes("SET storage_path = ?")) {
        return {
          run: (storagePath: string, size: number, id: string) => {
            const r = rows.find((x) => x.id === id);
            if (r) {
              r.storage_path = storagePath;
              r.file_size_bytes = size;
            }
          },
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return { db, rows };
}

const EMAIL_ID = "email-uuid-1";

describe("BACKLOG-1870 upsertEmailAttachmentMetadata", () => {
  it("inserts a metadata-only row (storage_path + no bytes) with exact values", () => {
    const { db, rows } = makeFakeTable();
    mockEnsureDb.mockReturnValue(db);

    const id = upsertEmailAttachmentMetadata({
      emailId: EMAIL_ID,
      externalEmailId: "provider-msg-1",
      filename: "wire-instructions.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 12345,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      email_id: EMAIL_ID,
      external_message_id: "provider-msg-1",
      filename: "wire-instructions.pdf",
      mime_type: "application/pdf",
      file_size_bytes: 12345,
      storage_path: null, // no bytes downloaded at sync
    });
  });

  it("is idempotent: re-syncing the same (email_id, filename) does NOT duplicate", () => {
    const { db, rows } = makeFakeTable();
    mockEnsureDb.mockReturnValue(db);

    const first = upsertEmailAttachmentMetadata({
      emailId: EMAIL_ID,
      externalEmailId: "provider-msg-1",
      filename: "disclosure.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 500,
    });
    const second = upsertEmailAttachmentMetadata({
      emailId: EMAIL_ID,
      externalEmailId: "provider-msg-1",
      filename: "disclosure.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 500,
    });

    expect(second).toBe(first); // same row id returned
    expect(rows).toHaveLength(1); // exactly one row — no duplicate
  });

  it("backfills mime/size only where NULL, never clobbering existing values", () => {
    const { db, rows } = makeFakeTable();
    mockEnsureDb.mockReturnValue(db);

    // First sync: mime/size unknown (NULL).
    upsertEmailAttachmentMetadata({
      emailId: EMAIL_ID,
      externalEmailId: "m1",
      filename: "photo.heic",
      mimeType: null,
      fileSizeBytes: null,
    });
    // Second sync: now we know mime/size → backfilled.
    upsertEmailAttachmentMetadata({
      emailId: EMAIL_ID,
      externalEmailId: "m1",
      filename: "photo.heic",
      mimeType: "image/heic",
      fileSizeBytes: 2048,
    });
    expect(rows[0].mime_type).toBe("image/heic");
    expect(rows[0].file_size_bytes).toBe(2048);

    // Third sync: a bogus different size must NOT clobber the known value.
    upsertEmailAttachmentMetadata({
      emailId: EMAIL_ID,
      externalEmailId: "m1",
      filename: "photo.heic",
      mimeType: "application/octet-stream",
      fileSizeBytes: 9999,
    });
    expect(rows[0].mime_type).toBe("image/heic");
    expect(rows[0].file_size_bytes).toBe(2048);
    expect(rows).toHaveLength(1);
  });

  it("reconciles with download: setEmailAttachmentStorage fills the SAME row by id", () => {
    const { db, rows } = makeFakeTable();
    mockEnsureDb.mockReturnValue(db);

    // Sync creates the metadata-only row.
    const id = upsertEmailAttachmentMetadata({
      emailId: EMAIL_ID,
      externalEmailId: "m1",
      filename: "contract.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 100,
    });

    // Download path first inspects the row...
    const before = getEmailAttachmentByFilename(EMAIL_ID, "contract.pdf");
    expect(before).toEqual({ id, storage_path: null }); // metadata-only → download

    // ...then fills storage on the SAME row.
    setEmailAttachmentStorage(id, "/data/attachments/hash.pdf", 4096);

    expect(rows).toHaveLength(1); // no second row created
    expect(rows[0].id).toBe(id);
    expect(rows[0].storage_path).toBe("/data/attachments/hash.pdf");
    expect(rows[0].file_size_bytes).toBe(4096);

    const after = getEmailAttachmentByFilename(EMAIL_ID, "contract.pdf");
    expect(after).toEqual({ id, storage_path: "/data/attachments/hash.pdf" });
  });
});
