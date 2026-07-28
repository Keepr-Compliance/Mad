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
    expect(screen.queryByTestId("audit-coverage-progress-indeterminate")).toBeNull();
    expect(screen.getByTestId("audit-coverage-update-now")).toBeDisabled();
    expect(screen.getByTestId("audit-coverage-skip")).toBeDisabled();
  });

  it("BACKLOG-2305: multi-pass ⇒ indeterminate bar, NO percentage (no 100%→0% loop)", () => {
    setup({
      hasGap: true,
      importerAvailable: true,
      importing: true,
      indeterminate: true,
      // Even though a percent is present, a multi-pass op must not render it.
      progress: { phase: "importing", current: 100, total: 100, percent: 100 },
    });
    expect(screen.getByTestId("audit-coverage-progress")).toBeInTheDocument();
    expect(screen.getByTestId("audit-coverage-progress-indeterminate")).toBeInTheDocument();
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it("BACKLOG-2305: importing with no progress yet renders the indeterminate bar", () => {
    setup({
      hasGap: true,
      importerAvailable: true,
      importing: true,
      progress: null,
    });
    expect(screen.getByTestId("audit-coverage-progress-indeterminate")).toBeInTheDocument();
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it("BACKLOG-2305: failsafe notice renders and the actions are RE-ENABLED (never trapped)", () => {
    setup({
      hasGap: true,
      importerAvailable: true,
      importing: false, // failsafe cleared it
      notice: "This is taking longer than expected — you can wait, try again, or skip.",
    });
    expect(screen.getByTestId("audit-coverage-notice")).toBeInTheDocument();
    expect(screen.getByTestId("audit-coverage-update-now")).not.toBeDisabled();
    expect(screen.getByTestId("audit-coverage-skip")).not.toBeDisabled();
  });
});
