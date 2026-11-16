/**
 * @jest-environment node
 *
 * BACKLOG-4238 — H19a: known-answer vectors for the pepper decode, hmac,
 * toBytea and ipDigest pipeline. Vectors from plan-pr2-rev1 section c
 * (pepper 00..1f): Node and openssl agree on d; Node and Postgres agree on
 * sha256(d).
 */

import { createHash } from 'node:crypto';
import { oauthConfig } from '@/lib/mcp/oauth/config';
import { hmac, ipDigest, newClientId, toBytea } from '@/lib/mcp/oauth/crypto';
import { OAUTH_ENV, PEPPER_BYTES } from './fixtures';

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV, ...OAUTH_ENV };
});
afterAll(() => {
  process.env = ENV;
});

function pepper(): Buffer {
  const cfg = oauthConfig();
  if (cfg.state !== 'ok') throw new Error('fixture config is not ok');
  return cfg.pepper;
}

describe('H19a: digest pipeline', () => {
  it('the configured pepper decodes to bytes 00..1f', () => {
    expect(pepper().equals(PEPPER_BYTES)).toBe(true);
  });

  it('hmac over a token matches the known answer; sha256 of it matches the Postgres value', () => {
    const d = hmac(pepper(), `kpr_at_${'A'.repeat(43)}`);
    expect(d.toString('hex')).toBe('05b06c0fa9d9be3db711aa66cdb58da3b1736c7cc2beac509e28406d72d22540');
    expect(createHash('sha256').update(d).digest('hex')).toBe(
      '0e5fb1cb7750b7c4b744cd5459482f296d1f8e3fcc94b379538f5515c7a50dcf'
    );
  });

  it('ipDigest matches the known answer', () => {
    expect(ipDigest(pepper(), '203.0.113.7').toString('hex')).toBe(
      'ee6f9612bd55af19581fb91675a14447ba26035f8c4a528dfbb840166be10c84'
    );
  });

  it('toBytea is one backslash, x, then 64 lowercase hex characters', () => {
    const v = toBytea(ipDigest(pepper(), '203.0.113.7'));
    expect(v).toBe('\\xee6f9612bd55af19581fb91675a14447ba26035f8c4a528dfbb840166be10c84');
    expect(v.length).toBe(66);
    expect(v.charCodeAt(0)).toBe(0x5c);
    expect(JSON.stringify({ v })).toBe('{"v":"\\\\xee6f9612bd55af19581fb91675a14447ba26035f8c4a528dfbb840166be10c84"}');
  });

  it('newClientId is kpr_c_ + 22 base64url characters (16 bytes)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = newClientId();
      expect(id).toMatch(/^kpr_c_[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(id.slice(6), 'base64url').length).toBe(16);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });
});
