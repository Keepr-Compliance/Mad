/**
 * BACKLOG-3927 round 5: Store-build self-ticking iPhone setup checklist.
 * Rows tick from the Apple Devices state the main process reports; only the
 * first unmet row is expanded; row 2 never ticks without a plugged-in iPhone.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { IPhoneSetupChecklist, checklistRows } from "../IPhoneSetupChecklist";
import type { AppleDevicesState, AppleUsbDriverState } from "../../../types/iphone";
import {
  APPLE_DEVICES_CHECK_BUTTON,
  APPLE_DEVICES_OPEN_BUTTON,
  APPLE_DEVICES_OPEN_FAILED,
  APPLE_DEVICES_STILL_NOT_RUNNING,
  APPLE_MSI_STOPPED_BODY,
  APPLE_WU_CHECK_BUTTON,
  APPLE_WU_OPTIONAL_BUTTON,
  CHECKLIST_APPLE_DEVICES_INSTALL,
  CHECKLIST_APPLE_DEVICES_STARTING,
  CHECKLIST_DONE_LABEL,
  CHECKLIST_ROW_APPLE_DEVICES,
  CHECKLIST_ROW_USB_DRIVER,
  CHECKLIST_USB_DRIVER_BODY,
  CHECKLIST_USB_DRIVER_UNCHECKED,
} from "../../../constants/appleDevicesStoreCopy";

const mockOpenStore = jest.fn();
const mockOpenWindowsUpdate = jest.fn();
jest.mock("../../../services/deviceService", () => ({
  deviceService: {
    openAppleDevicesStore: (...a: unknown[]) => mockOpenStore(...a),
    openWindowsUpdate: (...a: unknown[]) => mockOpenWindowsUpdate(...a),
  },
}));

const STATES: AppleDevicesState[] = [
  "not-installed",
  "not-running",
  "msi-service-stopped",
  "usb-driver-missing",
  "ready",
];
const USB: (AppleUsbDriverState | null)[] = ["bound", "missing", "no-device", null];

const rowStatus = (key: string) => screen.getByTestId(`setup-row-${key}`).getAttribute("data-status");
const openBodies = () => screen.queryAllByTestId(/^setup-row-.*-body$/).map((el) => el.getAttribute("data-testid"));

beforeEach(() => {
  jest.clearAllMocks();
  mockOpenStore.mockResolvedValue({ success: true });
  mockOpenWindowsUpdate.mockResolvedValue({ success: true });
});

describe("checklistRows — every state x every USB-driver value", () => {
  const expected: Record<AppleDevicesState, [string, string]> = {
    "not-installed": ["open", "waiting"],
    "not-running": ["open", "waiting"],
    "msi-service-stopped": ["open", "waiting"],
    "usb-driver-missing": ["done", "open"],
    ready: ["done", "unchecked"],
  };
  for (const state of STATES) {
    for (const usb of USB) {
      it(`${state} / usbDriver=${usb}`, () => {
        const rows = checklistRows(state, usb);
        const want = [...expected[state]];
        if (state === "ready" && usb === "bound") want[1] = "done";
        expect(Object.keys(rows)).toEqual(["appleDevices", "usbDriver"]);
        expect([rows.appleDevices, rows.usbDriver]).toEqual(want);
        // Only the first unmet row is open; "ready" has none (Connect screen takes over).
        expect(Object.values(rows).filter((s) => s === "open")).toHaveLength(state === "ready" ? 0 : 1);
      });
    }
  }
});

describe("rendered rows tick from the state; only the first unmet row is expanded", () => {
  const cases: [AppleDevicesState, AppleUsbDriverState | null, string, string, string | null][] = [
    ["not-installed", null, "open", "waiting", "setup-row-appleDevices-body"],
    ["not-running", null, "open", "waiting", "setup-row-appleDevices-body"],
    ["msi-service-stopped", null, "open", "waiting", "setup-row-appleDevices-body"],
    ["usb-driver-missing", "missing", "done", "open", "setup-row-usbDriver-body"],
    ["ready", "no-device", "done", "unchecked", null],
    ["ready", "bound", "done", "done", null],
    ["ready", null, "done", "unchecked", null],
  ];
  for (const [state, usb, r1, r2, body] of cases) {
    it(`${state} / usbDriver=${usb}`, () => {
      render(<IPhoneSetupChecklist state={state} usbDriver={usb} onCheckAgain={jest.fn()} />);
      expect([rowStatus("appleDevices"), rowStatus("usbDriver")]).toEqual([r1, r2]);
      expect(openBodies()).toEqual(body ? [body] : []);
      expect(screen.queryByTestId("setup-row-iphone")).not.toBeInTheDocument();
      expect(screen.getAllByTestId(/^setup-row-[A-Za-z]+$/)).toHaveLength(2);
      const doneCount = [r1, r2].filter((s) => s === "done").length;
      expect(screen.queryAllByRole("img", { name: CHECKLIST_DONE_LABEL })).toHaveLength(doneCount);
    });
  }
});

describe("row titles (founder-approved 2026-10-13)", () => {
  it("row 1 is 'Apple iPhone support installed', row 2 'Apple iPhone USB driver'; no third row", () => {
    render(<IPhoneSetupChecklist state="not-installed" onCheckAgain={jest.fn()} />);
    const titles = screen.getAllByTestId(/^setup-row-[A-Za-z]+$/).map((li) => li.querySelector("span.text-sm")?.textContent);
    expect(titles).toEqual(["Apple iPhone support installed", "Apple iPhone USB driver"]);
    expect(CHECKLIST_ROW_APPLE_DEVICES).toBe("Apple iPhone support installed");
    expect(CHECKLIST_ROW_USB_DRIVER).toBe("Apple iPhone USB driver");
    expect(screen.queryByText("iPhone connected and trusted")).not.toBeInTheDocument();
  });
});

describe("row 1 — Apple Devices", () => {
  it("not installed: Open Microsoft Store calls the Store IPC (no Windows Update buttons)", async () => {
    render(<IPhoneSetupChecklist state="not-installed" onCheckAgain={jest.fn()} />);
    expect(screen.getByText(CHECKLIST_APPLE_DEVICES_INSTALL)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON }));
    expect(mockOpenStore).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: APPLE_WU_CHECK_BUTTON })).not.toBeInTheDocument();
    expect(screen.queryByText(APPLE_DEVICES_OPEN_FAILED)).not.toBeInTheDocument();
  });

  it("not installed: a failed Store open says so", async () => {
    mockOpenStore.mockResolvedValue({ success: false, error: "x" });
    render(<IPhoneSetupChecklist state="not-installed" onCheckAgain={jest.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON }));
    expect(await screen.findByText(APPLE_DEVICES_OPEN_FAILED)).toBeInTheDocument();
  });

  it("installed, not running yet: 'starts on its own or open the app', no Store button", () => {
    render(<IPhoneSetupChecklist state="not-running" onCheckAgain={jest.fn()} />);
    expect(screen.getByText(CHECKLIST_APPLE_DEVICES_STARTING)).toBeInTheDocument();
    expect(CHECKLIST_APPLE_DEVICES_STARTING).toMatch(/on its own/);
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });

  it("Apple's MSI service stopped: the restart text, no Store button", () => {
    render(<IPhoneSetupChecklist state="msi-service-stopped" onCheckAgain={jest.fn()} />);
    expect(screen.getByText(APPLE_MSI_STOPPED_BODY)).toBeInTheDocument();
    expect(screen.queryByText(CHECKLIST_APPLE_DEVICES_STARTING)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });
});

describe("row 2 — Apple iPhone USB driver", () => {
  it("missing: the two Windows Update buttons open their own pages; restart text shown", async () => {
    render(<IPhoneSetupChecklist state="usb-driver-missing" usbDriver="missing" onCheckAgain={jest.fn()} />);
    expect(screen.getByText(CHECKLIST_USB_DRIVER_BODY)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: APPLE_WU_CHECK_BUTTON }));
    expect(mockOpenWindowsUpdate).toHaveBeenLastCalledWith("check");
    await userEvent.click(screen.getByRole("button", { name: APPLE_WU_OPTIONAL_BUTTON }));
    expect(mockOpenWindowsUpdate).toHaveBeenLastCalledWith("optional");
    expect(mockOpenWindowsUpdate).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: APPLE_DEVICES_OPEN_BUTTON })).not.toBeInTheDocument();
  });

  it("ready with no iPhone plugged in: 'checked when plugged in', never a tick", () => {
    render(<IPhoneSetupChecklist state="ready" usbDriver="no-device" onCheckAgain={jest.fn()} />);
    expect(screen.getByText(CHECKLIST_USB_DRIVER_UNCHECKED)).toBeInTheDocument();
    const row2 = screen.getByTestId("setup-row-usbDriver");
    expect(row2.querySelector(`[aria-label="${CHECKLIST_DONE_LABEL}"]`)).toBeNull();
  });

  it("ready with the probe not run (usbDriver null, MSI route): no 'checked when plugged in' note", () => {
    render(<IPhoneSetupChecklist state="ready" usbDriver={null} onCheckAgain={jest.fn()} />);
    expect(screen.queryByText(CHECKLIST_USB_DRIVER_UNCHECKED)).not.toBeInTheDocument();
    const row2 = screen.getByTestId("setup-row-usbDriver");
    expect(row2.querySelector(`[aria-label="${CHECKLIST_DONE_LABEL}"]`)).toBeNull();
  });

  it("ready with the iPhone on Apple's driver: ticked, no 'checked when plugged in' note", () => {
    render(<IPhoneSetupChecklist state="ready" usbDriver="bound" onCheckAgain={jest.fn()} />);
    expect(screen.queryByText(CHECKLIST_USB_DRIVER_UNCHECKED)).not.toBeInTheDocument();
    const row2 = screen.getByTestId("setup-row-usbDriver");
    expect(row2.querySelector(`[aria-label="${CHECKLIST_DONE_LABEL}"]`)).not.toBeNull();
  });
});

describe("Check again and focus re-check", () => {
  it("Check again re-ticks the rows from the new state", async () => {
    const onCheckAgain = jest.fn(async () => "usb-driver-missing" as const);
    render(<IPhoneSetupChecklist state="not-installed" onCheckAgain={onCheckAgain} />);
    await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(CHECKLIST_USB_DRIVER_BODY)).toBeInTheDocument();
    expect(rowStatus("appleDevices")).toBe("done");
  });

  it("Check again with no change shows the 'still' line for the open row", async () => {
    render(<IPhoneSetupChecklist state="not-running" onCheckAgain={jest.fn(async () => "not-running" as const)} />);
    await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
    expect(await screen.findByText(APPLE_DEVICES_STILL_NOT_RUNNING)).toBeInTheDocument();
  });

  it("re-checks on window focus by default (Settings / onboarding)", async () => {
    const onCheckAgain = jest.fn(async () => "not-installed" as const);
    render(<IPhoneSetupChecklist state="not-installed" onCheckAgain={onCheckAgain} />);
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
  });

  it("recheckOnFocus=false (Connect screen, the hook re-checks): no focus probe", async () => {
    const onCheckAgain = jest.fn(async () => "not-installed" as const);
    render(<IPhoneSetupChecklist state="not-installed" onCheckAgain={onCheckAgain} recheckOnFocus={false} />);
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(onCheckAgain).not.toHaveBeenCalled();
  });
});
