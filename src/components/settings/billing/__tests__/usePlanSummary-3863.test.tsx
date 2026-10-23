/**
 * BACKLOG-3863 — usePlanSummary (the hook slice 3's Plan & Billing card uses).
 *
 *   - reads the summary once on mount;
 *   - "Manage billing" arms a one-shot: the next window focus calls
 *     billing:refresh exactly once and shows its answer;
 *   - a second focus does nothing; a focus with nothing armed does nothing;
 *   - a failed open does not arm, and reports the allowed address.
 *
 * DTO fixture: transcribed from slice 1's route test
 * (planSummaryRoute.test.ts, "returns the caller's plan"); the ending variant
 * is its cancel_pending case (state cancel_pending, cancel_at_period_end true).
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { usePlanSummary } from "../usePlanSummary";

const ACTIVE = {
  state: "active" as const,
  interval: "month",
  current_period_end: "2026-11-10T18:47:55+00:00",
  cancel_at_period_end: false,
  paymentIncomplete: false,
  supportGrantEffective: false,
};
const ENDING = { ...ACTIVE, state: "cancel_pending" as const, cancel_at_period_end: true };

const billing = () => jest.mocked(window.api.billing);

function focusWindow(): void {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  billing().getPlanSummary.mockResolvedValue({ unavailable: false, summary: ACTIVE });
  billing().refresh.mockResolvedValue({ unavailable: false, summary: ENDING });
  billing().openPortal.mockResolvedValue({ success: true });
});

describe("BACKLOG-3863 — usePlanSummary", () => {
  it("reads the summary once on mount", async () => {
    const { result } = renderHook(() => usePlanSummary());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.summary).toEqual(ACTIVE);
    expect(result.current.unavailable).toBe(false);
    expect(billing().getPlanSummary).toHaveBeenCalledTimes(1);
    expect(billing().refresh).not.toHaveBeenCalled();
  });

  it("unavailable → no summary, flagged unavailable", async () => {
    billing().getPlanSummary.mockResolvedValueOnce({ unavailable: true });
    const { result } = renderHook(() => usePlanSummary());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.summary).toBeNull();
    expect(result.current.unavailable).toBe(true);
  });

  it("a thrown IPC call reads as unavailable, not a plan", async () => {
    billing().getPlanSummary.mockRejectedValueOnce(new Error("ipc gone"));
    const { result } = renderHook(() => usePlanSummary());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.summary).toBeNull();
    expect(result.current.unavailable).toBe(true);
  });

  it("focus with nothing armed does nothing", async () => {
    const { result } = renderHook(() => usePlanSummary());
    await waitFor(() => expect(result.current.loading).toBe(false));
    focusWindow();
    focusWindow();
    expect(billing().refresh).not.toHaveBeenCalled();
  });

  it("after Manage billing, the next focus refreshes once and shows the fresh answer; a second focus does not", async () => {
    const { result } = renderHook(() => usePlanSummary());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.openBillingPortal();
    });
    expect(billing().openPortal).toHaveBeenCalledTimes(1);
    expect(billing().openPortal.mock.calls[0]).toEqual([]);
    expect(billing().refresh).not.toHaveBeenCalled(); // opening alone does not refresh

    focusWindow();
    await waitFor(() => expect(result.current.summary).toEqual(ENDING));
    expect(billing().refresh).toHaveBeenCalledTimes(1);

    focusWindow();
    focusWindow();
    expect(billing().refresh).toHaveBeenCalledTimes(1);
    expect(billing().getPlanSummary).toHaveBeenCalledTimes(1); // no polling
  });

  it("a page that did not open does not arm, and reports the allowed address", async () => {
    billing().openPortal.mockResolvedValueOnce({
      success: false,
      error: "The browser couldn't be opened.",
      portalAddress: "https://app.keeprcompliance.com",
    });
    const { result } = renderHook(() => usePlanSummary());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.openBillingPortal();
    });
    expect(result.current.openFailed).toBe(true);
    expect(result.current.openFailedAddress).toBe("https://app.keeprcompliance.com");
    focusWindow();
    expect(billing().refresh).not.toHaveBeenCalled();
  });
});
