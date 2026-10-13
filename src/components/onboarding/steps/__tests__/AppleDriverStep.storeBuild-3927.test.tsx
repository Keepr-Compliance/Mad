/**
 * BACKLOG-3927: in the Microsoft Store build the onboarding iPhone-tools step
 * never offers Keepr's installer. It detects Apple Mobile Device Support and,
 * when missing, sends the user to Apple Devices in the Microsoft Store, then
 * re-detects. The website build still offers Install Tools.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AppleDriverStep, { meta } from "../AppleDriverStep";
import type { OnboardingContext } from "../../types";
import {
  APPLE_DEVICES_CHECK_BUTTON,
  APPLE_DEVICES_HEADING,
  APPLE_DEVICES_NOT_FOUND,
  APPLE_DEVICES_OPEN_BUTTON,
  APPLE_DEVICES_SKIP_DESCRIPTION,
} from "../../../../constants/appleDevicesStoreCopy";

const context = {
  platform: "windows",
  phoneType: "iphone",
  driverSetupComplete: false,
  driverSkipped: false,
} as unknown as OnboardingContext;

function setStoreFlag(value: boolean | undefined) {
  const system = (window.api as unknown as { system: Record<string, unknown> }).system;
  if (value === undefined) delete system.isStoreBuild;
  else system.isStoreBuild = value;
}

const notInstalled = { isInstalled: false, version: null, serviceRunning: false, error: null };
const installed = { isInstalled: true, version: null, serviceRunning: true, error: null };

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(notInstalled);
  (window.api.drivers!.hasBundled as jest.Mock).mockResolvedValue({ hasBundled: true });
  (window.api.drivers!.checkUpdate as jest.Mock).mockResolvedValue({
    updateAvailable: false,
    installedVersion: null,
    bundledVersion: null,
  });
  (window.api.drivers!.openAppleDevicesStore as jest.Mock).mockResolvedValue({ success: true });
});
afterEach(() => setStoreFlag(undefined));

describe("AppleDriverStep — Store build (BACKLOG-3927)", () => {
  it("driver missing: Apple Devices guide, no Install Tools, installer never called", async () => {
    setStoreFlag(true);
    const { Content } = AppleDriverStep;
    render(<Content context={context} onAction={jest.fn()} />);

    expect(await screen.findByText(APPLE_DEVICES_HEADING)).toBeInTheDocument();
    expect(screen.queryByText("Install Tools")).not.toBeInTheDocument();
    expect(screen.queryByText(/iTunes/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON }));
    expect(window.api.drivers!.openAppleDevicesStore).toHaveBeenCalledTimes(1);
    expect(window.api.drivers!.installApple).not.toHaveBeenCalled();
    expect(window.api.drivers!.hasBundled).not.toHaveBeenCalled();
  });

  it("Check again, still missing: says Apple Devices isn't installed yet", async () => {
    setStoreFlag(true);
    const { Content } = AppleDriverStep;
    render(<Content context={context} onAction={jest.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
    expect(await screen.findByText(APPLE_DEVICES_NOT_FOUND)).toBeInTheDocument();
  });

  it("Check again, now installed: Tools Ready, Continue dispatches DRIVER_SETUP_COMPLETE", async () => {
    setStoreFlag(true);
    const onAction = jest.fn();
    const { Content } = AppleDriverStep;
    render(<Content context={context} onAction={onAction} />);
    await screen.findByText(APPLE_DEVICES_HEADING);

    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(installed);
    await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
    expect(await screen.findByText("Tools Ready!")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onAction).toHaveBeenCalledWith({ type: "DRIVER_SETUP_COMPLETE" });
  });

  it("already installed on mount: Tools Ready without the guide", async () => {
    setStoreFlag(true);
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(installed);
    const { Content } = AppleDriverStep;
    render(<Content context={context} onAction={jest.fn()} />);
    expect(await screen.findByText("Tools Ready!")).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
  });

  it("skip copy names Apple Devices, not iTunes", () => {
    setStoreFlag(true);
    expect(meta.skip?.description).toBe(APPLE_DEVICES_SKIP_DESCRIPTION);
  });
});

describe("AppleDriverStep — website build unchanged (BACKLOG-3927)", () => {
  it("driver missing: Install Tools, no Apple Devices guide", async () => {
    const { Content } = AppleDriverStep;
    render(<Content context={context} onAction={jest.fn()} />);
    expect(await screen.findByRole("button", { name: "Install Tools" })).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
    await waitFor(() => expect(window.api.drivers!.hasBundled).toHaveBeenCalled());
    expect(meta.skip?.description).toBe("You can install iTunes later to sync iPhone messages");
  });
});
