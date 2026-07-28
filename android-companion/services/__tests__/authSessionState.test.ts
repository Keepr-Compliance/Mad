/**
 * Unit guard for the had-session marker — BACKLOG-2215.
 *
 * This marker is the signal the auth gate uses to tell a SESSION EXPIRY (had a
 * session, its refresh failed) apart from a FIRST RUN (never signed in), since
 * Supabase surfaces both as `session === null`. The four behaviors locked in
 * here map directly to the finding's required cases:
 *
 *   - first run (no marker)                 -> consumeHadSession() === false  => silent login
 *   - had a session (marker set)            -> consumeHadSession() === true   => "session expired"
 *   - one-shot (consume clears)             -> a second read === false        => no repeat notice
 *   - deliberate sign-out (cleared/flagged) -> suppressed on relaunch AND live
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    getItem: jest.fn(async (k: string) => (k in store ? store[k] : null)),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
    __reset: () => {
      store = {};
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  markHadSession,
  clearHadSession,
  consumeHadSession,
  markDeliberateSignOut,
  takeDeliberateSignOut,
} from '../authSessionState';

const reset = (AsyncStorage as unknown as { __reset: () => void }).__reset;

beforeEach(() => {
  reset();
  // Drain the synchronous deliberate-sign-out flag between tests.
  takeDeliberateSignOut();
});

describe('had-session marker (BACKLOG-2215)', () => {
  it('reports NO prior session on a first run (nothing stored)', async () => {
    // First run: never signed in -> the gate must route to login WITHOUT the
    // "session expired" notice.
    await expect(consumeHadSession()).resolves.toBe(false);
  });

  it('reports a prior session once a session has been observed (expiry signal)', async () => {
    await markHadSession();
    // A session existed but is now gone -> the gate shows "session expired".
    await expect(consumeHadSession()).resolves.toBe(true);
  });

  it('is one-shot: a second consume returns false so the notice is not repeated', async () => {
    await markHadSession();
    await expect(consumeHadSession()).resolves.toBe(true);
    await expect(consumeHadSession()).resolves.toBe(false);
  });

  it('suppresses the expiry signal across relaunch after a deliberate sign-out', async () => {
    await markHadSession();
    // signOut() clears the marker before Supabase emits SIGNED_OUT.
    await clearHadSession();
    await expect(consumeHadSession()).resolves.toBe(false);
  });
});

describe('deliberate-sign-out flag (BACKLOG-2215)', () => {
  it('defaults to false (a session loss is treated as expiry unless flagged)', () => {
    expect(takeDeliberateSignOut()).toBe(false);
  });

  it('is set by markDeliberateSignOut and cleared on read (one-shot)', () => {
    markDeliberateSignOut();
    expect(takeDeliberateSignOut()).toBe(true);
    // Read-and-clear: the next live SIGNED_OUT is not swallowed as deliberate.
    expect(takeDeliberateSignOut()).toBe(false);
  });
});
