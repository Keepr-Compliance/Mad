/**
 * @jest-environment node
 *
 * BACKLOG-4238 — H3: the REAL next.config.mjs has exactly the two OAuth
 * discovery rewrites, with exact sources. next.config.mjs is an ES module
 * wrapped in withSentryConfig, which jest's CJS transform cannot import, so a
 * child node process loads it and prints rewrites() as JSON (same harness as
 * __tests__/pwa-3796/next-config.test.ts). Matching runs Next's own logic.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRewrittenUrl, unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';

type Rewrite = { source: string; destination: string };
type Rewrites = { beforeFiles: Rewrite[]; afterFiles: Rewrite[]; fallback: Rewrite[] };

function loadRewrites(): Rewrites {
  const url = pathToFileURL(path.resolve(__dirname, '../../../next.config.mjs')).href;
  const script = `const c = (await import(${JSON.stringify(url)})).default; process.stdout.write(JSON.stringify(await c.rewrites()));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
  });
  return JSON.parse(out) as Rewrites;
}

const rewrites = loadRewrites();

async function rewrittenTo(url: string): Promise<string | null> {
  const res = await unstable_getResponseFromNextConfig({
    url: `https://portal.test${url}`,
    nextConfig: { rewrites: async () => rewrites },
  });
  const to = getRewrittenUrl(res);
  return to ? new URL(to).pathname : null;
}

describe('H3: OAuth discovery rewrites', () => {
  it('are exactly the two planned entries, in beforeFiles', () => {
    expect(rewrites).toEqual({
      beforeFiles: [
        { source: '/.well-known/oauth-authorization-server', destination: '/oauth/metadata' },
        { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/mcp/resource-metadata' },
      ],
      afterFiles: [],
      fallback: [],
    });
  });

  it.each([
    ['/.well-known/oauth-authorization-server', '/oauth/metadata'],
    ['/.well-known/oauth-protected-resource/api/mcp', '/api/mcp/resource-metadata'],
  ])('%s → %s', async (from, to) => {
    expect(await rewrittenTo(from)).toBe(to);
  });

  it.each([
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp/x',
    '/.well-known/oauth-protected-resource/api',
    '/.well-known/oauth-authorization-server/x',
    '/.well-known/oauth-authorization-serverx',
    '/.well-known/openid-configuration',
    '/x/.well-known/oauth-authorization-server',
  ])('near miss %s is not rewritten', async (from) => {
    expect(await rewrittenTo(from)).toBeNull();
  });
});
