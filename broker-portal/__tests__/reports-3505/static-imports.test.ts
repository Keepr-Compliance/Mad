/**
 * Reports code reads through the session client only — BACKLOG-3505.
 *
 * Every file under app/dashboard/reports, lib/reports and components/reports
 * may import from lib/supabase/server and nothing else under lib/supabase; the
 * service client (lib/supabase/service, createServiceClient) bypasses RLS,
 * which is the outer bound on every report row.
 *
 * Files under lib/reports/sharing/ (BACKLOG-3513) run in the browser and may
 * import the BROWSER session client (lib/supabase/client) instead. Never the
 * service client, anywhere. (lib/reports/saved-views/, BACKLOG-3514, was
 * removed with the personal saved-views panel, BACKLOG-3513 PR-3c.)
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

/** Directories whose files run in the browser and may use the browser session client. */
const BROWSER_DIRS = [
  // BACKLOG-3513 PR-3b (SR C11): the shared-report sharing and definition RPCs.
  'lib/reports/sharing/',
];

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
  // A bare side-effect import (`import '@/lib/supabase/service';`) has no `from` (BACKLOG-3513 SR N4/J16).
  for (const m of source.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
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

  it('C11 (BACKLOG-3513 PR-3b) the sharing adapters are scanned and use the browser session client', () => {
    const names = FILES.map((f) => relative(PORTAL, f).split('\\').join('/'));
    expect(names).toEqual(
      expect.arrayContaining([
        'lib/reports/sharing/sharing-api.ts',
        'lib/reports/sharing/definitions-api.ts',
        'lib/reports/definitions/server.ts',
        'components/reports/BrokerReportShareButton.tsx',
      ])
    );
    for (const f of ['lib/reports/sharing/sharing-api.ts', 'lib/reports/sharing/definitions-api.ts']) {
      expect(specifiers(readFileSync(join(PORTAL, f), 'utf8'))).toContain('@/lib/supabase/client');
    }
    // Outside the browser directories the browser client is still refused.
    expect(BROWSER_DIRS.some((d) => 'lib/reports/definitions/server.ts'.startsWith(d))).toBe(false);
    expect(BROWSER_DIRS.some((d) => 'components/reports/BrokerReportShareButton.tsx'.startsWith(d))).toBe(false);
  });

  it.each(FILES.map((f) => [relative(PORTAL, f), f]))('%s imports only the allowed session client', (name, file) => {
    const source = readFileSync(file, 'utf8');
    const rel = String(name).split('\\').join('/');
    const allowed = BROWSER_DIRS.some((d) => rel.startsWith(d)) ? ['@/lib/supabase/server', '@/lib/supabase/client'] : ['@/lib/supabase/server'];
    const supabaseImports = specifiers(source).filter((s) => /(^|\/)lib\/supabase\//.test(s) || /^\.\.?\/.*supabase/.test(s));
    for (const s of supabaseImports) expect(allowed).toContain(s);
    expect(source).not.toMatch(/createServiceClient|SUPABASE_SERVICE_ROLE/);
  });
});
