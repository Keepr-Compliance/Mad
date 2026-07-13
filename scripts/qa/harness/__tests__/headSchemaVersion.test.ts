/**
 * HEAD-schema-version drift guard (BACKLOG-1977 / BACKLOG-1987).
 *
 * The QA seeder (scripts/qa/harness/seed-fixture.js) stamps the freshly-provisioned fixture DB at
 * HEAD_SCHEMA_VERSION so the app treats it as an up-to-date HEAD install and REPLAYS NO migrations on
 * launch. That is the fix for BACKLOG-1987: schema.sql is already head structure but stamps
 * schema_version = 32, so leaving it at 32 made the app replay migrations 33→head — including v36's
 * contacts rebuild, which silently DROPS seeded provider-source contacts (outlook/google_contacts/iphone)
 * because the v36 CHECK constraint predates them. Stamping head skips the replay entirely.
 *
 * HEAD_SCHEMA_VERSION is MIRRORED in the seeder (not imported) so the seeder stays self-contained — it
 * runs under Electron with NO app build, so the compiled DatabaseService is not requireable. This guard is
 * the SINGLE SOURCE OF TRUTH cross-check: it parses electron/services/databaseService.ts, extracts the
 * highest DatabaseService.MIGRATIONS[].version, and asserts it equals the seeder's HEAD_SCHEMA_VERSION. If
 * a future migration (e.g. v50) is added WITHOUT bumping the seeder constant, this test FAILS loudly rather
 * than silently re-introducing the replay/data-loss regression.
 *
 * Pure Node (no Electron/DB) → runs under npm run qa:test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../seed-fixture.js') as { HEAD_SCHEMA_VERSION: number };

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const DB_SERVICE_PATH = join(REPO_ROOT, 'electron', 'services', 'databaseService.ts');

/**
 * The highest DatabaseService.MIGRATIONS[].version in databaseService.ts. Every numeric `version: NN`
 * occurrence in that file is a migration entry (the interface fields are typed `version: number`, which
 * has no digits and is not matched), so the max of the captured integers is the head migration version.
 */
function parseHeadMigrationVersion(): number {
  const src = readFileSync(DB_SERVICE_PATH, 'utf8');
  const matches = [...src.matchAll(/version:\s*(\d+)/g)].map((m) => Number(m[1]));
  if (matches.length === 0) {
    throw new Error(`No numeric migration versions found in ${DB_SERVICE_PATH} — parse assumption broke.`);
  }
  return Math.max(...matches);
}

describe('HEAD schema version drift guard (BACKLOG-1977/1987)', () => {
  it('the seeder HEAD_SCHEMA_VERSION is a positive integer', () => {
    expect(Number.isInteger(seed.HEAD_SCHEMA_VERSION)).toBe(true);
    expect(seed.HEAD_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('the seeder HEAD_SCHEMA_VERSION equals the highest MIGRATIONS[].version in databaseService.ts', () => {
    const headMigrationVersion = parseHeadMigrationVersion();
    expect(seed.HEAD_SCHEMA_VERSION).toBe(headMigrationVersion);
  });

  it('the head migration version is at or above the schema.sql stamped baseline (32)', () => {
    // schema.sql stamps schema_version = 32; the seeder must stamp AT or ABOVE it (never below, which
    // would make the app replay migrations and re-trigger the v36 contacts data-loss).
    expect(seed.HEAD_SCHEMA_VERSION).toBeGreaterThanOrEqual(32);
  });
});
