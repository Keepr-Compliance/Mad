/**
 * @jest-environment node
 *
 * BACKLOG-2551 — the upsert's four-step order, against the REAL driver.
 *
 * WHY NOT THE FAKE. attachmentDbService.metadata.test.ts routes SQL through a
 * hand-written in-memory table. That fake has no constraint engine, so it cannot
 * express the one thing this change is about: a PARTIAL UNIQUE INDEX, and an
 * `ON CONFLICT ... WHERE ...` clause that SQLite rejects at PREPARE time unless the
 * clause matches it. A fake asserting those would be a fixture describing a state
 * only the real driver can produce.
 *
 * Every fixture row is synthetic; this repo is public.
 */

import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let db: DatabaseType;

jest.mock("../core/dbConnection", () => ({
  ensureDb: () => db,
  dbTransaction: <T,>(fn: () => T): T => db.transaction(fn)(),
}));

import {
  upsertEmailAttachmentMetadata,
  findEmailAttachmentRow,
  setEmailAttachmentStorage,
} from "../attachmentDbService";
// BACKLOG-2551: the fixture below builds the post-v71 shape from the SAME constants
// migration v71 executes, rather than transcribing them. A hand-typed copy would
// keep this suite green while the migration's own definition drifted away from it —
// which is precisely the defect class this PR exists to remove, so it has no place
// in this PR's own tests. (The migration's index is separately exercised in
// databaseService.migration-v71.test.ts; this removes the second, silent copy.)
import {
  V71_ADD_PROVIDER_COLUMN_SQL,
  V71_CREATE_PROVIDER_INDEX_SQL,
} from "../migrationV71Sql";

const FROZEN = fs.readFileSync(
  path.join(__dirname, "..", "..", "__tests__", "fixtures", "chain-v69-schema.sql"),
  "utf8",
);

/** A post-v71 database: frozen v70 shape + exactly what migration v71 adds. */
function postV71Db(): DatabaseType {
  const d = new RealDatabase(":memory:") as DatabaseType;
  d.exec(FROZEN);
  d.exec(`INSERT INTO users_local (id,email,oauth_provider,oauth_id)
            VALUES ('u1','synthetic@example.test','google','oid-1');
          INSERT INTO emails (id,user_id) VALUES ('e1','u1');`);
  d.exec(V71_ADD_PROVIDER_COLUMN_SQL);
  d.exec(V71_CREATE_PROVIDER_INDEX_SQL);
  return d;
}

const rows = () =>
  db.prepare(
    "SELECT id, filename, provider_attachment_id, mime_type, file_size_bytes, storage_path FROM attachments ORDER BY rowid",
  ).all() as Array<Record<string, unknown>>;

beforeEach(() => {
  db = postV71Db();
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
});

describe("BACKLOG-2551 upsertEmailAttachmentMetadata — identity by provider id", () => {
  const base = { emailId: "e1", externalEmailId: "ext-1", mimeType: null, fileSizeBytes: null };

  it("PRECONDITION: the partial unique index is present and the fixture is post-v71", () => {
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='idx_attachments_email_provider'")
      .get() as { sql: string };
    expect(idx.sql).toMatch(/WHERE provider_attachment_id IS NOT NULL/);
  });

  it("CONTROL 1 (DB half): two SAME-NAMED attachments with different provider ids both land", () => {
    const a = upsertEmailAttachmentMetadata({ ...base, filename: "image001.png", providerAttachmentId: "P-A" });
    const b = upsertEmailAttachmentMetadata({ ...base, filename: "image001.png", providerAttachmentId: "P-B" });
    expect(a).not.toBe(b);
    expect(rows()).toHaveLength(2);
  });

  it("CONTROL 2: the same provider id twice upserts to ONE row and returns the SAME id", () => {
    const a = upsertEmailAttachmentMetadata({ ...base, filename: "sig.png", providerAttachmentId: "P-1" });
    const b = upsertEmailAttachmentMetadata({
      ...base, filename: "sig.png", providerAttachmentId: "P-1",
      mimeType: "image/png", fileSizeBytes: 99,
    });
    expect(b).toBe(a);
    expect(rows()).toHaveLength(1);
    // Metadata backfilled where it was NULL, never clobbered.
    expect(rows()[0]).toMatchObject({ mime_type: "image/png", file_size_bytes: 99 });
  });

  it("backfill never clobbers a value already written", () => {
    const id = upsertEmailAttachmentMetadata({
      ...base, filename: "a.pdf", providerAttachmentId: "P-2",
      mimeType: "application/pdf", fileSizeBytes: 10,
    });
    upsertEmailAttachmentMetadata({
      ...base, filename: "a.pdf", providerAttachmentId: "P-2",
      mimeType: "text/plain", fileSizeBytes: 999,
    });
    const r = db.prepare("SELECT mime_type, file_size_bytes FROM attachments WHERE id=?").get(id);
    expect(r).toMatchObject({ mime_type: "application/pdf", file_size_bytes: 10 });
  });

  it("STEP 2 — a pre-v71 row is ADOPTED, not duplicated (the upgrade-day regression this prevents)", () => {
    // A legacy row: written before v71, so provider_attachment_id is NULL.
    db.exec(`INSERT INTO attachments (id,email_id,filename) VALUES ('legacy-1','e1','contract.pdf')`);
    const id = upsertEmailAttachmentMetadata({
      ...base, filename: "contract.pdf", providerAttachmentId: "P-3",
    });
    expect(id).toBe("legacy-1");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].provider_attachment_id).toBe("P-3");
  });

  it("STEP 2 does not swallow a legitimate same-named SIBLING that already has its own id", () => {
    upsertEmailAttachmentMetadata({ ...base, filename: "image001.png", providerAttachmentId: "P-A" });
    // The IS NULL guard is what keeps this from adopting the row above.
    const second = upsertEmailAttachmentMetadata({
      ...base, filename: "image001.png", providerAttachmentId: "P-B",
    });
    expect(rows()).toHaveLength(2);
    expect(db.prepare("SELECT provider_attachment_id p FROM attachments WHERE id=?").get(second))
      .toMatchObject({ p: "P-B" });
  });

  it("STEP 4 — with NO provider id the behaviour is byte-for-byte pre-v71 (the Gmail path)", () => {
    const a = upsertEmailAttachmentMetadata({ ...base, filename: "g.pdf", providerAttachmentId: null });
    const b = upsertEmailAttachmentMetadata({ ...base, filename: "g.pdf", providerAttachmentId: null });
    // Idempotent by (email_id, filename), exactly as before, and NOT in the index.
    expect(b).toBe(a);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].provider_attachment_id).toBeNull();
  });

  it("many NULL-provider rows coexist: the partial index does not constrain them", () => {
    upsertEmailAttachmentMetadata({ ...base, filename: "one.pdf", providerAttachmentId: null });
    upsertEmailAttachmentMetadata({ ...base, filename: "two.pdf", providerAttachmentId: null });
    upsertEmailAttachmentMetadata({ ...base, filename: "three.pdf", providerAttachmentId: null });
    expect(rows()).toHaveLength(3);
  });

  it("the ON CONFLICT clause carries the index's WHERE — without it SQLite rejects it at PREPARE time", () => {
    // Pin the requirement itself, so a future 'simplification' that drops the
    // WHERE fails here with an explanation rather than at runtime in the field.
    expect(() =>
      db.prepare(
        `INSERT INTO attachments (id,email_id,filename,provider_attachment_id) VALUES (?,?,?,?)
         ON CONFLICT(email_id, provider_attachment_id) DO UPDATE SET filename = excluded.filename`,
      ),
    ).toThrow(/ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint/);

    expect(() =>
      db.prepare(
        `INSERT INTO attachments (id,email_id,filename,provider_attachment_id) VALUES (?,?,?,?)
         ON CONFLICT(email_id, provider_attachment_id) WHERE provider_attachment_id IS NOT NULL
         DO UPDATE SET filename = excluded.filename`,
      ),
    ).not.toThrow();
  });
});

describe("BACKLOG-2551 findEmailAttachmentRow — the shared lookup order", () => {
  it("prefers the provider id over a same-named sibling", () => {
    db.exec(`INSERT INTO attachments (id,email_id,filename,provider_attachment_id)
             VALUES ('r1','e1','x.png','P-A'),('r2','e1','x.png','P-B')`);
    expect(findEmailAttachmentRow("e1", "x.png", "P-B")?.id).toBe("r2");
  });

  it("falls back to a NULL-provider row of the same name (the adopt candidate)", () => {
    db.exec(`INSERT INTO attachments (id,email_id,filename) VALUES ('r3','e1','y.png')`);
    expect(findEmailAttachmentRow("e1", "y.png", "P-Z")?.id).toBe("r3");
  });

  it("does NOT return a row that already has a DIFFERENT provider id", () => {
    db.exec(`INSERT INTO attachments (id,email_id,filename,provider_attachment_id)
             VALUES ('r4','e1','z.png','P-OTHER')`);
    expect(findEmailAttachmentRow("e1", "z.png", "P-NEW")).toBeUndefined();
  });

  it("with no provider id it is the plain filename lookup", () => {
    db.exec(`INSERT INTO attachments (id,email_id,filename) VALUES ('r5','e1','w.png')`);
    expect(findEmailAttachmentRow("e1", "w.png", null)?.id).toBe("r5");
  });
});

describe("BACKLOG-2551 setEmailAttachmentStorage — stamping an adopted row", () => {
  it("fills storage AND stamps the provider id on a row that had none", () => {
    db.exec(`INSERT INTO attachments (id,email_id,filename) VALUES ('s1','e1','a.pdf')`);
    setEmailAttachmentStorage("s1", "/h/AAA.pdf", 123, "P-9");
    expect(db.prepare("SELECT storage_path sp, provider_attachment_id p FROM attachments WHERE id='s1'").get())
      .toMatchObject({ sp: "/h/AAA.pdf", p: "P-9" });
  });

  it("never overwrites a provider id the row already has", () => {
    db.exec(`INSERT INTO attachments (id,email_id,filename,provider_attachment_id) VALUES ('s2','e1','b.pdf','P-KEEP')`);
    setEmailAttachmentStorage("s2", "/h/BBB.pdf", 5, "P-OTHER");
    expect(db.prepare("SELECT provider_attachment_id p FROM attachments WHERE id='s2'").get())
      .toMatchObject({ p: "P-KEEP" });
  });
});
