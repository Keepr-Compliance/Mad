/**
 * Submissions report: registry, scope and parity with the database — BACKLOG-3513 PR-3a.
 *
 *  - B2: the shipped registry opens Submissions to every full role with scope
 *    'all' and to a brokerage agent with scope 'own'.
 *  - B4: every dataset_key the definitions table accepts (its CHECK, parsed from
 *    migration 20261112200000) is a registered report.
 *  - The sort keys a saved view may hold are exactly the row function's sort
 *    whitelist, and every argument the loader sends is a parameter of the
 *    row function (both parsed from the same migration).
 *  - B6: no reports file reads transaction_submissions itself; the dataset
 *    calls broker_report_submissions_rows.
 *
 * @jest-environment node
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { REPORT_REGISTRY, SUBMISSIONS_REPORT } from '@/lib/reports/registry';
import { reportScopeFor } from '@/lib/reports/report-gate';
import { SUBMISSIONS_ROWS_RPC } from '@/lib/reports/datasets/submissions';

jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: jest.fn() }));
jest.mock('@/lib/auth/portalAccess', () => ({ getPortalAccess: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createClient: jest.fn() }));
jest.mock('next/navigation', () => ({ notFound: jest.fn() }));

const PORTAL = join(__dirname, '..', '..');
/** Windows checkouts have CRLF line endings; every regex below expects LF. */
const readLf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = readLf(
  join(PORTAL, '..', 'supabase', 'migrations', '20261112200000_backlog_3513_broker_report_definitions.sql')
);

function quoted(list: string): string[] {
  return Array.from(list.matchAll(/'([^']+)'/g), (m) => m[1]);
}

describe('B2: Submissions in the shipped registry', () => {
  it('is registered once, under the slug the page asks the gate for', () => {
    expect(REPORT_REGISTRY.filter((r) => r.slug === 'submissions')).toEqual([SUBMISSIONS_REPORT]);
    const page = readFileSync(join(PORTAL, 'app/dashboard/reports/submissions/page.tsx'), 'utf8');
    expect(page).toMatch(/requireReportAccess\('submissions'\)/);
  });

  it.each(['broker', 'admin', 'it_admin'])('%s gets scope all', (role) => {
    expect(reportScopeFor(SUBMISSIONS_REPORT, { kind: 'full', role })).toBe('all');
  });

  it('a brokerage agent gets scope own', () => {
    expect(reportScopeFor(SUBMISSIONS_REPORT, { kind: 'agent', role: 'agent' })).toBe('own');
  });
});

describe('B4: registry and database agree', () => {
  it('every dataset_key the definitions table accepts is a registered report', () => {
    const check = /dataset_key text NOT NULL CHECK \(dataset_key IN \(([^)]*)\)\)/.exec(MIGRATION);
    expect(check).not.toBeNull();
    const keys = quoted(check![1]);
    expect(keys.length).toBeGreaterThan(0);
    const slugs = REPORT_REGISTRY.map((r) => r.slug);
    for (const key of keys) expect(slugs).toContain(key);
  });

  it("the saved-view sort keys are exactly the row function's sort whitelist", () => {
    const sorts = /CASE WHEN p_sort IN \(([^)]*)\) THEN p_sort/.exec(MIGRATION);
    expect(sorts).not.toBeNull();
    const whitelist = quoted(sorts![1]);
    expect(whitelist.length).toBeGreaterThan(0);
    expect([...SUBMISSIONS_REPORT.savedView!.sortKeys].sort()).toEqual([...whitelist].sort());
  });

  it('every argument the loader sends is a parameter of the row function', () => {
    const sig = new RegExp(`FUNCTION public\\.${SUBMISSIONS_ROWS_RPC}\\(([\\s\\S]*?)\\)\\nRETURNS`).exec(MIGRATION);
    expect(sig).not.toBeNull();
    const params = Array.from(sig![1].matchAll(/\b(p_[a-z_]+)\b/g), (m) => m[1]);
    expect(params.length).toBeGreaterThan(0);
    const loader = readLf(join(PORTAL, 'lib/reports/datasets/submissions.ts'));
    const body = /function rowArgs[\s\S]*?return \{([\s\S]*?)\};/.exec(loader);
    expect(body).not.toBeNull();
    const sent = Array.from(body![1].matchAll(/\b(p_[a-z_]+):/g), (m) => m[1]);
    expect(sent.length).toBeGreaterThan(0);
    for (const p of sent) expect(params).toContain(p);
  });
});

describe('B6: the report never reads transaction_submissions itself', () => {
  const ROOTS = ['app/dashboard/reports', 'lib/reports', 'components/reports'].map((r) => join(PORTAL, r));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  const FILES = ROOTS.flatMap(walk);

  it('scans the Submissions report files (not vacuous)', () => {
    const names = FILES.map((f) => relative(PORTAL, f).split('\\').join('/'));
    expect(names).toEqual(
      expect.arrayContaining([
        'app/dashboard/reports/submissions/page.tsx',
        'lib/reports/datasets/submissions.ts',
        'components/reports/submissions/SubmissionsReportTable.tsx',
      ])
    );
  });

  it.each(FILES.map((f) => [relative(PORTAL, f), f]))('%s has no table read of transaction_submissions', (_n, file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/\.from\(\s*['"`]transaction_submissions['"`]/);
    expect(source).not.toMatch(/['"`]transaction_submissions['"`]/);
  });

  it('the dataset reads its rows through broker_report_submissions_rows', () => {
    expect(SUBMISSIONS_ROWS_RPC).toBe('broker_report_submissions_rows');
    const loader = readFileSync(join(PORTAL, 'lib/reports/datasets/submissions.ts'), 'utf8');
    expect(loader).toMatch(/\.rpc\(SUBMISSIONS_ROWS_RPC,/);
  });
});
