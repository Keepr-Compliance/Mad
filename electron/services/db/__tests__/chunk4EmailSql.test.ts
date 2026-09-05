/**
 * Pins for `db/emailDeduplicationSql` and `db/emailDerivationSql` —
 * BACKLOG-2989 chunk 4.
 *
 * Six of these nine statements are byte-identical to their pre-move text
 * (content hash). Three are recomposed and carry a resolved-text equivalence
 * check instead, reported in the PR body:
 *
 *   - the derivation select has ONE optional clause, so its shape space is
 *     CLOSED at two and the sweep is exhaustive;
 *   - the two dedup `IN` statements have an UNBOUNDED width, so their sweep is
 *     a BOUNDARY sweep (0, 1, 2, N) and is never described as exhaustive.
 *
 * Schema: `electron/database/schema.sql` executed whole, `foreign_keys = ON`.
 * `emailDeduplicationService` had a suite already, but it hands `prepare` a
 * `jest.fn()` that never reads the SQL, so none of it could serve as a control.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  FIND_BY_CONTENT_HASH_SQL,
  FIND_BY_MESSAGE_ID_HEADER_SQL,
  findExistingByContentHashes,
  findExistingByMessageIdHeaders,
  type DedupQueryable,
} from "../emailDeduplicationSql";
import {
  EMAILS_TABLE_EXISTS_SQL,
  EMAILS_TABLE_INFO_SQL,
  STAMP_DERIVATION_VERSION_SQL,
  UPDATE_BODY_AND_VERSION_SQL,
  prepareStaleEmailSelect,
  type DerivationQueryable,
} from "../emailDerivationSql";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-c4";
const OTHER = "user-2989-c4-other";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const addUser = (id: string, email: string): void => {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(id, email, `oauth-${id}`);
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-c4-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  addUser(USER, "a@example.test");
  addUser(OTHER, "b@example.test");
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- dedup ----

const addMessage = (
  id: string,
  opts: {
    userId?: string;
    header?: string | null;
    hash?: string | null;
    duplicateOf?: string | null;
  } = {},
): void => {
  db.prepare(
    `INSERT INTO messages (id, user_id, channel, body_text, message_id_header, content_hash, duplicate_of)
     VALUES (?, ?, 'email', ?, ?, ?, ?)`,
  ).run(
    id,
    opts.userId ?? USER,
    `body ${id}`,
    opts.header ?? null,
    opts.hash ?? null,
    opts.duplicateOf ?? null,
  );
};

describe("single-row dedup lookups", () => {
  it("find a message by header, and by hash", () => {
    addMessage("m1", { header: "<a@x>", hash: "h1" });

    expect(db.prepare(FIND_BY_MESSAGE_ID_HEADER_SQL).get(USER, "<a@x>")).toEqual({ id: "m1" });
    expect(db.prepare(FIND_BY_CONTENT_HASH_SQL).get(USER, "h1")).toEqual({ id: "m1" });
  });

  it("never return a row that is itself already a duplicate", () => {
    // Returning one would chain duplicates to duplicates and orphan the real
    // original — the reason `duplicate_of IS NULL` is in all four statements.
    addMessage("m-orig", { header: "<a@x>", hash: "h1" });
    addMessage("m-dupe", { header: "<a@x>", hash: "h1", duplicateOf: "m-orig" });

    expect(db.prepare(FIND_BY_MESSAGE_ID_HEADER_SQL).get(USER, "<a@x>")).toEqual({ id: "m-orig" });
    expect(db.prepare(FIND_BY_CONTENT_HASH_SQL).get(USER, "h1")).toEqual({ id: "m-orig" });
  });

  it("are scoped to the requesting user", () => {
    addMessage("m-theirs", { userId: OTHER, header: "<a@x>", hash: "h1" });

    expect(db.prepare(FIND_BY_MESSAGE_ID_HEADER_SQL).get(USER, "<a@x>")).toBeUndefined();
    expect(db.prepare(FIND_BY_CONTENT_HASH_SQL).get(USER, "h1")).toBeUndefined();
  });
});

describe("batch dedup lookups — IN width boundary sweep (0, 1, 2, N)", () => {
  let q: DedupQueryable;
  beforeEach(() => {
    q = db as unknown as DedupQueryable;
  });

  it("width 0 — answered without touching the database", () => {
    // `IN ()` is valid SQLite that matches nothing, so building one would work
    // by accident. The early return states the intent instead.
    const spy = { prepare: jest.fn() };
    expect(findExistingByMessageIdHeaders(spy as unknown as DedupQueryable, USER, [])).toEqual([]);
    expect(findExistingByContentHashes(spy as unknown as DedupQueryable, USER, [])).toEqual([]);
    expect(spy.prepare).not.toHaveBeenCalled();
  });

  it("width 1", () => {
    addMessage("m1", { header: "<a@x>", hash: "h1" });
    expect(findExistingByMessageIdHeaders(q, USER, ["<a@x>"])).toEqual([
      { id: "m1", message_id_header: "<a@x>" },
    ]);
    expect(findExistingByContentHashes(q, USER, ["h1"])).toEqual([{ id: "m1", content_hash: "h1" }]);
  });

  it("width 2 — returns only the ids that exist, not one row per input", () => {
    addMessage("m1", { header: "<a@x>", hash: "h1" });
    const rows = findExistingByMessageIdHeaders(q, USER, ["<a@x>", "<missing@x>"]);
    expect(rows).toEqual([{ id: "m1", message_id_header: "<a@x>" }]);
  });

  it("width N — every match comes back, and nothing else", () => {
    for (let i = 0; i < 10; i++) addMessage(`m${i}`, { header: `<h${i}@x>`, hash: `hash${i}` });
    addMessage("m-other-user", { userId: OTHER, header: "<h0@x>", hash: "hash0" });

    const wanted = ["<h0@x>", "<h3@x>", "<h9@x>", "<nope@x>"];
    const ids = findExistingByMessageIdHeaders(q, USER, wanted).map((r) => r.id);

    // Identity, not count: the other user's row shares header <h0@x>, so a
    // dropped user scope would keep the count at 3 while changing the set.
    expect(ids.sort()).toEqual(["m0", "m3", "m9"]);
  });

  it("never returns a row that is itself already a duplicate", () => {
    /**
     * ADDED AFTER A MUTATION FAILED TO GO RED.
     *
     * Dropping `AND duplicate_of IS NULL` from the BATCH statements left this
     * suite green — 12 passed. The clause was covered for the two single-row
     * lookups and not for the two batch ones, so the batch path had a
     * predicate no test could discriminate. The mutation is what exposed it;
     * the fix belongs in the test, not the mutation.
     *
     * It matters on the batch path for the same reason as the single-row one:
     * returning a row that is itself a duplicate makes the importer dedup a
     * new message against a duplicate, chaining duplicates and orphaning the
     * real original.
     */
    addMessage("m-orig", { header: "<a@x>", hash: "h1" });
    addMessage("m-dupe", { header: "<a@x>", hash: "h1", duplicateOf: "m-orig" });
    addMessage("m-other", { header: "<b@x>", hash: "h2" });

    expect(
      findExistingByMessageIdHeaders(q, USER, ["<a@x>", "<b@x>"]).map((r) => r.id).sort(),
    ).toEqual(["m-orig", "m-other"]);

    expect(
      findExistingByContentHashes(q, USER, ["h1", "h2"]).map((r) => r.id).sort(),
    ).toEqual(["m-orig", "m-other"]);
  });

  it("binds the values it sized the IN list for", () => {
    // The width and the values now come from one array inside db/. If they
    // could diverge, a same-length different-values call would bind wrong and
    // SQLite would report no error, because the arity still matches.
    for (let i = 0; i < 3; i++) addMessage(`m${i}`, { hash: `hash${i}` });

    expect(findExistingByContentHashes(q, USER, ["hash0", "hash2"]).map((r) => r.id).sort()).toEqual(
      ["m0", "m2"],
    );
    expect(findExistingByContentHashes(q, USER, ["hash1", "hashX"]).map((r) => r.id)).toEqual(["m1"]);
  });
});

// ----------------------------------------------------------- derivation ----

describe("emailDerivationSql", () => {
  let q: DerivationQueryable;
  const addEmail = (id: string, version: number, userId = USER): void => {
    db.prepare(
      `INSERT INTO emails (id, user_id, body_plain, body_html, derived_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, userId, `plain ${id}`, `<p>${id}</p>`, version);
  };

  beforeEach(() => {
    q = db as unknown as DerivationQueryable;
  });

  it("EMAILS_TABLE_EXISTS_SQL and EMAILS_TABLE_INFO_SQL answer the migration probe", () => {
    expect(db.prepare(EMAILS_TABLE_EXISTS_SQL).get()).toEqual({ name: "emails" });

    const cols = (db.prepare(EMAILS_TABLE_INFO_SQL).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    // A PRAGMA rather than a query precisely so it answers when the column is
    // missing — which is the case the probe exists to detect.
    expect(cols).toContain("derived_version");
    expect(cols).toContain("body_plain");
  });

  it("selects only rows below the version, and honours the batch size", () => {
    addEmail("e-old1", 1);
    addEmail("e-old2", 1);
    addEmail("e-current", 3);

    const stmt = prepareStaleEmailSelect(q, undefined);
    expect(stmt.all(3, 10).map((r) => r.id).sort()).toEqual(["e-old1", "e-old2"]);
    expect(stmt.all(3, 1)).toHaveLength(1);
  });

  it("scopes to a user when one is given — the clause and its parameter travel together", () => {
    addEmail("e-mine", 1);
    addEmail("e-theirs", 1, OTHER);

    expect(prepareStaleEmailSelect(q, USER).all(3, 10).map((r) => r.id)).toEqual(["e-mine"]);
    expect(prepareStaleEmailSelect(q, undefined).all(3, 10).map((r) => r.id).sort()).toEqual([
      "e-mine",
      "e-theirs",
    ]);
  });

  it("UPDATE_BODY_AND_VERSION_SQL rewrites the body and stamps; STAMP only stamps", () => {
    addEmail("e1", 1);
    addEmail("e2", 1);

    db.prepare(UPDATE_BODY_AND_VERSION_SQL).run("rewritten", 3, "e1");
    db.prepare(STAMP_DERIVATION_VERSION_SQL).run(3, "e2");

    // The ROW READ BACK, not the writer's return value.
    expect(db.prepare("SELECT body_plain, derived_version FROM emails WHERE id = 'e1'").get()).toEqual(
      { body_plain: "rewritten", derived_version: 3 },
    );
    expect(db.prepare("SELECT body_plain, derived_version FROM emails WHERE id = 'e2'").get()).toEqual(
      { body_plain: "plain e2", derived_version: 3 },
    );
  });
});
