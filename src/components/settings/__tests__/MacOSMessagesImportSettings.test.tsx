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
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import { parseLocalCalendarDay } from "../../../utils/dateRangeUtils";

// macOS platform so the component renders.
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

// Sync orchestrator: mutable queue + captured requestSync so tests can (a)
// assert what the component asked the orchestrator to do, and (b) simulate a
// completed sync by swapping the queue and re-rendering.
const mockRequestSync = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockQueue: any[] = [];

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({
    queue: mockQueue,
    requestSync: mockRequestSync,
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

// Applies to every test: idle queue by default, quiet window.api.messages reads,
// and a clean requestSync spy.
beforeEach(() => {
  mockQueue = [];
  mockRequestSync.mockReset();
  (window.api.messages.getImportStatus as jest.Mock).mockResolvedValue({
    success: true,
    messageCount: 0,
    lastImportAt: null,
  });
  (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
    success: true,
    effectiveCutoffISO: "2026-04-27T00:00:00.000Z",
    source: "lookback-pref",
    lookbackMonths: 3,
  });
  // Keep availableCount below the 50,000 default cap so "Import Messages" runs
  // directly (no cap-confirmation prompt) in the gating tests.
  (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
    success: true,
    count: 10,
    filteredCount: 10,
  });
});

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
            content.includes("Auto-importing messages back to") &&
            content.includes(expectedDate),
        ),
      ).toBeInTheDocument();
    });

    // Explains that the date selector is only used to reach back even further.
    expect(
      screen.getByText(/only applies if you want to reach back even further/i),
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

describe("MacOSMessagesImportSettings — Force Re-import confirm dialog (BACKLOG-2331)", () => {
  const userId = "user-123";

  it("does NOT start the import until the confirm dialog is accepted", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={userId} />);

    fireEvent.click(screen.getByRole("button", { name: /force re-import/i }));

    // The confirm dialog is shown and warns about UNLINKING attached conversations.
    expect(
      await screen.findByTestId("force-reimport-confirm-modal"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/unlink your attached conversations/i),
    ).toBeInTheDocument();

    // Nothing dispatched to the orchestrator yet — the action is gated.
    expect(mockRequestSync).not.toHaveBeenCalled();
  });

  it("starts a FORCE import once the destructive confirm is clicked", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={userId} />);

    fireEvent.click(screen.getByRole("button", { name: /force re-import/i }));
    fireEvent.click(await screen.findByTestId("force-reimport-confirm"));

    expect(mockRequestSync).toHaveBeenCalledTimes(1);
    expect(mockRequestSync).toHaveBeenCalledWith(["messages"], userId, {
      forceReimport: true,
    });
  });

  it("aborts when the dialog is cancelled (no import, dialog closes)", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={userId} />);

    fireEvent.click(screen.getByRole("button", { name: /force re-import/i }));
    expect(
      await screen.findByTestId("force-reimport-confirm-modal"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByTestId("force-reimport-confirm-modal"),
      ).not.toBeInTheDocument(),
    );
    expect(mockRequestSync).not.toHaveBeenCalled();
  });

  it("does NOT gate the normal import behind the dialog", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={userId} />);

    fireEvent.click(screen.getByRole("button", { name: /^import messages$/i }));

    // No confirm dialog for the normal path...
    expect(
      screen.queryByTestId("force-reimport-confirm-modal"),
    ).not.toBeInTheDocument();
    // ...and the import is dispatched immediately WITHOUT the force flag.
    expect(mockRequestSync).toHaveBeenCalledWith(["messages"], userId, {
      forceReimport: undefined,
    });
  });
});

describe("MacOSMessagesImportSettings — inactive-source gating (BACKLOG-2335)", () => {
  const userId = "user-123";

  it("disables every control and shows the note when macOS is NOT the active source", async () => {
    renderStrict(
      <MacOSMessagesImportSettings
        userId={userId}
        enabled={false}
        disabledReason="Your message source is set to iPhone — switch to macOS above to import from Messages."
      />,
    );

    // Explanatory note renders, worded from the real active source.
    const note = await screen.findByTestId("macos-import-disabled-note");
    expect(note).toHaveTextContent(/message source is set to iPhone/i);

    // Both filter selects (date range + max messages) are disabled.
    const selects = screen.getAllByRole("combobox");
    expect(selects).toHaveLength(2);
    selects.forEach((select) => expect(select).toBeDisabled());

    // Import + Force Re-import buttons are disabled → the controls cannot no-op.
    expect(
      screen.getByRole("button", { name: /^import messages$/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /force re-import/i }),
    ).toBeDisabled();

    // A disabled Force Re-import must NOT open the destructive confirm dialog.
    fireEvent.click(screen.getByRole("button", { name: /force re-import/i }));
    expect(
      screen.queryByTestId("force-reimport-confirm-modal"),
    ).not.toBeInTheDocument();
    expect(mockRequestSync).not.toHaveBeenCalled();
  });

  it("falls back to a generic note when no disabledReason is provided", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={userId} enabled={false} />);

    const note = await screen.findByTestId("macos-import-disabled-note");
    expect(note).toHaveTextContent(/not your active message source/i);
  });

  it("leaves all controls enabled and shows no note when macOS IS the active source", async () => {
    // enabled defaults to true; pass it explicitly for clarity.
    renderStrict(<MacOSMessagesImportSettings userId={userId} enabled />);

    // No inactive-source note.
    await waitFor(() =>
      expect(
        screen.queryByTestId("macos-import-disabled-note"),
      ).not.toBeInTheDocument(),
    );

    // Filter selects are interactive.
    const selects = screen.getAllByRole("combobox");
    expect(selects).toHaveLength(2);
    selects.forEach((select) => expect(select).not.toBeDisabled());

    // Import + Force Re-import are clickable.
    expect(
      screen.getByRole("button", { name: /^import messages$/i }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /force re-import/i }),
    ).not.toBeDisabled();
  });
});

describe("MacOSMessagesImportSettings — completion count (BACKLOG-2329)", () => {
  const userId = "user-123";

  const completedMessages = (importedCount: number) => [
    { type: "messages", status: "complete", progress: 100, importedCount },
  ];

  it("reports the ACTUAL imported count (not the auto-link count of 0)", async () => {
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={userId} />,
    );

    // Orchestrator finishes a normal sync that imported 38,223 messages while
    // linking 0 — the result must show the import count, not the link count.
    mockQueue = completedMessages(38223);
    rerender(
      <React.StrictMode>
        <MacOSMessagesImportSettings userId={userId} />
      </React.StrictMode>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("import-result")).toHaveTextContent(
        "Successfully imported 38,223 new messages",
      ),
    );
  });

  it("uses 'Re-imported N messages' wording for the force path", async () => {
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={userId} />,
    );

    // Trigger the force path through the confirm dialog so the component records it.
    fireEvent.click(screen.getByRole("button", { name: /force re-import/i }));
    fireEvent.click(await screen.findByTestId("force-reimport-confirm"));
    expect(mockRequestSync).toHaveBeenCalledWith(["messages"], userId, {
      forceReimport: true,
    });

    // Orchestrator completes the force re-import with 38,223 rows.
    mockQueue = completedMessages(38223);
    rerender(
      <React.StrictMode>
        <MacOSMessagesImportSettings userId={userId} />
      </React.StrictMode>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("import-result")).toHaveTextContent(
        "Re-imported 38,223 messages",
      ),
    );
    // Must NOT fall back to the normal-sync "new messages" copy.
    expect(screen.getByTestId("import-result")).not.toHaveTextContent(
      "new messages",
    );
  });
});
