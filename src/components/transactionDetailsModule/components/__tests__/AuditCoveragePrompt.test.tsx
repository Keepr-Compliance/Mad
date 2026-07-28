/**
 * BACKLOG-2292 (Layer 1) — AuditCoveragePrompt presentational contract test.
 *
 * Verifies the founder's TWO-LAYER messaging (2026-07-28):
 *   Layer 1 ALWAYS shows the re-crop reassurance;
 *   Layer 2 is ADDITIVE only when a real data gap exists;
 *   the import CTA is gated on importer availability;
 *   inline progress renders and disables the actions while importing.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuditCoveragePrompt } from "../AuditCoveragePrompt";

const LAYER1 = /All of your communications will be updated to reflect this date range/i;

function setup(overrides: Partial<React.ComponentProps<typeof AuditCoveragePrompt>> = {}) {
  const props: React.ComponentProps<typeof AuditCoveragePrompt> = {
    hasGap: false,
    importerAvailable: true,
    importing: false,
    progress: null,
    onUpdateNow: jest.fn(),
    onSkip: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
  render(<AuditCoveragePrompt {...props} />);
  return props;
}

describe("AuditCoveragePrompt (BACKLOG-2292)", () => {
  it("Layer 1 always shows; no import line for a pure crop (no gap)", () => {
    setup({ hasGap: false });
    expect(screen.getByText(LAYER1)).toBeInTheDocument();
    expect(screen.queryByTestId("audit-coverage-import-line")).toBeNull();
    // No-gap ⇒ a single acknowledge button, no "Update now".
    expect(screen.getByTestId("audit-coverage-continue")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-coverage-update-now")).toBeNull();
  });

  it("gap + importer available ⇒ Layer 1 + additive import line + Update now / Skip", () => {
    const props = setup({ hasGap: true, importerAvailable: true });
    expect(screen.getByText(LAYER1)).toBeInTheDocument();
    expect(screen.getByTestId("audit-coverage-import-line")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("audit-coverage-update-now"));
    expect(props.onUpdateNow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("audit-coverage-skip"));
    expect(props.onSkip).toHaveBeenCalledTimes(1);
  });

  it("gap + importer UNAVAILABLE ⇒ degrade copy + a single Continue-anyway action", () => {
    const props = setup({ hasGap: true, importerAvailable: false });
    expect(screen.getByTestId("audit-coverage-degrade-line")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-coverage-update-now")).toBeNull();
    fireEvent.click(screen.getByTestId("audit-coverage-continue"));
    expect(props.onSkip).toHaveBeenCalledTimes(1);
  });

  it("shows inline progress and disables the actions while importing", () => {
    setup({
      hasGap: true,
      importerAvailable: true,
      importing: true,
      progress: { phase: "importing", current: 40, total: 100, percent: 40 },
    });
    expect(screen.getByTestId("audit-coverage-progress")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByTestId("audit-coverage-update-now")).toBeDisabled();
    expect(screen.getByTestId("audit-coverage-skip")).toBeDisabled();
  });
});
