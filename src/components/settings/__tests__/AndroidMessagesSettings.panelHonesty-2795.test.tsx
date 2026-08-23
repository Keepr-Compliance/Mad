/**
 * BACKLOG-2795 — the two defects this panel inherited from the macOS one.
 *
 * Both were fixed for `MacOSMessagesImportSettings` in PR #2345 (BACKLOG-2749)
 * and left standing here, which is what the SR sweep on that PR recorded:
 * "Residual: AndroidMessagesSettings.tsx:277/280 still carries the untreated
 * twin."
 *
 *   1. `setMaxMessages(filters.maxMessages ?? null)` rendered an ABSENT cap as
 *      "Unlimited" while the resolver treats an absent key as the 50,000
 *      default. Absent means "no preference"; only an explicit `null` — what
 *      this dropdown writes for "Unlimited" — means unbounded.
 *   2. The active-filter line named a cap ("...up to N messages") that nothing
 *      on the Android path enforces.
 *
 * The fixtures below are the shapes the app actually writes: each dropdown
 * writes ONE key, and the preferences deep-merge
 * (`electron/handlers/preferenceHandlers.ts:207-227`) leaves the other absent.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AndroidMessagesSettings } from "../AndroidMessagesSettings";

const mockGetPreferences = jest.fn();
const mockUpdatePreferences = jest.fn();
jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

/** BACKLOG-2734: the panel's own namespace, so no seed fires during these cases. */
const androidPrefs = (filters: Record<string, unknown>) => ({
  success: true,
  data: { messageImport: { android: { filters } } },
});

beforeEach(() => {
  mockGetPreferences.mockReset();
  mockUpdatePreferences.mockReset();
  mockUpdatePreferences.mockResolvedValue({ success: true });
  (window.api.localSync.getStatus as jest.Mock).mockResolvedValue({
    running: false,
    port: null,
    address: null,
    totalMessagesReceived: 0,
    lastSyncTimestamp: null,
  });
});

describe("BACKLOG-2795 · the Android cap dropdown tells the truth about stored state", () => {
  /**
   * This case needs an ANCHOR, and the anchor has to be the LOOKBACK.
   *
   * The component's initial cap state is already 50,000 — the value the fix
   * makes an absent key resolve to — so "50,000" is on screen before the stored
   * preference has been read. An assertion made at that moment passes with the
   * fix reverted, which is exactly how the first draft of this panel's 2561
   * mirror went green against a broken component (see that suite's comment).
   *
   * The fixture therefore stores `lookbackMonths: 18` and no cap. Waiting for
   * "Last 18 months" — which differs from the initial 3 — proves the SAME load
   * pass has landed, so the cap assertion after it measures post-read state.
   * `{ lookbackMonths: N }` with no cap key is precisely what
   * `handleLookbackChange` plus the deep-merge leave behind for a user who has
   * only ever changed the time range.
   */
  it("shows the 50,000 default when the maxMessages KEY is absent", async () => {
    mockGetPreferences.mockResolvedValue(androidPrefs({ lookbackMonths: 18 }));

    renderStrict(<AndroidMessagesSettings userId="user-2795" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Last 18 months")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("50,000")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Unlimited")).not.toBeInTheDocument();
  });

  it("shows Unlimited only for an EXPLICIT null", async () => {
    mockGetPreferences.mockResolvedValue(
      androidPrefs({ lookbackMonths: 18, maxMessages: null })
    );

    renderStrict(<AndroidMessagesSettings userId="user-2795" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Unlimited")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("Last 18 months")).toBeInTheDocument();
  });

  it("shows the stored cap when one is stored", async () => {
    mockGetPreferences.mockResolvedValue(
      androidPrefs({ lookbackMonths: 18, maxMessages: 10000 })
    );

    renderStrict(<AndroidMessagesSettings userId="user-2795" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("10,000")).toBeInTheDocument();
    });
  });
});

describe("BACKLOG-2795 · the panel does not name a cap no run enforces", () => {
  /**
   * The founder's ruling on BACKLOG-2749 (`1e8baa69`) dropped the "up to N
   * messages" phrase. On the macOS panel it survives only where it is true;
   * here there is no such branch, because no code on the Android companion path
   * reads `maxMessages` at all.
   *
   * The sweep is on the RENDERED text, both states that used to carry the
   * phrase — cap-only and range-plus-cap — because those are the two branches
   * the removed ternary had.
   */
  const capPhrase = /up to [\d,]+ messages/i;

  it("says nothing when only a cap is set (the standalone twin)", async () => {
    mockGetPreferences.mockResolvedValue(
      androidPrefs({ lookbackMonths: null, maxMessages: 10000 })
    );

    const { container } = renderStrict(
      <AndroidMessagesSettings userId="user-2795" />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue("10,000")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("All time")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(capPhrase);
    // Nor any active-filter line at all: an unbounded range plus an
    // unenforced cap leaves nothing true to say.
    expect(container.textContent).not.toMatch(/Importing/i);
  });

  it("states the range and only the range when both are set (the combined twin)", async () => {
    mockGetPreferences.mockResolvedValue(
      androidPrefs({ lookbackMonths: 6, maxMessages: 10000 })
    );

    const { container } = renderStrict(
      <AndroidMessagesSettings userId="user-2795" />
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue("10,000")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Importing messages from the last 6 months")
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(capPhrase);
  });
});
