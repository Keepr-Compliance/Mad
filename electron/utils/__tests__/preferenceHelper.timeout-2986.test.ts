/**
 * BACKLOG-2986 — A PREFERENCE READ THAT NEVER RETURNS IS NOT A FAILED READ.
 *
 * ===========================================================================
 * THE DISTINCTION THIS SUITE EXISTS TO PRESERVE
 * ===========================================================================
 * Every caller of `isContactSourceEnabled` passes `defaultValue: true`, and the
 * helper fails OPEN on it. That covers a read that REJECTS. It does not cover a
 * read that never settles: a pending promise is not an error, so the `catch`
 * never runs, the default is never applied, and the caller waits forever.
 *
 * **A control that mocks a REJECTION cannot see this.** That path already
 * worked before the timeout existed and still works after it. Every case below
 * therefore mocks a promise that NEVER SETTLES — `new Promise(() => {})` — and
 * asserts the call COMPLETES, with the right fallback VALUE.
 *
 * It is the same distinction BACKLOG-2206 exists to preserve one layer down:
 * "the read failed" and "the read never returned" are different states, and
 * collapsing them once hid a zero-message release for weeks.
 *
 * ===========================================================================
 * WHY IT BECAME URGENT
 * ===========================================================================
 * BACKLOG-2986 put a preference read on the INBOUND HTTP handler of the LAN
 * sync server (`localSyncService.storeContacts`). Before that the phone's POST
 * touched only local SQLite. A desktop that accepts the TCP connection and then
 * hangs inside the handler is indistinguishable, from the phone, from a desktop
 * that is down — which is the unexplained "desktop unreachable" of BACKLOG-2955.
 *
 * ===========================================================================
 * FAKE TIMERS, AND THE TWO WAYS THIS KIND OF TEST GOES QUIETLY WRONG
 * ===========================================================================
 * 1. The promise must be STARTED before the clock is advanced. The timer is
 *    created inside the call, so advancing first would advance past nothing.
 * 2. `runAllTimersAsync()` rather than one `advanceTimersByTimeAsync(N)`, so a
 *    caller that reads more than once in sequence is covered — each read only
 *    creates its timer after the previous one settles. The picker gate reads
 *    five times; see `contact-handlers.timeout-2986.test.ts`.
 *
 * `useRealTimers` is restored in `afterEach`: jest workers are reused across
 * suites and a leaked fake clock surfaces later as an unrelated, baffling hang.
 */

const mockGetPreferences = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: mockGetPreferences },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  isContactSourceEnabled,
  getEmailCacheDurationMonths,
  isShadowDeltaSyncEnabled,
  PREFERENCES_READ_TIMEOUT_MS,
} from "../preferenceHelper";
import logService from "../../services/logService";

/** A read that is still outstanding when the universe ends. */
const neverSettles = () => new Promise<never>(() => {});

/**
 * Start the call, run every timer the helper schedules, then await it.
 * If the timeout were absent this would never resolve and jest would fail the
 * case on its own per-test deadline — which is the red this suite needs.
 */
async function settleWithTimers<T>(start: () => Promise<T>): Promise<T> {
  const pending = start();
  await jest.runAllTimersAsync();
  return pending;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-2986 — a hung preference read still answers", () => {
  it("isContactSourceEnabled falls back to its caller's default instead of hanging", async () => {
    mockGetPreferences.mockImplementation(neverSettles);

    // The value, not merely completion. A timeout that RESOLVED with `{}`
    // instead of rejecting would also complete — and `{}` is a readable bag, so
    // an absent `androidContacts` would derive FALSE and a hung network would
    // silently switch the user's Android import off. Asserting `true` is what
    // separates those two implementations.
    await expect(
      settleWithTimers(() =>
        isContactSourceEnabled("user-1", "direct", "androidContacts", true),
      ),
    ).resolves.toBe(true);
  });

  it("honours a caller that asked to fail closed", async () => {
    mockGetPreferences.mockImplementation(neverSettles);

    await expect(
      settleWithTimers(() =>
        isContactSourceEnabled("user-1", "direct", "androidContacts", false),
      ),
    ).resolves.toBe(false);
  });

  it("getEmailCacheDurationMonths falls back to the documented default", async () => {
    mockGetPreferences.mockImplementation(neverSettles);

    await expect(
      settleWithTimers(() => getEmailCacheDurationMonths("user-1")),
    ).resolves.toBe(3);
  });

  it("isShadowDeltaSyncEnabled fails CLOSED, which is its own rule", async () => {
    // Deliberately the opposite direction from the two above: an opt-in
    // experiment must never be switched on by a read that did not answer.
    mockGetPreferences.mockImplementation(neverSettles);

    await expect(
      settleWithTimers(() => isShadowDeltaSyncEnabled("user-1")),
    ).resolves.toBe(false);
  });

  it("says the read did not RETURN, not that it failed", async () => {
    // The callers' own catch logs "could not load", which reads as a failed
    // read. A support investigation has to be able to tell a hang from an error
    // out of the log alone — that is the BACKLOG-2206 lesson.
    mockGetPreferences.mockImplementation(neverSettles);

    await settleWithTimers(() =>
      isContactSourceEnabled("user-1", "direct", "androidContacts", true),
    );

    const warned = (logService.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => /did not return within/i.test(m))).toBe(true);
    expect(warned.some((m) => m.includes(String(PREFERENCES_READ_TIMEOUT_MS)))).toBe(true);
  });

  it("does not wait on the clock at all when the read answers", async () => {
    // The timeout must not become a floor on every read. With real timers and
    // no fake clock to advance, a resolved read has to come back on its own.
    jest.useRealTimers();
    mockGetPreferences.mockResolvedValue({
      contactSources: { direct: { androidContacts: false } },
    });

    await expect(
      isContactSourceEnabled("user-1", "direct", "androidContacts", true),
    ).resolves.toBe(false);
  });

  it("leaves no timer behind after a read that answered", async () => {
    // `clearTimeout` in the `finally` is not tidiness: a pending timer keeps the
    // Node event loop alive, so without it every successful read would hold a
    // live handle for the full timeout.
    mockGetPreferences.mockResolvedValue({});

    await isContactSourceEnabled("user-1", "direct", "androidContacts", true);

    expect(jest.getTimerCount()).toBe(0);
  });
});
