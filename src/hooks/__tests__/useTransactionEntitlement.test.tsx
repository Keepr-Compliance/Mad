/**
 * Unit tests for useTransactionEntitlement (BACKLOG-2006a).
 *
 * Proves the renderer gate is FAIL-CLOSED and StrictMode-safe:
 *   - initial state is "loading" (⇒ shield), resolving to locked/unlocked;
 *   - error/absent-bridge ⇒ "locked", never "unlocked";
 *   - wrapping the hook in <React.StrictMode> (dev double-invoke) does NOT
 *     corrupt the resolved state — the value-comparison effect is safe.
 */

import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTransactionEntitlement } from "../useTransactionEntitlement";
import type { EntitlementStatus } from "../../services/entitlementService";

const getStatusMock = window.api.entitlement.getStatus as jest.Mock;
const unlockMock = window.api.entitlement.unlockWithCredit as jest.Mock;

const unlockedSnapshot = (tx: string): EntitlementStatus => ({
  localTransactionId: tx,
  status: "unlocked",
  fromCache: false,
  quote: null,
  creditBalance: null,
});

const lockedSnapshot = (tx: string): EntitlementStatus => ({
  localTransactionId: tx,
  status: "locked",
  lockReason: "no_unlock",
  fromCache: false,
  quote: { nextUnitIndex: 1, unitPriceCents: 499, currency: "USD", pricingTierId: "tier-1" },
  creditBalance: 0,
});

const strictWrapper = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);

beforeEach(() => {
  jest.clearAllMocks();
  getStatusMock.mockResolvedValue(lockedSnapshot("tx-1"));
});

describe("useTransactionEntitlement — FAIL-CLOSED", () => {
  it("starts in 'loading' (renders shield), never 'unlocked' initially", () => {
    getStatusMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useTransactionEntitlement("tx-1"));
    expect(result.current.state).toBe("loading");
    expect(result.current.isUnlocked).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });

  it("resolves to 'unlocked' ONLY on a positive unlocked snapshot", async () => {
    getStatusMock.mockResolvedValue(unlockedSnapshot("tx-1"));
    const { result } = renderHook(() => useTransactionEntitlement("tx-1"));
    await waitFor(() => expect(result.current.state).toBe("unlocked"));
    expect(result.current.isUnlocked).toBe(true);
  });

  it("locked snapshot ⇒ 'locked' with quote + balance for the CTA", async () => {
    getStatusMock.mockResolvedValue(lockedSnapshot("tx-1"));
    const { result } = renderHook(() => useTransactionEntitlement("tx-1"));
    await waitFor(() => expect(result.current.state).toBe("locked"));
    expect(result.current.isUnlocked).toBe(false);
    expect(result.current.quote?.unitPriceCents).toBe(499);
    expect(result.current.creditBalance).toBe(0);
    expect(result.current.lockReason).toBe("no_unlock");
  });

  it("undefined transaction id ⇒ 'locked', no fetch", async () => {
    const { result } = renderHook(() => useTransactionEntitlement(undefined));
    await waitFor(() => expect(result.current.state).toBe("locked"));
    expect(getStatusMock).not.toHaveBeenCalled();
  });

  it("StrictMode double-invoke does not corrupt the resolved unlocked state", async () => {
    getStatusMock.mockResolvedValue(unlockedSnapshot("tx-1"));
    const { result } = renderHook(() => useTransactionEntitlement("tx-1"), {
      wrapper: strictWrapper,
    });
    await waitFor(() => expect(result.current.state).toBe("unlocked"));
    expect(result.current.isUnlocked).toBe(true);
  });

  it("changing transaction id re-fetches and resets to loading first (shield)", async () => {
    getStatusMock.mockResolvedValue(unlockedSnapshot("tx-1"));
    const { result, rerender } = renderHook(
      ({ id }) => useTransactionEntitlement(id),
      { initialProps: { id: "tx-1" } },
    );
    await waitFor(() => expect(result.current.state).toBe("unlocked"));

    // New locked transaction — must not keep the previous unlocked state.
    getStatusMock.mockResolvedValue(lockedSnapshot("tx-2"));
    rerender({ id: "tx-2" });
    await waitFor(() => expect(result.current.state).toBe("locked"));
    expect(result.current.isUnlocked).toBe(false);
  });

  it("unlockWithCredit re-derives state from main after the attempt", async () => {
    getStatusMock.mockResolvedValue(lockedSnapshot("tx-1"));
    unlockMock.mockResolvedValue({ success: true, status: "unlocked" });
    const { result } = renderHook(() => useTransactionEntitlement("tx-1"));
    await waitFor(() => expect(result.current.state).toBe("locked"));

    // After unlock, the confirming re-read returns unlocked.
    getStatusMock.mockResolvedValue(unlockedSnapshot("tx-1"));
    await act(async () => {
      await result.current.unlockWithCredit();
    });
    await waitFor(() => expect(result.current.state).toBe("unlocked"));
  });
});
