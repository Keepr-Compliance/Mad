/**
 * @jest-environment node
 *
 * BACKLOG-2551 + BACKLOG-2839 — migration v71, against the REAL driver.
 *
 * WHY THE REAL DRIVER. Every claim v71 makes is a claim about SQLite's own
 * behaviour: that a partial unique index rejects a duplicate, that NULLs group
 * together, that ON DELETE SET NULL does not fire while foreign_keys is OFF, that
 * a CHECK is invisible to PRAGMA table_info. A mocked driver cannot answer any of
 * them, so a mocked test of this migration would be a fixture describing a state
 * the code cannot produce.
 *
 * THE FIXTURE is the frozen chain-v69 transcript + schema_version = 70 — the
 * transcript of what the real chain emitted, never derived from the post-change
 * schema.sql, so it cannot silently agree with the thing under test.
 *
 * EVERY FIXTURE ROW IS SYNTHETIC. This repo is public; no mailbox-derived data
 * appears here.
 */

import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { V71_SELECT_DUPLICATE_ATTACHMENTS_SQL } from "../db/migrationV71Sql";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const FROZEN = fs.readFileSync(
  path.join(__dirname, "fixtures", "chain-v69-schema.sql"),
  "utf8",
);

/** The v71 entry, read from the shipped chain rather than re-typed here. */
function v71(): { version: number; migrate: (d: DatabaseType) => void } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../databaseService").default;
  const chain = (svc.constructor as { MIGRATIONS: Array<{ version: number; migrate: (d: DatabaseType) => void }> })
    .MIGRATIONS;
  const entry = chain.find((m) => m.version === 71);
  if (!entry) throw new Error("v71 is not in DatabaseService.MIGRATIONS");
  return entry;
}

/** A v70 database: the frozen transcript, stamped at the baseline. */
function v70Fixture(): DatabaseType {
  const db = new RealDatabase(":memory:") as DatabaseType;
  db.exec(FROZEN);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             version INTEGER NOT NULL DEFAULT 1,
             updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
             migrated_at TEXT DEFAULT (datetime('now')));
           INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 70);
           INSERT INTO users_local (id, email, oauth_provider, oauth_id)
             VALUES ('u1', 'synthetic@example.test', 'google', 'oid-1');
           INSERT INTO emails (id, user_id) VALUES ('e1', 'u1');`);
  return db;
}

/** Run v71 exactly as the runner does: foreign_keys OFF, one transaction. */
function runV71(db: DatabaseType): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => v71().migrate(db))();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

const TRIMSET = "' '||char(9)||char(10)||char(13)||char(11)||char(12)||char(160)";

describe("migration v71 — BACKLOG-2551 attachments", () => {
  let db: DatabaseType;
  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
  });

  it("PRECONDITION: the v70 fixture has no provider_attachment_id and accepts the duplicate this migration exists to stop", () => {
    db = v70Fixture();
    const cols = (db.prepare("PRAGMA table_info(attachments)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).not.toContain("provider_attachment_id");

    // The defect, live: same email, same filename, twice, no complaint.
    db.exec(`INSERT INTO attachments (id, email_id, filename) VALUES ('x1','e1','image001.png')`);
    db.exec(`INSERT INTO attachments (id, email_id, filename) VALUES ('x2','e1','image001.png')`);
    expect(
      (db.prepare("SELECT COUNT(*) n FROM attachments WHERE email_id='e1'").get() as { n: number }).n,
    ).toBe(2);
  });

  it("CONTROL 2: the same (email_id, provider_attachment_id) twice collapses to ONE row", () => {
    db = v70Fixture();
    runV71(db);
    const ins = db.prepare(
      `INSERT INTO attachments (id, email_id, filename, provider_attachment_id)
       VALUES (?, 'e1', 'sig.png', 'PID-1')`,
    );
    ins.run("p1");
    expect(() => ins.run("p2")).toThrow(/UNIQUE constraint failed/);
    expect(
      (db.prepare("SELECT COUNT(*) n FROM attachments WHERE provider_attachment_id='PID-1'").get() as { n: number }).n,
    ).toBe(1);
  });

  it("CONTROL 1 (schema half): two SAME-NAMED attachments with different provider ids BOTH land", () => {
    db = v70Fixture();
    runV71(db);
    const ins = db.prepare(
      `INSERT INTO attachments (id, email_id, filename, provider_attachment_id) VALUES (?, 'e1', 'image001.png', ?)`,
    );
    ins.run("q1", "PID-A");
    ins.run("q2", "PID-B");
    expect(
      (db.prepare("SELECT COUNT(*) n FROM attachments WHERE email_id='e1' AND filename='image001.png'").get() as { n: number }).n,
    ).toBe(2);
  });

  it("legacy rows (NULL provider id) are EXCLUDED from the index, so nothing pre-existing collides", () => {
    db = v70Fixture();
    db.exec(`INSERT INTO attachments (id, email_id, filename) VALUES ('L1','e1','a.pdf'),('L2','e1','a.pdf')`);
    expect(() => runV71(db)).not.toThrow();
    // Both survive: same filename, but storage_path NULL on both, so not duplicates.
    expect((db.prepare("SELECT COUNT(*) n FROM attachments").get() as { n: number }).n).toBe(2);
    // And more NULL-provider rows can still be added.
    expect(() =>
      db.exec(`INSERT INTO attachments (id, email_id, filename) VALUES ('L3','e1','a.pdf')`),
    ).not.toThrow();
  });
});

describe("migration v71 — the dedup", () => {
  let db: DatabaseType;
  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
  });

  /**
   * Every column the dedup reads or writes, populated ASYMMETRICALLY between
   * keeper and loser — the discipline three separate data-loss defects were
   * hiding behind. Five triple cases, and a multi-loser group.
   */
  function seedDedupFixture(d: DatabaseType): void {
    const ins = d.prepare(
      `INSERT INTO attachments (id,email_id,filename,storage_path,mime_type,file_size_bytes,
         external_message_id,text_content,analysis_metadata,sync_session_id,
         document_type,document_type_confidence,document_type_source)
       VALUES (@id,'e1',@fn,@sp,@mt,@sz,@ext,@txt,@am,@sess,@dt,@dc,@ds)`,
    );
    const R = (o: Record<string, unknown>) =>
      ins.run({ mt: null, sz: null, ext: null, txt: null, am: null, sess: null, dt: null, dc: null, ds: null, ...o });

    // NULL storage_path: three DISTINCT metadata-only rows that must all survive.
    R({ id: "m1", fn: "one.pdf", sp: null });
    R({ id: "m2", fn: "two.pdf", sp: null });
    R({ id: "m3", fn: "three.pdf", sp: null });
    // Different files, same name: both survive.
    R({ id: "sameA", fn: "image001.png", sp: "/h/BBB.png" });
    R({ id: "sameB", fn: "image001.png", sp: "/h/CCC.png" });
    // k1 — keeper holds a MACHINE guess, loser holds the HUMAN correction.
    R({ id: "k1", fn: "a.pdf", sp: "/h/AAA.pdf", dt: "offer", dc: 0.55, ds: "pattern" });
    R({ id: "l1", fn: "a.pdf", sp: "/h/AAA.pdf", dt: "contract", dc: 0.99, ds: "user",
        mt: "application/pdf", sz: 4242, ext: "EXT-9", txt: "OCR TEXT", am: '{"k":1}', sess: "sess-7" });
    // k2 — keeper has no classification at all.
    R({ id: "k2", fn: "b.pdf", sp: "/h/DDD.pdf" });
    R({ id: "l2", fn: "b.pdf", sp: "/h/DDD.pdf", dt: "inspection", dc: 0.8, ds: "pattern", sess: "sess-7" });
    // k3 — keeper is the HUMAN; a machine guess must not displace it.
    R({ id: "k3", fn: "c.pdf", sp: "/h/EEE.pdf", dt: "contract", dc: 0.9, ds: "user" });
    R({ id: "l3", fn: "c.pdf", sp: "/h/EEE.pdf", dt: "offer", dc: 0.4, ds: "pattern" });
    // k4 — both 'user': the earlier row (MIN rowid) wins.
    R({ id: "k4", fn: "d.pdf", sp: "/h/FFF.pdf", dt: "contract", dc: 0.9, ds: "user" });
    R({ id: "l4", fn: "d.pdf", sp: "/h/FFF.pdf", dt: "addendum", dc: 0.7, ds: "user" });
    // k5 — keeper has a document_type with a NULL source. Reachable: the column is
    // nullable and its CHECK only constrains non-NULL values. The human wins.
    R({ id: "k5", fn: "e.pdf", sp: "/h/GGG.pdf", dt: "offer", dc: 0.5, ds: null });
    R({ id: "l5", fn: "e.pdf", sp: "/h/GGG.pdf", dt: "contract", dc: 0.95, ds: "user" });
    // MULTI-LOSER group: one keeper, two losers. A two-row group never exercises
    // the loop, and with two 'user' losers the survivor is order-dependent unless
    // the losers query orders by rowid.
    R({ id: "uk", fn: "f.pdf", sp: "/h/HHH.pdf", dt: "offer", dc: 0.3, ds: "pattern" });
    R({ id: "ul1", fn: "f.pdf", sp: "/h/HHH.pdf", dt: "contract", dc: 0.9, ds: "user", txt: "TEXT-A" });
    R({ id: "ul2", fn: "f.pdf", sp: "/h/HHH.pdf", dt: "addendum", dc: 0.7, ds: "user", txt: "TEXT-B" });

    d.exec(`INSERT INTO classification_feedback (id,user_id,attachment_id,feedback_type)
            VALUES ('f1','u1','l1','document_type')`);
  }

  const row = (d: DatabaseType, id: string) =>
    d.prepare(
      `SELECT id, document_type dt, document_type_confidence dc, document_type_source ds,
              mime_type mt, text_content tc, analysis_metadata am, external_message_id ext,
              file_size_bytes sz, sync_session_id sess
         FROM attachments WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined;

  // NOTE ON A CONTROL THAT CANNOT GO RED: removing `WHERE storage_path IS NOT NULL`
  // from the dedup leaves this suite fully green. Measured, not assumed — the query
  // joins on `keeper.storage_path = loser.storage_path`, and NULL never equals
  // NULL, so metadata-only rows are excluded by the join itself. The predicate is
  // defence in depth against the other natural spelling (GROUP BY, which DOES
  // collapse NULLs). This test still earns its place: it pins that m1/m2/m3 survive,
  // so a rewrite to GROUP BY without the guard would fail here.
  it("CONTROL 3: keeps exactly the right rows — metadata-only rows survive, same name never merges", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);

    const ids = (db.prepare("SELECT id FROM attachments ORDER BY id").all() as Array<{ id: string }>)
      .map((r) => r.id);
    // Losers gone; every keeper and every non-duplicate alive. An exact SET, not a count.
    expect(ids.sort()).toEqual(
      ["k1", "k2", "k3", "k4", "k5", "m1", "m2", "m3", "sameA", "sameB", "uk"].sort(),
    );
  });

  it("CONTROL 3: the five descriptive columns are coalesced onto the survivor", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    expect(row(db, "k1")).toMatchObject({
      mt: "application/pdf",
      sz: 4242,
      ext: "EXT-9",
      tc: "OCR TEXT",
      am: '{"k":1}',
    });
  });

  it("CONTROL 3 (k1): a HUMAN classification is never destroyed by a machine guess", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    expect(row(db, "k1")).toMatchObject({ dt: "contract", dc: 0.99, ds: "user" });
  });

  it("CONTROL 3 (k2): a keeper with no classification takes the loser's", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    expect(row(db, "k2")).toMatchObject({ dt: "inspection", ds: "pattern" });
  });

  it("CONTROL 3 (k3): a machine guess does NOT displace the keeper's human classification", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    expect(row(db, "k3")).toMatchObject({ dt: "contract", dc: 0.9, ds: "user" });
  });

  it("CONTROL 3 (k4): two 'user' rows — the earlier correction wins", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    expect(row(db, "k4")).toMatchObject({ dt: "contract", ds: "user" });
  });

  it("CONTROL 3 (k5): a keeper whose document_type has a NULL source yields to the human", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    expect(row(db, "k5")).toMatchObject({ dt: "contract", dc: 0.95, ds: "user" });
  });

  it("CONTROL 3: the classification triple is never half-set", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    const half = db.prepare(
      `SELECT COUNT(*) n FROM attachments
        WHERE (document_type IS NULL) <> (document_type_source IS NULL)
           OR (document_type IS NULL) <> (document_type_confidence IS NULL)`,
    ).get() as { n: number };
    expect(half.n).toBe(0);
  });

  it("CONTROL 3 (multi-loser): the survivor is deterministic — earliest loser wins, in rowid order", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    // ul1 precedes ul2 by rowid; both are 'user', so whichever the loop reaches
    // first wins and the other's triple is refused by the precedence guard.
    //
    // WHAT THIS CONTROL CAN AND CANNOT SEE (SR review af45b174 §2). It reds when
    // the order is REVERSED (ORDER BY ... DESC -> survivor becomes 'addendum'), so
    // it does discriminate direction. It does NOT red when the clause is DELETED:
    // on a plain table scan SQLite happens to return ascending rowid anyway, so
    // the assertion passes through the exact removal it is named for. The missing
    // property is not "this run came out ascending" but "the statement is not free
    // to choose", and no single execution can observe that. The control below
    // covers it on the statement itself.
    expect(row(db, "uk")).toMatchObject({ dt: "contract", dc: 0.9, ds: "user", tc: "TEXT-A" });
  });

  describe("the losers query is deterministic by construction", () => {
    // Asserting on SQL text is normally the weak instrument -- an earlier control
    // in this PR matched the word "unlinks" in its own comment prose and was
    // replaced with a behavioural one. It is the RIGHT instrument here, for a
    // reason that does not apply there: determinism is a property of the
    // STATEMENT, not of an execution. A run that comes out ordered proves nothing
    // about whether the engine was obliged to order it. And this is no longer a
    // scan of a function body -- the statement is a named exported constant with
    // its own contract, so this reads that contract.
    it("specifies ORDER BY loser.rowid, so two 'user' losers cannot resolve differently on two machines", () => {
      const sql = V71_SELECT_DUPLICATE_ATTACHMENTS_SQL;
      expect(sql).toMatch(/ORDER\s+BY\s+loser\.rowid/i);
      // Ascending, explicitly: DESC would make the LATEST correction win, which is
      // the opposite of the documented "earliest wins" rule and of the keeper's own
      // MIN(rowid) selection.
      expect(sql).not.toMatch(/ORDER\s+BY\s+loser\.rowid\s+DESC/i);
      // And the keeper is chosen by the same rule, so keeper and losers agree.
      expect(sql).toMatch(/MIN\(k\.rowid\)/);
    });

    it("returns a multi-loser group in ascending rowid order", () => {
      db = v70Fixture();
      seedDedupFixture(db);
      const losers = db
        .prepare(V71_SELECT_DUPLICATE_ATTACHMENTS_SQL)
        .all() as Array<{ loser: string; keep: string }>;
      const multi = losers.filter((l) => l.keep === "uk").map((l) => l.loser);
      expect(multi).toEqual(["ul1", "ul2"]); // insertion order == rowid order
      // Every loser resolves to exactly one keeper, and never to itself.
      expect(losers.every((l) => l.loser !== l.keep)).toBe(true);
    });
  });

  it("CONTROL 3: sync_session_id is NOT copied — a keeper is never enrolled in a session it was not part of", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    // Latent today (no writer sets it on an email row) but load-bearing: the column
    // drives deleteAttachmentsBySessionId, which returns storage_paths the caller
    // then unlinks from disk.
    const n = (db.prepare("SELECT COUNT(*) n FROM attachments WHERE sync_session_id IS NOT NULL").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("CONTROL 3: classification_feedback is re-pointed to the survivor, leaving no dangling attachment reference", () => {
    db = v70Fixture();
    seedDedupFixture(db);
    runV71(db);
    expect(
      (db.prepare("SELECT attachment_id FROM classification_feedback WHERE id='f1'").get() as { attachment_id: string }).attachment_id,
    ).toBe("k1");
    // Narrow by design: assert no dangle whose PARENT is attachments. Asserting the
    // whole check is empty would test fixture completeness instead of the dedup.
    const dangles = (db.pragma("foreign_key_check") as Array<{ parent: string }>)
      .filter((r) => r.parent === "attachments");
    expect(dangles).toEqual([]);
  });

  it("files on disk are never touched: every statement the migration runs is recorded, and none writes storage_path", () => {
    // Scanning the SOURCE for "unlink"/"fs" matches the prose in its own comments —
    // a control that fails on documentation is not a control. Record the SQL the
    // migration actually EXECUTES instead, and assert on that.
    db = v70Fixture();
    seedDedupFixture(db);
    const executed: string[] = [];
    const realPrepare = db.prepare.bind(db);
    const realExec = db.exec.bind(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).prepare = (sql: string) => { executed.push(sql); return realPrepare(sql); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).exec = (sql: string) => { executed.push(sql); return realExec(sql); };
    try {
      runV71(db);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).prepare = realPrepare;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).exec = realExec;
    }

    expect(executed.length).toBeGreaterThan(5); // the recorder actually recorded

    // storage_path is READ (as the dedup's grouping key) and never WRITTEN: the
    // rows move, the content-hash-named files they point at do not.
    const writesStoragePath = executed.filter((q) => /SET\s+storage_path/i.test(q));
    expect(writesStoragePath).toEqual([]);
    expect(executed.some((q) => /storage_path/i.test(q))).toBe(true);

    // And the only tables it writes are the three it is allowed to touch.
    const written = new Set(
      executed
        .map((q) => /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\s+"?([A-Za-z_]+)"?/i.exec(q)?.[1])
        .filter((t): t is string => Boolean(t)),
    );
    expect([...written].sort()).toEqual(
      ["attachments", "classification_feedback", "message_thread_names", "message_thread_names_new"].sort(),
    );
  });
});

describe("migration v71 — BACKLOG-2839 message_thread_names", () => {
  let db: DatabaseType;
  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
  });

  it("PRECONDITION: a v70 database accepts a whitespace-only display_name", () => {
    db = v70Fixture();
    expect(() =>
      db.exec(`INSERT INTO message_thread_names (user_id,thread_id,display_name) VALUES ('u1','t0','   ')`),
    ).not.toThrow();
  });

  it("CONTROL 7: the CHECK is read back from sqlite_master — PRAGMA table_info cannot see it", () => {
    db = v70Fixture();
    runV71(db);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_thread_names'").get() as { sql: string }).sql;
    expect(sql).toMatch(/CHECK\s*\(\s*length\s*\(\s*trim\(display_name/);
    // The blindness that makes a green schema-parity run worthless for this item.
    const info = JSON.stringify(db.prepare("PRAGMA table_info(message_thread_names)").all());
    expect(info).not.toMatch(/CHECK/i);
  });

  it.each([
    ["spaces", "'   '"],
    ["tab", "char(9)"],
    ["newline", "char(10)"],
    ["carriage return", "char(13)"],
    ["vertical tab", "char(11)"],
    ["form feed", "char(12)"],
    ["non-breaking space", "char(160)"],
  ])("CONTROL 6: a %s-only display_name is rejected", (name, expr) => {
    db = v70Fixture();
    runV71(db);
    expect(() =>
      db.exec(`INSERT INTO message_thread_names (user_id,thread_id,display_name) VALUES ('u1','t-${name.replace(/\s/g, "-")}',${expr})`),
    ).toThrow(/CHECK constraint failed/);
  });

  it("a real name is still accepted, and the thread index survives the rebuild", () => {
    db = v70Fixture();
    runV71(db);
    expect(() =>
      db.exec(`INSERT INTO message_thread_names (user_id,thread_id,display_name) VALUES ('u1','t-ok','Real Name')`),
    ).not.toThrow();
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='message_thread_names'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(idx).toContain("idx_message_thread_names_thread");
  });

  it("an existing blank row is DROPPED, not thrown on, and real rows are kept", () => {
    db = v70Fixture();
    db.exec(`INSERT INTO message_thread_names (user_id,thread_id,display_name)
             VALUES ('u1','macos-chat-1','Real Name'),('u1','macos-chat-2','   '),('u1','macos-chat-3',char(9))`);
    expect(() => runV71(db)).not.toThrow();
    const kept = (db.prepare("SELECT thread_id FROM message_thread_names").all() as Array<{ thread_id: string }>)
      .map((r) => r.thread_id);
    expect(kept).toEqual(["macos-chat-1"]);
  });

  it("CONTROL 8: the rebuild leaves no foreign-key violation", () => {
    db = v70Fixture();
    db.exec(`INSERT INTO message_thread_names (user_id,thread_id,display_name) VALUES ('u1','macos-chat-1','Real Name')`);
    runV71(db);
    const dangles = (db.pragma("foreign_key_check(message_thread_names)") as unknown[]);
    expect(dangles).toEqual([]);
  });

  it("the trim charset matches the DDL exactly, so the CHECK and the migration filter agree", () => {
    db = v70Fixture();
    runV71(db);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='message_thread_names'").get() as { sql: string }).sql;
    for (const c of ["char(9)", "char(10)", "char(13)", "char(11)", "char(12)", "char(160)"]) {
      expect(sql).toContain(c);
    }
  });
});

describe("migration v71 — idempotency", () => {
  let db: DatabaseType;
  afterEach(() => {
    try { db?.close(); } catch { /* ignore */ }
  });

  function fingerprint(d: DatabaseType): string {
    const objects = d.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all();
    return JSON.stringify(objects);
  }

  it("CONTROL 5: running v71 twice does not throw and leaves an IDENTICAL schema", () => {
    db = v70Fixture();
    runV71(db);
    const once = fingerprint(db);
    expect(() => runV71(db)).not.toThrow();
    expect(fingerprint(db)).toBe(once);
  });

  it("CONTROL 5: a second run deletes nothing — the dedup is not re-applied to survivors", () => {
    db = v70Fixture();
    db.exec(`INSERT INTO attachments (id,email_id,filename,storage_path) VALUES
             ('d1','e1','x.pdf','/h/AAA.pdf'),('d2','e1','x.pdf','/h/AAA.pdf')`);
    runV71(db);
    const after = (db.prepare("SELECT COUNT(*) n FROM attachments").get() as { n: number }).n;
    expect(after).toBe(1);
    runV71(db);
    expect((db.prepare("SELECT COUNT(*) n FROM attachments").get() as { n: number }).n).toBe(1);
  });

  it("is a no-op on a FRESH install shape, where schema.sql already added the column", () => {
    // schema.sql's shape: the column exists before the migration runs.
    db = v70Fixture();
    db.exec("ALTER TABLE attachments ADD COLUMN provider_attachment_id TEXT");
    expect(() => runV71(db)).not.toThrow();
    const cols = (db.prepare("PRAGMA table_info(attachments)").all() as Array<{ name: string }>)
      .filter((c) => c.name === "provider_attachment_id");
    expect(cols).toHaveLength(1);
  });
});
