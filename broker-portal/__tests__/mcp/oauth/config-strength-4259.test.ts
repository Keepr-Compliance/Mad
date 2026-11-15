/**
 * @jest-environment node
 *
 * BACKLOG-4259 — the strength rule for MCP_PORTAL_SECRET and MCP_TOKEN_PEPPER
 * (lib/mcp/secretStrength.ts), what the configuration does with a value that
 * fails it, and the per-address bucket used by registration.
 */

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { randomBytes } from 'node:crypto';
import * as register from '@/app/oauth/register/route';
import { ipDigest, toBytea } from '@/lib/mcp/oauth/crypto';
import { oauthConfig } from '@/lib/mcp/oauth/config';
import { rateLimitAddress } from '@/lib/mcp/oauth/clientIp';
import { decodeSecret, isStrongSecret } from '@/lib/mcp/secretStrength';
import { blockNetwork, captureConsole, OAUTH_ENV, ORIGIN, PEPPER_BYTES, PLANTED_PLAIN, REDIRECT_URI, registerOk } from './fixtures';

const ENV = { ...process.env };
blockNetwork();
let cap: ReturnType<typeof captureConsole>;

beforeEach(() => {
  process.env = { ...ENV, ...OAUTH_ENV };
  mockRpc.mockReset();
  mockRpc.mockImplementation(async (_fn: string, args: Record<string, unknown>) => ({
    data: registerOk(args.p_client_id as string, args.p_client_name as string, args.p_redirect_uris as string[]),
    error: null,
  }));
  cap = captureConsole();
});
afterEach(() => cap.restore());
afterAll(() => {
  process.env = ENV;
});

/** n bytes holding `distinct` different values (0..distinct-1, repeated). */
function bytes(n: number, distinct: number): Buffer {
  return Buffer.from(Array.from({ length: n }, (_, i) => i % distinct));
}

describe('the strength rule', () => {
  it.each([
    ['hex, 32 bytes (64 characters)', bytes(32, 32).toString('hex'), true],
    ['hex, 32 bytes, upper case', bytes(32, 32).toString('hex').toUpperCase(), true],
    ['hex, 31 bytes (62 characters)', bytes(31, 31).toString('hex'), false],
    ['hex, odd length (63 characters)', bytes(32, 32).toString('hex').slice(0, 63), false],
    ['hex, 32 bytes with 16 different values', bytes(32, 16).toString('hex'), true],
    ['hex, 32 bytes with 15 different values', bytes(32, 15).toString('hex'), false],
    ['hex digits only, 44 characters, read as hex (22 bytes)', 'a1b2c3d4e5f6'.repeat(4).slice(0, 44), false],
    ['base64url, 32 bytes (43 characters)', bytes(32, 32).toString('base64url'), true],
    ['base64url, 31 bytes (42 characters)', bytes(31, 31).toString('base64url'), false],
    ['base64url, 48 bytes', bytes(48, 48).toString('base64url'), true],
    ['base64url, 32 bytes with 15 different values', bytes(32, 15).toString('base64url'), false],
    ['base64 with padding', `${bytes(32, 32).toString('base64url')}=`, false],
    ['base64 standard alphabet', `${bytes(32, 32).toString('base64url').slice(0, 42)}+`, false],
    ['base64url, not canonical (unused bits set)', `${bytes(32, 32).toString('base64url').slice(0, 42)}9`, false],
    ['empty', '', false],
    ['planted plain text', PLANTED_PLAIN, false],
    ['the previous test fixture', 'portal-secret-fixture', false],
  ])('%s → %s', (_label, raw, strong) => {
    expect(isStrongSecret(raw)).toBe(strong);
  });

  it('a string of hex digits is read as hex, not base64url', () => {
    const raw = bytes(32, 32).toString('hex');
    expect(decodeSecret(raw)?.length).toBe(32);
  });

  it('values made the way the preview setup script makes them pass (token_hex(32); base64url of 32 random bytes)', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(isStrongSecret(randomBytes(32).toString('hex'))).toBe(true);
      expect(isStrongSecret(randomBytes(32).toString('base64url'))).toBe(true);
    }
  });
});

describe('MCP_PORTAL_SECRET that fails the rule', () => {
  const WEAK = 'ab'.repeat(32); // 64 hex characters, one byte value

  it('configuration is off; one log line names the variable, never the value', () => {
    process.env.MCP_PORTAL_SECRET = WEAK;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { oauthConfig: fresh } = require('@/lib/mcp/oauth/config');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { mcpEnabled } = require('@/lib/mcp/config');
      expect(mcpEnabled()).toBe(false);
      expect(fresh()).toEqual({ state: 'off' });
      expect(fresh()).toEqual({ state: 'off' });
    });
    const lines = cap.lines();
    expect(lines.filter((l) => l.includes('MCP_PORTAL_SECRET'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(WEAK);
    expect(lines.join('\n')).not.toContain('abab');
  });

  it('registration answers 404 and makes no database call', async () => {
    process.env.MCP_PORTAL_SECRET = WEAK;
    const res = await register.POST(
      new Request(`${ORIGIN}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
      })
    );
    expect(res.status).toBe(404);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('the fixture secret meets the rule, so the configuration is ok', () => {
    expect(isStrongSecret(OAUTH_ENV.MCP_PORTAL_SECRET)).toBe(true);
    expect(oauthConfig().state).toBe('ok');
  });
});

describe('MCP_TOKEN_PEPPER that fails the rule', () => {
  it.each([
    ['32 bytes with 15 different values', bytes(32, 15).toString('base64url'), 'misconfigured'],
    ['32 bytes with 16 different values', bytes(32, 16).toString('base64url'), 'ok'],
  ])('%s → %s', (_label, raw, state) => {
    process.env.MCP_TOKEN_PEPPER = raw;
    const cfg = oauthConfig();
    expect(cfg.state).toBe(state);
    if (cfg.state === 'misconfigured') expect(cfg.missing).toEqual(['MCP_TOKEN_PEPPER']);
  });
});

describe('the per-address bucket', () => {
  it.each([
    ['IPv4 unchanged', '203.0.113.7', '203.0.113.7'],
    ['IPv6 to its /64', '2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['IPv6 compressed', '2001:db8::1', '2001:db8:0:0::/64'],
    ['IPv6 compressed elsewhere, same /64', '2001:db8:0:0:1::', '2001:db8:0:0::/64'],
    ['IPv6 upper case', '2001:DB8:A::1', '2001:db8:a:0::/64'],
    ['IPv6 with a zone', 'fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['IPv6 in brackets', '[2001:db8::9]', '2001:db8:0:0::/64'],
    ['IPv4-mapped IPv6, dotted', '::ffff:203.0.113.7', '203.0.113.7'],
    ['IPv4-mapped IPv6, hex', '::ffff:cb00:7107', '203.0.113.7'],
    ['IPv6 with an embedded IPv4 tail', '64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
    ['unknown', 'unknown', 'unknown'],
    ['not an address', 'not-an-address', 'not-an-address'],
  ])('%s: %s → %s', (_label, ip, bucket) => {
    expect(rateLimitAddress(ip)).toBe(bucket);
  });

  it('two addresses in one /64 share a bucket; addresses in different /64s do not', () => {
    expect(rateLimitAddress('2001:db8:1:2::a')).toBe(rateLimitAddress('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(rateLimitAddress('2001:db8:1:2::a')).not.toBe(rateLimitAddress('2001:db8:1:3::a'));
    expect(rateLimitAddress('203.0.113.7')).not.toBe(rateLimitAddress('203.0.113.8'));
  });

  async function registeredDigest(ip: string): Promise<unknown> {
    mockRpc.mockClear();
    await register.POST(
      new Request(`${ORIGIN}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': ip },
        body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
      })
    );
    expect(mockRpc).toHaveBeenCalledTimes(1);
    return (mockRpc.mock.calls[0][1] as Record<string, unknown>).p_ip_sha256;
  }

  it('registration sends the digest of the bucket: same /64 → same digest, other /64 → other digest, IPv4 as before', async () => {
    const a = await registeredDigest('2001:db8:1:2::a');
    const b = await registeredDigest('2001:db8:1:2:9::b');
    const c = await registeredDigest('2001:db8:1:3::a');
    const v4 = await registeredDigest('203.0.113.7');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(toBytea(ipDigest(PEPPER_BYTES, '2001:db8:1:2::/64')));
    expect(v4).toBe(toBytea(ipDigest(PEPPER_BYTES, '203.0.113.7')));
  });
});
