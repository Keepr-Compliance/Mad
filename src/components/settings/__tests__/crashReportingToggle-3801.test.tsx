/**
 * BACKLOG-3801 — "Send crash reports to help fix problems" in Settings → Data & Privacy.
 *
 * The switch only shows what main says, and flipping it calls main. A switch
 * that changed local state without calling `privacy.setCrashReporting` would
 * hide the setting while Sentry kept sending — the first likely-wrong fix.
 * What happens in main once called is covered in
 * electron/services/__tests__/crashReportingPreference.test.ts and
 * electron/bootstrap/__tests__/installSentry.test.ts.
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

const mockGet = jest.fn();
const mockSet = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { api: unknown }).api = {
    failureLog: { getRecent: jest.fn().mockResolvedValue({ success: true, entries: [] }), clear: jest.fn() },
    databaseBackup: { getInfo: jest.fn().mockResolvedValue({ success: false }) },
    privacy: {
      exportData: jest.fn(),
      onExportProgress: jest.fn(() => () => undefined),
      getCrashReporting: (...a: unknown[]) => mockGet(...a),
      setCrashReporting: (...a: unknown[]) => mockSet(...a),
    },
  };
});

const renderPane = () =>
  render(
    <StrictMode>
      <DataPrivacySettings userId="user-1" />
    </StrictMode>,
  );

const crashSwitch = () => screen.findByRole("switch", { name: "Send crash reports" });

describe("Send crash reports switch (BACKLOG-3801)", () => {
  it("shows the label and reflects ON from main", async () => {
    mockGet.mockResolvedValue({ success: true, enabled: true, wasEnabledAtLaunch: true });
    renderPane();
    expect(await crashSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Send crash reports to help fix problems")).toBeInTheDocument();
  });

  it("turning it off calls main with false, and shows OFF from main's answer", async () => {
    mockGet.mockResolvedValue({ success: true, enabled: true, wasEnabledAtLaunch: true });
    mockSet.mockResolvedValue({ success: true, enabled: false, wasEnabledAtLaunch: true });
    renderPane();
    fireEvent.click(await crashSwitch());
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(false));
    await waitFor(async () => expect(await crashSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(mockNotifyError).not.toHaveBeenCalled();
  });

  it("turning it on after an OFF launch says it starts next time Keepr opens", async () => {
    mockGet.mockResolvedValue({ success: true, enabled: false, wasEnabledAtLaunch: false });
    mockSet.mockResolvedValue({ success: true, enabled: true, wasEnabledAtLaunch: false });
    renderPane();
    expect(screen.queryByTestId("crash-reporting-next-launch")).not.toBeInTheDocument();
    fireEvent.click(await crashSwitch());
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(true));
    expect(await screen.findByTestId("crash-reporting-next-launch")).toHaveTextContent(
      "Crash reports will start sending the next time you open Keepr.",
    );
  });

  it("a failed save tells the user and shows what main actually holds", async () => {
    mockGet.mockResolvedValue({ success: true, enabled: true, wasEnabledAtLaunch: true });
    mockSet.mockResolvedValue({ success: false, error: "Could not save the setting", enabled: false, wasEnabledAtLaunch: true });
    renderPane();
    fireEvent.click(await crashSwitch());
    await waitFor(() => expect(mockNotifyError).toHaveBeenCalledWith("Could not save the crash report setting."));
    expect(await crashSwitch()).toHaveAttribute("aria-checked", "false");
  });
});
