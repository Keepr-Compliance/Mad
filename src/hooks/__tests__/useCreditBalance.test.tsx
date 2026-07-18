/**
 * Tests for useCreditBalance (BACKLOG-2090).
 *
 * The persistent credit balance must:
 *   - surface the numeric balance from the bridge;
 *   - resolve to null when unavailable (offline/error) so the chip can HIDE
 *     rather than render a misleading "0 credits";
 *   - be StrictMode-safe.
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { useCreditBalance } from "../useCreditBalance";

const getBalanceMock = window.api.entitlement.getBalance as jest.Mock;

const strictWrapper = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);

beforeEach(() => {
  jest.clearAllMocks();
  getBalanceMock.mockResolvedValue(null);
});

describe("useCreditBalance", () => {
  it("surfaces a numeric balance from the bridge", async () => {
    getBalanceMock.mockResolvedValue(3);
    const { result } = renderHook(() => useCreditBalance());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.balance).toBe(3);
  });

  it("resolves null when the balance is unavailable (chip should hide)", async () => {
    getBalanceMock.mockResolvedValue(null);
    const { result } = renderHook(() => useCreditBalance());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.balance).toBeNull();
  });

  it("resolves null on a thrown bridge (never surfaces a fake 0)", async () => {
    getBalanceMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useCreditBalance());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.balance).toBeNull();
  });

  it("is StrictMode-safe: double-invoke keeps the resolved balance", async () => {
    getBalanceMock.mockResolvedValue(5);
    const { result } = renderHook(() => useCreditBalance(), {
      wrapper: strictWrapper,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.balance).toBe(5);
  });
});
