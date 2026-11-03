/**
 * Seeded-schema-version drift guard (BACKLOG-4093; closes the BACKLOG-2687 quarantine).
 *
 * The QA seeder (scripts/qa/harness/seed-fixture.js) creates the fixture DB by exec'ing
 * electron/database/schema.sql, which writes schema_version = the post-reset baseline. The seeded DB
 * must carry exactly that version — the same as a real fresh install, which seeds
 * DatabaseService.BASELINE_VERSION and then replays every migration above it on launch:
 *   - BELOW the baseline, the app's schema-baseline fence refuses the DB;
 *   - ABOVE it (e.g. stamping the highest migration), the app skips migrations whose objects
 *     schema.sql does not create (v71's idx_attachments_email_provider).
 *
 * So this guard pins three things:
 *   1. schema.sql's schema_version INSERT equals BASELINE_VERSION in databaseService.ts;
 *   2. the seeder never writes schema_version itself (so the seeded stamp IS the schema.sql stamp);
 *   3. the write-detector in (2) actually detects a stamp write (positive control on literals).
 *
 * Pure Node (no Electron/DB) → runs in the CI jest run and under npm run qa:test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const DB_SERVICE_PATH = join(REPO_ROOT, 'electron', 'services', 'databaseService.ts');
const SCHEMA_SQL_PATH = join(REPO_ROOT, 'electron', 'database', 'schema.sql');
const SEEDER_PATH = join(REPO_ROOT, 'scripts', 'qa', 'harness', 'seed-fixture.js');

function parseBaselineVersion(): number {
  const src = readFileSync(DB_SERVICE_PATH, 'utf8');
  const m = src.match(/static\s+readonly\s+BASELINE_VERSION\s*=\s*(\d+)\s*;/);
  if (!m) throw new Error(`BASELINE_VERSION not found in ${DB_SERVICE_PATH} — parse assumption broke.`);
  return Number(m[1]);
}

function parseSchemaSqlStamp(): number {
  const src = readFileSync(SCHEMA_SQL_PATH, 'utf8');
  const all = [
    ...src.matchAll(
      /INSERT\s+OR\s+IGNORE\s+INTO\s+schema_version\s*\(\s*id\s*,\s*version\s*\)\s*VALUES\s*\(\s*1\s*,\s*(\d+)\s*\)/gi,
    ),
  ];
  if (all.length !== 1) {
    throw new Error(`expected exactly one schema_version INSERT in schema.sql, found ${all.length}`);
  }
  return Number(all[0][1]);
}

/** Every statement in `src` that writes the schema_version table (SQL text inside JS strings). */
function schemaVersionWrites(src: string): string[] {
  const re =
    /\b(?:UPDATE\s+(?:OR\s+\w+\s+)?schema_version\b|(?:INSERT|REPLACE)\b[^;'"`]*?\bINTO\s+schema_version\b|DELETE\s+FROM\s+schema_version\b)/gi;
  return [...src.matchAll(re)].map((m) => m[0]);
}

/** The schema_version a freshly seeded DB carries: the schema.sql stamp unless the seeder writes its own. */
function seededStamp(): number {
  const writes = schemaVersionWrites(readFileSync(SEEDER_PATH, 'utf8'));
  if (writes.length > 0) {
    throw new Error(
      `seed-fixture.js writes schema_version itself (${writes.join(' | ')}); the seeded DB must keep the schema.sql stamp.`,
    );
  }
  return parseSchemaSqlStamp();
}

describe('seeded schema version drift guard (BACKLOG-4093 / BACKLOG-2687)', () => {
  it('schema.sql stamps exactly DatabaseService.BASELINE_VERSION', () => {
    expect(parseSchemaSqlStamp()).toBe(parseBaselineVersion());
  });

  it('the seeded DB carries BASELINE_VERSION (the seeder writes no schema_version of its own)', () => {
    expect(seededStamp()).toBe(parseBaselineVersion());
  });

  it('positive control: the write detector finds stamp writes in the shapes the seeder used', () => {
    expect(schemaVersionWrites("db.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(77);")).toHaveLength(1);
    expect(schemaVersionWrites("db.exec('INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 77)');")).toHaveLength(1);
    expect(schemaVersionWrites('// the seeded DB keeps the schema_version that schema.sql writes')).toHaveLength(0);
  });
});
