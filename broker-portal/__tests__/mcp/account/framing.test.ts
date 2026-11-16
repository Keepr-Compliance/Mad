/**
 * @jest-environment node
 *
 * BACKLOG-4238 — the consent page and the AI apps page are sent with
 * `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The REAL
 * next.config.mjs headers() is loaded in a child node process (it is an ES
 * module wrapped in withSentryConfig) and matched with Next's own logic.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';

type Header = { key: string; value: string };
type Entry = { source: string; headers: Header[] };

function loadHeaders(): Entry[] {
  const url = pathToFileURL(path.resolve(__dirname, '../../../next.config.mjs')).href;
  const script = `const c = (await import(${JSON.stringify(url)})).default; process.stdout.write(JSON.stringify(await c.headers()));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
  });
  return JSON.parse(out) as Entry[];
}

const entries = loadHeaders();

async function headersFor(p: string): Promise<Headers> {
  const res = await unstable_getResponseFromNextConfig({
    url: `https://portal.test${p}`,
    nextConfig: { headers: async () => entries },
  });
  return res.headers;
}

describe.each([
  '/dashboard/account/ai-apps',
  '/dashboard/account/ai-apps/connect/AAAAAAAAAAAAAAAAAAAAAA',
  '/dashboard/account/ai-apps/connect/AAAAAAAAAAAAAAAAAAAAAA?x=1',
])('%s', (p) => {
  it("is sent with frame-ancestors 'none'", async () => {
    const csp = (await headersFor(p)).get('content-security-policy') ?? '';
    expect(csp.split(';').map((d) => d.trim())).toContain("frame-ancestors 'none'");
  });

  it('is sent with X-Frame-Options: DENY', async () => {
    expect((await headersFor(p)).get('x-frame-options')).toBe('DENY');
  });
});
