/**
 * The version a FRESH install lands on, derived from the artefacts themselves.
 *
 * WHY THIS EXISTS (BACKLOG-2791, amended by BACKLOG-2993)
 * -------------------------------------------------------
 * Nine test files asserted the head as a hardcoded literal (`63`). Adding a
 * single migration turned SEVEN suites and 33 tests red at once. A literal
 * head is a claim that has to be re-typed in nine places every time the schema
 * moves, and it is re-typed under merge pressure. Deriving it means a schema
 * change changes ONE thing (the artefact), and the suites keep testing what
 * they were written to test.
 *
 * BACKLOG-2993 changed what "head" means. The migration chain was deleted and
 * `electron/database/schema.sql` became the whole story: it seeds its own
 * schema_version (70) and there is nothing above it to replay. The head is
 * therefore max(schema.sql's seed, any MIGRATIONS entries) — which today is
 * simply the seed, and automatically becomes a future migration's version if
 * a post-baseline chain is ever reintroduced.
 *
 * Version-SPECIFIC assertions must NOT use this. A test pinning what the v70
 * baseline contains pins 70 as a literal, because that claim is about 70 and
 * does not move when the head does. Use this only where the assertion means
 * "the install landed on its head".
 */

import path from "path";

/* eslint-disable @typescript-eslint/no-require-imports */

/** The schema_version that `electron/database/schema.sql` seeds on a fresh install. */
function schemaSqlSeedVersion(): number {
  // requireActual: several consumer suites (databaseService.migration.test.ts)
  // mock "fs" wholesale; this helper must read the REAL file regardless.
  const fs = jest.requireActual("fs") as typeof import("fs");
  const schemaPath = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
  const match = /INSERT OR IGNORE INTO schema_version \(id, version\) VALUES \(1, (\d+)\);/.exec(
    fs.readFileSync(schemaPath, "utf8"),
  );
  if (!match) {
    throw new Error(
      "schema.sql has no schema_version seed INSERT — chainHeadVersion cannot derive the fresh-install head",
    );
  }
  return Number(match[1]);
}

/**
 * The highest schema version a fresh install reaches: schema.sql's own seed,
 * plus any DatabaseService.MIGRATIONS above it (none since BACKLOG-2993).
 *
 * Read lazily through require() rather than a top-level import: these suites
 * mock heavily and several call this before their module mocks settle.
 */
export function chainHeadVersion(): number {
  const service = require("../../databaseService").default;
  const klass = service.constructor as { MIGRATIONS: Array<{ version: number }> };
  const versions = klass.MIGRATIONS.map((m) => m.version);
  const seed = schemaSqlSeedVersion();
  return versions.length === 0 ? seed : Math.max(seed, ...versions);
}
