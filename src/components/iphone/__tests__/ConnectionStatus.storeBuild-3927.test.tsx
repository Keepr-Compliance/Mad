/**
 * BACKLOG-3927: on the Connect Your iPhone screen, a Microsoft Store build with
 * the driver missing shows the Apple Devices guide (Open Microsoft Store /
 * Check again) instead of "Install Apple Mobile Device Support".
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ConnectionStatus } from "../ConnectionStatus";
import {
  APPLE_DEVICES_CHECK_BUTTON,
  APPLE_DEVICES_HEADING,
  APPLE_DEVICES_NOT_FOUND,
  APPLE_DEVICES_BODY,
  APPLE_DEVICES_OPEN_BUTTON,
  APPLE_USB_DRIVER_STEPS,
  APPLE_WU_CHECK_BUTTON,
  APPLE_WU_OPTIONAL_BUTTON,
  APPLE_OPEN_WINDOWS_UPDATE_FAILED,
  APPLE_USB_DRIVER_STILL_MISSING,
  APPLE_MSI_STOPPED_BODY,
  CHECKLIST_APPLE_DEVICES_INSTALL,
  CHECKLIST_APPLE_DEVICES_STARTING,
  CHECKLIST_HEADING,
  CHECKLIST_USB_DRIVER_BODY,
} from "../../../constants/appleDevicesStoreCopy";

/** BACKLOG-3927 (2.41): the Apple USB driver step, exact text. */
const USB_DRIVER_INSTRUCTION_EXACT =
  'Click Check for updates and wait for it to finish. Then open Optional updates, tick "Apple, Inc. - USBDevice", and click Download & install. If Windows shows Restart now, click it, then reopen Keepr.';

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
  expect(screen.getByTestId("iphone-setup-checklist")).toBeInTheDocument();
  expect(screen.queryByText("Install Apple Mobile Device Support")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
  expect(onRecheckDriver).toHaveBeenCalled();
  expect(await screen.findByText(APPLE_DEVICES_NOT_FOUND)).toBeInTheDocument();
  expect(onInstallDriver).not.toHaveBeenCalled();
});

it("Store build: window focus does not re-probe from the checklist (the hook's throttled re-check owns it)", async () => {
  const onRecheckDriver = jest.fn(async () => "not-installed" as const);
  render(
    <ConnectionStatus {...base} isStoreBuild appleDevicesState="not-installed" onRecheckDriver={onRecheckDriver} />,
  );
  await act(async () => {
    fireEvent.focus(window);
  });
  expect(onRecheckDriver).not.toHaveBeenCalled();
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
  expect(screen.queryByTestId("iphone-setup-checklist")).not.toBeInTheDocument();
});

it("website build shows no checklist in any Apple Devices state", () => {
  for (const st of ["not-installed", "not-running", "msi-service-stopped", "usb-driver-missing", "ready"] as const) {
    const { unmount } = render(
      <ConnectionStatus
        {...base}
        driverMissing={st !== "ready"}
        appleDevicesState={st}
        onInstallDriver={jest.fn()}
        onRecheckDriver={jest.fn()}
      />,
    );
    expect(screen.queryByTestId("iphone-setup-checklist")).not.toBeInTheDocument();
    expect(screen.queryByText(CHECKLIST_HEADING)).not.toBeInTheDocument();
    unmount();
  }
});

it("Windows on ARM still wins over the Store guide (BACKLOG-3363 unchanged)", () => {
  render(<ConnectionStatus {...base} isWindowsArm64 isStoreBuild onRecheckDriver={jest.fn()} />);
  expect(screen.getByTestId("windows-arm64-unsupported")).toBeInTheDocument();
  expect(screen.queryByTestId("iphone-setup-checklist")).not.toBeInTheDocument();
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
    expect(screen.getByText(CHECKLIST_APPLE_DEVICES_INSTALL)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).toBeInTheDocument();
    expect(screen.queryByText(CHECKLIST_USB_DRIVER_BODY)).not.toBeInTheDocument();
  });

  it("installed but not running: open Apple Devices once, no Store install text", () => {
    renderState("not-running");
    expect(screen.getByText(CHECKLIST_APPLE_DEVICES_STARTING)).toBeInTheDocument();
    expect(screen.queryByText(CHECKLIST_APPLE_DEVICES_INSTALL)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });

  it("USB driver missing: no Device Manager step; the two buttons open their own Settings pages", async () => {
    (window.api.drivers!.openWindowsUpdate as jest.Mock).mockResolvedValue({ success: true });
    renderState("usb-driver-missing");
    for (const step of APPLE_USB_DRIVER_STEPS) expect(step).not.toMatch(/Device Manager/);
    // BACKLOG-3927 (2.41): exact founder wording, pinned as a literal.
    expect(APPLE_USB_DRIVER_STEPS).toEqual([USB_DRIVER_INSTRUCTION_EXACT]);
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
    expect(screen.getByText(CHECKLIST_USB_DRIVER_BODY)).toBeInTheDocument();
    expect(CHECKLIST_USB_DRIVER_BODY).not.toMatch(/Device Manager/);
    expect(CHECKLIST_USB_DRIVER_BODY).toBe(USB_DRIVER_INSTRUCTION_EXACT);
    expect(screen.getByText(USB_DRIVER_INSTRUCTION_EXACT)).toBeInTheDocument();
    expect(screen.queryByText(/Apple Inc\. - USBDevice|restart may be needed/)).not.toBeInTheDocument();
    expect(screen.queryByText(CHECKLIST_APPLE_DEVICES_INSTALL)).not.toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_BODY)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
    expect(await screen.findByText(APPLE_USB_DRIVER_STILL_MISSING)).toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_NOT_FOUND)).not.toBeInTheDocument();
  });

  it("SR: 'ready' never shows the not-installed copy (neutral connect text)", () => {
    renderState("ready");
    // Both setup rows met: the normal Connect screen (unlock / Trust steps), no checklist.
    expect(screen.queryByTestId("iphone-setup-checklist")).not.toBeInTheDocument();
    expect(screen.getByText("Connect Your iPhone")).toBeInTheDocument();
    expect(screen.queryByText(CHECKLIST_APPLE_DEVICES_INSTALL)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });

  it("unknown (null) state never claims Apple Devices is missing", () => {
    renderState(null);
    // Unknown: plain connect view, no checklist (claims nothing either way).
    expect(screen.getByText("Connect Your iPhone")).toBeInTheDocument();
    expect(screen.queryByTestId("iphone-setup-checklist")).not.toBeInTheDocument();
  });

  it("Apple's MSI service stopped: neutral restart text, no Apple Devices install or open", () => {
    renderState("msi-service-stopped");
    expect(screen.getByText(APPLE_MSI_STOPPED_BODY)).toBeInTheDocument();
    expect(screen.queryByText(CHECKLIST_APPLE_DEVICES_STARTING)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });
});
