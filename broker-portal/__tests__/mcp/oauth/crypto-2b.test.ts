/**
 * @jest-environment node
 *
 * BACKLOG-4238 — H19b: token digests, new tokens and the browser binding.
 * Vectors (pepper 00..1f): digest of 'kpr_at_' + 43 x 'A' from plan-pr2-rev1
 * section c; the others computed with Python hmac/hashlib.
 */

import { bindingDigest, digest, newBinding, newToken } from '@/lib/mcp/oauth/crypto';
import { BINDING, PEPPER_BYTES, REFRESH } from './fixtures';

describe('H19b: digest', () => {
  it('digest of an access token matches the known answer', () => {
    expect(digest(PEPPER_BYTES, `kpr_at_${'A'.repeat(43)}`)).toBe(
      '\\x05b06c0fa9d9be3db711aa66cdb58da3b1736c7cc2beac509e28406d72d22540'
    );
  });

  it('digest covers the whole token, prefix included', () => {
    expect(digest(PEPPER_BYTES, REFRESH)).toBe('\\xff937fbef323a91c612eb41df4afdf1493487389417de077e5c3f71c5ad289a2');
    expect(digest(PEPPER_BYTES, REFRESH)).not.toBe(
      '\\xe719a89205739e17418cd610cd41460e2a08f567d552fb4021f7f0fa1b67699c'
    );
  });

  it('bindingDigest is sha256 of the cookie value', () => {
    expect(bindingDigest(BINDING)).toBe('\\x0e4e2cb38e971b556961a831a026442065be577ab21f12cdbef9fe10ca213231');
  });
});

describe('H19b: new values', () => {
  it.each(['at', 'rt'] as const)('newToken(%p) is kpr_<kind>_ + 43 characters from 32 random bytes', (kind) => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = newToken(kind);
      expect(t).toMatch(new RegExp(`^kpr_${kind}_[A-Za-z0-9_-]{43}$`));
      expect(Buffer.from(t.slice(7), 'base64url').length).toBe(32);
      seen.add(t);
    }
    expect(seen.size).toBe(50);
  });

  it('newBinding is kpr_bd_ + 43 characters from 32 random bytes', () => {
    const b = newBinding();
    expect(b).toMatch(/^kpr_bd_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(b.slice(7), 'base64url').length).toBe(32);
    expect(newBinding()).not.toBe(b);
  });
});
