/**
 * Pins for `db/emailForceSetSql` — BACKLOG-2989 commit A2.
 *
 * The predicate stopped travelling as text, so these assert what it MEANS
 * rather than what it says. Schema: `electron/database/schema.sql`, whole.
 *
 * The NULL-safety case is the one to read first. It is not defensive coding —
 * it is the difference between a re-cache that rebuilds the corpus and one that
 * silently stages a duplicate of every row it should have left alone.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  assertRebuildableProviders,
  deleteLiveForceSet,
  emailForceReadView,
  type EmailForceSet,
} from "../emailForceSetSql";
import { STAGING_PREFIX, checkedStagingTable } from "../stagingDdlSql";
import { sql } from "../core/sqlText";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-force";
const OTHER = "user-2989-force-other";
const SINCE = "2026-01-01T00:00:00Z";

const SET: EmailForceSet = {
  userId: USER,
  providers: ["gmail", "outlook"],
  cacheSinceIso: SINCE,
};

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const addUser = (id: string): void => {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(id, `${id}@example.test`, `oauth-${id}`);
};

const addEmail = (
  id: string,
  opts: {
    userId?: string;
    source?: string | null;
    externalId?: string | null;
    sentAt?: string | null;
  } = {},
): void => {
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, sent_at, subject)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.userId ?? USER,
    opts.externalId === undefined ? `ext-${id}` : opts.externalId,
    opts.source === undefined ? "gmail" : opts.source,
    opts.sentAt === undefined ? "2026-06-01T00:00:00Z" : opts.sentAt,
    `subject ${id}`,
  );
};

const liveIds = (): string[] =>
  (db.prepare("SELECT id FROM emails ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-force-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  addUser(USER);
  addUser(OTHER);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("assertRebuildableProviders", () => {
  it("refuses an unknown source rather than guessing", () => {
    expect(() =>
      assertRebuildableProviders(["gmail", "imap" as never]),
    ).toThrow(/unknown source "imap"/);
  });

  it("refuses an empty set — a predicate matching nothing is not a safe force set", () => {
    expect(() => assertRebuildableProviders([])).toThrow(/no rebuildable provider/);
  });

  it("guards the DELETE too, not just the constructor", () => {
    // The guard travels with the construction it protects, so a set that got
    // past the constructor by any route still cannot reach the SQL.
    expect(() =>
      deleteLiveForceSet(db as never, { ...SET, providers: ["pop3" as never] }),
    ).toThrow(/unknown source/);
  });
});

describe("deleteLiveForceSet — the ROW READ BACK, one case per predicate arm", () => {
  it("deletes exactly the force set and leaves every survivor in place", () => {
    addEmail("in-gmail");
    addEmail("in-outlook", { source: "outlook" });

    addEmail("keep-other-user", { userId: OTHER });
    addEmail("keep-null-external", { externalId: null });
    addEmail("keep-too-old", { sentAt: "2025-06-01T00:00:00Z" });

    const deleted = deleteLiveForceSet(db as never, SET);

    expect(deleted).toBe(2);
    // Identity, not a count: three different bugs give a survivor count of 3.
    expect(liveIds()).toEqual(["keep-null-external", "keep-other-user", "keep-too-old"]);
  });

  it("leaves a row whose source is not in the rebuilt provider list", () => {
    // Allow-list, not deny-list: a user who disconnected Outlook and clicks
    // Re-cache must not lose their Outlook mail.
    addEmail("gmail-row");
    addEmail("outlook-row", { source: "outlook" });

    deleteLiveForceSet(db as never, { ...SET, providers: ["gmail"] });

    expect(liveIds()).toEqual(["outlook-row"]);
  });

  it("leaves rows with a NULL source or NULL sent_at — the unrecognised row survives", () => {
    addEmail("null-source", { source: null });
    addEmail("null-sent", { sentAt: null });
    addEmail("deleted-me");

    expect(deleteLiveForceSet(db as never, SET)).toBe(1);
    expect(liveIds()).toEqual(["null-sent", "null-source"]);
  });
});

describe("emailForceReadView — live survivors UNION what this run staged", () => {
  const STAGING = checkedStagingTable(
    `${STAGING_PREFIX["email-recache"]}deadbeefcafe_emails`,
    "email-recache",
  );

  beforeEach(() => {
    db.exec(`CREATE TABLE "${STAGING}" (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, source TEXT, sent_at TEXT)`);
  });

  it("returns survivors plus staged rows, and NOT the live rows being replaced", () => {
    addEmail("live-in-force-set");
    addEmail("live-survivor", { sentAt: "2025-01-01T00:00:00Z" });
    db.prepare(`INSERT INTO "${STAGING}" (id, user_id, source, sent_at) VALUES ('staged-1', ?, 'gmail', '2026-06-02T00:00:00Z')`).run(USER);

    const view = emailForceReadView(SET, STAGING, sql`id`);
    const rows = (
      db.prepare(`SELECT id FROM ${view.sql} ORDER BY id`).all(...view.params) as Array<{
        id: string;
      }>
    ).map((r) => r.id);

    expect(rows).toEqual(["live-survivor", "staged-1"]);
  });

  it("NULL-SAFE: a row with a NULL source counts as a survivor, not as nothing", () => {
    /**
     * This is the case `COALESCE(..., 0) = 0` exists for, and the reason it is
     * spelled out by hand rather than written `NOT (...)`.
     *
     * `source` is nullable past its CHECK and `sent_at` is nullable outright, so
     * the force predicate can evaluate to NULL. Under a plain `NOT (...)` that
     * row is NULL — so it SURVIVES the DELETE (correct; a DELETE removes a row
     * only when its WHERE is TRUE) and then DROPS OUT of this survivor read
     * (wrong). A row that survives but is invisible to the rebuild's dedup gets
     * staged a second time, and the swap inserts a duplicate of a row the user
     * still had.
     */
    addEmail("null-source-survivor", { source: null });

    const view = emailForceReadView(SET, STAGING, sql`id`);
    const rows = (
      db.prepare(`SELECT id FROM ${view.sql}`).all(...view.params) as Array<{ id: string }>
    ).map((r) => r.id);

    expect(rows).toEqual(["null-source-survivor"]);
    // And the DELETE agrees it survived — the two must not disagree.
    expect(deleteLiveForceSet(db as never, SET)).toBe(0);
  });

  it("binds the same parameters the predicate needs, in order", () => {
    // BACKLOG-3102 PR 2: the providers are BOUND now, and they sit BETWEEN the
    // two parameters that were already here — matching the order the
    // placeholders appear in (`user_id = ?`, `source IN (?, ?)`,
    // `sent_at >= ?`). Transcribed from SET, so adding a provider to the fixture
    // cannot leave this assertion quietly describing the old arity.
    expect(emailForceReadView(SET, STAGING, sql`id`).params).toEqual([
      USER,
      ...SET.providers,
      SINCE,
    ]);
  });
});

describe("the staging name is branded here too, not just in stagingDdlSql", () => {
  /**
   * A2's first revision took `stagingTable: string` and interpolated it into
   * `FROM "${stagingTable}"` under a docstring saying it "is checked at
   * construction". A comment is not a constraint, and the brand A1 spent two
   * rounds establishing was dropped one commit later — including on
   * `EmailForceStaging.emailsTable`, which widened it back to `string` between
   * a correct construction and a correct use.
   *
   * These directives fail the build if the brand is ever removed again, the
   * same control A1 uses. `type-check:tests` is where they bite; `type-check`
   * skips test files.
   */
  const SET2: EmailForceSet = {
    userId: "u",
    providers: ["gmail"],
    cacheSinceIso: "2026-01-01T00:00:00Z",
  };

  it("refuses an unchecked staging table at the type level", () => {
    // `columns` is `sql`id`` and NOT the plain "id" it used to be. That matters:
    // a `@ts-expect-error` swallows EVERY error on its line, so once `columns`
    // became `SafeSql` a plain "id" here would satisfy the directive by itself
    // and these two lines would stop proving anything about the staging table.
    // With `columns` correct, the ONLY error left on each line is the one the
    // test is named for. (BACKLOG-3102 PR 2.)

    // @ts-expect-error a hostile raw string is not a StagingTableName
    expect(() => emailForceReadView(SET2, 'x"; DROP TABLE emails; --', sql`id`)).toBeDefined();

    // @ts-expect-error even a well-formed name is refused until it is checked
    expect(() => emailForceReadView(SET2, "staging_emailrecache_deadbeefcafe_emails", sql`id`)).toBeDefined();
  });

  it("accepts the checked form, so the brand is satisfiable and not merely obstructive", () => {
    // Without this, a brand so tight that nothing could satisfy it would also
    // pass the expect-error block above.
    const ok = checkedStagingTable(
      `${STAGING_PREFIX["email-recache"]}0123456789ab_emails`,
      "email-recache",
    );
    expect(emailForceReadView(SET2, ok, sql`id`).sql).toContain(ok);
  });
});

/**
 * BACKLOG-3102 PR 2 — EXECUTED PARITY across the provider-binding change.
 *
 * The provider list stopped being spliced as quoted literals and is now bound.
 * That rewrote the text of every force-mode statement, INCLUDING
 * `deleteLiveForceSet`, which deletes the user's mail. For that path a text
 * comparison is not evidence: the question is whether SQLite selects the same
 * rows, and only running both forms can answer it.
 *
 * So both statements are executed against the SAME fixture database and their
 * **ID SETS** are compared — never their counts. Three different defects produce
 * the same count.
 *
 * The old forms below are TRANSCRIBED from the pre-change tree
 * (`git show 47530f84a:electron/services/db/emailForceSetSql.ts`, `predicateFor`
 * at `:93-97` and `emailForceReadView` at `:143-147`), not re-derived from the
 * new code — a fixture re-derived from the thing under test proves nothing.
 *
 * Swept over EVERY provider combination the producer can emit. `connectedProviders`
 * (`emailSyncService.ts:2144-2147`) builds `[outlook?, gmail?]` and
 * `rebuiltProviders` (`:2151`, narrowed by `emailForceStaging.ts:410`) pushes in
 * completion order — so both single-provider sets and BOTH orderings of the pair
 * are reachable, and order is observable in the text and in the params.
 */
describe("BACKLOG-3102 — binding the providers selects the same rows, executed", () => {
  const STAGING_P = checkedStagingTable(
    `${STAGING_PREFIX["email-recache"]}0123456789ab_emails`,
    "email-recache",
  );

  /** Exactly what `predicateFor` emitted before the providers were bound. */
  const oldPredicate = (providers: readonly string[]): string =>
    `user_id = ? AND external_id IS NOT NULL ` +
    `AND source IN (${providers.map((p) => `'${p}'`).join(", ")}) ` +
    `AND sent_at >= ?`;

  const oldReadViewSql = (providers: readonly string[], columns: string): string =>
    `(SELECT ${columns} FROM emails WHERE COALESCE(${oldPredicate(providers)}, 0) = 0` +
    ` UNION ALL SELECT ${columns} FROM "${STAGING_P}")`;

  const COMBOS: ReadonlyArray<ReadonlyArray<"gmail" | "outlook">> = [
    ["gmail"],
    ["outlook"],
    ["gmail", "outlook"],
    ["outlook", "gmail"],
  ];

  /**
   * Every arm of the predicate, and both nullable columns it can trip over.
   * `source` is nullable past its CHECK and `sent_at` is nullable outright, so
   * the predicate CAN evaluate to NULL — the case `COALESCE(..., 0) = 0` exists
   * for. Names describe the row's role; no real mail, addresses or names.
   */
  const seedCorpus = (): void => {
    addEmail("row-gmail-in-window");
    addEmail("row-outlook-in-window", { source: "outlook" });
    addEmail("row-source-null", { source: null });
    addEmail("row-sent-at-null", { sentAt: null });
    addEmail("row-external-id-null", { externalId: null });
    addEmail("row-too-old", { sentAt: "2025-06-01T00:00:00Z" });
    addEmail("row-other-user", { userId: OTHER });
    addEmail("row-exactly-at-boundary", { sentAt: SINCE });
    db.exec(
      `CREATE TABLE "${STAGING_P}" (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT, source TEXT, sent_at TEXT, subject TEXT)`,
    );
    db.prepare(
      `INSERT INTO "${STAGING_P}" (id, user_id, external_id, source, sent_at) VALUES ('row-staged', ?, 'ext-staged', 'gmail', '2026-06-02T00:00:00Z')`,
    ).run(USER);
  };

  const idsFrom = (statement: string, params: readonly unknown[]): string[] =>
    (db.prepare(statement).all(...params) as Array<{ id: string }>).map((r) => r.id).sort();

  it.each(COMBOS.map((c) => [c.join("+"), c] as const))(
    "READ VIEW %s — identical id SET, old form vs new",
    (_label, providers) => {
      seedCorpus();
      const set: EmailForceSet = { ...SET, providers: [...providers] };

      const oldIds = idsFrom(`SELECT id FROM ${oldReadViewSql(providers, "id, user_id")}`, [
        USER,
        SINCE,
      ]);
      const view = emailForceReadView(set, STAGING_P, sql`id, user_id`);
      const newIds = idsFrom(`SELECT id FROM ${view.sql}`, view.params);

      expect(newIds).toEqual(oldIds);
      // And the set is the one the feature means, spelled out — so a change that
      // broke BOTH forms identically would still fail here.
      expect(newIds).toEqual(
        [
          "row-external-id-null",
          "row-other-user",
          "row-sent-at-null",
          "row-source-null",
          "row-staged",
          "row-too-old",
          // `row-exactly-at-boundary` is a gmail row with sent_at EXACTLY at the
          // window start. `sent_at >= ?` is inclusive, so it is INSIDE the force
          // set — it survives only when gmail is not being rebuilt. Sweeping the
          // boundary rather than sampling either side of it is what makes an
          // off-by-one here visible.
          ...(providers.includes("gmail")
            ? []
            : ["row-gmail-in-window", "row-exactly-at-boundary"]),
          ...(providers.includes("outlook") ? [] : ["row-outlook-in-window"]),
        ].sort(),
      );
    },
  );

  it.each(COMBOS.map((c) => [c.join("+"), c] as const))(
    "DELETE %s — identical id SET removed, old form vs new. This is the user's mail.",
    (_label, providers) => {
      const set: EmailForceSet = { ...SET, providers: [...providers] };

      seedCorpus();
      const before = liveIds();
      db.prepare(`DELETE FROM emails WHERE ${oldPredicate(providers)}`).run(USER, SINCE);
      const afterOld = liveIds();
      const removedByOld = before.filter((id) => !afterOld.includes(id));

      // Same fixture again, from scratch, so the two DELETEs cannot interfere.
      db.exec(`DROP TABLE "${STAGING_P}"`);
      db.prepare("DELETE FROM emails").run();
      seedCorpus();
      deleteLiveForceSet(db as never, set);
      const afterNew = liveIds();
      const removedByNew = before.filter((id) => !afterNew.includes(id));

      expect(removedByNew).toEqual(removedByOld);
      expect(afterNew).toEqual(afterOld);
      // Spelled out, for the same reason as above.
      expect(removedByNew).toEqual(
        [
          // The boundary row is gmail-sourced and sits exactly at `cacheSinceIso`;
          // `>=` is inclusive, so it is deleted whenever gmail is rebuilt.
          ...(providers.includes("gmail")
            ? ["row-gmail-in-window", "row-exactly-at-boundary"]
            : []),
          ...(providers.includes("outlook") ? ["row-outlook-in-window"] : []),
        ].sort(),
      );
    },
  );

  /**
   * CONTROL — this assertion FAILS on the pre-change tree. Verified by running it
   * against `47530f84a`, where the predicate emitted `source IN ('gmail', 'outlook')`
   * and this test reported the quote. A conversion control that passes before and
   * after the conversion has measured nothing.
   */
  it("carries NO quoted provider literal in the emitted text — fails on the old code", () => {
    for (const providers of COMBOS) {
      const view = emailForceReadView({ ...SET, providers: [...providers] }, STAGING_P, sql`id`);
      for (const provider of providers) {
        expect([provider, view.sql.includes(`'${provider}'`)]).toEqual([provider, false]);
      }
      expect(view.sql).toContain(`source IN (${providers.map(() => "?").join(", ")})`);
    }
  });

  it("binds the providers BETWEEN userId and cacheSince, matching placeholder order", () => {
    for (const providers of COMBOS) {
      const view = emailForceReadView({ ...SET, providers: [...providers] }, STAGING_P, sql`id`);
      expect([providers.join("+"), view.params]).toEqual([
        providers.join("+"),
        [USER, ...providers, SINCE],
      ]);
    }
  });
});
