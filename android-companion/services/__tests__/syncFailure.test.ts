/**
 * Sync-failure banner descriptor (BACKLOG-2296).
 *
 * Pins the founder's two-case distinction and the 2284 guard:
 *   (a) desktop unreachable (phone on Wi-Fi) → "Can't reach Keepr" + Re-connect.
 *   (b) phone offline (no Wi-Fi) → "You're not connected to Wi-Fi", no Re-connect.
 *   - a 403 account rejection (server_error) is NEVER a connectivity banner.
 *   - a success / unknown failure does not render the disconnected banner.
 */

import { syncDisconnection, hasSyncedSince } from '../syncFailure';
import type { SyncErrorType } from '../../types/sync';

const failure = (errorType: SyncErrorType) => ({ error: 'boom', errorType });

describe('syncDisconnection', () => {
  it('phone_offline → case (b) Wi-Fi message, NO Re-connect CTA', () => {
    const d = syncDisconnection(failure('phone_offline'));
    expect(d).not.toBeNull();
    expect(d?.cause).toBe('phone_offline');
    expect(d?.title).toMatch(/Wi-Fi/i);
    expect(d?.body).toMatch(/same Wi-Fi network as your computer/i);
    // Reconnecting Wi-Fi is the fix — re-pairing would not help.
    expect(d?.showReconnect).toBe(false);
  });

  it.each<SyncErrorType>([
    'connection_refused',
    'timeout',
    'network_after_connect',
  ])('%s → case (a) desktop-unreachable message + Re-connect CTA', (errorType) => {
    const d = syncDisconnection(failure(errorType));
    expect(d).not.toBeNull();
    expect(d?.cause).toBe('desktop_unreachable');
    expect(d?.title).toMatch(/Can't reach Keepr/i);
    expect(d?.body).toMatch(/make sure Keepr is open/i);
    expect(d?.showReconnect).toBe(true);
  });

  it('server_error (403 account rejection, 2284) → NULL: never a connectivity banner', () => {
    // The regression guard: a 403 means the desktop WAS reached and rejected the
    // account. It must NOT be reclassified as "desktop unreachable" / "offline".
    expect(syncDisconnection(failure('server_error'))).toBeNull();
  });

  it('unknown failure → NULL (handled by the generic surface, not this banner)', () => {
    expect(syncDisconnection(failure('unknown'))).toBeNull();
  });

  it('a successful result (no error) → NULL (no false-positive banner)', () => {
    expect(syncDisconnection({})).toBeNull();
    expect(syncDisconnection({ errorType: 'connection_refused' })).toBeNull(); // no error string
  });
});

describe('hasSyncedSince (BACKLOG-2301 SR N1 — foreground recovery clear)', () => {
  const RAISED_AT = Date.parse('2026-07-28T12:00:00.000Z');

  it('no banner up (disconnectedAt null) → false (nothing to clear)', () => {
    // Even a brand-new success must not "clear" a banner that was never raised.
    expect(hasSyncedSince(null, new Date(RAISED_AT + 60_000).toISOString())).toBe(
      false,
    );
  });

  it('a success STRICTLY NEWER than the failure → true (recovered)', () => {
    // A silent background/catch-up sync landed after the manual failure.
    expect(
      hasSyncedSince(RAISED_AT, new Date(RAISED_AT + 1_000).toISOString()),
    ).toBe(true);
  });

  it('the pre-failure baseline success (older/equal) → false (not a recovery)', () => {
    // The last success predates the failure — clearing on it would wrongly hide a
    // legitimate current disconnection.
    expect(
      hasSyncedSince(RAISED_AT, new Date(RAISED_AT - 1_000).toISOString()),
    ).toBe(false);
    expect(hasSyncedSince(RAISED_AT, new Date(RAISED_AT).toISOString())).toBe(
      false,
    );
  });

  it('no recorded success (null/undefined/unparseable) → false', () => {
    expect(hasSyncedSince(RAISED_AT, null)).toBe(false);
    expect(hasSyncedSince(RAISED_AT, undefined)).toBe(false);
    expect(hasSyncedSince(RAISED_AT, 'not-a-date')).toBe(false);
  });

  it('accepts an epoch-ms timestamp too (SyncStats tolerance)', () => {
    expect(hasSyncedSince(RAISED_AT, RAISED_AT + 1_000)).toBe(true);
    expect(hasSyncedSince(RAISED_AT, RAISED_AT - 1_000)).toBe(false);
  });
});
