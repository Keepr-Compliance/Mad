/**
 * Tests for CreditBalanceChip (BACKLOG-2090).
 *
 * The persistent balance chip must render the remaining credits (with correct
 * singular/plural) and render NOTHING while loading or when the balance is
 * unavailable (null) — an unavailable balance must never read as "0 credits".
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { CreditBalanceChip } from "../CreditBalanceChip";

const getBalanceMock = window.api.entitlement.getBalance as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  getBalanceMock.mockResolvedValue(null);
});

describe("CreditBalanceChip", () => {
  it("renders the balance with plural copy", async () => {
    getBalanceMock.mockResolvedValue(3);
    render(<CreditBalanceChip />);
    await waitFor(() =>
      expect(screen.getByTestId("credit-balance-chip")).toBeInTheDocument(),
    );
    expect(screen.getByText("3 credits")).toBeInTheDocument();
  });

  it("uses singular copy for exactly one credit", async () => {
    getBalanceMock.mockResolvedValue(1);
    render(<CreditBalanceChip />);
    await waitFor(() =>
      expect(screen.getByText("1 credit")).toBeInTheDocument(),
    );
  });

  it("renders a zero balance (0 credits) rather than hiding it", async () => {
    getBalanceMock.mockResolvedValue(0);
    render(<CreditBalanceChip />);
    await waitFor(() =>
      expect(screen.getByText("0 credits")).toBeInTheDocument(),
    );
  });

  it("renders nothing when the balance is unavailable (null)", async () => {
    getBalanceMock.mockResolvedValue(null);
    const { container } = render(<CreditBalanceChip />);
    // Give the effect a tick to resolve, then assert the chip is absent.
    await waitFor(() =>
      expect(getBalanceMock).toHaveBeenCalled(),
    );
    expect(screen.queryByTestId("credit-balance-chip")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("refetches the balance when refreshSignal changes (post-unlock/export)", async () => {
    // Starts at 3, drops to 2 after a credit is spent.
    getBalanceMock.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

    const { rerender } = render(<CreditBalanceChip refreshSignal={0} />);
    await waitFor(() => expect(screen.getByText("3 credits")).toBeInTheDocument());
    expect(getBalanceMock).toHaveBeenCalledTimes(1);

    // Bump the signal → the chip refetches and shows the new balance.
    await act(async () => {
      rerender(<CreditBalanceChip refreshSignal={1} />);
    });
    await waitFor(() => expect(screen.getByText("2 credits")).toBeInTheDocument());
    expect(getBalanceMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT refetch on mount when refreshSignal is provided (no double fetch)", async () => {
    getBalanceMock.mockResolvedValue(4);
    render(<CreditBalanceChip refreshSignal={5} />);
    await waitFor(() => expect(screen.getByText("4 credits")).toBeInTheDocument());
    // One fetch from the hook mount; the signal effect must not add a second.
    expect(getBalanceMock).toHaveBeenCalledTimes(1);
  });
});
