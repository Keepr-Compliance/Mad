/**
 * BACKLOG-3927: on the Connect Your iPhone screen, a Microsoft Store build with
 * the driver missing shows the Apple Devices guide (Open Microsoft Store /
 * Check again) instead of "Install Apple Mobile Device Support".
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ConnectionStatus } from "../ConnectionStatus";
import {
  APPLE_DEVICES_CHECK_BUTTON,
  APPLE_DEVICES_HEADING,
  APPLE_DEVICES_NOT_FOUND,
  APPLE_DEVICES_BODY,
  APPLE_DEVICES_OPEN_BUTTON,
  APPLE_DEVICES_NOT_RUNNING_HEADING,
  APPLE_DEVICES_NOT_RUNNING_BODY,
  APPLE_USB_DRIVER_HEADING,
  APPLE_USB_DRIVER_STEPS,
  APPLE_WU_CHECK_BUTTON,
  APPLE_WU_OPTIONAL_BUTTON,
  APPLE_OPEN_WINDOWS_UPDATE_FAILED,
  APPLE_USB_DRIVER_STILL_MISSING,
  APPLE_DEVICES_READY_HEADING,
  APPLE_MSI_STOPPED_HEADING,
  APPLE_MSI_STOPPED_BODY,
} from "../../../constants/appleDevicesStoreCopy";

const base = { isConnected: false, device: null, onSyncClick: jest.fn(), driverMissing: true };

beforeEach(() => jest.clearAllMocks());

it("Store build: Apple Devices guide; Check again calls the re-check", async () => {
  const onInstallDriver = jest.fn();
  const onRecheckDriver = jest.fn(async () => "not-installed" as const);
  render(
    <ConnectionStatus
      {...base}
      isStoreBuild
      appleDevicesState="not-installed"
      onInstallDriver={onInstallDriver}
      onRecheckDriver={onRecheckDriver}
    />,
  );
  expect(screen.getByText(APPLE_DEVICES_HEADING)).toBeInTheDocument();
  expect(screen.queryByText("Install Apple Mobile Device Support")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
  expect(onRecheckDriver).toHaveBeenCalled();
  expect(await screen.findByText(APPLE_DEVICES_NOT_FOUND)).toBeInTheDocument();
  expect(onInstallDriver).not.toHaveBeenCalled();
});

it("Store build without a re-check handler never falls back to the installer view", () => {
  render(<ConnectionStatus {...base} isStoreBuild onInstallDriver={jest.fn()} />);
  expect(screen.queryByText("Install Apple Mobile Device Support")).not.toBeInTheDocument();
  expect(screen.getByText("Connect Your iPhone")).toBeInTheDocument();
});

it("website build unchanged: Install Apple Mobile Device Support", () => {
  render(<ConnectionStatus {...base} onInstallDriver={jest.fn()} onRecheckDriver={jest.fn()} />);
  expect(screen.getByRole("button", { name: "Install Apple Mobile Device Support" })).toBeInTheDocument();
  expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
});

it("Windows on ARM still wins over the Store guide (BACKLOG-3363 unchanged)", () => {
  render(<ConnectionStatus {...base} isWindowsArm64 isStoreBuild onRecheckDriver={jest.fn()} />);
  expect(screen.getByTestId("windows-arm64-unsupported")).toBeInTheDocument();
  expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
});

// BACKLOG-3927 fix round (PC test 2026-10-12): three different Store-build
// problems, three different instructions.
describe("Store build guidance follows the Apple Devices state", () => {
  const renderState = (
    state: "not-installed" | "not-running" | "msi-service-stopped" | "usb-driver-missing" | "ready" | null,
  ) =>
    render(
      <ConnectionStatus
        {...base}
        isStoreBuild
        appleDevicesState={state}
        onRecheckDriver={jest.fn(async () => state ?? "ready")}
      />,
    );

  it("not installed: install Apple Devices from the Microsoft Store", () => {
    renderState("not-installed");
    expect(screen.getByText(APPLE_DEVICES_HEADING)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).toBeInTheDocument();
    expect(screen.queryByText(APPLE_USB_DRIVER_HEADING)).not.toBeInTheDocument();
  });

  it("installed but not running: open Apple Devices once, no Store install text", () => {
    renderState("not-running");
    expect(screen.getByText(APPLE_DEVICES_NOT_RUNNING_HEADING)).toBeInTheDocument();
    expect(screen.getByText(APPLE_DEVICES_NOT_RUNNING_BODY)).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });

  it("USB driver missing: no Device Manager step; the two buttons open their own Settings pages", async () => {
    (window.api.drivers!.openWindowsUpdate as jest.Mock).mockResolvedValue({ success: true });
    renderState("usb-driver-missing");
    for (const step of APPLE_USB_DRIVER_STEPS) expect(step).not.toMatch(/Device Manager/);
    expect(APPLE_USB_DRIVER_STEPS.join(" ")).toMatch(/restart may be needed/);
    await userEvent.click(screen.getByRole("button", { name: APPLE_WU_CHECK_BUTTON }));
    expect(window.api.drivers!.openWindowsUpdate).toHaveBeenLastCalledWith("check");
    await userEvent.click(screen.getByRole("button", { name: APPLE_WU_OPTIONAL_BUTTON }));
    expect(window.api.drivers!.openWindowsUpdate).toHaveBeenLastCalledWith("optional");
    expect(window.api.drivers!.openWindowsUpdate).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(APPLE_OPEN_WINDOWS_UPDATE_FAILED)).not.toBeInTheDocument();
  });

  it("USB driver missing: a failed open says so", async () => {
    (window.api.drivers!.openWindowsUpdate as jest.Mock).mockResolvedValue({ success: false, error: "x" });
    renderState("usb-driver-missing");
    await userEvent.click(screen.getByRole("button", { name: APPLE_WU_OPTIONAL_BUTTON }));
    expect(await screen.findByText(APPLE_OPEN_WINDOWS_UPDATE_FAILED)).toBeInTheDocument();
  });

  it("the Windows Update buttons appear only for the USB-driver state", () => {
    for (const st of ["not-installed", "not-running", "msi-service-stopped", "ready"] as const) {
      const { unmount } = renderState(st);
      expect(screen.queryByRole("button", { name: APPLE_WU_CHECK_BUTTON })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: APPLE_WU_OPTIONAL_BUTTON })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("USB driver missing: Windows Update / Device Manager steps, not the Apple Devices install message", async () => {
    renderState("usb-driver-missing");
    expect(screen.getByText(APPLE_USB_DRIVER_HEADING)).toBeInTheDocument();
    for (const step of APPLE_USB_DRIVER_STEPS) expect(screen.getByText(step)).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_BODY)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
    expect(await screen.findByText(APPLE_USB_DRIVER_STILL_MISSING)).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_NOT_FOUND)).not.toBeInTheDocument();
  });

  it("SR: 'ready' never shows the not-installed copy (neutral connect text)", () => {
    renderState("ready");
    expect(screen.getByText(APPLE_DEVICES_READY_HEADING)).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });

  it("unknown (null) state never claims Apple Devices is missing", () => {
    renderState(null);
    expect(screen.getByText(APPLE_DEVICES_READY_HEADING)).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
  });

  it("Apple's MSI service stopped: neutral restart text, no Apple Devices install or open", () => {
    renderState("msi-service-stopped");
    expect(screen.getByText(APPLE_MSI_STOPPED_HEADING)).toBeInTheDocument();
    expect(screen.getByText(APPLE_MSI_STOPPED_BODY)).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_NOT_RUNNING_HEADING)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });
});
