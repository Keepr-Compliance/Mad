/**
 * BACKLOG-2792 — the Complete button's two decisions.
 *
 *  CONTROL 2 — THE COMPLETENESS GATE. A non-empty queue can never reach the
 *    export or the submit flow. There is no bypass, and the gate re-reads the
 *    count AT CLICK TIME rather than trusting a render-stale prop.
 *    MUTATION RUN: change the gate to `state.count > 1`, and to read a captured
 *    initial count instead of the fresh one → red both times (recorded below).
 *
 *  CONTROL 3 — THE LICENSE BRANCH, both ways. Individual → export. Broker-org
 *    member → submit. And it FAILS CLOSED: anything ambiguous (entitlements
 *    still loading, canSubmit true but no organization) goes to export, because
 *    export is the individual's only completion path and wrongly routing them to
 *    submit removes it. useFeatureGate would have failed OPEN here (`?? true`).
 */
import { renderHook, act } from "@testing-library/react";
import { useCompleteTransaction } from "../useCompleteTransaction";
import { useLicense } from "@/contexts/LicenseContext";

jest.mock("@/contexts/LicenseContext", () => ({ useLicense: jest.fn() }));

const mockUseLicense = useLicense as jest.MockedFunction<typeof useLicense>;

function setLicense(canSubmit: boolean, organizationId: string | null) {
  mockUseLicense.mockReturnValue({
    canSubmit,
    organizationId,
  } as unknown as ReturnType<typeof useLicense>);
}

function setup(count: number, license: { canSubmit: boolean; org: string | null }) {
  setLicense(license.canSubmit, license.org);
  const openExport = jest.fn();
  const openSubmit = jest.fn();
  const openNeedsReview = jest.fn();
  const refreshReviewState = jest.fn().mockResolvedValue({
    items: Array.from({ length: count }, (_, i) => ({ id: `pending:i${i}` })),
    count,
  });
  const hook = renderHook(() =>
    useCompleteTransaction({ refreshReviewState, openExport, openSubmit, openNeedsReview }),
  );
  return { hook, openExport, openSubmit, openNeedsReview, refreshReviewState };
}

describe("CONTROL 2 — the completeness gate", () => {
  it("blocks completion when the queue is not empty, reaching NEITHER flow", async () => {
    const { hook, openExport, openSubmit } = setup(3, { canSubmit: false, org: null });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).not.toHaveBeenCalled();
    expect(openSubmit).not.toHaveBeenCalled();
    // P3 is up, carrying the count the gate actually read.
    expect(hook.result.current.blockedCount).toBe(3);
  });

  it("blocks on a queue of exactly ONE — the off-by-one the gate must not have", async () => {
    const { hook, openExport, openSubmit } = setup(1, { canSubmit: false, org: null });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).not.toHaveBeenCalled();
    expect(openSubmit).not.toHaveBeenCalled();
    expect(hook.result.current.blockedCount).toBe(1);
  });

  it("proceeds once the queue is empty", async () => {
    const { hook, openExport } = setup(0, { canSubmit: false, org: null });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).toHaveBeenCalledTimes(1);
    expect(hook.result.current.blockedCount).toBeNull();
  });

  it("re-reads the count at click time, so a queue that filled since render still blocks", async () => {
    // Renders with an EMPTY queue, then the queue fills before the click. A gate
    // reading a render-time prop would sail through; this one must not.
    setLicense(false, null);
    const openExport = jest.fn();
    const refreshReviewState = jest
      .fn()
      .mockResolvedValueOnce({ items: [], count: 0 })
      .mockResolvedValueOnce({ items: [{ id: "pending:new" }], count: 1 });

    const hook = renderHook(() =>
      useCompleteTransaction({
        refreshReviewState,
        openExport,
        openSubmit: jest.fn(),
        openNeedsReview: jest.fn(),
      }),
    );

    // First click: genuinely empty → proceeds.
    await act(async () => {
      await hook.result.current.requestComplete();
    });
    expect(openExport).toHaveBeenCalledTimes(1);

    // Second click: the service now reports an item → blocked.
    await act(async () => {
      await hook.result.current.requestComplete();
    });
    expect(openExport).toHaveBeenCalledTimes(1);
    expect(hook.result.current.blockedCount).toBe(1);
  });

  it("P3's only affirmative action is Review; Cancel completes nothing", async () => {
    const { hook, openExport, openSubmit, openNeedsReview } = setup(2, {
      canSubmit: false,
      org: null,
    });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    act(() => hook.result.current.reviewFromGate());
    expect(openNeedsReview).toHaveBeenCalledTimes(1);
    expect(hook.result.current.blockedCount).toBeNull();

    await act(async () => {
      await hook.result.current.requestComplete();
    });
    act(() => hook.result.current.cancelGate());

    expect(hook.result.current.blockedCount).toBeNull();
    expect(openExport).not.toHaveBeenCalled();
    expect(openSubmit).not.toHaveBeenCalled();
  });
});

describe("CONTROL 3 — the license branch, both ways", () => {
  it("individual (no broker org) → the export flow", async () => {
    const { hook, openExport, openSubmit } = setup(0, { canSubmit: false, org: null });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).toHaveBeenCalledTimes(1);
    expect(openSubmit).not.toHaveBeenCalled();
    expect(hook.result.current.resolveTarget()).toBe("export");
  });

  it("broker-org member → the submit flow", async () => {
    const { hook, openExport, openSubmit } = setup(0, { canSubmit: true, org: "org-123" });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openSubmit).toHaveBeenCalledTimes(1);
    expect(openExport).not.toHaveBeenCalled();
    expect(hook.result.current.resolveTarget()).toBe("submit");
  });

  it("FAILS CLOSED: canSubmit without an organization goes to export, not submit", async () => {
    // The shape entitlements take while still loading. Routing this user to
    // submit would take away the export that is their only way to complete.
    const { hook, openExport, openSubmit } = setup(0, { canSubmit: true, org: null });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).toHaveBeenCalledTimes(1);
    expect(openSubmit).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED: an organization without canSubmit also goes to export", async () => {
    const { hook, openExport, openSubmit } = setup(0, { canSubmit: false, org: "org-123" });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openExport).toHaveBeenCalledTimes(1);
    expect(openSubmit).not.toHaveBeenCalled();
  });

  it("the gate runs BEFORE the branch — a broker with a full queue reaches neither", async () => {
    const { hook, openExport, openSubmit } = setup(4, { canSubmit: true, org: "org-123" });

    await act(async () => {
      await hook.result.current.requestComplete();
    });

    expect(openSubmit).not.toHaveBeenCalled();
    expect(openExport).not.toHaveBeenCalled();
    expect(hook.result.current.blockedCount).toBe(4);
  });
});
