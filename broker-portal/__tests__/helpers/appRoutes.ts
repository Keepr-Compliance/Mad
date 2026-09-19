/**
 * Route helpers shared by the public-page link tests (BACKLOG-3092, BACKLOG-3097).
 *
 * Extracted from `__tests__/app/guides/microsoft-approval.test.tsx` when
 * `__tests__/app/help/page.test.tsx` needed the same route resolution. Not a
 * test file: jest's `testMatch` for this portal is
 * `**\/__tests__/**\/*.(test|spec).{js,jsx,ts,tsx}`, which this name does not
 * match, and `sourceFiles` below skips `__tests__` entirely.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

/** broker-portal/ — derived from this file's own location, not the caller's. */
export const PORTAL_ROOT = join(__dirname, '..', '..');
export const APP_DIR = join(PORTAL_ROOT, 'app');
export const COMPONENTS_DIR = join(PORTAL_ROOT, 'components');

/**
 * Every `href="/…"` literal in a source file, deduplicated, in source order.
 *
 * SOURCE-LEVEL ONLY. It sees `href="/x"` and `href={'/x'}`, and it does NOT see
 * a link whose href arrives through a variable — `<Link href={article.href}>`,
 * as `/help` renders every one of its links. A page shaped like that must have
 * its hrefs read off the rendered DOM instead (see `renderedHrefs`), or the
 * regex returns an empty set and the test passes on nothing.
 */
export function internalHrefs(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/href=(?:"|'|\{')(\/[^"'`{}\s]*)(?:"|'|'\})/g)) {
    found.add(match[1]);
  }
  return [...found];
}

/**
 * Every href actually rendered by a component, deduplicated and sorted —
 * internal, external and any other scheme alike. Read from the DOM, so a link
 * built from a variable or a `.map()` is caught exactly like a literal one.
 */
export function renderedHrefs(container: HTMLElement): string[] {
  const found = new Set<string>();
  container.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href');
    if (href) found.add(href);
  });
  return [...found].sort();
}

/**
 * Resolve an App Router path to the file that serves it, honouring dynamic
 * segments (`[id]`, `[...slug]`); route groups are not needed here, but the
 * dynamic case is, so a missing route can never pass by accident.
 */
export function resolveRoute(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  let dir = APP_DIR;

  for (const segment of segments) {
    const exact = join(dir, segment);
    if (existsSync(exact) && statSync(exact).isDirectory()) {
      dir = exact;
      continue;
    }
    const dynamic = readdirSync(dir, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && entry.name.startsWith('[')
    );
    if (!dynamic) return null;
    dir = join(dir, dynamic.name);
  }

  for (const leaf of ['page.tsx', 'page.ts', 'route.ts', 'route.tsx']) {
    const candidate = join(dir, leaf);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Strip comments so a note *about* a route does not read as a link *to* it.
 * Only whole-line `//` comments are removed, never an inline `//`, so a `https://`
 * inside a string literal survives and stays scannable.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Every .ts/.tsx file under a directory, excluding tests and build output. */
export function sourceFiles(root: string, skip: (path: string) => boolean = () => false): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (skip(full)) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.next') {
          continue;
        }
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Read a source file under broker-portal/. */
export function readSource(...segments: string[]): string {
  return readFileSync(join(PORTAL_ROOT, ...segments), 'utf8');
}
