/**
 * BACKLOG-4144: the registry report keys equal the keys seeded in the M1 `reports` catalog.
 * A registry slug missing from the catalog makes report_my_access answer null for everyone,
 * Super Admins included, so that report would 404 with no other test going red.
 */

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { REPORTS } from '@/lib/reports/registry';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');
const M1 = '20261105100000_backlog_4144_report_access.sql';

/**
 * Every key any migration inserts into public.reports. M1 seeds the first eight; a report added later
 * (BACKLOG-4130: email-precache, 20261105160000) adds its key in its own migration.
 */
function catalogKeys(): string[] {
  const keys: string[] = [];
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (!files.includes(M1)) throw new Error('the M1 migration is missing');
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const m of sql.matchAll(/INSERT INTO public\.reports \(report_key\) VALUES([\s\S]*?)ON CONFLICT/g)) {
      keys.push(...Array.from(m[1].matchAll(/\('([^']+)'\)/g), (x) => x[1]));
    }
  }
  return keys;
}

describe('registry == reports catalog (M1 + later report migrations)', () => {
  it('the catalog seeds 9 distinct keys', () => {
    const keys = catalogKeys();
    expect(keys).toHaveLength(9);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every registry slug is a catalog key and vice versa', () => {
    expect(REPORTS.map((r) => r.slug).sort()).toEqual(catalogKeys().sort());
  });
});
