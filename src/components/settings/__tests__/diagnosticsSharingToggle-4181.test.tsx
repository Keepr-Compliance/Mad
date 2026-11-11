/**
 * BACKLOG-4181 — "Share diagnostics with Keepr" in Settings → Data & Privacy.
 *
 * The switch shows what main says and flipping it calls main through
 * diagnosticsSharingService. A switch that only changed local state would hide
 * the setting while diagnostics kept sending. What main does with the value is
 * covered in electron/services/diagnostics/__tests__.
 */
import React, { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockNotifyError = jest.fn();
jest.mock("@/hooks/useNotification", () => ({
  useNotification: () => ({
    notify: { error: (...a: unknown[]) => mockNotifyError(...a), success: jest.fn(), warning: jest.fn(), info: jest.fn() },
    dismiss: jest.fn(),
    dismissAll: jest.fn(),
  }),
}));
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: [], requestSync: jest.fn() }),
}));

import { DataPrivacySettings } from "../DataPrivacySettings";

const mockCrashGet = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockCrashGet.mockResolvedValue({ success: true, enabled: true, wasEnabledAtLaunch: true });
  (window as unknown as { api: unknown }).api = {
    failureLog: { getRecent: jest.fn().mockResolvedValue({ success: true, entries: [] }), clear: jest.fn() },
    databaseBackup: { getInfo: jest.fn().mockResolvedValue({ success: false }) },
    privacy: {
      exportData: jest.fn(),
      onExportProgress: jest.fn(() => () => undefined),
      getCrashReporting: (...a: unknown[]) => mockCrashGet(...a),
      setCrashReporting: jest.fn(),
      getDiagnosticsSharing: (...a: unknown[]) => mockGet(...a),
      setDiagnosticsSharing: (...a: unknown[]) => mockSet(...a),
    },
  };
});

const renderPane = () =>
  render(
    <StrictMode>
      <DataPrivacySettings userId="user-1" />
    </StrictMode>,
  );
const diagSwitch = () => screen.findByRole("switch", { name: "Share diagnostics with Keepr" });

describe("Share diagnostics with Keepr switch (BACKLOG-4181)", () => {
  it("shows the label and helper copy and reflects ON from main", async () => {
    mockGet.mockResolvedValue({ success: true, enabled: true });
    renderPane();
    expect(await diagSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Share diagnostics with Keepr")).toBeInTheDocument();
    expect(screen.getByText("Sends app speed and error details, never your messages, contacts or files.")).toBeInTheDocument();
    expect(await diagSwitch()).not.toBeDisabled();
  });

  it("turning it off calls main with false and shows main's answer", async () => {
    mockGet.mockResolvedValue({ success: true, enabled: true });
    mockSet.mockResolvedValue({ success: true, enabled: false });
    renderPane();
    fireEvent.click(await diagSwitch());
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(false));
    await waitFor(async () => expect(await diagSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(mockNotifyError).not.toHaveBeenCalled();
  });

  it("a failed save shows an error and main's value", async () => {
    mockGet.mockResolvedValue({ success: true, enabled: true });
    mockSet.mockResolvedValue({ success: false, enabled: false, error: "Could not save the setting" });
    renderPane();
    fireEvent.click(await diagSwitch());
    await waitFor(() => expect(mockNotifyError).toHaveBeenCalledWith("Could not save the diagnostics setting."));
    expect(await diagSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("crash reports OFF: disabled, with 'Needs Send crash reports.'", async () => {
    mockCrashGet.mockResolvedValue({ success: true, enabled: false, wasEnabledAtLaunch: false });
    mockGet.mockResolvedValue({ success: true, enabled: true });
    renderPane();
    await waitFor(async () => expect(await diagSwitch()).toBeDisabled());
    expect(screen.getByTestId("diagnostics-needs-crash-reports")).toHaveTextContent("Needs Send crash reports.");
  });

  it("crash reports turned on this session after an OFF launch: 'Takes effect after restart.'", async () => {
    mockCrashGet.mockResolvedValue({ success: true, enabled: true, wasEnabledAtLaunch: false });
    mockGet.mockResolvedValue({ success: true, enabled: true });
    renderPane();
    expect(await screen.findByTestId("diagnostics-next-launch")).toHaveTextContent("Takes effect after restart.");
  });

  it("not shown when main cannot be read", async () => {
    mockGet.mockResolvedValue({ success: false });
    renderPane();
    await screen.findByRole("switch", { name: "Send crash reports" });
    expect(screen.queryByRole("switch", { name: "Share diagnostics with Keepr" })).toBeNull();
  });
});
