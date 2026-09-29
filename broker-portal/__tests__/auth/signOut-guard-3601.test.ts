/**
 * BACKLOG-3601 — every sign-out in broker-portal goes through
 * `lib/auth/signOutLocal.ts`, which always ends only this browser's session.
 * The one exception is the "Sign Out All Devices" server action.
 *
 * This is a source scan. It walks the filesystem (not git) from the portal
 * root and from ../packages, reads every .ts/.tsx/.js/.jsx/.mjs/.cjs file
 * outside node_modules/.next/test-results/coverage, and runs the rules on the
 * whole file text, so a call split over several lines is still seen.
 * Comments are matched too: a comment that spells a direct call must be
 * reworded rather than exempted.
 *
 * MEASURED LIMITS (planted forms, BACKLOG-3601 plan + SR review): a computed
 * property name (`auth['sign' + 'Out']`), `Reflect.get` / `Reflect.apply`,
 * and code outside the walked roots are NOT caught.
 *
 * @jest-environment node
 */

import * as fs from 'fs';
import * as path from 'path';

const PORTAL_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGES_ROOT = path.resolve(PORTAL_ROOT, '..', 'packages');

const HELPER = 'lib/auth/signOutLocal.ts';
const SIGN_OUT_ALL_DEVICES = 'lib/actions/signOutAllDevices.ts';

const SKIP_DIRS = new Set(['node_modules', '.next', 'test-results', 'coverage', 'playwright-report', 'dist']);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function isTestFile(rel: string): boolean {
  return (
    rel.split('/').includes('__tests__') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  );
}

interface Scanned {
  rel: string;
  text: string;
}

function walk(root: string, prefix: string, out: Scanned[]): void {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        const abs = path.join(dir, entry.name);
        const rel = prefix + path.relative(root, abs).split(path.sep).join('/');
        // Read bytes and decode, so a stray NUL byte cannot hide a file.
        out.push({ rel, text: fs.readFileSync(abs).toString('utf8') });
      }
    }
  }
}

function scanAll(): Scanned[] {
  const out: Scanned[] = [];
  walk(PORTAL_ROOT, '', out);
  walk(PACKAGES_ROOT, '../packages/', out);
  return out;
}

/** Each rule matches the whole file text; a hit is reported by line. */
const RULES: Array<{ name: string; re: RegExp }> = [
  // member call or reference, incl. `.bind` and `a\n  .signOut(`
  { name: 'member .signOut', re: /\.signOut\b/g },
  { name: "bracket ['signOut']", re: /\[\s*['"`]signOut['"`]\s*\]/g },
  // destructure from *.auth, multi-line and renamed forms
  { name: 'destructured signOut', re: /\{[^{}]*\bsignOut\b[^{}]*\}\s*=\s*[^;]*\bauth\b/g },
  // `const { auth: { signOut } } = supabase`
  { name: 'nested auth: { signOut }', re: /\bauth\s*:\s*\{[^{}]*\bsignOut\b/g },
  // a hand-built REST call to the Supabase logout endpoint
  { name: 'logout endpoint literal', re: /auth\/v1\/logout/g },
];

interface Hit {
  rel: string;
  line: number;
  rule: string;
  text: string;
}

function hitsIn(file: Scanned): Hit[] {
  const hits: Hit[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(file.text)) !== null) {
      const line = file.text.slice(0, m.index).split('\n').length;
      hits.push({ rel: file.rel, line, rule: rule.name, text: file.text.split('\n')[line - 1].trim() });
    }
  }
  return hits;
}

const files = scanAll();
const sourceFiles = files.filter((f) => !isTestFile(f.rel));
const testFiles = files.filter((f) => isTestFile(f.rel));
const byRel = new Map(files.map((f) => [f.rel, f]));

describe('BACKLOG-3601 sign-out guard (broker-portal)', () => {
  it('scans enough files to mean something', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(testFiles.length).toBeGreaterThan(20);
  });

  it('finds the helper and the Sign Out All Devices action, each with exactly one hit', () => {
    for (const rel of [HELPER, SIGN_OUT_ALL_DEVICES]) {
      const file = byRel.get(rel);
      expect(file).toBeDefined();
      expect(hitsIn(file as Scanned).map((h) => `${h.rule} :${h.line}`)).toHaveLength(1);
    }
  });

  it("pins the helper's call to scope 'local' and the action's to scope 'global'", () => {
    const helperHit = hitsIn(byRel.get(HELPER) as Scanned)[0];
    expect(helperHit.rule).toBe('member .signOut');
    expect(helperHit.text).toContain(".signOut({ scope: 'local' })");
    const allHit = hitsIn(byRel.get(SIGN_OUT_ALL_DEVICES) as Scanned)[0];
    expect(allHit.text).toContain(".signOut({ scope: 'global' })");
  });

  it('has no other sign-out anywhere in non-test source', () => {
    const violations = sourceFiles
      .filter((f) => f.rel !== HELPER && f.rel !== SIGN_OUT_ALL_DEVICES)
      .flatMap(hitsIn)
      .map((h) => `${h.rel}:${h.line} [${h.rule}] ${h.text}`);
    expect(violations).toEqual([]);
  });

  it('keeps the helper importable from client pages: no next/* value import, no server directive', () => {
    const text = (byRel.get(HELPER) as Scanned).text;
    const nextImports = text.match(/^\s*import\s+[^;]*?from\s*['"]next\/[^'"]*['"]/gm) ?? [];
    expect(nextImports.filter((line) => !/^\s*import\s+type\b/.test(line))).toEqual([]);
    expect(text).not.toMatch(/^\s*import\s*['"]next\//m);
    expect(text).not.toMatch(/\brequire\s*\(\s*['"]next\//);
    expect(text).not.toMatch(/\bimport\s*\(\s*['"]next\//);
    expect(text).not.toMatch(/^\s*['"]use (server|client)['"]/m);
    expect(text).not.toMatch(/['"]server-only['"]\s*;?\s*$/m);
  });

  it('no test replaces the real helper with a mock', () => {
    const MOCKS_HELPER = [
      // `jest.mock('…')`, `vi.mock('…')`, `vi.doMock(…)`, and vitest's typed `vi.mock(import('…'))`
      /[mM]ock\w*\s*\(\s*(?:import\s*\(\s*)?['"`][^'"`]*signOutLocal/,
      /spyOn\s*\([^)]*['"`]signOutLocal['"`]/,
    ];
    const offenders = testFiles
      .filter((f) => MOCKS_HELPER.some((re) => re.test(f.text)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
