/**
 * BACKLOG-2305 — useAuditCoverageCheck.runMessagesImport reliability contract.
 *
 * The audit-coverage popup disables BOTH buttons purely off the hook's
 * `importing` flag, so the hook MUST guarantee `importing` always returns to
 * false — even when the coverage IPC resolution is lost (the observed hang:
 * backend completed, renderer never notified). Verifies:
 *   - normal completion re-enables + returns the floor
 *   - a never-resolving IPC trips the failsafe watchdog (timedOut) and re-enables
 *   - progress activity re-arms the idle watchdog (a live import never trips it)
 *   - an IPC rejection re-enables with an error (not stuck)
 *   - a per-pass 0→100 reset flips to indeterminate (no visible looping bar)
 */
import { renderHook, act } from "@testing-library/react";
import {
  useAuditCoverageCheck,
  IMPORT_IDLE_FAILSAFE_MS,
  IMPORT_HARD_CAP_MS,
  type CoverageImportProgress,
} from "../useAuditCoverageCheck";

const ensureMock = () =>
  window.api.transactions.ensureMessagesCoverage as jest.Mock;
const onProgressMock = () => window.api.messages.onImportProgress as jest.Mock;

/** Wire onImportProgress to capture the subscriber so tests can emit events. */
function captureProgress(): { emit: (p: CoverageImportProgress) => void; unsub: jest.Mock } {
  const unsub = jest.fn();
  let cb: ((p: CoverageImportProgress) => void) | undefined;
  onProgressMock().mockImplementation((fn: (p: CoverageImportProgress) => void) => {
    cb = fn;
    return unsub;
  });
  return {
    emit: (p) => cb?.(p),
    unsub,
  };
}

const OK_RESULT = {
  success: true,
  ran: true,
  importRan: true,
  reason: "date-change",
  imported: 5,
  messagesFloorISO: "2025-01-01T00:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  ensureMock().mockReset().mockResolvedValue(OK_RESULT);
  onProgressMock().mockReset().mockReturnValue(jest.fn());
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useAuditCoverageCheck.runMessagesImport (BACKLOG-2305)", () => {
  it("resolves and re-enables (importing→false) on normal completion", async () => {
    const { result } = renderHook(() => useAuditCoverageCheck("u1"));

    let outcome: Awaited<ReturnType<typeof result.current.runMessagesImport>> | undefined;
    await act(async () => {
      outcome = await result.current.runMessagesImport("2025-01-01T00:00:00.000Z", "t1");
    });

    expect(outcome).toMatchObject({
      ran: true,
      importRan: true,
      floorISO: "2025-01-01T00:00:00.000Z",
    });
    expect(outcome?.timedOut).toBeUndefined();
    expect(result.current.importing).toBe(false);
  });

  it("FAILSAFE: a never-resolving coverage IPC still re-enables the buttons (timedOut)", async () => {
    jest.useFakeTimers();
    // The IPC promise never settles — the exact hang the founder hit.
    ensureMock().mockReturnValue(new Promise<never>(() => {}));
    const { result } = renderHook(() => useAuditCoverageCheck("u1"));

    let outcomePromise: Promise<Awaited<ReturnType<typeof result.current.runMessagesImport>>>;
    act(() => {
      outcomePromise = result.current.runMessagesImport("2025-01-01T00:00:00.000Z", "t1");
    });
    expect(result.current.importing).toBe(true);

    // No progress + no resolution for the idle window → watchdog trips.
    await act(async () => {
      jest.advanceTimersByTime(IMPORT_IDLE_FAILSAFE_MS + 1000);
    });

    const outcome = await outcomePromise!;
    expect(outcome.timedOut).toBe(true);
    expect(result.current.importing).toBe(false);
  });

  it("idle watchdog is RE-ARMED by progress — a live import never trips it, then fires once idle", async () => {
    jest.useFakeTimers();
    ensureMock().mockReturnValue(new Promise<never>(() => {}));
    const progress = captureProgress();
    const { result } = renderHook(() => useAuditCoverageCheck("u1"));

    let outcomePromise: Promise<Awaited<ReturnType<typeof result.current.runMessagesImport>>>;
    act(() => {
      outcomePromise = result.current.runMessagesImport("2025-01-01T00:00:00.000Z", "t1");
    });

    // Progress keeps arriving just under the idle window → never trips.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        jest.advanceTimersByTime(IMPORT_IDLE_FAILSAFE_MS - 1000);
        progress.emit({ phase: "importing", current: i, total: 100, percent: i });
      });
      expect(result.current.importing).toBe(true);
    }

    // Activity stops → after one full idle window the watchdog fires.
    await act(async () => {
      jest.advanceTimersByTime(IMPORT_IDLE_FAILSAFE_MS + 1000);
    });
    const outcome = await outcomePromise!;
    expect(outcome.timedOut).toBe(true);
    expect(result.current.importing).toBe(false);
  });

  it("hard cap is the ultimate ceiling even if progress keeps streaming", async () => {
    jest.useFakeTimers();
    ensureMock().mockReturnValue(new Promise<never>(() => {}));
    const progress = captureProgress();
    const { result } = renderHook(() => useAuditCoverageCheck("u1"));

    let outcomePromise: Promise<Awaited<ReturnType<typeof result.current.runMessagesImport>>>;
    act(() => {
      outcomePromise = result.current.runMessagesImport("2025-01-01T00:00:00.000Z", "t1");
    });

    // Stream progress continuously so the idle watchdog is perpetually re-armed;
    // the hard cap must still eventually re-enable the UI.
    const step = 30_000;
    for (let elapsed = 0; elapsed < IMPORT_HARD_CAP_MS + step; elapsed += step) {
      await act(async () => {
        jest.advanceTimersByTime(step);
        progress.emit({ phase: "importing", current: 1, total: 100, percent: 50 });
      });
    }

    const outcome = await outcomePromise!;
    expect(outcome.timedOut).toBe(true);
    expect(result.current.importing).toBe(false);
  });

  it("an IPC rejection re-enables with an error (not stuck, not timedOut)", async () => {
    ensureMock().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useAuditCoverageCheck("u1"));

    let outcome: Awaited<ReturnType<typeof result.current.runMessagesImport>> | undefined;
    await act(async () => {
      outcome = await result.current.runMessagesImport("2025-01-01T00:00:00.000Z", "t1");
    });

    expect(outcome?.error).toBe("boom");
    expect(outcome?.timedOut).toBeUndefined();
    expect(result.current.importing).toBe(false);
  });

  it("flips to INDETERMINATE when a pass resets (0→100 loop) instead of looping the bar", async () => {
    let resolveIpc: (v: typeof OK_RESULT) => void = () => {};
    ensureMock().mockReturnValue(
      new Promise<typeof OK_RESULT>((res) => {
        resolveIpc = res;
      }),
    );
    const progress = captureProgress();
    const { result } = renderHook(() => useAuditCoverageCheck("u1"));

    let outcomePromise: Promise<Awaited<ReturnType<typeof result.current.runMessagesImport>>>;
    act(() => {
      outcomePromise = result.current.runMessagesImport("2025-01-01T00:00:00.000Z", "t1");
    });

    // First pass climbs — still determinate.
    act(() => progress.emit({ phase: "importing", current: 95, total: 100, percent: 95 }));
    expect(result.current.indeterminate).toBe(false);

    // A new pass resets the percentage → indeterminate for the rest of the op.
    act(() => progress.emit({ phase: "importing", current: 1, total: 100, percent: 1 }));
    expect(result.current.indeterminate).toBe(true);

    await act(async () => {
      resolveIpc(OK_RESULT);
      await outcomePromise!;
    });
    // Reset for the next run.
    expect(result.current.importing).toBe(false);
    expect(result.current.indeterminate).toBe(false);
  });
});
