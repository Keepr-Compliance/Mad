/**
 * Tests for MacOSMessagesImportSettings.tsx — BACKLOG-2286
 *
 * The Settings → macOS Messages label must reflect the EFFECTIVE (audit-aware)
 * import window, not always "last N months". Post-BACKLOG-2276 the real import
 * lower bound is the EARLIER of the user's lookback preference and the earliest
 * transaction audit-period start, so:
 *   - when the audit period drives the window, the label shows the audit-period
 *     copy with the formatted cutoff date, and
 *   - when the lookback preference governs, the label keeps the pref-based copy.
 *
 * Date assertions are derived from the SAME local-day formatter the component
 * uses (parseLocalCalendarDay), so they are timezone- and locale-agnostic.
 *
 * Wrapped in React.StrictMode per repo convention (StrictMode is ON in prod).
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import { parseLocalCalendarDay } from "../../../utils/dateRangeUtils";

// macOS platform so the component renders.
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

// Sync orchestrator: idle queue (not importing).
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({
    queue: [],
    requestSync: jest.fn(),
  })),
}));

// Preference reads/writes are no-ops for these label tests.
jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: jest.fn().mockResolvedValue({ success: true, data: {} }),
    updatePreferences: jest.fn().mockResolvedValue({ success: true }),
  },
}));

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

/** Expected display string for a cutoff ISO, via the component's own formatter. */
function expectedCutoffLabel(iso: string): string {
  const d = parseLocalCalendarDay(iso)!;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

describe("MacOSMessagesImportSettings — effective import window label (BACKLOG-2286)", () => {
  const userId = "user-123";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows the audit-period copy with the formatted date when the window is audit-driven", async () => {
    const auditCutoffISO = "2026-01-01T00:00:00.000Z";
    (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
      success: true,
      effectiveCutoffISO: auditCutoffISO,
      source: "audit-period",
      lookbackMonths: 3,
    });

    renderStrict(<MacOSMessagesImportSettings userId={userId} />);

    const expectedDate = expectedCutoffLabel(auditCutoffISO); // e.g. "Jan 1, 2026"

    await waitFor(() => {
      expect(
        screen.getByText(
          (content) =>
            content.includes("Importing messages since") &&
            content.includes(expectedDate) &&
            content.includes("(audit period)"),
        ),
      ).toBeInTheDocument();
    });

    // Explains that the date selector is only used when it reaches back further.
    expect(
      screen.getByText(/used\s+only when it reaches back further/i),
    ).toBeInTheDocument();

    // Must NOT show the misleading "last N months" copy while audit-driven.
    expect(
      screen.queryByText(/Importing messages from the last \d+ months/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the lookback-preference copy when the preference governs", async () => {
    (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
      success: true,
      effectiveCutoffISO: "2026-04-27T00:00:00.000Z",
      source: "lookback-pref",
      lookbackMonths: 3,
    });

    renderStrict(<MacOSMessagesImportSettings userId={userId} />);

    // Default UI state is 3 months + 50,000 cap, so the combined pref copy shows.
    await waitFor(() => {
      expect(
        screen.getByText(/Importing last 3 months, up to 50,000 messages/i),
      ).toBeInTheDocument();
    });

    // No audit-period copy when the preference governs.
    expect(screen.queryByText(/\(audit period\)/i)).not.toBeInTheDocument();
  });
});
