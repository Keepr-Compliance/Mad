/**
 * BACKLOG-3666 — the pairing code panel. SR: when 5 wrong tries use a code
 * up, say so plainly (it can be an attack) and offer a new code.
 * Mutations: no burned message → red; the old code left on screen → red.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

let mockBurned = false;
jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    pairCode: async () => ({ success: true, data: { code: "QWERTY23", expiresAt: "2026-10-02T12:05:00.000Z" } }),
    pairCancel: async () => undefined,
    getExtensionState: async () => ({ success: true, data: { pairCodeBurned: mockBurned } }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PairingCodePanel, formatPairCode } = require("../PairingCodePanel") as typeof import("../PairingCodePanel");

beforeEach(() => {
  jest.useFakeTimers();
  mockBurned = false;
});
afterEach(() => jest.useRealTimers());

describe("PairingCodePanel", () => {
  it("shows the code as ABCD-EFGH", async () => {
    render(<PairingCodePanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show pairing code" }));
    });
    expect(screen.getByTestId("gm-pair-code")).toHaveTextContent("QWER-TY23");
    expect(formatPairCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  it("a code used up by wrong attempts: said plainly, the code gone, a new one offered", async () => {
    render(<PairingCodePanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show pairing code" }));
    });
    mockBurned = true;
    await act(async () => {
      jest.advanceTimersByTime(2100);
    });
    expect(screen.getByTestId("gm-pair-burned")).toHaveTextContent("Code used up by wrong attempts — get a new code.");
    expect(screen.queryByTestId("gm-pair-code")).toBeNull();
    expect(screen.getByRole("button", { name: "Show pairing code" })).toBeInTheDocument();
  });
});
