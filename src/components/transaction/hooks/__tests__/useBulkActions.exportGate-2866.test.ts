/**
 * BACKLOG-2866 — ROUTE 4: Bulk Export is gated by THE SAME gate as Complete.
 *
 * The highest-risk route. The user is exporting deals they never opened, so an
 * unreviewed email is easiest to miss here, and one blocked deal must not
 * silently degrade the batch.
 *
 * THE DECISION, ASSERTED: one blocked deal blocks the WHOLE batch and nothing
 * is written. Excluding the blocked deals and exporting the rest was rejected —
 * it does not force the review the founder's rule requires, it makes one click
 * mean two different things depending on the selection, and a set of packages
 * silently missing deals under a "Successfully exported 4 transactions" toast
 * is exactly the defect this item is about.
 *
 * THIS SUITE DOES NOT MOCK `exportReviewGate`. It drives the REAL gate through
 * `window.api.transactions.getReviewState`. Mocking the gate would make the
 * mutate-once control pass vacuously.
 */
import { renderHook, act } from "@testing-library/react";
import { useBulkActions } from "../useBulkActions";

const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const getReviewStateMock = window.api.transactions.getReviewState as jest.Mock;

const PAYWALL = "PAYWALL_LOCKED: This transaction is locked. Unlock it to export.";

const ADDRESSES: Record<string, string> = {
  "tx-a": "123 Main St",
  "tx-b": "45 Oak Ave",
  "tx-c": "9 Elm Rd",
  "tx-locked": "77 Pine Way",
};

const makeCallbacks = () => ({
  onComplete: jest.fn().mockResolvedValue(undefined),
  showError: jest.fn(),
  exitSelectionMode: jest.fn(),
  closeBulkDeleteModal: jest.fn(),
  closeBulkExportModal: jest.fn(),
  labelForTransaction: (id: string) => ADDRESSES[id],
});

/** Drive the REAL gate: an id→queue-count map behind the real IPC surface. */
function setQueues(counts: Record<string, number>): void {
  getReviewStateMock.mockImplementation(async (id: string) => {
    const n = counts[id] ?? 0;
    return { items: Array.from({ length: n }, (_, i) => ({ id: `p:${i}` })), count: n };
  });
}

/** The exact id SET that reached the exporter. */
function exportedIds(): Set<string> {
  return new Set(exportEnhancedMock.mock.calls.map((c) => c[0] as string));
}

beforeEach(() => {
  jest.clearAllMocks();
  setQueues({});
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/x" });
});

describe("bulk export — blocked direction", () => {
  it("one blocked deal among three blocks the ENTIRE batch: exported id set is EMPTY", async () => {
    setQueues({ "tx-b": 2 });
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b", "tx-c"]), 3, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    // The export never started — by id SET, not by count.
    expect(exportedIds()).toEqual(new Set<string>());
    expect(exportEnhancedMock).not.toHaveBeenCalled();
    // The block FIRED, and it is not dressed as a success.
    expect(cb.showError).toHaveBeenCalledTimes(1);
    expect(result.current.bulkActionSuccess).toBeNull();
    expect(cb.onComplete).not.toHaveBeenCalled();
  });

  it("the refusal NAMES the blocked deal, and not the clean ones", async () => {
    setQueues({ "tx-b": 2 });
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b", "tx-c"]), 3, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    const message = cb.showError.mock.calls[0][0] as string;
    expect(message).toContain("45 Oak Ave (2)");
    // The clean deals are not blamed.
    expect(message).not.toContain("123 Main St");
    expect(message).not.toContain("9 Elm Rd");
    // Same sentence the details-screen P3 dialog shows.
    expect(message).toContain(
      "that need to be reviewed before completing the transaction",
    );
  });

  it("names EVERY blocked deal when several are blocked", async () => {
    setQueues({ "tx-a": 3, "tx-c": 1 });
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b", "tx-c"]), 3, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    const message = cb.showError.mock.calls[0][0] as string;
    expect(message).toContain("123 Main St (3)");
    expect(message).toContain("9 Elm Rd (1)");
    expect(exportedIds()).toEqual(new Set<string>());
  });

  it("keeps the selection so the user can retry after reviewing", async () => {
    setQueues({ "tx-b": 1 });
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b"]), 2, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    expect(cb.exitSelectionMode).not.toHaveBeenCalled();
    expect(cb.closeBulkExportModal).toHaveBeenCalled();
    expect(result.current.isBulkExporting).toBe(false);
  });

  it("an unreadable queue blocks the batch too, without claiming a count", async () => {
    getReviewStateMock.mockRejectedValue(new Error("IPC down"));
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b"]), 2, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    expect(exportedIds()).toEqual(new Set<string>());
    const message = cb.showError.mock.calls[0][0] as string;
    // The unreadable BODY, reused verbatim from the P3 dialog — it reports that
    // the queue could not be read rather than asserting a count it does not
    // have. (The dialog's "Couldn't check Needs Review" is its TITLE; the bulk
    // route has no dialog, only this one sentence.)
    expect(message).toContain("until the review queue can be read");
    expect(message).toContain("123 Main St (couldn't check)");
    expect(message).not.toMatch(/You have -\d/);
  });
});

describe("bulk export — allowed direction", () => {
  it("every queue empty ⇒ every selected deal exports: exact id SET", async () => {
    setQueues({});
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b", "tx-c"]), 3, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    expect(exportedIds()).toEqual(new Set(["tx-a", "tx-b", "tx-c"]));
    expect(cb.showError).not.toHaveBeenCalled();
    expect(result.current.bulkActionSuccess).toContain(
      "Successfully exported 3 transactions",
    );
  });

  it("the gate reads EVERY selected deal, not just the first", async () => {
    // A gate that short-circuited on the first clean read would let a blocked
    // deal at position 3 through.
    setQueues({});
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b", "tx-c"]), 3, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    expect(new Set(getReviewStateMock.mock.calls.map((c) => c[0] as string))).toEqual(
      new Set(["tx-a", "tx-b", "tx-c"]),
    );
  });
});

describe("precedence — the review gate runs BEFORE the BACKLOG-2075 locked loop", () => {
  it("mixed selection (review-blocked + locked + clean) blocks outright, zero exports", async () => {
    // Pins the ordering. If review were checked INSIDE the loop it would be
    // counted as one more per-deal failure and the batch would partially
    // export — the silent degradation this gate exists to prevent.
    setQueues({ "tx-b": 2 });
    exportEnhancedMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "tx-locked"
          ? { success: false, error: PAYWALL }
          : { success: true, path: "/out/x" },
      ),
    );
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b", "tx-locked"]), 3, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    expect(exportEnhancedMock).not.toHaveBeenCalled();
    const message = cb.showError.mock.calls[0][0] as string;
    expect(message).toContain("45 Oak Ave (2)");
    // The refusal is about REVIEW, not the paywall.
    expect(message).not.toContain("locked");
  });

  it("BACKLOG-2075 locked-exclusion is untouched once the review gate passes", async () => {
    // The clean path must behave exactly as it did before the gate existed:
    // locked deals excluded, the rest exported, reported separately.
    setQueues({});
    exportEnhancedMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "tx-locked"
          ? { success: false, error: PAYWALL }
          : { success: true, path: "/out/x" },
      ),
    );
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-locked"]), 2, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    expect(exportedIds()).toEqual(new Set(["tx-a", "tx-locked"]));
    expect(result.current.bulkActionSuccess).toContain(
      "Successfully exported 1 transaction",
    );
    expect(result.current.bulkActionSuccess).toContain("1 locked — unlock to include");
  });
});
