/**
 * BACKLOG-3302 keep-control. useTermsHandlers loses its dead
 * `pendingOAuthData` branches; what remains is the live terms path. Measured
 * before this file: dropping `await declineTerms()` left 525 suites green.
 *
 * Mutations: decline no longer calls declineTerms; accept writes for a
 * different user; accept skips clearTermsRequirement -> red.
 */
import { act, renderHook } from "@testing-library/react";

const mockAcceptTermsToSupabase = jest.fn();
jest.mock("@/services", () => ({
  authService: { acceptTermsToSupabase: (...a: unknown[]) => mockAcceptTermsToSupabase(...a) },
}));

import { useTermsHandlers } from "../useTermsHandlers";

function setup(currentUserId: string | null) {
  const clearTermsRequirement = jest.fn();
  const declineTerms = jest.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useTermsHandlers({ currentUserId, clearTermsRequirement, declineTerms }),
  );
  return { result, clearTermsRequirement, declineTerms };
}

describe("useTermsHandlers (BACKLOG-3302)", () => {
  beforeEach(() => mockAcceptTermsToSupabase.mockReset());

  it("decline calls declineTerms once", async () => {
    const t = setup("user-1");
    await act(() => t.result.current.handleDeclineTerms());
    expect(t.declineTerms).toHaveBeenCalledTimes(1);
  });

  it("accept writes for the signed-in user and clears the requirement", async () => {
    mockAcceptTermsToSupabase.mockResolvedValue({ success: true });
    const t = setup("user-1");
    await act(() => t.result.current.handleAcceptTerms());
    expect(mockAcceptTermsToSupabase).toHaveBeenCalledWith("user-1");
    expect(t.clearTermsRequirement).toHaveBeenCalledTimes(1);
  });

  it("accept with no signed-in user throws and writes nothing", async () => {
    const t = setup(null);
    await expect(t.result.current.handleAcceptTerms()).rejects.toThrow("No user ID");
    expect(mockAcceptTermsToSupabase).not.toHaveBeenCalled();
    expect(t.clearTermsRequirement).not.toHaveBeenCalled();
  });
});
