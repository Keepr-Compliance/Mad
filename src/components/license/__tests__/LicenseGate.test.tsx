/**
 * BACKLOG-4038 — the app-level LicenseGate maps each blockReason to the right
 * UpgradeScreen variant. "expired" (admin-set expired/cancelled) is never a trial.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LicenseGate } from "../LicenseGate";
import { useLicense } from "../../../contexts/LicenseContext";

jest.mock("../../../contexts/LicenseContext", () => ({
  useLicense: jest.fn(),
}));

function blockedWith(blockReason: string | null, deviceCount = 0, deviceLimit = 2): void {
  jest.mocked(useLicense).mockReturnValue({
    validationStatus: { isValid: false, blockReason, deviceCount, deviceLimit },
    isLoading: false,
    hasInitialized: true,
    isValid: false,
    blockReason,
  } as unknown as ReturnType<typeof useLicense>);
}

function renderGate() {
  return render(
    <LicenseGate>
      <div>app content</div>
    </LicenseGate>,
  );
}

describe("LicenseGate reason mapping (BACKLOG-4038)", () => {
  it("expired renders the ended variant and never the word trial", () => {
    blockedWith("expired");
    const { container } = renderGate();
    expect(screen.getByRole("heading", { name: "Your Keepr license has ended" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/trial/i);
    expect(screen.queryByText("app content")).not.toBeInTheDocument();
  });

  it("suspended renders the paused variant", () => {
    blockedWith("suspended");
    renderGate();
    expect(screen.getByRole("heading", { name: "Your account is paused" })).toBeInTheDocument();
  });

  it.each(["limit_reached", "no_license", "load_error"])("%s renders the fallback variant", (reason) => {
    blockedWith(reason);
    const { container } = renderGate();
    expect(screen.getByRole("heading", { name: "Your Keepr license isn't active" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/trial|5 transactions/i);
  });
});
