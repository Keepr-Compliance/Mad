/**
 * BACKLOG-4144: the registry report keys equal the keys seeded in the M1 `reports` catalog.
 * A registry slug missing from the catalog makes report_my_access answer null for everyone,
 * Super Admins included, so that report would 404 with no other test going red.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { REPORTS } from '@/lib/reports/registry';

const MIGRATION = path.resolve(
  __dirname,
  '../../../supabase/migrations/20261105100000_backlog_4144_report_access.sql'
);

function catalogKeys(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const m = sql.match(/INSERT INTO public\.reports \(report_key\) VALUES([\s\S]*?)ON CONFLICT/);
  if (!m) throw new Error('catalog insert not found in the M1 migration');
  return Array.from(m[1].matchAll(/\('([^']+)'\)/g), (x) => x[1]);
}

describe('registry == M1 reports catalog', () => {
  it('the catalog seeds 8 keys', () => {
    expect(catalogKeys()).toHaveLength(8);
  });

  it('every registry slug is a catalog key and vice versa', () => {
    expect(REPORTS.map((r) => r.slug).sort()).toEqual(catalogKeys().sort());
  });
});
