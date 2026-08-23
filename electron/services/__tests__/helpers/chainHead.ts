/**
 * The migration chain's HEAD version, derived from the chain itself.
 *
 * WHY THIS EXISTS (BACKLOG-2791)
 * ------------------------------
 * Nine test files asserted the head as a hardcoded literal (`63`). Adding a
 * single migration turned SEVEN suites and 33 tests red at once — including
 * `onDiskUpgrade` and `migrationChainRehearsal`, the only two that exercise a
 * migration against a REAL shipped database file. So the moment a migration is
 * added, the two suites that would prove it upgrades a real install stop running
 * at all, which is exactly when they are most needed.
 *
 * A literal head is a claim that has to be re-typed in nine places every time
 * the chain grows, and it is re-typed under merge pressure — the shape that
 * produced this. Deriving it means a new migration changes ONE thing (the
 * migration), and the suites keep testing what they were written to test.
 *
 * Version-SPECIFIC assertions must NOT use this. A test pinning what v56 did to
 * the tombstone columns pins 56 as a literal, because that claim is about 56 and
 * does not move when the head does. Use this only where the assertion means
 * "the chain landed on its head".
 */

/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * The highest version in DatabaseService.MIGRATIONS.
 *
 * Read lazily through require() rather than a top-level import: these suites
 * mock heavily and several call this before their module mocks settle.
 */
export function chainHeadVersion(): number {
  const service = require("../../databaseService").default;
  const klass = service.constructor as { MIGRATIONS: Array<{ version: number }> };
  const versions = klass.MIGRATIONS.map((m) => m.version);
  if (versions.length === 0) {
    throw new Error("MIGRATIONS is empty — chainHeadVersion has nothing to derive from");
  }
  return Math.max(...versions);
}
