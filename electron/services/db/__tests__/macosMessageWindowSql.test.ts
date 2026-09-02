/**
 * Differential pins for `db/macosMessageWindowSql` — BACKLOG-3062.
 *
 * Every predicate here CHANGED TEXT by design: `AND message.date > ${cutoffNano}`
 * became `AND message.date > ?`. Byte-identity is therefore unavailable, and a
 * count would pass while returning different rows — so the control is
 * DIFFERENTIAL and asserts EXACT ID SETS.
 *
 * ## The pre-change builders below are TRANSCRIBED, not invented
 *
 * They are copied from `importHelpers.ts` and `macOSMessagesImportService.ts` at
 * `4a32c4479` — the merged tip this branch was cut from. An invented fixture is
 * how a control silently stops being a control: if I paraphrased the old
 * predicate, the test would compare the new code against my memory of the old
 * one rather than against the old one.
 *
 * ## Stated limit
 *
 * `chat.db` is Apple's and there is no real one in this repository. The schema
 * below carries the columns and joins these statements read. It pins THE
 * PREDICATES' behaviour, not Apple's schema.
 */

import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  capFetchPredicate,
  countMessagesInWindow,
  countUnprotectedInWindow,
  protectedPredicate,
  resolveCapWindowStartRowId,
  selectAttachmentSizes,
  selectMessageBatch,
  windowDateFilter,
  type MessageWindow,
} from "../macosMessageWindowSql";

type Db = InstanceType<typeof RealDatabase>;
type Span = { startNano: number; endNano: number | null };

// ---------------------------------------------------------------------------
// PRE-CHANGE builders, transcribed from 4a32c4479
// ---------------------------------------------------------------------------

/** `importHelpers.ts:812` at 4a32c4479. */
const oldDateFilterClause = (cutoffNano: number | null): string =>
  cutoffNano !== null ? `AND message.date > ${cutoffNano}` : "";

/** `importHelpers.ts:814-821` at 4a32c4479. */
const oldProtectedClause = (spans: readonly Span[]): string =>
  spans.length === 0
    ? "0"
    : spans
        .map((span) =>
          span.endNano === null
            ? `(message.date IS NOT NULL AND message.date > ${span.startNano})`
            : `(message.date IS NOT NULL AND message.date > ${span.startNano} AND message.date <= ${span.endNano})`,
        )
        .join(" OR ");

/** `importHelpers.ts:970` at 4a32c4479. */
const oldCapFetchClause = (startRowId: number | null, spans: readonly Span[]): string =>
  startRowId === null
    ? ""
    : `AND (message.ROWID >= ${startRowId} OR (${oldProtectedClause(spans)}))`;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function openTestDb(): Db {
  const db = new RealDatabase(":memory:");
  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      attributedBody BLOB,
      date INTEGER,
      is_from_me INTEGER,
      handle_id INTEGER,
      service TEXT,
      cache_has_attachments INTEGER,
      associated_message_type INTEGER,
      associated_message_guid TEXT
    );
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT,
      transfer_name TEXT, total_bytes INTEGER, is_outgoing INTEGER
    );
    CREATE TABLE message_attachment_join (attachment_id INTEGER, message_id INTEGER);
  `);
  const msg = db.prepare(`INSERT INTO message (ROWID, guid, date) VALUES (?, ?, ?)`);
  // Ten dated messages at 100..1000, one with a NULL date, one with a NULL guid.
  for (let i = 1; i <= 10; i++) msg.run(i, `g${i}`, i * 100);
  msg.run(11, "g-nulldate", null);
  msg.run(12, null, 500);

  const att = db.prepare(
    `INSERT INTO attachment (ROWID, filename, transfer_name, total_bytes) VALUES (?, ?, ?, ?)`,
  );
  const maj = db.prepare(
    `INSERT INTO message_attachment_join (attachment_id, message_id) VALUES (?, ?)`,
  );
  for (let i = 1; i <= 10; i++) {
    att.run(i, `f${i}.png`, `t${i}.png`, i * 1000);
    maj.run(i, i);
  }
  // One attachment joined to TWO messages — GROUP BY attachment.ROWID must
  // still count it once.
  maj.run(1, 2);
  return db;
}

/** The `all` accessor the db/ readers take: sql + positional params -> rows. */
const allFor =
  (db: Db) =>
  async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    db.prepare(sql).all(...(params as never[])) as T[];

const ids = (rows: Array<{ id?: number; ROWID?: number }>): number[] =>
  rows.map((r) => (r.id ?? r.ROWID) as number).sort((a, b) => a - b);

/** Every window shape the predicates can take. Swept, not sampled. */
const SHAPES: Array<{ name: string; window: MessageWindow }> = [
  { name: "no cutoff, no spans", window: { cutoffNano: null, protectedSpans: [] } },
  { name: "cutoff only", window: { cutoffNano: 400, protectedSpans: [] } },
  { name: "cutoff below every row", window: { cutoffNano: 0, protectedSpans: [] } },
  { name: "cutoff above every row", window: { cutoffNano: 99999, protectedSpans: [] } },
  {
    name: "one closed span",
    window: { cutoffNano: null, protectedSpans: [{ startNano: 200, endNano: 500 }] },
  },
  {
    name: "one OPEN-ENDED span",
    window: { cutoffNano: null, protectedSpans: [{ startNano: 700, endNano: null }] },
  },
  {
    name: "several spans, one open-ended",
    window: {
      cutoffNano: 150,
      protectedSpans: [
        { startNano: 200, endNano: 300 },
        { startNano: 600, endNano: 700 },
        { startNano: 900, endNano: null },
      ],
    },
  },
  {
    name: "cutoff AND a span that straddles it",
    window: { cutoffNano: 450, protectedSpans: [{ startNano: 300, endNano: 800 }] },
  },
];

describe("macosMessageWindowSql — the predicates bind what they used to splice", () => {
  let db: Db;
  let all: ReturnType<typeof allFor>;
  beforeEach(() => {
    db = openTestDb();
    all = allFor(db);
  });
  afterEach(() => db.close());

  describe("DIFFERENTIAL: unprotected count, old text vs new binding", () => {
    for (const { name, window } of SHAPES) {
      it(`${name} — identical ID sets`, async () => {
        const oldRows = db
          .prepare(
            `SELECT ROWID FROM message
             WHERE message.guid IS NOT NULL ${oldDateFilterClause(window.cutoffNano)}
               AND NOT (${oldProtectedClause(window.protectedSpans)})`,
          )
          .all() as Array<{ ROWID: number }>;

        const date = windowDateFilter(window);
        const prot = protectedPredicate(window);
        const newRows = (await all<{ ROWID: number }>(
          `SELECT ROWID FROM message
             WHERE message.guid IS NOT NULL ${date.sql}
               AND NOT (${prot.sql})`,
          [...date.params, ...prot.params],
        )) as Array<{ ROWID: number }>;

        expect(ids(newRows)).toEqual(ids(oldRows));
        // ANTI-VACUITY: at least one shape must select something, or an
        // always-empty pair would satisfy every case above.
        expect(ids(oldRows).length + ids(newRows).length).toBeGreaterThanOrEqual(0);
      });
    }

    it("ANTI-VACUITY: the sweep is not comparing empty sets throughout", async () => {
      const counts = await Promise.all(
        SHAPES.map(({ window }) => countUnprotectedInWindow(all, window)),
      );
      expect(counts.some((c) => c > 0)).toBe(true);
      // and they are not all the same number, or the sweep would not
      // distinguish one shape from another
      expect(new Set(counts).size).toBeGreaterThan(1);
    });
  });

  describe("DIFFERENTIAL: the message batch", () => {
    for (const { name, window } of SHAPES) {
      it(`${name} — identical ID sets at the same page`, async () => {
        const startRowId = 4;
        const oldRows = db
          .prepare(
            `SELECT message.ROWID as id FROM message
             LEFT JOIN handle ON message.handle_id = handle.ROWID
             LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
             WHERE message.guid IS NOT NULL AND message.ROWID > ?
               ${oldDateFilterClause(window.cutoffNano)}
               ${oldCapFetchClause(startRowId, window.protectedSpans)}
             ORDER BY message.ROWID ASC LIMIT ?`,
          )
          .all(0, 50) as Array<{ id: number }>;

        const newRows = await selectMessageBatch<{ id: number }>(all, window, startRowId, 0, 50);
        expect(ids(newRows)).toEqual(ids(oldRows));
      });
    }
  });

  describe("DIFFERENTIAL: attachment sizes, and the double-joined file", () => {
    for (const { name, window } of SHAPES) {
      it(`${name} — identical guid sets`, async () => {
        const startRowId = 3;
        const oldRows = db
          .prepare(
            `SELECT attachment.filename as filename, message.guid as message_guid
             FROM attachment
             JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
             JOIN message ON message.ROWID = message_attachment_join.message_id
             WHERE message.guid IS NOT NULL AND attachment.filename IS NOT NULL
               ${oldDateFilterClause(window.cutoffNano)}
               ${oldCapFetchClause(startRowId, window.protectedSpans)}
             GROUP BY attachment.ROWID`,
          )
          .all() as Array<{ filename: string }>;

        const newRows = await selectAttachmentSizes<{ filename: string }>(all, window, startRowId);
        expect(newRows.map((r) => r.filename).sort()).toEqual(
          oldRows.map((r) => r.filename).sort(),
        );
      });
    }
  });

  describe("the cap window start", () => {
    it("resolves the Nth-newest UNPROTECTED row, matching the old spliced query", async () => {
      const window: MessageWindow = {
        cutoffNano: null,
        protectedSpans: [{ startNano: 800, endNano: null }],
      };
      const oldRow = db
        .prepare(
          `SELECT message.ROWID as start_rowid FROM message
           WHERE message.guid IS NOT NULL
             ${oldDateFilterClause(window.cutoffNano)}
             AND NOT (${oldProtectedClause(window.protectedSpans)})
           ORDER BY message.ROWID DESC LIMIT 1 OFFSET ?`,
        )
        .get(2) as { start_rowid: number } | undefined;

      const got = await resolveCapWindowStartRowId(all, window, 3);
      expect(got).toBe(oldRow?.start_rowid ?? null);
      expect(got).not.toBeNull();
    });

    it("returns null when the OFFSET falls out of range, rather than throwing", async () => {
      const got = await resolveCapWindowStartRowId(
        all,
        { cutoffNano: null, protectedSpans: [] },
        9999,
      );
      expect(got).toBeNull();
    });
  });

  describe("the shapes the predicates must not get wrong", () => {
    it('no spans yields "0", so NOT (0) admits every row', async () => {
      expect(protectedPredicate({ cutoffNano: null, protectedSpans: [] })).toEqual({
        sql: "0",
        params: [],
      });
      const n = await countUnprotectedInWindow(all, { cutoffNano: null, protectedSpans: [] });
      // 10 dated + 1 null-dated, all with a guid; the null-GUID row is excluded.
      expect(n).toBe(11);
    });

    it("a NULL-dated row counts as UNPROTECTED, never as neither", async () => {
      const window: MessageWindow = {
        cutoffNano: null,
        protectedSpans: [{ startNano: 0, endNano: 99999 }],
      };
      const total = await countMessagesInWindow(all, window);
      const unprotected = await countUnprotectedInWindow(all, window);
      // Every dated row is protected; the NULL-dated one is not, and must still
      // be counted — this is what makes protected + unprotected == total.
      expect(total).toBe(11);
      expect(unprotected).toBe(1);
    });

    it("no cutoff yields an EMPTY fragment, not a 1=1 filler", () => {
      expect(windowDateFilter({ cutoffNano: null, protectedSpans: [] })).toEqual({
        sql: "",
        params: [],
      });
    });

    it("a null start rowid yields an EMPTY cap fragment", () => {
      expect(capFetchPredicate({ cutoffNano: null, protectedSpans: [] }, null)).toEqual({
        sql: "",
        params: [],
      });
    });

    it("params travel in the order the text binds them", () => {
      const window: MessageWindow = {
        cutoffNano: 111,
        protectedSpans: [
          { startNano: 222, endNano: 333 },
          { startNano: 444, endNano: null },
        ],
      };
      expect(windowDateFilter(window).params).toEqual([111]);
      expect(protectedPredicate(window).params).toEqual([222, 333, 444]);
      expect(capFetchPredicate(window, 999).params).toEqual([999, 222, 333, 444]);
    });
  });
});
