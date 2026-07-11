/**
 * Tests for NavigationButtons.
 *
 * BACKLOG-1919: Covers the two-step skip confirmation. When a step's skip config
 * sets requireConfirm (Apple-driver step for iPhone users), the first click must
 * NOT skip — it reveals a warning + explicit "Skip anyway" button. This keeps
 * skipping possible but not the path of least resistance.
 *
 * Wrapped in StrictMode per repo convention (StrictMode is ON in main.tsx).
 */

import React, { StrictMode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { NavigationButtons } from "../NavigationButtons";
import type { SkipConfig } from "../../types";

const renderStrict = (ui: React.ReactElement) =>
  render(<StrictMode>{ui}</StrictMode>);

describe("NavigationButtons skip confirmation (BACKLOG-1919)", () => {
  it("skips immediately on click when requireConfirm is not set", () => {
    const onSkip = jest.fn();
    const skip: SkipConfig = { enabled: true, label: "Skip for now" };

    renderStrict(
      <NavigationButtons showBack={false} showNext skipConfig={skip} onSkip={onSkip} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("requires a second explicit click when requireConfirm is set", () => {
    const onSkip = jest.fn();
    const skip: SkipConfig = {
      enabled: true,
      label: "Skip for now",
      requireConfirm: true,
      confirmWarning: "Your iPhone can't be detected without this.",
      confirmLabel: "Skip anyway",
    };

    renderStrict(
      <NavigationButtons showBack={false} showNext skipConfig={skip} onSkip={onSkip} />,
    );

    // First click reveals the warning but does NOT skip.
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).not.toHaveBeenCalled();
    expect(
      screen.getByText("Your iPhone can't be detected without this."),
    ).toBeInTheDocument();

    // Second, explicit click on "Skip anyway" performs the skip.
    fireEvent.click(screen.getByRole("button", { name: "Skip anyway" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("can back out of the confirmation without skipping", () => {
    const onSkip = jest.fn();
    const skip: SkipConfig = {
      enabled: true,
      label: "Skip for now",
      requireConfirm: true,
    };

    renderStrict(
      <NavigationButtons showBack={false} showNext skipConfig={skip} onSkip={onSkip} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));

    expect(onSkip).not.toHaveBeenCalled();
    // Back to the original single skip affordance.
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeInTheDocument();
  });
});
