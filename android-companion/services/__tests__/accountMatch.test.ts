/**
 * BACKLOG-2224 — phone-side account-match pre-check.
 *
 * Guards the QR pre-check that stops a phone from pairing to (and leaking texts
 * into) a desktop signed into a DIFFERENT Keepr account. Covers the hash parity
 * with the desktop and every branch of checkDesktopAccountMatch().
 */

import {
  hashUserId,
  checkDesktopAccountMatch,
  accountMatchMessage,
} from '../accountMatch';

// getSession is the only external dependency of accountMatch.
const mockGetSession = jest.fn();
jest.mock('../authService', () => ({
  getSession: () => mockGetSession(),
}));

describe('hashUserId', () => {
  it('produces the canonical SHA-256 hex (parity with desktop Node crypto)', () => {
    // sha256("hello") — identical to crypto.createHash('sha256') on the desktop.
    expect(hashUserId('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('checkDesktopAccountMatch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('allows pairing when the QR carries no hash (legacy desktop build)', async () => {
    const result = await checkDesktopAccountMatch(undefined);
    expect(result).toEqual({ ok: true });
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('allows pairing when the desktop hash matches the signed-in user', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-A' } });
    const result = await checkDesktopAccountMatch(hashUserId('user-A'));
    expect(result).toEqual({ ok: true });
  });

  it('aborts (account_mismatch) when the phone is on a different account', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-A' } });
    const result = await checkDesktopAccountMatch(hashUserId('user-B'));
    expect(result).toEqual({ ok: false, reason: 'account_mismatch' });
  });

  it('aborts (not_signed_in) when a hash is present but no session exists', async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await checkDesktopAccountMatch(hashUserId('user-A'));
    expect(result).toEqual({ ok: false, reason: 'not_signed_in' });
  });

  it('BACKLOG-2284: fails closed to not_signed_in when getSession THROWS (does not surface as "Invalid QR Code")', async () => {
    // A thrown session read (corrupt/locked secure storage) must NOT propagate
    // out of checkDesktopAccountMatch — otherwise the caller catches it and
    // shows a misleading "Invalid QR Code". It resolves to an accurate abort.
    mockGetSession.mockRejectedValue(new Error('secure storage unavailable'));
    const result = await checkDesktopAccountMatch(hashUserId('user-A'));
    expect(result).toEqual({ ok: false, reason: 'not_signed_in' });
  });
});

describe('accountMatchMessage', () => {
  it('returns distinct copy for each abort reason', () => {
    expect(accountMatchMessage('account_mismatch').title).toMatch(/Different Keepr Account/i);
    expect(accountMatchMessage('not_signed_in').title).toMatch(/Sign In/i);
  });
});
