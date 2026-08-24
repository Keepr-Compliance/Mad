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
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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
  /*
   * BACKLOG-2749 added the plan's own facts to this wire, so the fixture gains
   * them — transcribed from what `messages:get-import-count` now returns, not
   * invented. `effectiveCap` is `ImportPlan.effectiveCap`; `overrides` is empty
   * because this corpus has no deals, which is also why `filteredCount` here
   * equals the cap exactly.
   */
  plan: {
    effectiveCap: CAP,
    fetchStartISO: null,
    overrides: [] as [],
  },
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
    /*
     * BACKLOG-2749 replaced the prompt's lead sentence by founder decision
     * (`1e8baa69`, 2026-08-22): the dialog leads with the WINDOW statement,
     * in the same words the inline notice uses, instead of "This time period
     * has N messages but your limit is M".
     *
     * The NUMERIC assertion is unchanged and is what this test is for — the
     * window count, never the admitted count. Only the text query moved, and
     * it is scoped to the dialog because the inline notice on the panel behind
     * it now carries the identical sentence (that identity is the point: one
     * fact, one wording).
     */
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await openCapPrompt();

    /*
     * BACKLOG-2749 round 3 (founder live QA): the passage was rewritten again,
     * to his dictation. The NUMBERS this suite exists for are unchanged — the
     * window against the cap, never the admitted count — only the sentence
     * carrying them.
     */
    const prompt = within(
      await screen.findByTestId("import-plan-cap-body")
    ).getByText(/Your selected time range of/);
    expect(prompt).toHaveTextContent("707,842");
    expect(prompt).toHaveTextContent("cap of 50,000");
    // The defect this suite exists for, stated directly.
    expect(prompt).not.toHaveTextContent("includes 50,000 messages");
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

    const importAll = await screen.findByTestId("import-plan-import-all");
    expect(importAll).toHaveTextContent("Import all 707,842 messages");
    expect(importAll).not.toHaveTextContent("50,000");

    /*
     * BACKLOG-2749 round 3: the sibling this used to pair against — "Import
     * most recent 50,000 only" — was REMOVED by the founder at live QA. His
     * 08-20 ruling (do not offer most-recent-N) returned; #2345 had superseded
     * it, and he re-superseded the supersede.
     *
     * The pairing was how this test avoided passing on a lone number, so it
     * needs a replacement rather than a deletion. The passage carries the cap,
     * the button carries the window, and they must still be different numbers
     * in different places — which is the property the pair was standing in for.
     */
    expect(screen.queryByRole("button", { name: /most recent/i })).toBeNull();
    const passage = screen.getByText(/Your selected time range of/);
    expect(passage).toHaveTextContent("cap of 50,000");
    expect(passage).toHaveTextContent("707,842");
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
