/**
 * BACKLOG-2561 — the Android panel reads the SAME preference as the macOS one.
 *
 * `AndroidMessagesSettings` writes and reads `messageImport.filters` — the exact
 * key `messageImportHandlers` imports with — so it had the identical `?? null`
 * collapse: an ABSENT `lookbackMonths` rendered as "All time" while the main
 * process imported the 3-month default.
 *
 * These are the macOS assertions mirrored onto this panel, so the Android fix is
 * covered by a suite rather than by the argument that it looks the same.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AndroidMessagesSettings } from "../AndroidMessagesSettings";

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
  (window.api.localSync.getStatus as jest.Mock).mockResolvedValue({
    running: false,
    port: null,
    address: null,
    totalMessagesReceived: 0,
    lastSyncTimestamp: null,
  });
});

describe("BACKLOG-2561 · the Android lookback dropdown tells the truth", () => {
  /**
   * The absent-key case needs an ANCHOR, because the component's initial state
   * is already 3 months — "Last 3 months" is on screen before the stored
   * preference has even been read, so an assertion made at that moment passes
   * no matter what the component does with the preference. The first draft of
   * this test did exactly that and stayed GREEN with the fix reverted; the
   * control caught it.
   *
   * The fixture therefore stores a cap of 10,000, which differs from the
   * component's initial 50,000. Waiting for "10,000" proves the SAME
   * `loadFilters` pass has landed, so the lookback assertion after it measures
   * post-read state. 10,000 is a real dropdown option, and `{ maxMessages: N }`
   * with no lookback key is exactly what `handleMaxMessagesChange` plus the
   * preference deep-merge leave behind.
   */
  it("shows Last 3 months when the lookbackMonths KEY is absent", async () => {
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: { messageImport: { filters: { maxMessages: 10000 } } },
    });

    renderStrict(<AndroidMessagesSettings userId="user-2561" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("10,000")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("Last 3 months")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("All time")).not.toBeInTheDocument();
  });

  it("shows All time only for an EXPLICIT null", async () => {
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: { messageImport: { filters: { lookbackMonths: null, maxMessages: 50000 } } },
    });

    renderStrict(<AndroidMessagesSettings userId="user-2561" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("All time")).toBeInTheDocument();
    });
  });

  it("shows the stored number when one is stored", async () => {
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: { messageImport: { filters: { lookbackMonths: 18, maxMessages: 50000 } } },
    });

    renderStrict(<AndroidMessagesSettings userId="user-2561" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Last 18 months")).toBeInTheDocument();
    });
  });
});
