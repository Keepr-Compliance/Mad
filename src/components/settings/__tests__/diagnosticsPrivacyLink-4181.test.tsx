/**
 * BACKLOG-4181 — "Privacy policy" link next to "Share diagnostics with Keepr".
 *
 * Clicking it must reach main's `shell:open-external` bridge with the published
 * policy URL. The service is NOT mocked, so this covers component → service →
 * window.api.shell.openExternal.
 */
import React, { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("@/hooks/useNotification", () => ({
  useNotification: () => ({
    notify: { error: jest.fn(), success: jest.fn(), warning: jest.fn(), info: jest.fn() },
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

const mockOpenExternal = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockOpenExternal.mockResolvedValue({ success: true });
  (window as unknown as { api: unknown }).api = {
    failureLog: { getRecent: jest.fn().mockResolvedValue({ success: true, entries: [] }), clear: jest.fn() },
    databaseBackup: { getInfo: jest.fn().mockResolvedValue({ success: false }) },
    shell: { openExternal: (...a: unknown[]) => mockOpenExternal(...a) },
    privacy: {
      exportData: jest.fn(),
      onExportProgress: jest.fn(() => () => undefined),
      getCrashReporting: jest.fn().mockResolvedValue({ success: true, enabled: true, wasEnabledAtLaunch: true }),
      setCrashReporting: jest.fn(),
      getDiagnosticsSharing: jest.fn().mockResolvedValue({ success: true, enabled: true }),
      setDiagnosticsSharing: jest.fn(),
    },
  };
});

describe("Privacy policy link by the diagnostics switch (BACKLOG-4181)", () => {
  it("opens https://keeprcompliance.com/privacy in the default browser", async () => {
    render(
      <StrictMode>
        <DataPrivacySettings userId="user-1" />
      </StrictMode>,
    );
    await screen.findByRole("switch", { name: "Share diagnostics with Keepr" });
    const link = screen.getByRole("button", { name: "Privacy policy" });
    fireEvent.click(link);
    await waitFor(() => expect(mockOpenExternal).toHaveBeenCalledTimes(1));
    expect(mockOpenExternal).toHaveBeenCalledWith("https://keeprcompliance.com/privacy");
  });
});
