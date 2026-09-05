/**
 * DIFFERENTIAL pin for `db/attachmentTextExtractionSql` — BACKLOG-2989 chunk 3.
 *
 * ## Why this suite is shaped differently from every other pin in this item
 *
 * These are the only two statements BACKLOG-2989 moves that deliberately
 * CHANGE. Everywhere else the control is a content hash proving the text is
 * byte-identical. Here the text had to change — the MIME types are now BOUND
 * rather than concatenated into the SQL, which is what removes the inverse
 * leak and deletes a service-side string-concatenation-into-SQL with no
 * escaping (see the module header for the full reasoning).
 *
 * So the control is REPLACED, not waived. The pre-move statement is
 * reconstructed below and executed against the SAME database as the new one,
 * and the two must return an identical exact ID SET — not an identical count,
 * which two different bugs can produce together.
 *
 * ## Provenance of the reconstruction
 *
 * `PRE_MOVE_PENDING_WHERE` is transcribed from
 * `electron/services/attachmentTextExtractionBackfillService.ts` at commit
 * `e157b2cf4` (the merge of BACKLOG-2989 PR 1, i.e. the tree before chunk 3),
 * with `${EXTRACTABLE_MIME_SQL_LIST}` expanded exactly as
 * `attachmentTextExtractionService.ts:64` built it — `map(m => `'${m}'`).join(", ")`
 * over `EXTRACTABLE_MIME_TYPES`. It is a transcription of a real producer's
 * output, not an invented fixture, and `reconstructsThePreMoveList` below
 * asserts the expansion still matches the live constant.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { EXTRACTABLE_MIME_TYPES } from "../../attachmentTextExtractionService";
import {
  preparePendingCount,
  preparePendingPage,
  type TextExtractionQueryable,
} from "../attachmentTextExtractionSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");

/** How `attachmentTextExtractionService.ts:64` built the fragment at e157b2cf4. */
const preMoveMimeList = (): string =>
  EXTRACTABLE_MIME_TYPES.map((m) => `'${m}'`).join(", ");

/** The pre-move WHERE, transcribed from e157b2cf4. */
const PRE_MOVE_PENDING_WHERE = `
  FROM attachments
  WHERE storage_path IS NOT NULL
    AND text_content IS NULL
    AND mime_type IN (${preMoveMimeList()})
`;

const PRE_MOVE_COUNT_SQL = `SELECT COUNT(*) AS n ${PRE_MOVE_PENDING_WHERE}`;
const PRE_MOVE_PAGE_SQL = `SELECT id, storage_path, mime_type ${PRE_MOVE_PENDING_WHERE}
         ORDER BY created_at DESC
         LIMIT ?`;

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;
let q: TextExtractionQueryable;

/** Every branch of the WHERE clause gets a row, present and absent. */
function seedAllBranches(): void {
  const ins = db.prepare(
    `INSERT INTO attachments (id, message_id, filename, mime_type, storage_path, text_content, created_at)
     VALUES (?, 'm1', ?, ?, ?, ?, ?)`,
  );
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, body_text) VALUES ('m1', 'u1', 'imessage', 'b')`,
  ).run();

  // WANTED — one per extractable type, so a dropped type is visible.
  ins.run("w-pdf", "1.pdf", "application/pdf", "/p/1.pdf", null, "2026-01-01");
  ins.run("w-txt", "2.txt", "text/plain", "/p/2.txt", null, "2026-02-01");
  ins.run("w-csv", "3.csv", "text/csv", "/p/3.csv", null, "2026-03-01");

  // EXCLUDED, one per predicate.
  ins.run("x-nofile", "4.pdf", "application/pdf", null, null, "2026-04-01");        // storage_path IS NULL
  ins.run("x-done", "5.pdf", "application/pdf", "/p/5.pdf", "text", "2026-05-01");  // text_content set
  ins.run("x-empty", "6.pdf", "application/pdf", "/p/6.pdf", "", "2026-06-01");     // extracted-but-empty
  ins.run("x-type", "7.png", "image/png", "/p/7.png", null, "2026-07-01");          // not extractable
  ins.run("x-nomime", "8.bin", null, "/p/8.bin", null, "2026-08-01");               // NULL mime
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-textext-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u1', 'a@b.test', 'google', 'o1')`,
  ).run();
  q = db as unknown as TextExtractionQueryable;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the reconstruction is faithful", () => {
  it("reconstructsThePreMoveList — the expansion still matches the live capability list", () => {
    // If EXTRACTABLE_MIME_TYPES ever changes, this test's reconstruction moves
    // with it rather than silently comparing against a stale fixture.
    expect(preMoveMimeList()).toBe("'application/pdf', 'text/plain', 'text/csv'");
    expect(PRE_MOVE_PENDING_WHERE).toContain("mime_type IN ('application/pdf', 'text/plain', 'text/csv')");
  });
});

describe("differential: bound parameters select exactly what interpolation did", () => {
  it("returns the identical exact ID SET, across every branch of the WHERE", () => {
    seedAllBranches();

    const before = (db.prepare(PRE_MOVE_PAGE_SQL).all(100) as Array<{ id: string }>).map((r) => r.id);
    const after = (
      preparePendingPage(q, EXTRACTABLE_MIME_TYPES).all(
        ...EXTRACTABLE_MIME_TYPES,
        100,
      ) as Array<{ id: string }>
    ).map((r) => r.id);

    // Identity, not count: two offsetting errors produce the same length.
    expect(after).toEqual(before);
    expect(after.sort()).toEqual(["w-csv", "w-pdf", "w-txt"]);
  });

  it("returns the identical count", () => {
    seedAllBranches();

    const before = (db.prepare(PRE_MOVE_COUNT_SQL).get() as { n: number }).n;
    const after = (
      preparePendingCount(q, EXTRACTABLE_MIME_TYPES).get(...EXTRACTABLE_MIME_TYPES) as { n: number }
    ).n;

    expect(after).toBe(before);
    expect(after).toBe(3);
  });

  it("orders newest first, identically to the pre-move statement", () => {
    seedAllBranches();

    const before = (db.prepare(PRE_MOVE_PAGE_SQL).all(2) as Array<{ id: string }>).map((r) => r.id);
    const after = (
      preparePendingPage(q, EXTRACTABLE_MIME_TYPES).all(
        ...EXTRACTABLE_MIME_TYPES,
        2,
      ) as Array<{ id: string }>
    ).map((r) => r.id);

    expect(after).toEqual(before);
    expect(after).toEqual(["w-csv", "w-txt"]);
  });

  it("agrees on an empty table", () => {
    const before = (db.prepare(PRE_MOVE_COUNT_SQL).get() as { n: number }).n;
    const after = (
      preparePendingCount(q, EXTRACTABLE_MIME_TYPES).get(...EXTRACTABLE_MIME_TYPES) as { n: number }
    ).n;
    expect(after).toBe(before);
    expect(after).toBe(0);
  });
});

describe("an empty MIME list is refused rather than silently matching nothing", () => {
  it("SQLite really does accept IN () and evaluate it false — measured, not assumed", () => {
    // This is the hazard the guard exists for, demonstrated on the real driver
    // so the guard is justified by behaviour rather than by belief.
    db.exec("CREATE TABLE probe (id TEXT, mime TEXT)");
    db.prepare("INSERT INTO probe VALUES ('a', 'application/pdf')").run();

    expect(db.prepare("SELECT id FROM probe WHERE mime IN ()").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM probe WHERE mime IN ()").get()).toEqual({ n: 0 });
  });

  it("throws instead of building IN ()", () => {
    // Without this, an empty capability list makes the backfill report
    // totalPending: 0 and return successfully having examined nothing — a
    // silent no-op indistinguishable from a clean run.
    expect(() => preparePendingCount(q, [])).toThrow(/mimeTypes is empty/);
    expect(() => preparePendingPage(q, [])).toThrow(/mimeTypes is empty/);
  });

  it("works with a single type — the IN list is built from the list's length", () => {
    seedAllBranches();
    const ids = (
      preparePendingPage(q, ["text/csv"]).all("text/csv", 100) as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(["w-csv"]);
  });
});
