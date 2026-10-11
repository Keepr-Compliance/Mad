/**
 * BACKLOG-3797 — admin next.config.mjs headers for the PWA.
 *
 * next.config.mjs is an ES module wrapped in withSentryConfig. A child node
 * process loads the REAL file and prints the resolved headers() array as JSON
 * (so nothing in this process can mock what it imports).
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Header = { key: string; value: string };
type Entry = { source: string; headers: Header[] };

function loadHeaders(): Entry[] {
  const url = pathToFileURL(path.resolve(__dirname, '../../next.config.mjs')).href;
  const script = `const c = (await import(${JSON.stringify(url)})).default; process.stdout.write(JSON.stringify(await c.headers()));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
  });
  return JSON.parse(out) as Entry[];
}

const entries = loadHeaders();

function csp(): string[] {
  const all = entries.find((e) => e.source === '/:path*');
  const value = all?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
  return value.split(';').map((d) => d.trim());
}

describe('BACKLOG-3797 admin next.config.mjs', () => {
  it('CSP allows the same-origin manifest explicitly', () => {
    expect(csp()).toContain("manifest-src 'self'");
  });

  it('CSP still allows the same-origin worker script (and Realtime blob workers)', () => {
    expect(csp()).toContain("worker-src 'self' blob:");
  });

  it('/sw.js is served with Cache-Control no-cache, no-store, must-revalidate', () => {
    const sw = entries.filter((e) => e.source === '/sw.js');
    expect(sw).toHaveLength(1);
    expect(sw[0].headers).toEqual([
      { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
    ]);
  });

  it('adds no Service-Worker-Allowed header (scope / is the script directory)', () => {
    const keys = entries.flatMap((e) => e.headers.map((h) => h.key.toLowerCase()));
    expect(keys).not.toContain('service-worker-allowed');
  });
});
