/**
 * Tests for the pure self-recovery decision policy (BACKLOG-1905, Deliverable 1
 * + the runtime-blocker fixes B1/B2/B3).
 *
 * Verifies the errorType-keyed recovery matrix:
 * - checksum_mismatch → ONE full-download fallback, then surface
 * - network_timeout   → retry up to N=2 (3 total) with backoff, then surface
 * - all other classes → surface immediately (never retried)
 * - B3: any failure with NO download in flight this cycle → surface immediately
 *
 * And the executor semantics:
 * - B1: the checksum full-download fallback is DEFERRED (via `schedule`), never
 *   invoked inline — a synchronous downloadUpdate() from the error dispatch is a
 *   no-op against electron-updater's `downloadPromise != null` guard.
 * - B2: a rejected/throwing recovery download is routed to `onError` and never
 *   escapes as an unhandled rejection.
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

/** A synchronous `schedule` so deferred work runs immediately within the test. */
function runInlineSchedule(): jest.Mock {
  return jest.fn((fn: () => void) => fn());
}

describe("createRetryState", () => {
  it("starts with fresh counters", () => {
    expect(createRetryState()).toEqual({
      checksumFallbackUsed: false,
      networkRetryCount: 0,
    });
  });
});

describe("decideRecovery — checksum_mismatch (download in flight)", () => {
  it("first failure → fallback-full (once)", () => {
    const state = createRetryState();
    const d = decideRecovery("checksum_mismatch", state, true);
    expect(d.action).toBe("fallback-full");
    expect(d.reason).toMatch(/full.*re-download/i);
  });

  it("after the fallback was used → surface (no infinite loop)", () => {
    const state: RetryState = { checksumFallbackUsed: true, networkRetryCount: 0 };
    expect(decideRecovery("checksum_mismatch", state, true).action).toBe("surface");
  });

  it("is a pure decision — does not mutate the state", () => {
    const state = createRetryState();
    decideRecovery("checksum_mismatch", state, true);
    expect(state.checksumFallbackUsed).toBe(false);
  });
});

describe("decideRecovery — network_timeout (download in flight)", () => {
  it(`retries exactly ${MAX_NETWORK_RETRIES} times then surfaces (${
    MAX_NETWORK_RETRIES + 1
  } total attempts)`, () => {
    const state = createRetryState();
    const actions: string[] = [];

    // Simulate the caller's loop: decide → (if retry) advance counter → repeat.
    for (let i = 0; i < MAX_NETWORK_RETRIES + 2; i++) {
      const d = decideRecovery("network_timeout", state, true);
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
    const first = decideRecovery("network_timeout", state, true);
    expect(first.backoffMs).toBe(NETWORK_RETRY_BASE_BACKOFF_MS * 1);

    state.networkRetryCount = 1;
    const second = decideRecovery("network_timeout", state, true);
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
    const d = decideRecovery(errorType, createRetryState(), true);
    expect(d.action).toBe("surface");
    expect(d.backoffMs).toBe(0);
  });
});

describe("decideRecovery — B3: check-phase failures (no download in flight)", () => {
  it("network_timeout with NO download started → surface (does NOT retry)", () => {
    const state = createRetryState();
    const d = decideRecovery("network_timeout", state, false);
    expect(d.action).toBe("surface");
    expect(d.reason).toMatch(/check-phase|no download in flight/i);
    // Even though a retry budget exists, we must not consume it.
    expect(state.networkRetryCount).toBe(0);
  });

  it("checksum_mismatch with NO download started → surface (does NOT fall back)", () => {
    const state = createRetryState();
    const d = decideRecovery("checksum_mismatch", state, false);
    expect(d.action).toBe("surface");
    expect(state.checksumFallbackUsed).toBe(false);
  });

  it("network_timeout with download started → still retries (regression guard)", () => {
    const d = decideRecovery("network_timeout", createRetryState(), true);
    expect(d.action).toBe("retry");
  });
});

describe("executeRecovery — proves the real re-download (acceptance #3)", () => {
  it("checksum_mismatch: DEFERS the fallback, disables differential, re-calls downloadUpdate once", () => {
    const state = createRetryState();
    const updater = mockUpdater();
    const schedule = runInlineSchedule();
    const decision = decideRecovery("checksum_mismatch", state, true);

    const recovered = executeRecovery(decision, state, updater, { schedule });

    expect(recovered).toBe(true);
    // B1: the fallback is scheduled (deferred), not run inline.
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 0);
    // With the inline schedule the deferred body has now run.
    expect(updater.disableDifferentialDownload).toBe(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(state.checksumFallbackUsed).toBe(true);

    // A second checksum failure this cycle surfaces (no second re-download).
    const second = decideRecovery("checksum_mismatch", state, true);
    expect(executeRecovery(second, state, updater, { schedule })).toBe(false);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("checksum_mismatch: does NOT call downloadUpdate inline before the tick (B1)", () => {
    const state = createRetryState();
    const updater = mockUpdater();
    // Capture the scheduled fn WITHOUT running it — proves inline is a no-op.
    let scheduled: (() => void) | null = null;
    const schedule = jest.fn((fn: () => void) => {
      scheduled = fn;
    });
    const decision = decideRecovery("checksum_mismatch", state, true);

    executeRecovery(decision, state, updater, { schedule });

    // Nothing happened inline.
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.disableDifferentialDownload).toBe(false);

    // Only after the deferred tick fires does the re-download start.
    expect(scheduled).not.toBeNull();
    scheduled!();
    expect(updater.disableDifferentialDownload).toBe(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("network_timeout: schedules a backoff then re-calls downloadUpdate", () => {
    const state = createRetryState();
    const updater = mockUpdater();
    const schedule = runInlineSchedule();
    const decision = decideRecovery("network_timeout", state, true);

    const recovered = executeRecovery(decision, state, updater, { schedule });

    expect(recovered).toBe(true);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), NETWORK_RETRY_BASE_BACKOFF_MS);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(state.networkRetryCount).toBe(1);
  });

  it("surface decision: takes no action and returns false", () => {
    const state = createRetryState();
    const updater = mockUpdater();
    const decision = decideRecovery("signature_codesign", state, true);

    expect(executeRecovery(decision, state, updater)).toBe(false);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("calls onAttempt hook for a recovery action", () => {
    const state = createRetryState();
    const updater = mockUpdater();
    const onAttempt = jest.fn();
    const decision = decideRecovery("checksum_mismatch", state, true);

    executeRecovery(decision, state, updater, { onAttempt, schedule: runInlineSchedule() });
    expect(onAttempt).toHaveBeenCalledWith(decision);
  });
});

describe("executeRecovery — B2: rejected/throwing recovery download is always handled", () => {
  /**
   * The recovery downloadUpdate() returns a REJECTED promise. Assert:
   *   (a) no unhandled rejection — the error is routed to `onError`, and
   *   (b) the fallback is DEFERRED (invoked after a tick, not inline).
   */
  it("checksum_mismatch: rejected downloadUpdate routes to onError and is deferred", async () => {
    const state = createRetryState();
    const rejection = new Error(
      "sha512 mismatch for https://x/keepr.exe?X-Amz-Signature=deadbeef",
    );
    const updater: RecoverableUpdater & { downloadUpdate: jest.Mock } = {
      disableDifferentialDownload: false,
      downloadUpdate: jest.fn().mockRejectedValue(rejection),
    };
    const onError = jest.fn();
    // Defer the scheduled fn so we can assert it did NOT run inline first.
    let scheduled: (() => void) | null = null;
    const schedule = jest.fn((fn: () => void) => {
      scheduled = fn;
    });
    const decision = decideRecovery("checksum_mismatch", state, true);

    const recovered = executeRecovery(decision, state, updater, { schedule, onError });

    // Recovery was accepted (caller must NOT surface yet).
    expect(recovered).toBe(true);
    // (b) DEFERRED — nothing ran inline.
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    // Run the deferred body; downloadUpdate rejects.
    scheduled!();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);

    // (a) The rejection is caught and routed to onError — no unhandled rejection.
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(rejection);
  });

  it("network_timeout: rejected downloadUpdate routes to onError", async () => {
    const state = createRetryState();
    const rejection = new Error("net::ERR_CONNECTION_RESET");
    const updater: RecoverableUpdater & { downloadUpdate: jest.Mock } = {
      disableDifferentialDownload: false,
      downloadUpdate: jest.fn().mockRejectedValue(rejection),
    };
    const onError = jest.fn();
    const decision = decideRecovery("network_timeout", state, true);

    executeRecovery(decision, state, updater, { schedule: runInlineSchedule(), onError });

    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(rejection);
  });

  it("routes a synchronous throw from downloadUpdate to onError", () => {
    const state = createRetryState();
    const onError = jest.fn();
    const updater: RecoverableUpdater = {
      disableDifferentialDownload: false,
      downloadUpdate: jest.fn(() => {
        throw new Error("cannot start download");
      }),
    };
    const decision = decideRecovery("checksum_mismatch", state, true);

    // Recovery is still accepted (deferred); the throw surfaces via onError.
    expect(
      executeRecovery(decision, state, updater, { schedule: runInlineSchedule(), onError }),
    ).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
