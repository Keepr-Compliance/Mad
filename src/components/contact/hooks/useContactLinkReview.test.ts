/**
 * BACKLOG-2410 — the review-queue count and provenance hooks.
 *
 * THE PROPERTY UNDER TEST IS THE DIAGNOSTIC, NOT THE FALLBACK.
 *
 * Both hooks fall back to an empty result when the IPC call fails, and both
 * fallbacks are correct: a wrong number on a review surface is worse than a
 * missing button, and an empty source list simply hides the Sources section.
 *
 * What was wrong — and what SR flagged on #2183 — is that the fallback was
 * SILENT. A broken channel then looks exactly like a healthy empty queue, on
 * the one screen whose job is to let a user find a wrong merge. That is the
 * BACKLOG-1898 shape.
 *
 * So these tests assert the log line, not just the state.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { useReviewQueueCount, useContactSources } from "./useContactLinkReview";
import logger from "../../../utils/logger";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const warn = logger.warn as jest.Mock;
const USER = "u1";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useReviewQueueCount", () => {
  it("reports the count on success and logs nothing", async () => {
    window.api.contacts.getReviewQueueCount.mockResolvedValue({ success: true, count: 7 });

    const { result } = renderHook(() => useReviewQueueCount(USER));

    await waitFor(() => expect(result.current.count).toBe(7));
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to 0 AND logs when the channel reports failure", async () => {
    window.api.contacts.getReviewQueueCount.mockResolvedValue({
      success: false,
      error: "no local user",
    });

    const { result } = renderHook(() => useReviewQueueCount(USER));

    await waitFor(() => expect(result.current.count).toBe(0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("review queue count unavailable");
    expect(warn.mock.calls[0][0]).toContain("no local user");
  });

  /**
   * NEGATIVE CONTROL RUN: removed the `logger.warn` from the catch block.
   * Observed: 1 failed / 7 passed — this test, on `warn` never being called,
   * while the fallback assertion stayed green. That split is the whole point:
   * the value was already right, the silence was the defect.
   */
  it("falls back to 0 AND logs when the call throws", async () => {
    window.api.contacts.getReviewQueueCount.mockRejectedValue(new Error("channel closed"));

    const { result } = renderHook(() => useReviewQueueCount(USER));

    await waitFor(() => expect(result.current.count).toBe(0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("review queue count failed");
    expect(warn.mock.calls[0][0]).toContain("channel closed");
  });

  it("starts as null so a transient 'Review 0' never renders", () => {
    window.api.contacts.getReviewQueueCount.mockResolvedValue({ success: true, count: 3 });
    const { result } = renderHook(() => useReviewQueueCount(USER));
    // Synchronously after mount, before the promise resolves.
    expect(result.current.count).toBeNull();
  });
});

describe("useContactSources", () => {
  it("returns the sources on success and logs nothing", async () => {
    window.api.contacts.getSources.mockResolvedValue({
      success: true,
      sources: [{ linkId: "l-1" }, { linkId: "l-2" }],
    });

    const { result } = renderHook(() => useContactSources(USER, "c-1"));

    await waitFor(() => expect(result.current.sources.map((s) => s.linkId)).toEqual(["l-1", "l-2"]));
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to [] AND logs when the channel reports failure", async () => {
    window.api.contacts.getSources.mockResolvedValue({ success: false, error: "bad contact id" });

    const { result } = renderHook(() => useContactSources(USER, "c-1"));

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(result.current.sources).toEqual([]);
    expect(warn.mock.calls[0][0]).toContain("contact sources unavailable");
    expect(warn.mock.calls[0][0]).toContain("bad contact id");
  });

  it("falls back to [] AND logs when the call throws", async () => {
    window.api.contacts.getSources.mockRejectedValue(new Error("channel closed"));

    const { result } = renderHook(() => useContactSources(USER, "c-1"));

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(result.current.sources).toEqual([]);
    expect(warn.mock.calls[0][0]).toContain("contact sources load failed");
  });

  it("does not call IPC at all for a null contact — that is not a failure", async () => {
    const { result } = renderHook(() => useContactSources(USER, null));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(window.api.contacts.getSources).not.toHaveBeenCalled();
    expect(result.current.sources).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
