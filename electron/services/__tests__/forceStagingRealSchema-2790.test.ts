/**
 * @jest-environment node
 *
 * BACKLOG-2790 — the staging-DDL derivation, run against the REAL schema.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM `forceStaging-2790.test.ts`
 * ---------------------------------------------------------------------------
 * Adopted from the SR review of PR #2344, which found the gap and is the reason
 * it is closed: every other suite exercises `deriveStagingTableDdl` against a
 * hand-reduced schema — seven columns in the unit suite, sixteen in the
 * real-driver ones. Production `messages` is 37 columns, 2 foreign keys, 13
 * named indexes, 7 CHECKs and 3 DEFAULTs; `attachments` is 15 / 2 / 2 / 3 / 1.
 * The FK-stripping regexes had never been run over that text.
 *
 * A hand-written fixture cannot find this class of defect, because the fixture
 * is written by the same person who wrote the regex and contains the constructs
 * they were thinking of. So the inputs here are not fixtures at all — they are
 * the schema the app actually ships (`electron/database/schema.sql`) and a
 * genuinely different historical shape produced by the migration chain
 * (`fixtures/schema-2026-01-26-5cec24486.sql`, which has 12 message indexes
 * rather than 13). What this catches is the future migration that adds a
 * construct the regexes mishandle — a column-level `REFERENCES`, a
 * `DEFERRABLE` clause, a generated column — which would otherwise surface as a
 * failed re-import on a user's machine.
 *
 * MUTATIONS THAT MAKE IT RED (re-run by the engineer at adoption, and by the SR
 * before recommending it):
 *   - disable FK stripping in `deriveStagingTableDdl` -> 22 unexpected foreign
 *     key entries across the two tables;
 *   - skip the index mirroring in `forceStagingLifecycle.create` -> Expected 13
 *     / Received 0 against the production schema, Expected 12 / Received 0
 *     against the migrated fixture.
 */

import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import {
  forceStagingLifecycle,
  swapStagingIntoLive,
} from "../macOSMessagesImportService/forceStaging";

type Col = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

const PRODUCTION_SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const MIGRATED_FIXTURE = nodePath.join(
  __dirname,
  "fixtures",
  "schema-2026-01-26-5cec24486.sql",
);

function loadSchema(db: DatabaseType, sqlPath: string): void {
  // Foreign keys are off only while the schema loads: the file creates tables in
  // an order that references some of them before they exist, exactly as the real
  // migration runner does.
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(sqlPath, "utf8"));
  db.pragma("foreign_keys = ON");
}

/** Everything worth comparing between a live table and its staging clone. */
function describeTablePair(db: DatabaseType, live: string, staging: string) {
  const columnIdentity = (rows: Col[]) =>
    rows.map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
  const checkCount = (name: string) => {
    const { sql } = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = ?`)
      .get(name) as { sql: string };
    return (sql.match(/\bCHECK\s*\(/gi) || []).length;
  };
  const indexCount = (name: string) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master
           WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
        )
        .get(name) as { c: number }
    ).c;

  return {
    liveColumns: columnIdentity(db.prepare(`PRAGMA table_info(${live})`).all() as Col[]),
    stagingColumns: columnIdentity(
      db.prepare(`PRAGMA table_info("${staging}")`).all() as Col[],
    ),
    liveForeignKeys: db.prepare(`PRAGMA foreign_key_list(${live})`).all(),
    stagingForeignKeys: db.prepare(`PRAGMA foreign_key_list("${staging}")`).all(),
    liveChecks: checkCount(live),
    stagingChecks: checkCount(staging),
    liveIndexes: indexCount(live),
    stagingIndexes: indexCount(staging),
  };
}

/**
 * Insert a `users_local` row without hard-coding that table's shape — it is not
 * what these tests are about, and a migration that adds a NOT NULL column to it
 * should not turn this suite red for the wrong reason.
 */
function insertUser(db: DatabaseType, id: string): void {
  const required = (db.prepare(`PRAGMA table_info(users_local)`).all() as Col[]).filter(
    (c) => c.pk === 1 || (c.notnull === 1 && c.dflt_value === null),
  );
  db.prepare(
    `INSERT INTO users_local (${required.map((c) => `"${c.name}"`).join(", ")})
     VALUES (${required.map(() => "?").join(", ")})`,
  ).run(
    ...required.map((c) =>
      c.name === "id" ? id : c.name === "oauth_provider" ? "google" : `x-${id}`,
    ),
  );
}

describe.each([
  ["the production schema.sql", PRODUCTION_SCHEMA],
  ["a migrated shape from 2026-01-26", MIGRATED_FIXTURE],
])("BACKLOG-2790 — staging derived from %s", (_label, sqlPath) => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSchema(db, sqlPath);
  });

  afterEach(() => {
    db?.close();
  });

  it("mirrors columns, defaults, CHECKs and indexes, and drops the foreign keys", () => {
    const staging = forceStagingLifecycle.create(db, "u1");

    for (const [live, stagingTable] of [
      ["messages", staging.messagesTable],
      ["attachments", staging.attachmentsTable],
    ] as const) {
      const pair = describeTablePair(db, live, stagingTable);

      // Column IDENTITY, not column count: name, declared type, NOT NULL, the
      // DEFAULT expression and the primary-key position, in order. A staging
      // table that agreed on names and disagreed on a default is the failure
      // this whole derivation exists to avoid.
      expect(pair.stagingColumns).toEqual(pair.liveColumns);

      // Foreign keys stripped — and the live table really had some, or the
      // assertion above it would be vacuous.
      expect(pair.stagingForeignKeys).toEqual([]);
      expect(pair.liveForeignKeys.length).toBeGreaterThan(0);

      // CHECKs kept: they constrain the ROWS, and the rows are the same rows.
      expect(pair.stagingChecks).toBe(pair.liveChecks);

      // Every named index mirrored, not just the unique one dedup depends on.
      expect(pair.stagingIndexes).toBe(pair.liveIndexes);
      expect(pair.liveIndexes).toBeGreaterThan(0);
    }

    staging.drop();
  });

  it("a swap carries DEFAULT-supplied values into live, not NULLs", () => {
    // The reason the DDL is derived rather than built with
    // `CREATE TABLE … AS SELECT * … WHERE 0`, checked end to end on the real
    // column set: the import names a fraction of the columns and lets the table
    // supply the rest, and those supplied values have to survive the swap.
    insertUser(db, "u1");
    const staging = forceStagingLifecycle.create(db, "u1");

    db.prepare(
      `INSERT INTO "${staging.messagesTable}"
         (id, user_id, channel, external_id, direction, body_text, sent_at)
       VALUES ('m1', 'u1', 'imessage', 'guid-1', 'inbound', 'hi', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO "${staging.attachmentsTable}"
         (id, message_id, external_message_id, filename)
       VALUES ('a1', 'm1', 'guid-1', 'p.jpg')`,
    ).run();

    const counts = swapStagingIntoLive(db, staging);
    expect(counts.messagesInserted).toBe(1);
    expect(counts.attachmentsInserted).toBe(1);

    const row = db
      .prepare(`SELECT has_attachments, is_false_positive, created_at FROM messages WHERE id = 'm1'`)
      .get() as { has_attachments: number; is_false_positive: number; created_at: string | null };

    expect(row.has_attachments).toBe(0);
    expect(row.is_false_positive).toBe(0);
    expect(row.created_at).not.toBeNull();

    staging.drop();
  });
});

describe("BACKLOG-2790 — the force set's boundary, against the real schema", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSchema(db, PRODUCTION_SCHEMA);
    insertUser(db, "u1");
    insertUser(db, "u2");
  });

  afterEach(() => {
    db?.close();
  });

  it("spares ANOTHER user's rows, and this user's rows without an external_id", () => {
    // The half of the force set no other suite covers: `messages` is shared, so
    // the swap's DELETE has to be a strict subset of it. A predicate that
    // dropped the `user_id` term, or the `external_id IS NOT NULL` term, would
    // pass every cancellation test in the PR and quietly delete a stranger's
    // data on the SUCCESS path.
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id) VALUES ('mine','u1','imessage','g-1')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id) VALUES ('theirs','u2','imessage','g-2')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, user_id, channel, external_id) VALUES ('mine-null','u1','imessage',NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO attachments (id, message_id, external_message_id, filename)
       VALUES ('a-theirs','theirs','g-2','t.jpg')`,
    ).run();

    const staging = forceStagingLifecycle.create(db, "u1");
    db.prepare(
      `INSERT INTO "${staging.messagesTable}" (id, user_id, channel, external_id)
       VALUES ('new','u1','imessage','g-1')`,
    ).run();
    swapStagingIntoLive(db, staging);
    staging.drop();

    // Exact ID sets, both tables.
    expect(
      (db.prepare(`SELECT id FROM messages ORDER BY id`).all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual(["mine-null", "new", "theirs"]);
    expect(
      (db.prepare(`SELECT id FROM attachments ORDER BY id`).all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual(["a-theirs"]);
  });

  it("shows what the `changes > 0` guard prevents: a phantom id fails the SWAP, not one attachment", () => {
    // The hazard behind the hardening in `storeMessages`. Reproduced by writing
    // staging the way the code did BEFORE the guard — mapping a GUID to an id
    // whose `INSERT OR IGNORE` was ignored — and running the real swap.
    //
    // Under the old long-transaction design the same phantom hit a per-row
    // FOREIGN KEY error that the attachment loop swallowed as `skipped++`.
    // Staging is FK-free, so the bad row survives the rebuild and the whole swap
    // throws instead: one skipped attachment would have become a failed
    // re-import. The store is intact either way, which is the second assertion.
    const staging = forceStagingLifecycle.create(db, "u1");
    const insert = db.prepare(
      `INSERT OR IGNORE INTO "${staging.messagesTable}" (id, user_id, channel, external_id)
       VALUES (?, ?, ?, ?)`,
    );

    expect(insert.run("m-a", "u1", "imessage", "dup-guid").changes).toBe(1);
    // The same GUID again: the mirrored partial unique index makes this a silent
    // no-op, which is precisely why the id it was given must not be remembered.
    expect(insert.run("m-b", "u1", "imessage", "dup-guid").changes).toBe(0);

    db.prepare(
      `INSERT INTO "${staging.attachmentsTable}" (id, message_id, external_message_id, filename)
       VALUES ('a-x','m-b','dup-guid','p.jpg')`,
    ).run();

    expect(() => swapStagingIntoLive(db, staging)).toThrow(/FOREIGN KEY/i);
    // The swap that threw changed nothing.
    expect(db.prepare(`SELECT COUNT(*) AS c FROM messages`).get()).toEqual({ c: 0 });

    staging.drop();
  });
});
