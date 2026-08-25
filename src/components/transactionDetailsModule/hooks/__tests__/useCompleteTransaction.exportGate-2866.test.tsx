/**
 * BACKLOG-2866 — the details-screen export routes are gated by THE SAME gate as
 * Complete.
 *
 * Three routes reach the export modal from this screen:
 *   1. Complete → export        (individual; gated since BACKLOG-2792)
 *   2. the header Export button (brokerage-only, BACKLOG-2849; was UNGATED)
 *   3. the submit modal's Export offer (downstream of 1; now re-gated)
 *
 * Route 2 was the defect: `onShowExportModal={() => setShowExportModal(true)}`
 * opened the modal without ever consulting review state, so the one class of
 * user with a separate export route — brokerage, whose Complete leads to Submit
 * — was the one class that could produce an audit package containing emails
 * nobody had reviewed.
 *
 * THIS SUITE DOES NOT MOCK `exportReviewGate`. It drives the REAL gate through
 * the hook's bound reader. Mocking the gate here would make the mutate-once
 * control below pass vacuously, and the "one gate, not three" claim would be
 * fiction.
 *
 * CONTROLS RUN (measured red counts recorded in the PR):
 *   - mutate `evaluateExportGate` once (`count > 0` → `count > 999`) → this
 *     suite AND the bulk suite go red together. That is the one-gate proof.
 *   - revert route 2's wiring alone → only route 2's assertions redden.
 *   - revert route 3's wiring alone → only route 3's assertions redden.
 */
import { renderHook, act } from "@testing-library/react";
import { useCompleteTransaction } from "../useCompleteTransaction";
import { useLicense } from "@/contexts/LicenseContext";

jest.mock("@/contexts/LicenseContext", () => ({ useLicense: jest.fn() }));

const mockUseLicense = useLicense as jest.MockedFunction<typeof useLicense>;

function setLicense(canSubmit: boolean, organizationId: string | null): void {
  mockUseLicense.mockReturnValue({
    canSubmit,
    organizationId,
  } as unknown as ReturnType<typeof useLicense>);
}

const queueOf = (n: number) => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `pending:${i}` })),
  count: n,
});

/** Brokerage user — the class that HAS the header Export button. */
function setupBrokerage(queueCount: number) {
  setLicense(true, "org-1");
  const openExport = jest.fn();
  const openSubmit = jest.fn();
  const openNeedsReview = jest.fn();
  const refreshReviewState = jest.fn().mockResolvedValue(queueOf(queueCount));
  const hook = renderHook(() =>
    useCompleteTransaction({
      transactionId: "tx-2866",
      refreshReviewState,
      openExport,
      openSubmit,
      openNeedsReview,
    }),
  );
  return { hook, openExport, openSubmit, openNeedsReview, refreshReviewState };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ROUTE 2 — the brokerage-only header Export button", () => {
  it("BLOCKS on a non-empty queue: the block fires and NO export starts", async () => {
    const { hook, openExport, openSubmit, refreshReviewState } = setupBrokerage(4);

    await act(async () => {
      await hook.result.current.requestExport();
    });

    // The block FIRED — not merely "a modal did not open". The P3 dialog is
    // driven by blockedCount, and it carries the count the gate actually read.
    expect(hook.result.current.blockedCount).toBe(4);
    // The export never started.
    expect(openExport).not.toHaveBeenCalled();
    expect(openSubmit).not.toHaveBeenCalled();
    // And it was read at click time, from the service.
    expect(refreshReviewState).toHaveBeenCalledTimes(1);
  });

  it("PROCEEDS on an empty queue — the gate is a gate, not a wall", async () => {
    const { hook, openExport, openSubmit } = setupBrokerage(0);

    await act(async () => {
      await hook.result.current.requestExport();
    });

    expect(openExport).toHaveBeenCalledTimes(1);
    expect(hook.result.current.blockedCount).toBeNull();
    // Export, NOT submit — requestExport has no license branch.
    expect(openSubmit).not.toHaveBeenCalled();
  });

  it("BLOCKS when the queue cannot be read, without claiming a count", async () => {
    setLicense(true, "org-1");
    const openExport = jest.fn();
    const refreshReviewState = jest.fn().mockRejectedValue(new Error("IPC down"));
    const hook = renderHook(() =>
      useCompleteTransaction({
        transactionId: "tx-2866",
        refreshReviewState,
        openExport,
        openSubmit: jest.fn(),
        openNeedsReview: jest.fn(),
      }),
    );

    await act(async () => {
      await hook.result.current.requestExport();
    });

    expect(hook.result.current.blockedCount).toBe(-1);
    expect(openExport).not.toHaveBeenCalled();
  });

  it("re-reads AT CLICK TIME: a queue that filled since mount blocks the second click", async () => {
    // A render-stale gate would sail through here. This is the failure mode
    // BACKLOG-2792 called out, re-asserted for the export route.
    setLicense(true, "org-1");
    const openExport = jest.fn();
    const refreshReviewState = jest
      .fn()
      .mockResolvedValueOnce(queueOf(0))
      .mockResolvedValueOnce(queueOf(1));
    const hook = renderHook(() =>
      useCompleteTransaction({
        transactionId: "tx-2866",
        refreshReviewState,
        openExport,
        openSubmit: jest.fn(),
        openNeedsReview: jest.fn(),
      }),
    );

    await act(async () => {
      await hook.result.current.requestExport();
    });
    expect(openExport).toHaveBeenCalledTimes(1);

    await act(async () => {
      await hook.result.current.requestExport();
    });
    expect(openExport).toHaveBeenCalledTimes(1); // still 1 — the second was refused
    expect(hook.result.current.blockedCount).toBe(1);
  });
});

describe("ROUTE 3 — the submit modal's Export offer", () => {
  // The offer is reached only after Complete's gate passed, but the modal can
  // sit open while a background sync queues new items. The queue it was cleared
  // against is not the queue at click time.
  it("BLOCKS when the queue filled while the submit modal was open", async () => {
    setLicense(true, "org-1");
    const openExport = jest.fn();
    const openSubmit = jest.fn();
    const refreshReviewState = jest
      .fn()
      .mockResolvedValueOnce(queueOf(0)) // Complete passed, submit modal opened
      .mockResolvedValueOnce(queueOf(2)); // a sync queued 2 while it sat open
    const hook = renderHook(() =>
      useCompleteTransaction({
        transactionId: "tx-2866",
        refreshReviewState,
        openExport,
        openSubmit,
        openNeedsReview: jest.fn(),
      }),
    );

    await act(async () => {
      await hook.result.current.requestComplete();
    });
    expect(openSubmit).toHaveBeenCalledTimes(1);

    // The user now clicks "Export" inside the submit modal.
    await act(async () => {
      await hook.result.current.requestExport();
    });

    expect(hook.result.current.blockedCount).toBe(2);
    expect(openExport).not.toHaveBeenCalled();
  });

  it("PROCEEDS when the queue is still empty", async () => {
    const { hook, openExport, openSubmit } = setupBrokerage(0);

    await act(async () => {
      await hook.result.current.requestComplete();
    });
    expect(openSubmit).toHaveBeenCalledTimes(1);

    await act(async () => {
      await hook.result.current.requestExport();
    });
    expect(openExport).toHaveBeenCalledTimes(1);
  });
});

describe("ROUTE 1 — Complete still gated, by the SAME gate", () => {
  it("blocks Complete on a non-empty queue, reaching neither flow", async () => {
    const { hook, openExport, openSubmit } = setupBrokerage(3);

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(hook.result.current.blockedCount).toBe(3);
    expect(openExport).not.toHaveBeenCalled();
    expect(openSubmit).not.toHaveBeenCalled();
  });

  it("an individual's Complete still reaches export on an empty queue", async () => {
    setLicense(false, null);
    const openExport = jest.fn();
    const openSubmit = jest.fn();
    const hook = renderHook(() =>
      useCompleteTransaction({
        transactionId: "tx-2866",
        refreshReviewState: jest.fn().mockResolvedValue(queueOf(0)),
        openExport,
        openSubmit,
        openNeedsReview: jest.fn(),
      }),
    );

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).toHaveBeenCalledTimes(1);
    expect(openSubmit).not.toHaveBeenCalled();
  });

  it("Complete and Export block on the SAME queue read — one gate", async () => {
    // Both routes, one hook, one blockedCount, one dialog. If these ever
    // disagree, two gates have been built.
    const { hook, openExport, openSubmit } = setupBrokerage(5);

    await act(async () => {
      await hook.result.current.requestComplete();
    });
    const afterComplete = hook.result.current.blockedCount;

    await act(async () => {
      hook.result.current.cancelGate();
    });
    await act(async () => {
      await hook.result.current.requestExport();
    });
    const afterExport = hook.result.current.blockedCount;

    expect(afterComplete).toBe(5);
    expect(afterExport).toBe(5);
    expect(openExport).not.toHaveBeenCalled();
    expect(openSubmit).not.toHaveBeenCalled();
  });
});
