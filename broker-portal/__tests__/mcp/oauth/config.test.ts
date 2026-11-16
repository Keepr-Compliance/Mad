/**
 * @jest-environment node
 *
 * BACKLOG-4238 — kill switch and configuration for every OAuth route (H5).
 * 'off' → 404 on every route and method; a missing or malformed pepper,
 * secret or Supabase variable → 503 with no database call and a log line that
 * lists names only. No variable substitutes for another.
 */

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import * as metadata from '@/app/oauth/metadata/route';
import * as prm from '@/app/api/mcp/resource-metadata/route';
import * as register from '@/app/oauth/register/route';
import * as authorize from '@/app/oauth/authorize/route';
import * as token from '@/app/oauth/token/route';
import { oauthConfig } from '@/lib/mcp/oauth/config';
import { blockNetwork, captureConsole, OAUTH_ENV, ORIGIN, PLANTED_PLAIN, REDIRECT_URI } from './fixtures';

const ENV = { ...process.env };
blockNetwork();
let cap: ReturnType<typeof captureConsole>;

beforeEach(() => {
  process.env = { ...ENV, ...OAUTH_ENV };
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  mockRpc.mockReset();
  cap = captureConsole();
});
afterEach(() => cap.restore());
afterAll(() => {
  process.env = ENV;
});

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const ROUTES = [
  ['metadata', metadata, `${ORIGIN}/oauth/metadata`],
  ['resource-metadata', prm, `${ORIGIN}/api/mcp/resource-metadata`],
  ['register', register, `${ORIGIN}/oauth/register`],
  ['authorize', authorize, `${ORIGIN}/oauth/authorize`],
  ['token', token, `${ORIGIN}/oauth/token`],
] as const;

function call(mod: (typeof ROUTES)[number][1], m: (typeof METHODS)[number], url: string) {
  const init: NonNullable<ConstructorParameters<typeof Request>[1]> = { method: m };
  if (m === 'POST') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify({ redirect_uris: [REDIRECT_URI] });
  }
  return mod[m](new Request(url, init));
}

describe('H5: off', () => {
  const offEnvs: Array<[string, Record<string, string | undefined>]> = [
    ['MCP_ENABLED unset', { MCP_ENABLED: undefined }],
    ['MCP_ENABLED=TRUE', { MCP_ENABLED: 'TRUE' }],
    ['MCP_ENABLED=1', { MCP_ENABLED: '1' }],
    ['enabled, origin unset', { MCP_PUBLIC_ORIGIN: undefined }],
    ['enabled, origin http', { MCP_PUBLIC_ORIGIN: 'http://portal.test' }],
    ['enabled, origin with a path', { MCP_PUBLIC_ORIGIN: 'https://portal.test/x' }],
    ['enabled, origin with a query', { MCP_PUBLIC_ORIGIN: 'https://portal.test/?x=1' }],
    ['enabled, origin with userinfo', { MCP_PUBLIC_ORIGIN: 'https://u:p@portal.test' }],
    ['enabled, origin not a URL', { MCP_PUBLIC_ORIGIN: 'portal.test' }],
  ];

  it.each(offEnvs)('%s: every route and method is 404 with no database call', async (_label, env) => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    expect(oauthConfig().state).toBe('off');
    for (const [, mod, url] of ROUTES) {
      for (const m of METHODS) {
        const res = await call(mod, m, url);
        expect([m, url, res.status]).toEqual([m, url, 404]);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each(offEnvs)('%s: no route writes a log line', async (_label, env) => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const [, mod, url] of ROUTES) {
      for (const m of METHODS) await call(mod, m, url);
    }
    expect(cap.lines()).toEqual([]);
  });

  it('positive: the same calls with the configuration on write log lines', async () => {
    for (const [, mod, url] of ROUTES) await call(mod, 'GET', url);
    expect(cap.lines().filter((l) => l.startsWith('[mcp-oauth] ')).length).toBeGreaterThan(0);
  });

  it('positive: the full configuration is ok', () => {
    expect(oauthConfig().state).toBe('ok');
  });
});

describe('H5: misconfigured', () => {
  const cases: Array<[string, Record<string, string | undefined>, string[]]> = [
    ['pepper unset', { MCP_TOKEN_PEPPER: undefined }, ['MCP_TOKEN_PEPPER']],
    ['pepper 31 bytes', { MCP_TOKEN_PEPPER: Buffer.alloc(31).toString('base64url') }, ['MCP_TOKEN_PEPPER']],
    ['pepper 33 bytes', { MCP_TOKEN_PEPPER: Buffer.alloc(33).toString('base64url') }, ['MCP_TOKEN_PEPPER']],
    ['pepper not base64url', { MCP_TOKEN_PEPPER: `${PLANTED_PLAIN}+/=` }, ['MCP_TOKEN_PEPPER']],
    ['pepper planted text', { MCP_TOKEN_PEPPER: PLANTED_PLAIN }, ['MCP_TOKEN_PEPPER']],
    ['secret unset', { MCP_PORTAL_SECRET: undefined }, ['MCP_PORTAL_SECRET']],
    ['secret empty', { MCP_PORTAL_SECRET: '' }, ['MCP_PORTAL_SECRET']],
    ['supabase url unset', { NEXT_PUBLIC_SUPABASE_URL: undefined }, ['NEXT_PUBLIC_SUPABASE_URL']],
    ['anon key unset', { NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined }, ['NEXT_PUBLIC_SUPABASE_ANON_KEY']],
    [
      'pepper and secret unset, service role key set',
      { MCP_TOKEN_PEPPER: undefined, MCP_PORTAL_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: `service-${PLANTED_PLAIN}` },
      ['MCP_TOKEN_PEPPER', 'MCP_PORTAL_SECRET'],
    ],
    [
      'anon key unset, service role key set',
      { NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: `service-${PLANTED_PLAIN}` },
      ['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    ],
    [
      // the service key is shaped like a valid pepper, so a fallback to it would succeed
      'pepper unset, service role key set to a 32-byte base64url value',
      { MCP_TOKEN_PEPPER: undefined, SUPABASE_SERVICE_ROLE_KEY: Buffer.alloc(32, 7).toString('base64url') },
      ['MCP_TOKEN_PEPPER'],
    ],
    [
      'secret unset, service role key set',
      { MCP_PORTAL_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: Buffer.alloc(32, 7).toString('base64url') },
      ['MCP_PORTAL_SECRET'],
    ],
  ];

  it.each(cases)('%s: every route is 503 with no database call; the log names the variable only', async (_l, env, names) => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const cfg = oauthConfig();
    expect(cfg).toEqual({ state: 'misconfigured', missing: names });
    for (const [route, mod, url] of ROUTES) {
      const m = route === 'register' || route === 'token' ? 'POST' : 'GET';
      const res = await call(mod, m, url);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    }
    expect(mockRpc).not.toHaveBeenCalled();
    const lines = cap.lines().filter((l) => l.startsWith('[mcp-oauth] '));
    expect(lines).toHaveLength(ROUTES.length);
    for (const l of lines) {
      const o = JSON.parse(l.slice('[mcp-oauth] '.length));
      expect(o.outcome).toBe('misconfigured');
      expect(o.missing).toEqual(names);
    }
    for (const l of cap.lines()) {
      expect(l).not.toContain(PLANTED_PLAIN);
      expect(l).not.toContain(OAUTH_ENV.MCP_PORTAL_SECRET);
      expect(l).not.toContain(OAUTH_ENV.MCP_TOKEN_PEPPER);
      expect(l).not.toContain(OAUTH_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY);
      if (process.env.SUPABASE_SERVICE_ROLE_KEY) expect(l).not.toContain(process.env.SUPABASE_SERVICE_ROLE_KEY);
    }
  });
});
