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
  APPLE_MSI_STOPPED_BODY,
  CHECKLIST_APPLE_DEVICES_STARTING,
} from "../../../constants/appleDevicesStoreCopy";

function setStoreFlag(value: boolean | undefined) {
  const system = (window.api as unknown as { system: Record<string, unknown> }).system;
  if (value === undefined) delete system.isStoreBuild;
  else system.isStoreBuild = value;
}
/**
 * Shapes `checkAppleDrivers` returns (electron/services/appleDriverService.ts):
 * when the MSI route is not running the probe runs and `appleDevices.state`
 * is set; `installedVia` names the source.
 */
type Via = "msi" | "apple-devices" | null;
type State = "not-installed" | "not-running" | "msi-service-stopped" | "usb-driver-missing" | "ready";
const status = (isInstalled: boolean, serviceRunning: boolean, installedVia: Via = null, state?: State) => ({
  isInstalled,
  version: null,
  serviceRunning,
  error: null,
  installedVia,
  ...(state ? { appleDevices: { state } } : {}),
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

  it("Apple Devices installed, not running: guidance text, no Repair Installation, source shown", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(
      status(true, false, "apple-devices", "not-running"),
    );
    render(<SyncToolsSettings />);
    expect(await screen.findByText(CHECKLIST_APPLE_DEVICES_STARTING)).toBeInTheDocument();
    expect(screen.getByTestId("iphone-setup-checklist")).toBeInTheDocument();
    expect(screen.queryByTestId("apple-devices-store-guide")).not.toBeInTheDocument();
    expect(screen.queryByText("Repair Installation")).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-tools-driver-source")).toHaveTextContent("Apple Devices app");
  });

  it("Apple's MSI found, its service stopped: neutral text (no 'open Apple Devices', no Repair)", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(
      status(true, false, "msi", "msi-service-stopped"),
    );
    render(<SyncToolsSettings />);
    expect(await screen.findByText(APPLE_MSI_STOPPED_BODY)).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_SERVICE_STOPPED)).not.toBeInTheDocument();
    expect(screen.queryByText("Repair Installation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
    expect(screen.getByTestId("sync-tools-driver-source")).toHaveTextContent("Apple Mobile Device Support");
  });
});

describe("website build unchanged (BACKLOG-3927)", () => {
  it("not installed: Install Sync Tools, no Apple Devices guide", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(status(false, false));
    render(<SyncToolsSettings />);
    expect(await screen.findByText("Install Sync Tools")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });

  it("MSI installed, service stopped: Repair Installation", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(
      status(true, false, "msi", "msi-service-stopped"),
    );
    render(<SyncToolsSettings />);
    expect(await screen.findByText("Repair Installation")).toBeInTheDocument();
    expect(screen.getByTestId("sync-tools-driver-source")).toHaveTextContent("Apple Mobile Device Support");
  });

  it("nothing found: source reads None found", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(status(false, false, null, "not-installed"));
    render(<SyncToolsSettings />);
    expect(await screen.findByTestId("sync-tools-driver-source")).toHaveTextContent("None found");
  });
});

describe("website build, Apple Devices as the source (BACKLOG-3927)", () => {
  it("ready via Apple Devices: Installed, Running, source shown, no Install or Repair", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(status(true, true, "apple-devices", "ready"));
    render(<SyncToolsSettings />);
    expect(await screen.findByTestId("sync-tools-driver-source")).toHaveTextContent("Apple Devices app");
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Install Sync Tools")).not.toBeInTheDocument();
    expect(screen.queryByText("Repair Installation")).not.toBeInTheDocument();
  });

  it("Apple Devices not running: its guidance, no Repair (Repair re-runs Apple's MSI)", async () => {
    (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue(
      status(true, false, "apple-devices", "not-running"),
    );
    render(<SyncToolsSettings />);
    expect(await screen.findByText(APPLE_DEVICES_SERVICE_STOPPED)).toBeInTheDocument();
    expect(screen.queryByText("Repair Installation")).not.toBeInTheDocument();
    // BACKLOG-3927 round 5: the website build keeps the single-state guide.
    expect(screen.getByTestId("apple-devices-store-guide")).toBeInTheDocument();
    expect(screen.queryByTestId("iphone-setup-checklist")).not.toBeInTheDocument();
  });
});
