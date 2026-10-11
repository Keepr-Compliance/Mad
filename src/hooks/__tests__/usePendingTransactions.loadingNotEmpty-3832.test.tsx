/**
 * BACKLOG-3832 — Start New Audit's pending list is LOADING until its first read
 * ends. The fetch runs in a mount effect, so the first frame used to report
 * `isLoading: false` with no rows, and the modal painted "No pending
 * transactions to review". Frames are recorded because a post-render look sees
 * the state the effect already fixed.
 */
import React from "react";
import { act, render } from "@testing-library/react";
import { usePendingTransactions } from "../usePendingTransactions";

let mockUser: { id: string } | null = { id: "user-3832" };
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: mockUser, isAuthenticated: !!mockUser }),
}));

interface Frame {
  isLoading: boolean;
  count: number;
}

function Probe({ frames }: { frames: Frame[] }) {
  const r = usePendingTransactions();
  frames.push({ isLoading: r.isLoading, count: r.pendingTransactions.length });
  return null;
}

let getAll: jest.Mock;
beforeEach(() => {
  mockUser = { id: "user-3832" };
  getAll = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).api = { transactions: { getAll } };
});

describe("BACKLOG-3832 usePendingTransactions", () => {
  it("the first frame is loading, and an empty answer then reads as loaded-and-empty", async () => {
    let resolve!: (v: unknown) => void;
    getAll.mockReturnValue(new Promise((r) => (resolve = r)));
    const frames: Frame[] = [];
    render(<Probe frames={frames} />);
    expect(frames[0]).toEqual({ isLoading: true, count: 0 });
    expect(frames.every((f) => f.isLoading)).toBe(true);

    await act(async () => {
      resolve({ success: true, transactions: [] });
      await Promise.resolve();
    });
    expect(frames[frames.length - 1]).toEqual({ isLoading: false, count: 0 });
  });

  it("loaded: the pending rows", async () => {
    getAll.mockResolvedValue({
      success: true,
      transactions: [
        { id: "t1", detection_status: "pending" },
        { id: "t2", detection_status: "confirmed" },
      ],
    });
    const frames: Frame[] = [];
    await act(async () => {
      render(<Probe frames={frames} />);
    });
    expect(frames[frames.length - 1]).toEqual({ isLoading: false, count: 1 });
  });

  it("signed out: not loading (no read will ever run)", () => {
    mockUser = null;
    const frames: Frame[] = [];
    render(<Probe frames={frames} />);
    expect(frames[frames.length - 1].isLoading).toBe(false);
    expect(getAll).not.toHaveBeenCalled();
  });
});
