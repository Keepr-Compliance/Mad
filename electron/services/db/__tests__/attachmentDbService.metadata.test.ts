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
  // BACKLOG-2551: the upsert now runs its read-modify-write inside one
  // transaction (BACKLOG-2530's atomicity guard requires it). Run the body
  // straight through here — this fake has no constraint engine and no rollback,
  // which is exactly why the ATOMICITY and UNIQUENESS claims are tested against
  // the real driver instead (attachmentDbService.providerAttachmentId-2551).
  dbTransaction: <T,>(fn: () => T): T => fn(),
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
  provider_attachment_id: string | null;
}

/**
 * A stateful fake `attachments` table that routes by SQL substring.
 *
 * BACKLOG-2551 SCOPE NOTE: this fake keeps testing the BACKLOG-1870 claims it was
 * written for — the upsert is idempotent, and a later download fills the SAME row.
 * It deliberately does NOT model the partial UNIQUE index, because it cannot: a
 * substring router has no constraint engine, so an ON CONFLICT clause here would
 * be a fixture describing a state the driver alone can produce. The 2551
 * behaviours that depend on that index — two same-named attachments both landing,
 * one provider id upserting to one row, the legacy adopt — are tested against the
 * REAL driver in attachmentDbService.providerAttachmentId-2551.test.ts.
 */
function makeFakeTable() {
  const rows: Row[] = [];
  const find = (p: (r: Row) => boolean) => rows.find(p);
  const project = (r: Row | undefined) =>
    r
      ? {
          id: r.id,
          storage_path: r.storage_path,
          provider_attachment_id: r.provider_attachment_id,
        }
      : undefined;

  const db = {
    prepare(sql: string) {
      const has = (...parts: string[]) => parts.every((x) => sql.includes(x));

      // --- lookups, most specific first ---
      if (has("SELECT id, storage_path, provider_attachment_id", "provider_attachment_id = ?")) {
        return {
          get: (emailId: string, providerId: string) =>
            project(
              find((x) => x.email_id === emailId && x.provider_attachment_id === providerId),
            ),
          all: () => [],
        };
      }
      if (has("SELECT id, storage_path, provider_attachment_id", "provider_attachment_id IS NULL")) {
        return {
          get: (emailId: string, filename: string) =>
            project(
              find(
                (x) =>
                  x.email_id === emailId &&
                  x.filename === filename &&
                  x.provider_attachment_id === null,
              ),
            ),
          all: () => [],
        };
      }
      if (has("SELECT id, storage_path, provider_attachment_id")) {
        return {
          get: (emailId: string, filename: string) =>
            project(find((x) => x.email_id === emailId && x.filename === filename)),
          all: () => [],
        };
      }
      if (has("SELECT id FROM attachments", "provider_attachment_id = ?")) {
        return {
          get: (emailId: string, providerId: string) => {
            const r = find(
              (x) => x.email_id === emailId && x.provider_attachment_id === providerId,
            );
            return r ? { id: r.id } : undefined;
          },
          all: () => [],
        };
      }
      if (has("SELECT id FROM attachments")) {
        return {
          get: (emailId: string, filename: string) => {
            const r = find((x) => x.email_id === emailId && x.filename === filename);
            return r ? { id: r.id } : undefined;
          },
          all: () => [],
        };
      }

      // --- writes ---
      if (has("INSERT INTO attachments", "provider_attachment_id, created_at")) {
        return {
          run: (
            id: string,
            emailId: string,
            ext: string | null,
            filename: string,
            mime: string | null,
            size: number | null,
            providerId: string | null,
          ) => {
            rows.push({
              id,
              email_id: emailId,
              external_message_id: ext,
              filename,
              mime_type: mime,
              file_size_bytes: size,
              storage_path: null,
              provider_attachment_id: providerId,
            });
          },
        };
      }
      if (has("INSERT INTO attachments")) {
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
              provider_attachment_id: null,
            });
          },
        };
      }
      if (has("SET mime_type = COALESCE")) {
        return {
          run: (mime: string | null, size: number | null, id: string) => {
            const r = find((x) => x.id === id);
            if (r) {
              r.mime_type = r.mime_type ?? mime;
              r.file_size_bytes = r.file_size_bytes ?? size;
            }
          },
        };
      }
      if (has("SET provider_attachment_id = ?")) {
        return {
          run: (providerId: string | null, id: string) => {
            const r = find((x) => x.id === id);
            if (r) r.provider_attachment_id = providerId;
          },
        };
      }
      if (has("SET storage_path = ?")) {
        return {
          run: (
            storagePath: string,
            size: number,
            providerId: string | null,
            id: string,
          ) => {
            const r = find((x) => x.id === id);
            if (r) {
              r.storage_path = storagePath;
              r.file_size_bytes = size;
              r.provider_attachment_id = r.provider_attachment_id ?? providerId;
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
    // BACKLOG-2551: the lookup now also returns provider_attachment_id, which both
    // writers need to tell "reconcile this row" from "insert a sibling".
    expect(before).toEqual({ id, storage_path: null, provider_attachment_id: null }); // metadata-only → download

    // ...then fills storage on the SAME row.
    setEmailAttachmentStorage(id, "/data/attachments/hash.pdf", 4096);

    expect(rows).toHaveLength(1); // no second row created
    expect(rows[0].id).toBe(id);
    expect(rows[0].storage_path).toBe("/data/attachments/hash.pdf");
    expect(rows[0].file_size_bytes).toBe(4096);

    const after = getEmailAttachmentByFilename(EMAIL_ID, "contract.pdf");
    expect(after).toEqual({
      id,
      storage_path: "/data/attachments/hash.pdf",
      provider_attachment_id: null,
    });
  });
});
