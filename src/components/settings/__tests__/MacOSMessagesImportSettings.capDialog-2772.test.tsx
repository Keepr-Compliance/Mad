/**
 * BACKLOG-2772 — the cap dialog states the WINDOW, and its buttons promise what
 * their runs actually do.
 *
 * ─── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
 *
 * Making the estimate honour Cap' changed what `availableCount` MEANS. It used
 * to be the window; it is now what the run will import, cap already applied.
 * Three places in this panel were still reading it as the window, and each
 * failure is worse than the last:
 *
 *   1. "This time period contains N messages, which exceeds the M limit" —
 *      with a 50,000 cap and no deals, N IS 50,000. The sentence contradicts
 *      itself, guaranteed, every time it renders.
 *   2. The same shape inside the cap prompt.
 *   3. "Import all N messages" — and that button writes `maxMessages: null` and
 *      fetches the WHOLE window. It would have offered to import 50,000 and
 *      then imported 707,842.
 *
 * (3) is the one that matters. It is a false statement at the moment of
 * consent, and it breaks the founder's own rule for this dialog: no rendered
 * button may promise something its run does not deliver.
 *
 * The figures are the founder's measured ones, as elsewhere in this suite:
 * 707,842 messages in the window, a 50,000 cap.
 */

import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

const mockRequestSync = jest.fn();
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({ queue: [], requestSync: mockRequestSync })),
}));

const mockGetPreferences = jest.fn();
const mockUpdatePreferences = jest.fn();
jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

const USER_ID = "user-2772";
const WINDOW_COUNT = 707842;
const CAP = 50000;

/**
 * What main returns for a window of 707,842 with a 50,000 cap and no deals.
 *
 * Transcribed from the shape `getAvailableMessageCount` now produces rather
 * than invented: `filteredCount` is the ADMITTED count (the cap, applied) and
 * `windowCount` is the selection before it. Pre-BACKLOG-2772 there was no
 * `windowCount` and `filteredCount` carried the window — which is exactly why
 * the three consumers below read the wrong one.
 */
const CAPPED_RESULT = {
  success: true,
  count: WINDOW_COUNT,
  filteredCount: CAP,
  windowCount: WINDOW_COUNT,
  attachmentBytes: 2_600_000_000,
  attachmentCount: 2_913,
  availableDiskBytes: 59_100_000_000,
  fitsOnDisk: true,
};

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

/**
 * Press Import once the estimate has settled.
 *
 * Waiting for ENABLED rather than merely present is load-bearing: the button is
 * disabled while the size estimate is in flight (BACKLOG-2760's fail-closed
 * guard), so clicking on first paint reaches a disabled control and the prompt
 * never opens.
 */
async function openCapPrompt(): Promise<void> {
  const importButton = await screen.findByRole("button", { name: /Import Messages/i });
  await waitFor(() => expect(importButton).toBeEnabled());
  fireEvent.click(importButton);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestSync.mockReset();
  mockUpdatePreferences.mockResolvedValue({ success: true });

  mockGetPreferences.mockResolvedValue({
    success: true,
    data: {
      messageImport: {
        filters: { lookbackMonths: null, maxMessages: CAP, skipAttachments: false },
      },
    },
  });

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
  (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(CAPPED_RESULT);
});

describe("BACKLOG-2772 — the cap disclosure reads the window, not the admitted count", () => {
  it("the pre-import notice states the window and cannot contradict itself", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const notice = await screen.findByText(/This time period contains/);

    expect(notice).toHaveTextContent("707,842 messages");
    expect(notice).toHaveTextContent("exceeds the 50,000 limit");
    // The defect stated directly: the two numbers must never be the same one.
    expect(notice).not.toHaveTextContent("contains 50,000 messages");
  });

  it("the cap prompt states the window", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await openCapPrompt();

    const prompt = await screen.findByText(/This time period has/);
    expect(prompt).toHaveTextContent("707,842 messages but your limit is 50,000");
  });

  it("PIN: 'Import all N' promises the number that run actually fetches", async () => {
    /*
     * The honourable-buttons rule, as a test.
     *
     * This button sets `maxMessages: null` before starting the run, so its run
     * resolves a plan with `effectiveCap: null` — and a null cap admits the
     * whole window, which is `windowCount`. The label must therefore be
     * `windowCount`, and the sibling "most recent N only" button must be the
     * cap. Asserting both together is what makes the pair coherent rather than
     * merely non-empty.
     *
     * The other half of this pin — that a null-cap plan really does admit
     * exactly `windowCount` — is asserted against the real driver in
     * `macOSMessagesImportService.preflightMaskingRealDriver-2784.test.ts`
     * ("a null cap admits the whole window"). Neither half is sufficient
     * alone: this one knows what the label says, that one knows what the run
     * does.
     */
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await openCapPrompt();

    const importAll = await screen.findByRole("button", { name: /Import all/i });
    expect(importAll).toHaveTextContent("Import all 707,842 messages");
    expect(importAll).not.toHaveTextContent("50,000");

    const mostRecent = screen.getByRole("button", { name: /most recent/i });
    expect(mostRecent).toHaveTextContent("Import most recent 50,000 only");
  });

  it("ANTI-VACUITY: no cap disclosure at all when the window fits under the cap", async () => {
    // Without this, every assertion above would be equally green for a panel
    // that rendered the cap warning unconditionally.
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      ...CAPPED_RESULT,
      count: 1200,
      filteredCount: undefined,
      windowCount: 1200,
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Import Messages/i })).toBeEnabled()
    );
    expect(screen.queryByText(/This time period contains/)).not.toBeInTheDocument();
  });
});
