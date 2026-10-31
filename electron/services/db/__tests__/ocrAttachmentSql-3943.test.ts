/**
 * @jest-environment node
 *
 * BACKLOG-3943 — the OCR SQL against the real driver and the shipped schema.
 *
 *   - the OCR pending set, one row per branch of its WHERE, present and absent;
 *   - json_valid / json_extract exist on this driver and a non-JSON value cannot fail the
 *     query (measured here, not assumed — same shape as the chunk-3 `IN ()` probe);
 *   - C3: an OCR "empty" write takes the row out of the pending set;
 *   - R1: the compare-and-set write loses when the row changed after it was read;
 *   - R2: the text-layer write only fills a NULL column;
 *   - R3: a retryable error stays pending until OCR_MAX_ATTEMPTS, then parks.
 *
 * Runs under Electron's node (the driver is built for Electron):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file> --bail=0
 */
import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb, setDbPath, setEncryptionKey } from "../core/dbConnection";
import {
  compareAndSetAttachmentOcrResult,
  getAttachmentOcrRow,
  setAttachmentTextContent,
} from "../attachmentDbService";
import {
  prepareOcrPendingCount,
  prepareOcrPendingPage,
  type TextExtractionQueryable,
} from "../attachmentTextExtractionSql";
import { OCR_MAX_ATTEMPTS, OCR_MIME_TYPES } from "../../ocr/ocrConfig";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");

let db: DatabaseType;
let q: TextExtractionQueryable;

const errorMeta = (attempts: number): string =>
  JSON.stringify({ textSource: "none", reason: "error", retryable: true, attempts, lastFailure: "signal", at: "t" });

function insert(id: string, mime: string | null, storage: string | null, text: string | null, meta: string | null, created: string): void {
  db.prepare(
    `INSERT INTO attachments (id, message_id, filename, mime_type, storage_path, text_content, analysis_metadata, created_at)
     VALUES (?, 'm1', ?, ?, ?, ?, ?, ?)`,
  ).run(id, `${id}.pdf`, mime, storage, text, meta, created);
}

function pendingIds(limit = 100): string[] {
  return (
    prepareOcrPendingPage(q, OCR_MIME_TYPES).all(...OCR_MIME_TYPES, OCR_MAX_ATTEMPTS, limit) as Array<{ id: string }>
  ).map((r) => r.id);
}

function pendingCount(): number {
  return (prepareOcrPendingCount(q, OCR_MIME_TYPES).get(...OCR_MIME_TYPES, OCR_MAX_ATTEMPTS) as { n: number }).n;
}

function row(id: string): { text_content: string | null; analysis_metadata: string | null } {
  return db.prepare(`SELECT text_content, analysis_metadata FROM attachments WHERE id = ?`).get(id) as {
    text_content: string | null;
    analysis_metadata: string | null;
  };
}

beforeEach(() => {
  db = new RealDatabase(":memory:") as unknown as DatabaseType;
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  setDb(db);
  setDbPath(":memory:");
  setEncryptionKey("test-key-not-a-real-key");
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u1', 'fixture@example.invalid', 'google', 'o1')`,
  ).run();
  db.prepare(`INSERT INTO messages (id, user_id, channel, body_text) VALUES ('m1', 'u1', 'imessage', 'b')`).run();
  q = db as unknown as TextExtractionQueryable;
});

afterEach(() => {
  setDb(null as unknown as DatabaseType);
  setDbPath(null as unknown as string);
  db.close();
});

describe("the driver has the JSON functions the pending query relies on — measured", () => {
  it("json_valid / json_extract exist; json_extract raises on non-JSON, CASE keeps it unreached", () => {
    expect(db.prepare(`SELECT json_extract('{"a":true}', '$.a') AS v`).get()).toEqual({ v: 1 });
    expect(db.prepare(`SELECT json_valid('not json') AS v`).get()).toEqual({ v: 0 });
    expect(() => db.prepare(`SELECT json_extract('not json', '$.a') AS v`).get()).toThrow(/malformed JSON/);
    expect(
      db.prepare(`SELECT CASE WHEN json_valid('not json') THEN json_extract('not json', '$.a') ELSE 0 END AS v`).get(),
    ).toEqual({ v: 0 });
  });
});

describe("OCR pending set — every branch of the WHERE", () => {
  function seed(): void {
    // WANTED
    insert("w-new", "application/pdf", "/p/a", "", null, "2026-01-01");
    insert("w-retry1", "application/pdf", "/p/b", "", errorMeta(1), "2026-01-02");
    insert("w-retry2", "application/pdf", "/p/c", "", errorMeta(OCR_MAX_ATTEMPTS - 1), "2026-01-03");
    // EXCLUDED, one per predicate
    insert("x-nofile", "application/pdf", null, "", null, "2026-02-01");
    insert("x-never", "application/pdf", "/p/d", null, null, "2026-02-02"); // text pass not run yet
    insert("x-text", "application/pdf", "/p/e", "real text", null, "2026-02-03");
    insert("x-plain", "text/plain", "/p/f", "", null, "2026-02-04"); // not an OCR type
    insert("x-image", "image/png", "/p/g", "", null, "2026-02-05"); // images are a later item
    insert("x-empty", "application/pdf", "/p/h", "", JSON.stringify({ textSource: "ocr", result: "empty" }), "2026-02-06");
    insert("x-overcap", "application/pdf", "/p/i", "", JSON.stringify({ textSource: "none", reason: "over-cap" }), "2026-02-07");
    insert("x-parked", "application/pdf", "/p/j", "", errorMeta(OCR_MAX_ATTEMPTS), "2026-02-08");
    insert("x-notjson", "application/pdf", "/p/k", "", "stray value", "2026-02-09");
  }

  it("selects exactly the never-OCR'd and still-retryable rows, newest first", () => {
    seed();
    expect(pendingIds()).toEqual(["w-retry2", "w-retry1", "w-new"]);
    expect(pendingCount()).toBe(3);
  });

  it("honours the page size", () => {
    seed();
    expect(pendingIds(2)).toEqual(["w-retry2", "w-retry1"]);
  });

  it("refuses an empty MIME list", () => {
    expect(() => prepareOcrPendingPage(q, [])).toThrow(/mimeTypes is empty/);
  });
});

describe("C3 — an OCR result takes the row out of the pending set", () => {
  it("empty result: text stays \"\", metadata written, row no longer pending", () => {
    insert("a", "application/pdf", "/p/a", "", null, "2026-01-01");
    expect(pendingIds()).toEqual(["a"]);
    const changes = compareAndSetAttachmentOcrResult("a", "", JSON.stringify({ textSource: "ocr", result: "empty" }), null);
    expect(changes).toBe(1);
    expect(row("a").text_content).toBe("");
    expect(pendingIds()).toEqual([]);
  });

  it("text result: text and provenance land together", () => {
    insert("a", "application/pdf", "/p/a", "", null, "2026-01-01");
    compareAndSetAttachmentOcrResult("a", "Form 41", JSON.stringify({ textSource: "ocr", result: "text" }), null);
    expect(row("a").text_content).toBe("Form 41");
    expect(JSON.parse(row("a").analysis_metadata as string).textSource).toBe("ocr");
    expect(pendingIds()).toEqual([]);
  });
});

describe("R1 — the OCR write is compare-and-set", () => {
  it("loses (0 rows) when text_content changed after the read, and leaves the newer value", () => {
    insert("a", "application/pdf", "/p/a", "", null, "2026-01-01");
    const read = getAttachmentOcrRow("a");
    expect(read).toEqual({ storage_path: "/p/a", mime_type: "application/pdf", text_content: "", analysis_metadata: null });
    db.prepare(`UPDATE attachments SET text_content = 'newer' WHERE id = 'a'`).run();
    expect(compareAndSetAttachmentOcrResult("a", "ocr", "{}", read!.analysis_metadata)).toBe(0);
    expect(row("a")).toEqual({ text_content: "newer", analysis_metadata: null });
  });

  it("loses when analysis_metadata changed after the read", () => {
    insert("a", "application/pdf", "/p/a", "", null, "2026-01-01");
    db.prepare(`UPDATE attachments SET analysis_metadata = ? WHERE id = 'a'`).run(errorMeta(1));
    expect(compareAndSetAttachmentOcrResult("a", "ocr", "{}", null)).toBe(0);
  });

  it("wins against the exact metadata value it read (a retry of an error row)", () => {
    insert("a", "application/pdf", "/p/a", "", errorMeta(1), "2026-01-01");
    expect(compareAndSetAttachmentOcrResult("a", "ocr", "{}", errorMeta(1))).toBe(1);
    expect(row("a").text_content).toBe("ocr");
  });
});

describe("R2 — the text-layer write only fills a NULL column", () => {
  it("does not overwrite OCR text with a stale empty result", () => {
    insert("a", "application/pdf", "/p/a", "ocr text", JSON.stringify({ textSource: "ocr" }), "2026-01-01");
    expect(setAttachmentTextContent("a", "")).toBe(0);
    expect(row("a").text_content).toBe("ocr text");
  });

  it("still fills a NULL column", () => {
    insert("a", "application/pdf", "/p/a", null, null, "2026-01-01");
    expect(setAttachmentTextContent("a", "x")).toBe(1);
    expect(row("a").text_content).toBe("x");
  });
});

describe("R3 — retryable errors stay pending until the attempts bound", () => {
  it.each([
    [1, true],
    [OCR_MAX_ATTEMPTS - 1, true],
    [OCR_MAX_ATTEMPTS, false],
    [OCR_MAX_ATTEMPTS + 1, false],
  ])("attempts=%i -> pending=%s", (attempts, pending) => {
    insert("a", "application/pdf", "/p/a", "", errorMeta(attempts), "2026-01-01");
    expect(pendingIds().includes("a")).toBe(pending);
  });

  it("a non-retryable parked reason is never pending", () => {
    insert("a", "application/pdf", "/p/a", "", JSON.stringify({ textSource: "none", reason: "unreadable" }), "2026-01-01");
    expect(pendingIds()).toEqual([]);
  });
});
