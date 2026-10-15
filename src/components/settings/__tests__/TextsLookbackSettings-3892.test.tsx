/**
 * BACKLOG-3892 S3 — C2: the macOS panel follows the SHARED "How far back to
 * import texts" picker.
 *
 * The most likely wrong S3: the shared picker saves, but the macOS panel keeps
 * its own copy of the lookback, so its size estimate and its window label go on
 * describing the old window. Rendered the way Settings composes it — one
 * TextsLookbackProvider around the picker and the panel.
 *
 * The effective-window fixture stands in for main's `getEffectiveImportWindow`
 * (messageImportHandlers): the import floor is the EARLIER of the stored
 * lookback and the earliest audit-period start, so a deal starting 1 March 2026
 * drives the window while the lookback is 3 months, and the lookback drives it
 * once it reaches back a year.
 */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import { TextsLookbackSettings } from "../TextsLookbackSettings";
import { TextsLookbackProvider } from "../textsLookback";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({ queue: [], requestSync: jest.fn() })),
}));

const mockGetPreferences = jest.fn();
const mockUpdatePreferences = jest.fn();
jest.mock("../../../services", () => ({
  systemService: {
    checkMessagesPermission: jest.fn().mockResolvedValue({ success: true, data: { hasPermission: true } }),
    openFullDiskAccessSettings: jest.fn().mockResolvedValue({ success: true }),
    relaunchApp: jest.fn().mockResolvedValue({ success: true, data: { relaunched: true } }),
  },
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

const USER_ID = "user-3892";
/** The stored lookback, as main would read it after a save. */
let storedLookback: number | null = 3;

const ESTIMATE = {
  success: true,
  count: 20_000,
  filteredCount: 9_000,
  attachmentBytes: 1_000_000_000,
  attachmentCount: 100,
  availableDiskBytes: 50_000_000_000,
  fitsOnDisk: true,
};

beforeEach(() => {
  storedLookback = 3;
  mockGetPreferences.mockReset().mockImplementation(async () => ({
    success: true,
    data: { messageImport: { filters: { lookbackMonths: storedLookback, maxMessages: 50000 } } },
  }));
  mockUpdatePreferences.mockReset().mockImplementation(
    async (_userId: string, patch: { messageImport?: { filters?: { lookbackMonths?: number | null } } }) => {
      const months = patch.messageImport?.filters?.lookbackMonths;
      // Real order (preferences:update = Supabase GET + UPSERT): the store changes
      // only when the write lands, a few ticks AFTER the call. A mock that set it
      // synchronously could not show a read that races ahead of the write.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (months !== undefined) storedLookback = months;
      return { success: true };
    },
  );
  (window.api.messages.getImportStatus as jest.Mock).mockResolvedValue({
    success: true,
    messageCount: 0,
    lastImportAt: null,
  });
  (window.api.messages.getEffectiveImportWindow as jest.Mock).mockReset().mockImplementation(async () =>
    storedLookback === 12
      ? { success: true, effectiveCutoffISO: "2025-10-12T00:00:00.000Z", source: "lookback-pref", lookbackMonths: 12 }
      : { success: true, effectiveCutoffISO: "2026-03-01T00:00:00.000Z", source: "audit-period", lookbackMonths: storedLookback },
  );
  (window.api.messages.getImportCount as jest.Mock).mockReset().mockResolvedValue(ESTIMATE);
});

const renderSettingsMessages = () =>
  render(
    <React.StrictMode>
      <TextsLookbackProvider userId={USER_ID}>
        <TextsLookbackSettings userId={USER_ID} />
        <MacOSMessagesImportSettings userId={USER_ID} />
      </TextsLookbackProvider>
    </React.StrictMode>,
  );

const estimatedWindows = () =>
  (window.api.messages.getImportCount as jest.Mock).mock.calls.map(
    (call) => (call[1] as { lookbackMonths: number | null }).lookbackMonths,
  );

describe("BACKLOG-3892 S3 — C2: the macOS panel follows the shared picker", () => {
  it("a change on the shared picker re-requests the estimate for the new window and re-reads the window label", async () => {
    renderSettingsMessages();

    // Before: the stored 3 months, estimated; the deal's audit period drives the label.
    await waitFor(() => expect(estimatedWindows()).toContain(3));
    await screen.findByText(/Auto-importing messages back to/);
    const select = screen.getByTestId("texts-lookback-select") as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(select.value).toBe("3");
    expect(estimatedWindows()).not.toContain(12);
    const windowReadsBefore = (window.api.messages.getEffectiveImportWindow as jest.Mock).mock.calls.length;

    await act(async () => {
      select.value = "12";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(mockUpdatePreferences).toHaveBeenCalledWith(USER_ID, { messageImport: { filters: { lookbackMonths: 12 } } });
    // The estimate describes the NEW window …
    await waitFor(() => expect(estimatedWindows()).toContain(12));
    // … and the effective window was re-read, so the label states it.
    await waitFor(() =>
      expect((window.api.messages.getEffectiveImportWindow as jest.Mock).mock.calls.length).toBeGreaterThan(
        windowReadsBefore,
      ),
    );
    expect(await screen.findByText("Importing the last year, up to 50,000 messages")).toBeInTheDocument();
    expect(screen.queryByText(/Auto-importing messages back to/)).not.toBeInTheDocument();
  });
});
