/**
 * BACKLOG-2212 — pairing failure classification + messaging.
 *
 * The pair screen and the home re-pair screen both feed a failed registerDevice
 * result through this module to decide WHICH message + retryability to show.
 * These tests pin the distinct failure modes so they can never collapse into one
 * generic "pairing failed": a desktop 403 must read as an account problem (no
 * Retry), transport errors must read as a reachability problem (with Retry), and
 * anything else falls back to generic (with Retry).
 */

import {
  classifyPairFailure,
  pairFailureMessage,
} from '../pairingFeedback';

// accountMatch (imported for the shared account-mismatch copy) only needs
// getSession stubbed to load under jest.
const mockGetSession = jest.fn();
jest.mock('../authService', () => ({
  getSession: () => mockGetSession(),
}));

describe('classifyPairFailure (BACKLOG-2212)', () => {
  it('classifies a desktop 403 as an account rejection (not reachability)', () => {
    // A 403 means the phone REACHED the desktop and it refused on account
    // grounds — errorType is server_error but status wins.
    expect(
      classifyPairFailure({ status: 403, errorType: 'server_error' }),
    ).toBe('account');
  });

  it.each(['connection_refused', 'timeout', 'network_after_connect'] as const)(
    'classifies transport error %s as reachability',
    (errorType) => {
      expect(classifyPairFailure({ errorType })).toBe('reachability');
    },
  );

  it('classifies a non-403 server error as generic', () => {
    expect(
      classifyPairFailure({ status: 500, errorType: 'server_error' }),
    ).toBe('generic');
  });

  it('classifies an unknown error as generic', () => {
    expect(classifyPairFailure({ errorType: 'unknown' })).toBe('generic');
  });
});

describe('pairFailureMessage (BACKLOG-2212)', () => {
  it('account (403): shows the account-mismatch copy and is NOT retryable', () => {
    const msg = pairFailureMessage({ status: 403, errorType: 'server_error' });
    expect(msg.retryable).toBe(false);
    // Reuses the BACKLOG-2224 account copy verbatim.
    expect(msg.title).toBe('Different Keepr Account');
    expect(msg.body).toMatch(/different Keepr account/i);
    // Must NOT read as a reachability problem.
    expect(msg.body).not.toMatch(/Wi-Fi/i);
  });

  it('reachability: shows the reach-Keepr copy and IS retryable', () => {
    const msg = pairFailureMessage({ errorType: 'connection_refused' });
    expect(msg.retryable).toBe(true);
    expect(msg.title).toMatch(/reach keepr/i);
    expect(msg.body).toMatch(/same Wi-Fi/i);
    expect(msg.body).toMatch(/Keepr app is open/i);
    // Must NOT read as an account problem.
    expect(msg.body).not.toMatch(/different Keepr account/i);
  });

  it('a bounded-timeout failure surfaces the reachability (reach-Keepr) message', () => {
    // registerDevice maps an aborted (hung) request to errorType 'timeout'.
    const msg = pairFailureMessage({ errorType: 'timeout' });
    expect(msg.title).toMatch(/reach keepr/i);
    expect(msg.retryable).toBe(true);
  });

  it('generic: retryable with a non-account, non-reachability message', () => {
    const msg = pairFailureMessage({ status: 500, errorType: 'server_error' });
    expect(msg.retryable).toBe(true);
    expect(msg.body).not.toMatch(/different Keepr account/i);
    expect(msg.body).not.toMatch(/same Wi-Fi/i);
  });
});
