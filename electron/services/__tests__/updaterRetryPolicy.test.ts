/**
 * Tests for the pure self-recovery decision policy (BACKLOG-1905, Deliverable 1).
 *
 * Verifies the errorType-keyed recovery matrix:
 * - checksum_mismatch → ONE full-download fallback, then surface
 * - network_timeout   → retry up to N=2 (3 total) with backoff, then surface
 * - all other classes → surface immediately (never retried)
 *
 * The policy is PURE (does not mutate state); the caller advances counters when
 * it actually performs the action, so these tests advance state explicitly to
 * simulate the caller's loop.
 */

import {
  createRetryState,
  decideRecovery,
  executeRecovery,
  MAX_NETWORK_RETRIES,
  NETWORK_RETRY_BASE_BACKOFF_MS,
  type RecoverableUpdater,
  type RetryState,
} from "../updaterRetryPolicy";
import type { UpdaterErrorType } from "../updateDiagnostics";

/** A minimal mocked electron-updater for the executor tests. */
function mockUpdater(): RecoverableUpdater & {
  downloadUpdate: jest.Mock;
} {
  return {
    disableDifferentialDownload: false,
    downloadUpdate: jest.fn().mockResolvedValue(undefined),
  };
}

describe("createRetryState", () => {
  it("starts with fresh counters", () => {
    expect(createRetryState()).toEqual({
      checksumFallbackUsed: false,
      networkRetryCount: 0,
    });
  });
});

describe("decideRecovery — checksum_mismatch", () => {
  it("first failure → fallback-full (once)", () => {
    const state = createRetryState();
    const d = decideRecovery("checksum_mismatch", state);
    expect(d.action).toBe("fallback-full");
    expect(d.reason).toMatch(/full.*re-download/i);
  });

  it("after the fallback was used → surface (no infinite loop)", () => {
    const state: RetryState = { checksumFallbackUsed: true, networkRetryCount: 0 };
    expect(decideRecovery("checksum_mismatch", state).action).toBe("surface");
  });

  it("is a pure decision — does not mutate the state", () => {
    const state = createRetryState();
    decideRecovery("checksum_mismatch", state);
    expect(state.checksumFallbackUsed).toBe(false);
  });
});

describe("decideRecovery — network_timeout", () => {
  it(`retries exactly ${MAX_NETWORK_RETRIES} times then surfaces (${
    MAX_NETWORK_RETRIES + 1
  } total attempts)`, () => {
    const state = createRetryState();
    const actions: string[] = [];

    // Simulate the caller's loop: decide → (if retry) advance counter → repeat.
    for (let i = 0; i < MAX_NETWORK_RETRIES + 2; i++) {
      const d = decideRecovery("network_timeout", state);
      actions.push(d.action);
      if (d.action === "retry") {
        state.networkRetryCount += 1;
      }
    }

    // First MAX_NETWORK_RETRIES decisions are retries, the rest surface.
    const retries = actions.filter((a) => a === "retry").length;
    expect(retries).toBe(MAX_NETWORK_RETRIES);
    expect(actions[MAX_NETWORK_RETRIES]).toBe("surface");
  });

  it("uses linear backoff (attempt × base)", () => {
    const state = createRetryState();
    const first = decideRecovery("network_timeout", state);
    expect(first.backoffMs).toBe(NETWORK_RETRY_BASE_BACKOFF_MS * 1);

    state.networkRetryCount = 1;
    const second = decideRecovery("network_timeout", state);
    expect(second.backoffMs).toBe(NETWORK_RETRY_BASE_BACKOFF_MS * 2);
  });
});

describe("decideRecovery — non-retryable classes surface immediately", () => {
  const nonRetryable: UpdaterErrorType[] = [
    "signature_codesign",
    "disk_space",
    "permission",
    "manifest_parse",
    "feed_not_found",
    "unknown",
  ];

  it.each(nonRetryable)("%s → surface", (errorType) => {
    const d = decideRecovery(errorType, createRetryState());
    expect(d.action).toBe("surface");
    expect(d.backoffMs).toBe(0);
  });
});

describe("executeRecovery — proves the real re-download (acceptance #3)", () => {
  it("checksum_mismatch: disables differential download AND re-calls downloadUpdate once", () => {
    const state = createRetryState();
    const updater = mockUpdater();
    const decision = decideRecovery("checksum_mismatch", state);

    const recovered = executeRecovery(decision, state, updater);

    expect(recovered).toBe(true);
    expect(updater.disableDifferentialDownload).toBe(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(state.checksumFallbackUsed).toBe(true);

    // A second checksum failure this cycle surfaces (no second re-download).
    const second = decideRecovery("checksum_mismatch", state);
    expect(executeRecovery(second, state, updater)).toBe(false);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("network_timeout: schedules a backoff then re-calls downloadUpdate", () => {
    const state = createRetryState();
    const updater = mockUpdater();
    const schedule = jest.fn((fn: () => void) => fn()); // run immediately
    const decision = decideRecovery("network_timeout", state);

    const recovered = executeRecovery(decision, state, updater, { schedule });

    expect(recovered).toBe(true);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), NETWORK_RETRY_BASE_BACKOFF_MS);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(state.networkRetryCount).toBe(1);
  });

  it("surface decision: takes no action and returns false", () => {
    const state = createRetryState();
    const updater = mockUpdater();
    const decision = decideRecovery("signature_codesign", state);

    expect(executeRecovery(decision, state, updater)).toBe(false);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("calls onAttempt hook for a recovery action", () => {
    const state = createRetryState();
    const updater = mockUpdater();
    const onAttempt = jest.fn();
    const decision = decideRecovery("checksum_mismatch", state);

    executeRecovery(decision, state, updater, { onAttempt });
    expect(onAttempt).toHaveBeenCalledWith(decision);
  });

  it("surfaces (returns false) when the fallback download throws synchronously", () => {
    const state = createRetryState();
    const onError = jest.fn();
    const updater: RecoverableUpdater = {
      disableDifferentialDownload: false,
      downloadUpdate: jest.fn(() => {
        throw new Error("cannot start download");
      }),
    };
    const decision = decideRecovery("checksum_mismatch", state);

    expect(executeRecovery(decision, state, updater, { onError })).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
