/**
 * Reports code reads through the session client only — BACKLOG-3505.
 *
 * Every file under app/dashboard/reports, lib/reports and components/reports
 * may import from lib/supabase/server and nothing else under lib/supabase; the
 * service client (lib/supabase/service, createServiceClient) bypasses RLS,
 * which is the outer bound on every report row.
 *
 * BACKLOG-3514: files under lib/reports/saved-views/ run in the browser and
 * may import the BROWSER session client (lib/supabase/client) instead. Never
 * the service client, anywhere.
 *
 * @jest-environment node
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const PORTAL = join(__dirname, '..', '..');
const ROOTS = [
  join(PORTAL, 'app', 'dashboard', 'reports'),
  join(PORTAL, 'lib', 'reports'),
  join(PORTAL, 'components', 'reports'),
];

const BROWSER_DIR = 'lib/reports/saved-views/';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const FILES = ROOTS.flatMap(walk);

/** Every module specifier imported or re-exported by a source file. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

describe('reports files never reach the service client', () => {
  it('finds the reports files (not vacuous)', () => {
    const names = FILES.map((f) => relative(PORTAL, f).split('\\').join('/'));
    expect(names).toEqual(
      expect.arrayContaining(['app/dashboard/reports/page.tsx', 'lib/reports/registry.ts', 'lib/reports/report-gate.ts'])
    );
    expect(specifiers(readFileSync(join(PORTAL, 'lib/reports/report-gate.ts'), 'utf8'))).toContain('@/lib/supabase/server');
  });

  it('C8 (BACKLOG-3514) the saved-views adapter is scanned and uses the browser session client', () => {
    const names = FILES.map((f) => relative(PORTAL, f).split('\\').join('/'));
    expect(names).toEqual(
      expect.arrayContaining(['lib/reports/saved-views/broker-views-api.ts', 'components/reports/ReportSavedViews.tsx'])
    );
    expect(specifiers(readFileSync(join(PORTAL, 'lib/reports/saved-views/broker-views-api.ts'), 'utf8'))).toContain(
      '@/lib/supabase/client'
    );
  });

  it.each(FILES.map((f) => [relative(PORTAL, f), f]))('%s imports only the allowed session client', (name, file) => {
    const source = readFileSync(file, 'utf8');
    const rel = String(name).split('\\').join('/');
    const allowed = rel.startsWith(BROWSER_DIR) ? ['@/lib/supabase/server', '@/lib/supabase/client'] : ['@/lib/supabase/server'];
    const supabaseImports = specifiers(source).filter((s) => /(^|\/)lib\/supabase\//.test(s) || /^\.\.?\/.*supabase/.test(s));
    for (const s of supabaseImports) expect(allowed).toContain(s);
    expect(source).not.toMatch(/createServiceClient|SUPABASE_SERVICE_ROLE/);
  });
});
