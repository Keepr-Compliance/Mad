/**
 * BACKLOG-3927: Settings > iPhone Sync in the Microsoft Store build never
 * offers Install Sync Tools or Repair Installation; it shows the Apple Devices
 * guide. The website build is unchanged.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SyncToolsSettings } from "../SyncToolsSettings";
import {
  APPLE_DEVICES_CHECK_BUTTON,
  APPLE_DEVICES_NOT_FOUND,
  APPLE_DEVICES_OPEN_BUTTON,
  APPLE_DEVICES_SERVICE_STOPPED,
} from "../../../constants/appleDevicesStoreCopy";

function setStoreFlag(value: boolean | undefined) {
  const system = (window.api as unknown as { system: Record<string, unknown> }).system;
  if (value === undefined) delete system.isStoreBuild;
  else system.isStoreBuild = value;
}
const status = (isInstalled: boolean, serviceRunning: boolean) => ({
  isInstalled,
  version: null,
  serviceRunning,
  error: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.drivers!.openAppleDevicesStore as jest.Mock).mockResolvedValue({ success: true });
});
afterEach(() => setStoreFlag(undefined));

describe("Store build (BACKLOG-3927)", () => {
  beforeEach(() => setStoreFlag(true));

  it("not installed: Apple Devices guide, no Install Sync Tools", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(status(false, false));
    render(<SyncToolsSettings />);
    await userEvent.click(await screen.findByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON }));
    expect(window.api.drivers!.openAppleDevicesStore).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Install Sync Tools")).not.toBeInTheDocument();
    expect(window.api.drivers!.installApple).not.toHaveBeenCalled();
  });

  it("Check again keeps the guide on screen and reports the result", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(status(false, false));
    render(<SyncToolsSettings />);
    await userEvent.click(await screen.findByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
    expect(await screen.findByText(APPLE_DEVICES_NOT_FOUND)).toBeInTheDocument();
  });

  it("installed, service stopped: guidance text, no Repair Installation", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(status(true, false));
    render(<SyncToolsSettings />);
    expect(await screen.findByText(APPLE_DEVICES_SERVICE_STOPPED)).toBeInTheDocument();
    expect(screen.queryByText("Repair Installation")).not.toBeInTheDocument();
  });
});

describe("website build unchanged (BACKLOG-3927)", () => {
  it("not installed: Install Sync Tools, no Apple Devices guide", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(status(false, false));
    render(<SyncToolsSettings />);
    expect(await screen.findByText("Install Sync Tools")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });

  it("installed, service stopped: Repair Installation", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(status(true, false));
    render(<SyncToolsSettings />);
    expect(await screen.findByText("Repair Installation")).toBeInTheDocument();
  });
});
