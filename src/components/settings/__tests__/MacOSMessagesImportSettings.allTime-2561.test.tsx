/**
 * BACKLOG-2561 — the Settings dropdown must not claim "All time" for a
 * preference the main process treats as three months.
 *
 * `messageImport.filters.lookbackMonths` has two meaningful non-numeric states
 * and they are NOT the same:
 *   - the key is ABSENT  ⇒ the user never chose ⇒ the 3-month default,
 *   - the key is `null`  ⇒ the user picked "All time" ⇒ unbounded.
 *
 * This component read it with `?? null`, which renders an absent key as "All
 * time" while the import runs the default window. That state is reachable
 * today: changing only the message cap writes `{ maxMessages: N }` and the
 * preference deep-merge leaves `lookbackMonths` absent — so the fixture below is
 * the shape the app actually stores, not an invented one.
 *
 * These assertions also pin the component's local `DEFAULT_LOOKBACK_MONTHS`
 * against the main process's, which the renderer cannot import across the
 * electron/renderer boundary.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({ queue: [], requestSync: jest.fn() })),
}));

const mockGetPreferences = jest.fn();
jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: jest.fn().mockResolvedValue({ success: true }),
  },
}));

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

beforeEach(() => {
  mockGetPreferences.mockReset();
  (window.api.messages.getImportStatus as jest.Mock).mockResolvedValue({
    success: true,
    messageCount: 0,
    lastImportAt: null,
  });
  (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
    success: true,
    effectiveCutoffISO: null,
    source: "lookback-pref",
    lookbackMonths: null,
  });
  (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
    success: true,
    count: 10,
    filteredCount: 10,
  });
});

describe("BACKLOG-2561 · the lookback dropdown tells the truth about stored state", () => {
  it("shows Last 3 months when the lookbackMonths KEY is absent", async () => {
    // Exactly what handleMaxMessagesChange + the preference deep-merge leave
    // behind for a user who has only ever changed the cap.
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: { messageImport: { filters: { maxMessages: 50000 } } },
    });

    renderStrict(<MacOSMessagesImportSettings userId="user-2561" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Last 3 months")).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue("All time")).not.toBeInTheDocument();
  });

  it("shows All time only for an EXPLICIT null", async () => {
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: { messageImport: { filters: { lookbackMonths: null, maxMessages: 50000 } } },
    });

    renderStrict(<MacOSMessagesImportSettings userId="user-2561" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("All time")).toBeInTheDocument();
    });
  });

  it("shows the stored number when one is stored", async () => {
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: { messageImport: { filters: { lookbackMonths: 12, maxMessages: 50000 } } },
    });

    renderStrict(<MacOSMessagesImportSettings userId="user-2561" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Last 12 months")).toBeInTheDocument();
    });
  });

  it("shows Last 3 months when no messageImport preference exists at all", async () => {
    mockGetPreferences.mockResolvedValue({ success: true, data: {} });

    renderStrict(<MacOSMessagesImportSettings userId="user-2561" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Last 3 months")).toBeInTheDocument();
    });
  });
});
