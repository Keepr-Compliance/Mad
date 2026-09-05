/**
 * Shared force-staging SQL — BACKLOG-2989 commit A (chunks 4-5 prerequisite).
 *
 * Two services stage a destructive rebuild the same way: the email force
 * re-cache (`electron/services/emailForceStaging.ts`) and the macOS messages
 * force re-import (`electron/services/macOSMessagesImportService/forceStaging.ts`,
 * BACKLOG-2990's file). They shared six SQL hashes and carried two copies of
 * `tableDdl` that differed only by one word in an error string. This module is
 * the one copy.
 *
 * ## The rule this module is built to satisfy, stated precisely
 *
 * A `db/` export may not EXECUTE SQL text it received as a parameter.
 *
 * A pure transform that RETURNS text is fine: every execution of its output
 * stays an enumerated call site, so the gate can still see it. What is
 * forbidden is the combination — parameter in, execution inside, caller left
 * holding no verb — because that is what makes SQL invisible. `execStagingDdl`
 * (rejected by review), `dbAll(sql)` (BACKLOG-3044's 114+ hidden sites) and
 * `scalar(sql)` (the chunk 2 blocker) all have all three. `deriveStagingTableDdl`
 * has the parameter and not the execution, and its callers keep their `db.exec`.
 *
 * An earlier draft of this module justified those two by PROVENANCE — that the
 * DDL they receive is read from `sqlite_master` rather than authored. That
 * argument was rejected on review and rightly: it is not enforceable at a
 * signature, since nothing stops a future caller passing hand-written DDL. The
 * rule above is checkable by reading the function.
 *
 * **Forward condition, recorded for BACKLOG-2990:** if 2990 later moves its
 * `db.exec(deriveStagingTableDdl(...))` execution into `db/`, these two must
 * stop being exported — otherwise the forbidden combination reappears inside
 * the layer.
 */

import type { Database as DatabaseType } from "better-sqlite3";

/** Which force-staging family a table belongs to. */
export type StagingKind = "email-recache" | "message-import";

/**
 * The live prefixes. `sweepStaleStaging` drops every table matching its own
 * prefix unscoped, so the two families MUST NOT share one: an email re-cache
 * staging under the messages prefix would be swept away mid-run by a messages
 * force re-import, and vice versa.
 */
export const STAGING_PREFIX: Readonly<Record<StagingKind, string>> = {
  "email-recache": "staging_emailrecache_",
  "message-import": "staging_msgimport_",
};

/**
 * A staging table name that has been checked against its prefix pattern.
 *
 * BRANDED on purpose. A plain `asserts name is string` narrows nothing — the
 * argument is already `string` — so the only guarantee it buys is "somebody
 * remembered to call the assertion". These names are interpolated directly into
 * SQL and are generated at runtime from a random token, so the compiler should
 * refuse an unchecked one rather than trusting a convention.
 */
export type StagingTableName = string & {
  readonly __stagingChecked: unique symbol;
};

/**
 * Anchored at BOTH ends, deliberately.
 *
 * The token is 12 hex characters from `crypto.randomUUID()`
 * (`emailForceStaging.ts:307`, `forceStaging.ts:367`), so the set of legal names
 * is not knowable at compile time and a union type is impossible here — this is
 * the allow-list half of guardrail (ii).
 *
 * Unanchored, the pattern would accept
 * `x staging_emailrecache_deadbeefcafe_emails; DROP TABLE emails --`
 * as a "valid" staging table, which is the whole hazard.
 *
 * ## The token is `[0-9a-f]+`, not `{12}` — and that is a correction
 *
 * An earlier revision demanded exactly twelve hex characters, which is what
 * today's generator emits. `sweepStaleStaging` then threw on an orphan left by
 * a build whose token was a different length: the sweep DISCOVERS names from
 * `sqlite_master` rather than constructing them, so a constructor-grade check
 * on a discovery path turns "reclaim a crashed run's leftovers" into "refuse to
 * clean up, loudly". `emailSyncService.forceRecache-2856.test.ts` caught it.
 *
 * The security property is the PREFIX, the ANCHORING and the CHARSET — none of
 * which the length contributes to. `staging_emailrecache_deadbeef_emails` is a
 * table this code made; a length rule only stops it being tidied away.
 */
const STAGING_NAME_PATTERN: Readonly<Record<StagingKind, RegExp>> = {
  "email-recache": /^staging_emailrecache_[0-9a-f]+_[A-Za-z0-9_]+$/,
  "message-import": /^staging_msgimport_[0-9a-f]+_[A-Za-z0-9_]+$/,
};

/**
 * Checks a runtime-generated staging table name and brands it.
 *
 * Throws rather than returning a boolean: a boolean invites an unchecked call
 * site, and there is no safe fallback for a name that is about to be spliced
 * into DDL.
 */
export function checkedStagingTable(
  name: string,
  kind: StagingKind,
): StagingTableName {
  if (!STAGING_NAME_PATTERN[kind].test(name)) {
    throw new Error(
      `Refusing to use "${name}" as a staging table: it does not match the ` +
        `anchored ${STAGING_PREFIX[kind]}<hex>_<suffix> pattern for ${kind}.`,
    );
  }
  return name as StagingTableName;
}

/**
 * What each family calls the operation, so neither caller loses its wording.
 *
 * The indefinite article lives INSIDE the value rather than in the template.
 * `Cannot stage a ${STAGING_OPERATION[kind]}` renders correctly for both of
 * today's values, but it is the shape BACKLOG-2673's guard rejects — because
 * whether "a" or "an" is right depends on a value the template cannot see, so
 * the next entry added here would silently produce "a inbox re-scan". Rendered
 * output is unchanged.
 */
const STAGING_OPERATION: Readonly<Record<StagingKind, string>> = {
  "email-recache": "a force re-cache",
  "message-import": "a force re-import",
};

/**
 * The stored `CREATE TABLE` of a live table.
 *
 * One copy. The two it replaces were byte-identical apart from the operation
 * name in the error, which is now parameterised by `kind`.
 *
 * This EXECUTES, but its SQL is a constant defined right here — it takes a
 * table NAME as a bound parameter, never SQL text.
 */
export function tableDdl(
  db: DatabaseType,
  table: string,
  kind: StagingKind,
): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  if (!row?.sql) {
    throw new Error(
      `Cannot stage ${STAGING_OPERATION[kind]}: table "${table}" does not exist`,
    );
  }
  return row.sql;
}

/**
 * The columns of a live table, in declaration order, quoted for reuse on both
 * sides of the swap.
 *
 * ONE COPY, for the same reason as `tableDdl` in commit A1: the email force
 * re-cache and the macOS messages force re-import carried byte-identical
 * definitions, and its statement (`text:9b532957dcbe`) was baselined under BOTH
 * BACKLOG-2989 and BACKLOG-2990. Moving it closes that key in both files, which
 * is a second early 2990 ratchet — declared, not incidental.
 *
 * Executes, but takes a table NAME as an interpolated identifier, never SQL
 * text from a caller. The name is a literal at every call site (`emails`,
 * `email_participants`, `messages`, `attachments`).
 */
export function columnList(db: DatabaseType, table: string): string {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.length === 0) {
    throw new Error(`Cannot swap: table "${table}" has no columns`);
  }
  return columns.map((c) => `"${c.name}"`).join(", ");
}

/**
 * Kind-fixed views of `tableDdl`, one per caller.
 *
 * These exist so the CALL SITES do not change. Threading `kind` through as a
 * third argument would have rewritten
 * `deriveStagingTableDdl(tableDdl(db, live), live, staging)` at both callers —
 * and the SQL boundary gate keys an UNRESOLVABLE site on the SOURCE TEXT of its
 * argument, so editing that expression re-keys the baseline entry. The gate
 * then correctly refuses to record the new key without `--allow-growth`, a flag
 * BACKLOG-2989 forbids itself outright.
 *
 * The refusal would have been a FALSE alarm — no SQL is authored at those sites,
 * they are the same call to the same function — but the honest way to answer a
 * gate that says "this line changed" is to not change the line. Each caller
 * imports the one it needs as `tableDdl`, so its call reads exactly as before
 * and its key is preserved.
 */
export const emailTableDdl = (db: DatabaseType, table: string): string =>
  tableDdl(db, table, "email-recache");

export const messageTableDdl = (db: DatabaseType, table: string): string =>
  tableDdl(db, table, "message-import");

/**
 * Derive a staging table's DDL from the live table's own definition.
 *
 * Derived from `sqlite_master` rather than `CREATE TABLE ... AS SELECT * ...
 * WHERE 0` because the insert names a subset of the columns and lets the table
 * supply the rest from its DEFAULTs. `AS SELECT` copies names and types and
 * drops every default, so staging would store NULL where live stores 0 — and
 * the swap would carry those NULLs into live.
 *
 * PURE: returns text, executes nothing. See the module header.
 */
export function deriveStagingTableDdl(
  liveDdl: string,
  liveTable: string,
  stagingTable: StagingTableName
): string {
  const renamed = liveDdl.replace(
    new RegExp(
      `^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`\\[]?${liveTable}["'\`\\]]?`,
      "i"
    ),
    `CREATE TABLE ${stagingTable}`
  );
  if (renamed === liveDdl) {
    throw new Error(
      `Could not derive a staging table from the definition of "${liveTable}"`
    );
  }

  const referencesClause =
    `REFERENCES\\s+["'\`\\[]?\\w+["'\`\\]]?\\s*\\([^)]*\\)` +
    `(?:\\s+ON\\s+(?:DELETE|UPDATE)\\s+(?:NO\\s+ACTION|RESTRICT|SET\\s+NULL|SET\\s+DEFAULT|CASCADE))*` +
    `(?:\\s+(?:NOT\\s+)?DEFERRABLE(?:\\s+INITIALLY\\s+(?:DEFERRED|IMMEDIATE))?)?`;

  return (
    renamed
      // table-level: `, FOREIGN KEY (x) REFERENCES y(z) ON DELETE CASCADE`
      .replace(
        new RegExp(`,?\\s*FOREIGN\\s+KEY\\s*\\([^)]*\\)\\s*${referencesClause}`, "gi"),
        ""
      )
      // column-level: `x TEXT REFERENCES y(z)`
      .replace(new RegExp(`\\s+${referencesClause}`, "gi"), "")
      // tidy up whatever the removals left behind
      .replace(/,(\s*)\)/g, "$1)")
      .replace(/\((\s*),/g, "($1")
  );
}

/** Mirror one index definition onto the staging table, under a unique name. */
export function deriveStagingIndexDdl(
  liveDdl: string,
  liveIndexName: string,
  liveTable: string,
  stagingTable: StagingTableName,
  stagingIndexName: StagingTableName
): string {
  return liveDdl
    .replace(
      new RegExp(
        `(CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)["'\`\\[]?${liveIndexName}["'\`\\]]?`,
        "i"
      ),
      `$1${stagingIndexName}`
    )
    .replace(
      new RegExp(`(\\sON\\s+)["'\`\\[]?${liveTable}["'\`\\]]?`, "i"),
      `$1${stagingTable}`
    );
}

// ---------------------------------------------------------------------------
// Staging lifecycle execution — BACKLOG-2990 chunk 5
// ---------------------------------------------------------------------------
//
// These moved out of `services/macOSMessagesImportService/forceStaging.ts` with
// the SQL they run. They EXECUTE, and they take table names and a prefix —
// never SQL text — so none has the combination the layer rule forbids.
//
// Moving the execution here is also what lets `deriveStagingTableDdl` and
// `deriveStagingIndexDdl` stop being exported: their only outside callers were
// the two `db.exec(derive…())` sites in `forceStaging.ts`, which were
// UNRESOLVABLE to the gate precisely because a call expression as argument 0
// cannot be resolved to text.

/** Staging tables left behind by a previous run — matched by prefix, then dropped. */
export const STALE_STAGING_TABLES_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`;

/** Index definitions on a live table, so staging can mirror them. */
export const TABLE_INDEXES_SQL = `SELECT name, sql FROM sqlite_master
           WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`;

/**
 * Drop a staging table.
 *
 * The name is BRANDED, which is the whole safety story: a table name cannot be
 * bound as a parameter, so it reaches SQL by interpolation and the only thing
 * standing between it and an injection is that it came from
 * `checkedStagingTable`.
 */
export function dropStagingTable(db: DatabaseType, table: StagingTableName): void {
  db.exec(`DROP TABLE IF EXISTS "${table}"`);
}

/**
 * Drop every staging table left over from an interrupted run, and name them.
 *
 * Returns what it dropped rather than a count: a caller that has to log which
 * tables were swept cannot do it from a number, and the previous shape made the
 * caller re-derive the list.
 */
export function sweepStaleStagingTables(db: DatabaseType, likePattern: string): string[] {
  const stale = db.prepare(STALE_STAGING_TABLES_SQL).all(likePattern) as Array<{ name: string }>;
  for (const row of stale) db.exec(`DROP TABLE IF EXISTS "${row.name}"`);
  return stale.map((r) => r.name);
}

/** Create the staging mirror of a live table. */
export function createStagingTable(
  db: DatabaseType,
  live: string,
  staging: StagingTableName,
): void {
  db.exec(deriveStagingTableDdl(messageTableDdl(db, live), live, staging));
}

/**
 * Mirror the live table's indexes onto staging.
 *
 * Indexes are mirrored, not skipped: `INSERT OR IGNORE`'s dedup depends on one
 * of them — the partial unique index on `(user_id, external_id)` is what makes
 * the staged insert ignore a duplicate rather than store it twice.
 */
export function mirrorStagingIndexes(
  db: DatabaseType,
  live: string,
  staging: StagingTableName,
  stagingIndexName: (indexName: string) => StagingTableName,
): void {
  const indexes = db.prepare(TABLE_INDEXES_SQL).all(live) as Array<{
    name: string;
    sql: string;
  }>;
  for (const index of indexes) {
    db.exec(deriveStagingIndexDdl(index.sql, index.name, live, staging, stagingIndexName(index.name)));
  }
}

/** How many rows a staging table holds, so a yielded row can be counted rather than inferred. */
export function countStagingRows(db: DatabaseType, table: StagingTableName): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
}
