/**
 * Tests for useUnlockedTransactionIds (BACKLOG-2090).
 *
 * Proves the batch unlock lookup is FAIL-CLOSED and StrictMode-safe:
 *   - resolves the exact id SET from the bridge;
 *   - a thrown/absent bridge resolves to an EMPTY set (⇒ every row locked);
 *   - StrictMode's dev double-invoke does not corrupt the resolved set.
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { useUnlockedTransactionIds } from "../useUnlockedTransactionIds";

const getUnlockedIdsMock = window.api.entitlement
  .getUnlockedIds as jest.Mock;

const strictWrapper = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);

beforeEach(() => {
  jest.clearAllMocks();
  getUnlockedIdsMock.mockResolvedValue([]);
});

describe("useUnlockedTransactionIds", () => {
  it("starts empty and loading before the fetch resolves", () => {
    getUnlockedIdsMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useUnlockedTransactionIds());
    expect(result.current.loading).toBe(true);
    expect(result.current.unlockedIds.size).toBe(0);
  });

  it("resolves the exact id SET returned by the bridge", async () => {
    getUnlockedIdsMock.mockResolvedValue(["tx-A", "tx-C"]);
    const { result } = renderHook(() => useUnlockedTransactionIds());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Exact-identity assertions (not counts).
    expect(result.current.unlockedIds.has("tx-A")).toBe(true);
    expect(result.current.unlockedIds.has("tx-C")).toBe(true);
    expect(result.current.unlockedIds.has("tx-B")).toBe(false);
    expect([...result.current.unlockedIds].sort()).toEqual(["tx-A", "tx-C"]);
  });

  it("FAIL-CLOSED: a thrown bridge resolves to an EMPTY set", async () => {
    getUnlockedIdsMock.mockRejectedValue(new Error("ipc boom"));
    const { result } = renderHook(() => useUnlockedTransactionIds());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unlockedIds.size).toBe(0);
  });

  it("is StrictMode-safe: double-invoke does not corrupt the set", async () => {
    getUnlockedIdsMock.mockResolvedValue(["tx-A"]);
    const { result } = renderHook(() => useUnlockedTransactionIds(), {
      wrapper: strictWrapper,
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect([...result.current.unlockedIds]).toEqual(["tx-A"]);
  });
});
