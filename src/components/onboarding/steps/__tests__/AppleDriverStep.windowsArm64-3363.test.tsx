/**
 * BACKLOG-3363 (option A): on Windows on ARM the onboarding driver step shows
 * "iPhone USB sync isn't supported on this PC" with only a Continue button.
 * Continue takes the existing skip path (DRIVER_SKIPPED) — never
 * DRIVER_SETUP_COMPLETE, since nothing was installed. No install, no
 * "Skip anyway" confirmation, no shell Continue.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AppleDriverStep, { meta } from "../AppleDriverStep";
import type { OnboardingContext } from "../../types";
import { WINDOWS_ARM64_UNSUPPORTED_HEADING } from "../../../../constants/windowsArm64Copy";

const context = {
  platform: "windows",
  phoneType: "iphone",
  driverSetupComplete: false,
  driverSkipped: false,
} as unknown as OnboardingContext;

function setArmFlag(value: boolean | undefined) {
  const system = (window.api as unknown as { system: Record<string, unknown> }).system;
  if (value === undefined) delete system.isWindowsArm64;
  else system.isWindowsArm64 = value;
}

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue({
    isInstalled: false,
    version: null,
    serviceRunning: false,
    error: null,
  });
});
afterEach(() => setArmFlag(undefined));

describe("AppleDriverStep on Windows on ARM (BACKLOG-3363)", () => {
  it("ARM: message + one Continue that dispatches DRIVER_SKIPPED (not DRIVER_SETUP_COMPLETE)", async () => {
    setArmFlag(true);
    const onAction = jest.fn();
    const { Content } = AppleDriverStep;
    render(<Content context={context} onAction={onAction} />);

    expect(screen.getByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Continue");
    expect(window.api.drivers!.checkApple).not.toHaveBeenCalled();

    await userEvent.click(buttons[0]);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ type: "DRIVER_SKIPPED" });
    expect(onAction).not.toHaveBeenCalledWith({ type: "DRIVER_SETUP_COMPLETE" });
  });

  it("ARM: no skip config (no 'Skip anyway' warning) and the shell Continue is hidden", () => {
    setArmFlag(true);
    expect(meta.skip).toBeUndefined();
    expect(meta.navigation?.hideContinue).toBe(true);
  });

  it("normal Windows PC: install flow (driver check runs), skip-with-confirm and shell Continue kept", async () => {
    setArmFlag(false);
    const { Content } = AppleDriverStep;
    render(<Content context={context} onAction={jest.fn()} />);
    expect(screen.queryByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeNull();
    expect(window.api.drivers!.checkApple).toHaveBeenCalled();
    expect(meta.skip?.requireConfirm).toBe(true);
    expect(meta.navigation?.hideContinue).toBe(false);
  });
});
