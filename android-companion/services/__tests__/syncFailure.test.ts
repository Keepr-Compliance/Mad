/**
 * Sync-failure banner descriptor (BACKLOG-2296).
 *
 * Pins the founder's two-case distinction and the 2284 guard:
 *   (a) desktop unreachable (phone on Wi-Fi) → "Can't reach Keepr" + Re-connect.
 *   (b) phone offline (no Wi-Fi) → "You're not connected to Wi-Fi", no Re-connect.
 *   - a 403 account rejection (server_error) is NEVER a connectivity banner.
 *   - a success / unknown failure does not render the disconnected banner.
 */

import { syncDisconnection } from '../syncFailure';
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
