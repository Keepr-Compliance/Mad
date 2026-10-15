/**
 * BACKLOG-3782: the broker portal must not load Microsoft Clarity.
 *
 * Clarity stays on the marketing site only (separate repo). This guard scans
 * every portal source/config file that can ship to the browser or shape its
 * headers, so re-adding the package, an init call, an env-gated component or
 * the CSP allowance for clarity.ms turns this test red.
 */
import fs from 'fs';
import path from 'path';

const PORTAL_ROOT = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.next', '__tests__', 'coverage', 'dist']);
const SCANNED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/;
// Specific tokens only: the English word "clarity" appears in ordinary comments.
const CLARITY = /@microsoft\/clarity|clarity\.ms|CLARITY_PROJECT_ID|ClarityAnalytics/i;

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SCANNED_EXT.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('BACKLOG-3782: no Microsoft Clarity in the broker portal', () => {
  const files = walk(PORTAL_ROOT, []);

  it('scans the files that actually ship (layout, next.config, package.json)', () => {
    const rel = files.map((f) => path.relative(PORTAL_ROOT, f));
    expect(rel).toEqual(
      expect.arrayContaining([
        path.join('app', 'layout.tsx'),
        'next.config.mjs',
        'package.json',
      ]),
    );
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no Clarity package, init, env var or CSP host in any portal file', () => {
    const offenders = files
      .filter((f) => CLARITY.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(PORTAL_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('declares no @microsoft/clarity dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PORTAL_ROOT, 'package.json'), 'utf8'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain(
      '@microsoft/clarity',
    );
  });
});
