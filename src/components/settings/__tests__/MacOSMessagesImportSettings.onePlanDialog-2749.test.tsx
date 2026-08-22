/**
 * BACKLOG-2749 — the ONE pre-import dialog, pinned against the resolver's plan.
 *
 * ─── THE CASE THIS SUITE IS BUILT ON ─────────────────────────────────────────
 *
 * The founder's live machine, 2026-08-22, testing PR #2343's estimate panel.
 * A 50,000 message cap, deals whose audit periods reach back into the corpus,
 * and 708,400 messages in the selected window. Under Cap' (BACKLOG-2772) the
 * messages inside those audit periods are fetched complete and never counted
 * against the cap, so the run admits 62,824 — the cap PLUS the protected
 * history. Three things then went wrong at once, and each is a control here:
 *
 *   1. The panel's header said "Importing up to 50,000 messages" while the
 *      line beneath it said the selection covered 62,823. Both were derived
 *      honestly, from different inputs, and they contradicted each other.
 *      (`1e8baa69`)
 *   2. "Import most recent 50,000 only" actually delivered 62,823 — it
 *      understated in the user's favour, but it still was not what happened.
 *      (`3a4fc2b2`)
 *   3. The completion toast said "659,619 messages excluded by import limit",
 *      computed as 708,400 − 48,781: the window minus what THAT RUN
 *      downloaded. It counted the 14,042 messages already in the store as
 *      excluded. The true figure is 708,400 − 62,824 = 645,576. (`a14b3a82`)
 *
 * All three are the same defect wearing three hats: a surface computing a
 * number it should have been TOLD.
 *
 * ─── WHY THE FIXTURE HAS TO SEPARATE ALL THREE NUMBERS ───────────────────────
 *
 * window (708,400) > admitted (62,824) > cap (50,000).
 *
 * A fixture with no deals cannot catch any of this: admitted == cap, so a
 * dialog that printed the admitted count where the cap belongs — or the cap
 * where the admitted count belongs — would be indistinguishable from a correct
 * one. That is exactly why the pre-existing `capDialog-2772` suite, which is a
 * no-deals fixture, stayed green through the whole of this defect. Every
 * mutation in the CONTROL block below is invisible to it.
 *
 * The plan facts are transcribed from what `messages:get-import-count` returns
 * now that the handler spreads `{effectiveCap, fetchStartISO, overrides}` onto
 * the counts — not invented.
 */

import React from "react";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
  act,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import { stripStaleCapClause } from "../MacOSMessagesImportSettings";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

const mockRequestSync = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockQueue: any[] = [];
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({
    queue: mockQueue,
    requestSync: mockRequestSync,
    markCancelRequested: jest.fn(),
  })),
}));

const mockGetPreferences = jest.fn();
const mockUpdatePreferences = jest.fn();
jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

const USER_ID = "user-2749";

/** The founder's measured figures, 2026-08-22. */
const WINDOW_COUNT = 708400;
const ADMITTED_COUNT = 62824;
const CAP = 50000;
/** What his delta run actually downloaded — 14,042 were already stored. */
const IMPORTED_THIS_RUN = 48781;
/** window − admitted. The figure he should have been shown. */
const CORRECT_EXCLUDED = 645576;
/** window − imported-this-run. The figure he WAS shown. */
const WRONG_EXCLUDED = 659619;

/**
 * What main returns for the founder's case.
 *
 * `filteredCount` is the ADMITTED coverage (Cap' applied), `windowCount` the
 * selection before the cap, and `plan` the resolver's own decisions. The
 * override is present because his deals reach further back than his
 * "Import messages from" setting — which is what makes the protected history
 * exist at all.
 */
const FOUNDER_RESULT = {
  success: true,
  count: WINDOW_COUNT,
  filteredCount: ADMITTED_COUNT,
  windowCount: WINDOW_COUNT,
  attachmentBytes: 2_600_000_000,
  attachmentCount: 2_913,
  availableDiskBytes: 59_100_000_000,
  fitsOnDisk: true,
  plan: {
    effectiveCap: CAP,
    fetchStartISO: "2024-03-01T00:00:00.000Z",
    overrides: [
      {
        kind: "window-extended-by-deals" as const,
        requestedStartISO: "2026-05-22T00:00:00.000Z",
        effectiveStartISO: "2024-03-01T00:00:00.000Z",
      },
    ],
  },
};

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

const importButton = () =>
  screen.getByRole("button", { name: /Import Messages/i });

/** Open the dialog once the estimate has settled and Import is live. */
async function openDialog(): Promise<HTMLElement> {
  await waitFor(() => expect(importButton()).toBeEnabled());
  fireEvent.click(importButton());
  return screen.findByTestId("import-plan-dialog");
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueue = [];
  mockRequestSync.mockReset();
  mockUpdatePreferences.mockResolvedValue({ success: true });

  mockGetPreferences.mockResolvedValue({
    success: true,
    data: {
      messageImport: {
        filters: { lookbackMonths: 3, maxMessages: CAP, skipAttachments: false },
      },
    },
  });

  (window.api.messages.getImportStatus as jest.Mock).mockResolvedValue({
    success: true,
    messageCount: 14042,
    lastImportAt: null,
  });
  (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
    success: true,
    effectiveCutoffISO: "2024-03-01T00:00:00.000Z",
    source: "audit-period",
    lookbackMonths: 3,
  });
  (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
    FOUNDER_RESULT
  );
});

// ───────────────────────────────────────────────────────────────────────────
// CONTROL 1 — every number on the dialog comes from the plan
// ───────────────────────────────────────────────────────────────────────────

describe("BACKLOG-2749 — the dialog states the plan's numbers, and derives none", () => {
  it("CONTROL: cap and window are two DIFFERENT numbers, each in its own place", async () => {
    /*
     * The mutation this is built to catch: a dialog that reconstructs the cap
     * from the counts. Every plausible reconstruction is wrong here and lands
     * on a number this test names:
     *
     *   - cap from `filteredCount`          -> "cap of 62,824"
     *   - cap from `min(window, admitted)`  -> "cap of 62,824"
     *
     * With a no-deals fixture both of those print 50,000 and nothing goes red,
     * which is how this defect survived a full SR review on #2343.
     *
     * BACKLOG-2749 round 3: the coverage line is gone (founder, live QA), so
     * the admitted count no longer appears on this dialog at all. That is now
     * itself an assertion — Cap' still admits 62,824 at RUN time, but the
     * dialog stopped explaining it.
     */
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();
    const body = within(dialog);

    const passage = body.getByText(/Your selected time range of/);
    expect(passage).toHaveTextContent("708,400");
    expect(passage).toHaveTextContent("cap of 50,000");
    expect(passage).not.toHaveTextContent("62,824");
    // The dropped explanation, pinned as dropped.
    expect(body.queryByTestId("import-plan-coverage")).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("62,824");
  });

  it("names the user's own time range back to him", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();
    expect(
      within(dialog).getByText(/Your selected time range of/)
    ).toHaveTextContent("Last 3 months");
  });

  it("CONTROL: the recommendation is the largest range whose OWN count fits the cap", async () => {
    /*
     * The founder's [R], and the mutation that matters: self-computing it.
     *
     * Messages are not spread evenly across months, so nothing about the
     * current range's 708,400 tells you which shorter range holds fewer than
     * 50,000. The renderer must ASK main for each candidate's own count and
     * select among the answers. Here 24 and 18 months are still over the cap
     * and 12 is under it, so R is 12 — a fixture no proportional guess from
     * 708,400 would land on.
     */
    // All time, so shorter presets exist to recommend. (On a 3-month range
    // there is nothing shorter than 3, and no recommendation is the correct
    // answer — pinned by the ANTI-VACUITY case below.)
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        messageImport: {
          filters: { lookbackMonths: null, maxMessages: CAP, skipAttachments: false },
        },
      },
    });
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection?: { lookbackMonths: number | null }) => {
        const months = selection?.lookbackMonths ?? null;
        if (months === null) return Promise.resolve(FOUNDER_RESULT);
        if (months >= 18)
          return Promise.resolve({ ...FOUNDER_RESULT, windowCount: 300000 });
        return Promise.resolve({ ...FOUNDER_RESULT, windowCount: 41000 });
      }
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    const passage = await within(dialog).findByText(
      /Your selected time range of/
    );
    await waitFor(() =>
      expect(passage).toHaveTextContent("recommended: Last 12 months")
    );
    expect(passage).not.toHaveTextContent("Last 9 months");
    expect(
      within(dialog).getByTestId("import-plan-change-range")
    ).toHaveTextContent("Change the time range");
  });

  it("ANTI-VACUITY: no recommendation when nothing shorter fits the cap", async () => {
    // Every candidate is still over the cap, so there is nothing to recommend
    // and the blue button does not appear. Without this half, a button that
    // always appeared would pass the test above.
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
      FOUNDER_RESULT
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    await waitFor(() =>
      expect(
        within(dialog).getByTestId("import-plan-import-all")
      ).toBeInTheDocument()
    );
    expect(
      within(dialog).queryByTestId("import-plan-change-range")
    ).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/recommended:/i);
  });

  it("the founder's dropped offers are gone: no most-recent-N, no third button", async () => {
    /*
     * His 08-20 ruling RETURNED at live QA. PR #2345 had superseded it on the
     * reasoning that Cap' made "most recent N" honourable — which it did. The
     * offer was honest and still one choice too many: "very long, a user will
     * get lost — what are we asking?"
     *
     * Cap' is untouched. Protected audit history is still always imported at
     * RUN time, whichever button is pressed; only the dialog's offer changed.
     */
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    expect(
      within(dialog).queryByTestId("import-plan-keep-limit")
    ).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/most recent/i);
    expect(dialog).not.toHaveTextContent(/protected history/i);
    // The way out is the unobtrusive close, not a third row button.
    expect(within(dialog).getByTestId("import-plan-close")).toBeInTheDocument();
    expect(
      within(dialog).queryByTestId("import-plan-cancel")
    ).not.toBeInTheDocument();
  });

  it("the import-everything button carries the WINDOW count (BACKLOG-2772, unweakened)", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    const all = within(dialog).getByTestId("import-plan-import-all");
    expect(all).toHaveTextContent("Import all 708,400 messages");
    // The 2772 pin, restated for the deals case: this button clears the cap and
    // fetches the whole window, so neither the cap nor the admitted count may
    // appear on it.
    expect(all).not.toHaveTextContent("50,000");
    expect(all).not.toHaveTextContent("62,824");
  });

  it("CONTROL: the import-everything button NEVER starts a run without the interstitial", async () => {
    /*
     * Founder, live QA: "This will slow down Keepr's performance and is not
     * recommended." A single click on the expensive answer must not reach the
     * orchestrator — it must reach that sentence first.
     *
     * Two-ended on purpose. The first click starts nothing; only the confirm
     * does. Asserting the second half alone would pass for a dialog with no
     * interstitial at all.
     */
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByTestId("import-plan-import-all"));

    const confirm = await within(dialog).findByTestId(
      "import-plan-import-all-confirm"
    );
    expect(confirm).toHaveTextContent(
      /This will slow down Keepr.s performance and is not recommended\./
    );
    expect(mockRequestSync).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByTestId("import-plan-import-all-anyway")
    );
    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());
  });

  it("Back returns to the question with its numbers intact", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByTestId("import-plan-import-all"));
    fireEvent.click(await within(dialog).findByTestId("import-plan-import-all-back"));

    expect(
      within(dialog).getByText(/Your selected time range of/)
    ).toHaveTextContent("708,400");
    expect(mockRequestSync).not.toHaveBeenCalled();
  });

  it("ANTI-VACUITY: no dialog at all when the window fits under the cap", async () => {
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      ...FOUNDER_RESULT,
      count: 4200,
      filteredCount: 4200,
      windowCount: 4200,
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await waitFor(() => expect(importButton()).toBeEnabled());
    fireEvent.click(importButton());

    expect(screen.queryByTestId("import-plan-dialog")).not.toBeInTheDocument();
    // It ran straight through, which is the other half of "no friction".
    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CONTROL 1b — the plan's cap is not the dropdown's cap, and the plan wins
// ───────────────────────────────────────────────────────────────────────────

describe("BACKLOG-2749 — an ABSENT maxMessages preference is a cap, not Unlimited", () => {
  /*
   * Found by writing CONTROL 1, and live on develop before this change.
   *
   * Changing ONLY the lookback writes `{ lookbackMonths: N }` and the
   * preferences deep-merge leaves `maxMessages` ABSENT — the shape BACKLOG-2561
   * documented. The panel read that with `?? null`, and `null` is what its own
   * dropdown writes for an explicit "Unlimited". So the setting read Unlimited
   * while `resolveMaxMessages` capped the run at 50,000, and because the panel
   * believed there was no cap, no dialog opened to say so.
   *
   * This is BACKLOG-2733 on the renderer side: the resolver learned to tell an
   * absent key from an explicit null, and the panel never did. It is also this
   * item's own invariant — what the user was told is what the service does —
   * broken in the quietest available way.
   */
  beforeEach(() => {
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        // No `maxMessages` key at all. Written by changing only the lookback.
        messageImport: { filters: { lookbackMonths: 3, skipAttachments: false } },
      },
    });
  });

  it("CONTROL: the dropdown shows the cap the run will enforce, not Unlimited", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByDisplayValue("50,000")).toBeInTheDocument()
    );
    expect(screen.queryByDisplayValue("Unlimited")).not.toBeInTheDocument();
  });

  it("CONTROL: the dialog opens and states the plan's cap", async () => {
    // The half that needs the plan on the wire. `plan.effectiveCap` is 50,000
    // because that is what the resolver applies for an absent key; the panel's
    // own dropdown state is a SECOND opinion, and this is the case that proves
    // the dialog reads the first one.
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    expect(
      within(dialog).getByText(/Your selected time range of/)
    ).toHaveTextContent("cap of 50,000");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CONTROL 2 — the founder's self-contradiction, as a test
// ───────────────────────────────────────────────────────────────────────────

describe("BACKLOG-2749 — no surface says 'up to 50,000' while another says 62,824", () => {
  it("CONTROL: the whole panel, dialog open, contains no 'up to 50,000' anywhere", async () => {
    /*
     * This is the founder's screenshot as an assertion. It deliberately reads
     * the ENTIRE rendered tree rather than one element, because the defect was
     * never in one element — it was two elements each right on its own.
     *
     * It reaches lines that no earlier control touched: the audit-driven
     * indicator ("Auto-importing messages back to …, up to 50,000 messages")
     * and its lookback-preference twin. Reverting either of those to the
     * unconditional "up to {maxMessages}" phrasing turns this red while every
     * dialog assertion above stays green.
     */
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    await openDialog();

    const panel = screen.getByTestId("macos-messages-import");
    expect(panel).not.toHaveTextContent(/up to 50,000/i);
    // …while the coverage the run really delivers IS on screen. BACKLOG-2749
    // round 3 moved this to the PANEL indicator: the founder removed the
    // dialog's coverage line, so the panel is now the only place that states
    // what Cap' will actually deliver. The contradiction this control exists
    // for is therefore still exactly reachable.
    expect(panel).toHaveTextContent("covering 62,824 messages");
  });

  it("the panel indicator states the coverage, not the cap, when history is protected", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const indicator = await screen.findByText(/Auto-importing messages back to/);
    expect(indicator).toHaveTextContent("covering 62,824 messages");
    expect(indicator).toHaveTextContent("your 50,000 newest plus your deals");
    expect(indicator).not.toHaveTextContent(/up to 50,000/i);
  });

  it("ANTI-VACUITY: with nothing protected, the cap phrasing is kept verbatim", async () => {
    /*
     * The other half, and the reason the reword is conditional rather than a
     * blanket rewrite: when admitted == cap, "up to 50,000 messages" is exactly
     * true and three suites assert it. A change that made the coverage phrasing
     * unconditional would read "covering 50,000 messages (your 50,000 newest
     * plus your deals' protected history)" for a user with no deals.
     */
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      ...FOUNDER_RESULT,
      filteredCount: CAP,
      plan: { ...FOUNDER_RESULT.plan, overrides: [] },
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const indicator = await screen.findByText(/Auto-importing messages back to/);
    expect(indicator).toHaveTextContent("up to 50,000 messages");
    expect(indicator).not.toHaveTextContent(/covering/i);
  });

  it("ANTI-VACUITY: with nothing protected the panel keeps the plain cap phrasing", async () => {
    /*
     * The other half, and the reason the panel's reword is conditional rather
     * than a blanket rewrite: when admitted == cap, "up to 50,000 messages" is
     * exactly true and three suites assert it. An unconditional coverage
     * phrasing would read "covering 50,000 messages (your 50,000 newest plus
     * your deals' protected history)" for a user with no deals.
     */
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      ...FOUNDER_RESULT,
      filteredCount: CAP,
      plan: { ...FOUNDER_RESULT.plan, overrides: [] },
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    const indicator = await screen.findByText(/Auto-importing messages back to/);
    expect(indicator).toHaveTextContent("up to 50,000 messages");
    expect(indicator).not.toHaveTextContent(/covering/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CONTROL 3 — the completion arithmetic
// ───────────────────────────────────────────────────────────────────────────

describe("BACKLOG-2749 — completion reports coverage, not fetch volume", () => {
  /*
   * WHICH RUN STILL HITS THE CAP — worth stating, because round 3 changed it.
   *
   * The founder's rewrite removed the keep-the-limit button, which is how
   * these tests used to start a capped run. Walking the remaining paths: the
   * blue recommendation moves to a range that FITS (so nothing is excluded),
   * and "Import all anyway" clears the cap for its run (so nothing is
   * excluded). Neither can produce this sentence.
   *
   * The path that still can is the SPACE refusal: a library too large for the
   * disk AND over the cap shows the space dialog (it outranks the cap), and
   * "Import message text only" starts a run on the unchanged range — capped,
   * with the cap genuinely excluding messages. That is a real journey, not a
   * contrivance: it is the founder's own machine, which is both.
   *
   * So the coverage sentence is reachable, and narrower than it was. Recorded
   * rather than assumed — I walked the paths before repointing these tests.
   */
  const TOO_BIG_AND_CAPPED = {
    ...FOUNDER_RESULT,
    attachmentBytes: 61_300_000_000,
    availableDiskBytes: 59_100_000_000,
    fitsOnDisk: false,
  };

  beforeEach(() => {
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
      TOO_BIG_AND_CAPPED
    );
  });

  /** Start the capped run the way a user still can. */
  async function startCappedRun(): Promise<void> {
    const dialog = await openDialog();
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("import-without-attachments"));
    });
    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());
  }

  /** Drive the orchestrator queue to a completed messages run. */
  async function completeRun(
    rerender: (ui: React.ReactElement) => void,
    warning?: string
  ): Promise<void> {
    mockQueue = [
      {
        type: "messages",
        status: "complete",
        progress: 100,
        importedCount: IMPORTED_THIS_RUN,
        warning,
      },
    ];
    await act(async () => {
      rerender(
        <React.StrictMode>
          <MacOSMessagesImportSettings userId={USER_ID} />
        </React.StrictMode>
      );
    });
  }

  it("CONTROL: the coverage, and NEITHER exclusion figure", async () => {
    /*
     * The founder's live restore reported "659,619 messages excluded by import
     * limit" — 708,400 − 48,781, the window minus what that run downloaded,
     * counting his 14,042 already-present messages as excluded. The correct
     * arithmetic was 708,400 − 62,824 = 645,576.
     *
     * His second live-QA pass then removed the exclusion sentence ALTOGETHER:
     * the strip now states only what the store covers. So this test's job
     * changed shape — the wrong number must still never appear, and now the
     * right one does not appear either. Both are named so a future edit that
     * reintroduces the tail has to pick a side deliberately.
     *
     * HONEST LIMIT, recorded rather than papered over: with the tail gone,
     * `lastCoverage.excluded` is computed and never rendered, so the
     * SUBTRACTION itself is no longer pinned by anything (mutation M3 goes
     * green). What is still pinned is the CONDITION it guards — the strip
     * appears only when the window exceeds the admitted coverage — and the
     * coverage figure the strip actually shows.
     */
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={USER_ID} />
    );
    await startCappedRun();
    await completeRun(
      rerender,
      `${WRONG_EXCLUDED.toLocaleString()} messages excluded by import limit. Adjust in Settings.`
    );

    const coverage = await screen.findByTestId("import-coverage");
    expect(coverage).toHaveTextContent("Your store now covers 62,824 for this period");

    const panel = screen.getByTestId("macos-messages-import");
    // The wrong figure is nowhere — not in the strip, and not in the
    // orchestrator's warning, which is stripped for exactly this.
    expect(panel).not.toHaveTextContent(WRONG_EXCLUDED.toLocaleString());
    // Nor the right one: the founder removed that sentence.
    expect(panel).not.toHaveTextContent(CORRECT_EXCLUDED.toLocaleString());
    expect(panel).not.toHaveTextContent(/stay outside your import limit/i);
    expect(panel).not.toHaveTextContent(/Adjust in Settings/i);
  });

  it("the two numbers are labelled so they cannot read as a contradiction", async () => {
    // "Re-imported 48,781 messages" is what THIS RUN fetched; "your store now
    // covers 62,824" is what the period HOLDS. A delta import does not
    // re-fetch what it already had, so the second is legitimately larger —
    // unlabelled and side by side, the founder read them as disagreeing.
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={USER_ID} />
    );
    await startCappedRun();
    await completeRun(rerender);

    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent("48,781");
    expect(result).toHaveTextContent("Your store now covers 62,824 for this period");
  });

  it("the completion strip can be dismissed, and a new run reports fresh", async () => {
    // It used to linger with no way to close it. Dismissing hides THIS run's
    // message and nothing else.
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={USER_ID} />
    );
    await startCappedRun();
    await completeRun(rerender);

    await screen.findByTestId("import-result");
    fireEvent.click(screen.getByTestId("import-result-dismiss"));
    expect(screen.queryByTestId("import-result")).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-coverage")).not.toBeInTheDocument();

    // ANTI-VACUITY: the dismissal is for that run only. Without this, a
    // dismissal that permanently silenced the panel would pass the above.
    mockQueue = [];
    await act(async () => {
      rerender(
        <React.StrictMode>
          <MacOSMessagesImportSettings userId={USER_ID} />
        </React.StrictMode>
      );
    });
    await completeRun(rerender);
    expect(await screen.findByTestId("import-result")).toBeInTheDocument();
  });

  it("keeps the disk-space clause when the orchestrator sends both", async () => {
    // The cap clause and the space clause arrive concatenated in one string.
    // Removing the wrong one must not take the accurate one with it — that
    // clause is the ONLY notice that attachments were skipped.
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={USER_ID} />
    );
    await startCappedRun();
    await completeRun(
      rerender,
      `${WRONG_EXCLUDED.toLocaleString()} messages excluded by import limit. Adjust in Settings. ` +
        "Attachments were not imported: they need 80.0 GB but only 40.0 GB is free. Messages imported normally."
    );

    expect(await screen.findByTestId("import-warning")).toHaveTextContent(
      /Attachments were not imported/i
    );
    expect(screen.getByTestId("import-warning")).not.toHaveTextContent(
      /excluded by import limit/i
    );
  });

  it("an import-everything run reports NO exclusion at all", async () => {
    // It cleared the cap for itself, so the limit excluded nothing. "0 outside
    // your limit" would be noise about a limit that did not act.
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
      FOUNDER_RESULT
    );
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={USER_ID} />
    );

    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByTestId("import-plan-import-all"));
    fireEvent.click(
      await within(dialog).findByTestId("import-plan-import-all-anyway")
    );
    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());

    await completeRun(rerender);

    await screen.findByTestId("import-result");
    expect(screen.queryByTestId("import-coverage")).not.toBeInTheDocument();
  });

  it("stripStaleCapClause: removes only the orchestrator's own leading sentence", () => {
    // Unit-level, because the regex is the load-bearing part and a rendered
    // assertion cannot show what it declines to touch.
    expect(
      stripStaleCapClause(
        "659,619 messages excluded by import limit. Adjust in Settings."
      )
    ).toBeUndefined();

    expect(stripStaleCapClause("Attachments were not imported: 80.0 GB.")).toBe(
      "Attachments were not imported: 80.0 GB."
    );

    // Anchored: a sentence that merely CONTAINS the phrase is left alone, so
    // the strip can never eat an unrelated warning.
    expect(
      stripStaleCapClause(
        "Something happened. 12 messages excluded by import limit. Adjust in Settings."
      )
    ).toBe(
      "Something happened. 12 messages excluded by import limit. Adjust in Settings."
    );

    expect(stripStaleCapClause(undefined)).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CONTROL 4 — the refusal computes the way out (founder `2259031c`)
// ───────────────────────────────────────────────────────────────────────────

describe("BACKLOG-2749 — the space refusal names a window that fits", () => {
  /** All-time selection; the founder's ~61 GB corpus against ~59 GB free. */
  const TOO_BIG = {
    ...FOUNDER_RESULT,
    attachmentBytes: 61_300_000_000,
    availableDiskBytes: 59_100_000_000,
    fitsOnDisk: false,
  };

  beforeEach(() => {
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        messageImport: {
          filters: {
            lookbackMonths: null,
            maxMessages: CAP,
            skipAttachments: false,
          },
        },
      },
    });
  });

  it("offers the LARGEST preset that fits, with that window's own estimate", async () => {
    // 24 and 18 months do not fit; 12 does, at 8.2 GB. The button must name 12
    // — the largest that fits — and carry main's figure for THAT window, never
    // a figure scaled from another.
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection?: { lookbackMonths: number | null }) => {
        const months = selection?.lookbackMonths ?? null;
        if (months === null) return Promise.resolve(TOO_BIG);
        if (months >= 18)
          return Promise.resolve({ ...TOO_BIG, attachmentBytes: 40_000_000_000 });
        if (months === 12)
          return Promise.resolve({
            ...TOO_BIG,
            attachmentBytes: 8_200_000_000,
            fitsOnDisk: true,
          });
        return Promise.resolve({
          ...TOO_BIG,
          attachmentBytes: 1_000_000_000,
          fitsOnDisk: true,
        });
      }
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    const fitting = await within(dialog).findByTestId(
      "import-plan-fitting-window"
    );
    expect(fitting).toHaveTextContent("Import last 12 months — 8.2 GB");
    // The smaller windows also fit, but the founder asked for the LARGEST.
    expect(fitting).not.toHaveTextContent("6 months");
    expect(fitting).not.toHaveTextContent("3 months");
  });

  it("ANTI-VACUITY: when NOTHING shorter fits, no window button appears", async () => {
    // The founder's hiding rule, and the deals-force-the-window case: every
    // candidate comes back the same size, so there is nothing to offer. Both
    // halves of this control matter — a button that always appeared would pass
    // the test above just as well.
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(TOO_BIG);

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    await waitFor(() =>
      expect(
        within(dialog).queryByTestId("import-plan-window-searching")
      ).not.toBeInTheDocument()
    );
    expect(
      within(dialog).queryByTestId("import-plan-fitting-window")
    ).not.toBeInTheDocument();

    // The text-only escape and Cancel remain — a refusal with no way out is a
    // dead end, which is the thing BACKLOG-2743's hatch exists to prevent.
    expect(
      within(dialog).getByTestId("import-without-attachments")
    ).toBeInTheDocument();
    expect(within(dialog).getByTestId("import-plan-cancel")).toBeInTheDocument();
  });

  it("the refusal outranks the cap choice, and offers no way to start an oversized run", async () => {
    // Order is load-bearing: this window ALSO exceeds the cap, and the cap
    // dialog's "Import all 708,400 messages" is the larger of the two imports
    // that cannot fit.
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(TOO_BIG);

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    expect(within(dialog).getByTestId("import-space-block")).toBeInTheDocument();
    expect(
      within(dialog).queryByTestId("import-plan-cap-body")
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByTestId("import-plan-import-all")
    ).not.toBeInTheDocument();
    expect(mockRequestSync).not.toHaveBeenCalled();
  });

  it("choosing the fitting window saves it and runs — it reaches the run stage", async () => {
    // Founder's standing invariant for this button: clicking it must succeed
    // to the run stage. It moves the dropdown the user can see, persists it,
    // and starts the import; the run's own pre-flight re-verifies fit.
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection?: { lookbackMonths: number | null }) =>
        Promise.resolve(
          selection?.lookbackMonths === null
            ? TOO_BIG
            : { ...TOO_BIG, attachmentBytes: 8_200_000_000, fitsOnDisk: true }
        )
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    const fitting = await within(dialog).findByTestId(
      "import-plan-fitting-window"
    );
    await act(async () => {
      fireEvent.click(fitting);
    });

    await waitFor(() =>
      expect(mockUpdatePreferences).toHaveBeenCalledWith(USER_ID, {
        messageImport: { filters: { lookbackMonths: 24 } },
      })
    );
    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());
  });

  it("CONTROL: the completion surface promises NO coverage for a window-changing run", async () => {
    /*
     * The one way the coverage snapshot can lie, and it took a second look to
     * see it: this button changes the lookback and imports in the same click,
     * so the panel's `windowCount` / `availableCount` still describe the window
     * the user just DECLINED. Without `windowChanged`, completing a 24-month
     * run renders "covers 62,824 of 708,400" — figures belonging to neither the
     * old run nor the new one.
     *
     * Saying nothing is the correct answer here. A completion sentence exists
     * to be true, and the panel does not yet know the new window's coverage.
     */
    // The shorter window is a DIFFERENT size, which is what gives the final
    // assertion teeth: with both windows reporting 708,400 the panel could
    // carry the stale figure and look correct.
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection?: { lookbackMonths: number | null }) =>
        Promise.resolve(
          selection?.lookbackMonths === null
            ? TOO_BIG
            : {
                ...TOO_BIG,
                count: 120000,
                windowCount: 120000,
                filteredCount: 55000,
                attachmentBytes: 8_200_000_000,
                fitsOnDisk: true,
              }
        )
    );

    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={USER_ID} />
    );
    const dialog = await openDialog();

    await act(async () => {
      fireEvent.click(
        await within(dialog).findByTestId("import-plan-fitting-window")
      );
    });
    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());

    mockQueue = [
      {
        type: "messages",
        status: "complete",
        progress: 100,
        importedCount: IMPORTED_THIS_RUN,
      },
    ];
    await act(async () => {
      rerender(
        <React.StrictMode>
          <MacOSMessagesImportSettings userId={USER_ID} />
        </React.StrictMode>
      );
    });

    await screen.findByTestId("import-result");
    expect(screen.queryByTestId("import-coverage")).not.toBeInTheDocument();
    // And emphatically not the declined window's figures.
    expect(screen.getByTestId("macos-messages-import")).not.toHaveTextContent(
      "708,400"
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CONTROL 5 — a dialog action that cannot save must not run (SR, PR #2345)
// ───────────────────────────────────────────────────────────────────────────

describe("BACKLOG-2749 — a failed preference write stops the run", () => {
  /*
   * Found by the SR review of PR #2345, by execution rather than by reading.
   *
   * `handleLookbackChange` swallowed a failed write, and the fitting-window
   * button saves the shorter window and imports in the SAME click. So with the
   * write rejected, clicking "Import last 12 months — 8.2 GB" still fired
   * `requestSync` — and the run fetched the ORIGINAL All-time window, the very
   * one the guard had just refused, while the dialog closed as though the
   * narrower window had been chosen. The disk stayed safe because the
   * pre-flight refuses the attachment copy on its own, so what the user saw
   * was an All-time import with attachments silently skipped: the refusal
   * reversed by the button offered as the way to respect it.
   *
   * TWO failure shapes are pinned below, and only one of them is a throw.
   * `settingsService.updatePreferences` catches its own errors and returns
   * `{ success: false }` — so the PRODUCTION failure never reaches a `catch`
   * at all, and a fix tested only against a rejected promise would have left
   * the reachable shape wide open.
   */
  const TOO_BIG_ALL_TIME = {
    ...FOUNDER_RESULT,
    attachmentBytes: 61_300_000_000,
    availableDiskBytes: 59_100_000_000,
    fitsOnDisk: false,
  };

  beforeEach(() => {
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        messageImport: {
          filters: {
            lookbackMonths: null,
            maxMessages: CAP,
            skipAttachments: false,
          },
        },
      },
    });
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection?: { lookbackMonths: number | null }) =>
        Promise.resolve(
          selection?.lookbackMonths === null
            ? TOO_BIG_ALL_TIME
            : {
                ...TOO_BIG_ALL_TIME,
                attachmentBytes: 8_200_000_000,
                fitsOnDisk: true,
              }
        )
    );
  });

  async function clickFittingWindow(): Promise<void> {
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();
    await act(async () => {
      fireEvent.click(
        await within(dialog).findByTestId("import-plan-fitting-window")
      );
    });
  }

  it("CONTROL (SR's scenario): the write REJECTS — no run, and the dialog says why", async () => {
    mockUpdatePreferences.mockRejectedValue(new Error("preferences unavailable"));

    await clickFittingWindow();

    // The whole point: the guard's refusal is not reversed by its own way out.
    expect(mockRequestSync).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("import-plan-action-error")
    ).toHaveTextContent(/could not save that time period/i);
    // Still open, so the user can retry or cancel rather than watch a dead button.
    expect(screen.getByTestId("import-plan-dialog")).toBeInTheDocument();
  });

  it("CONTROL: the write RETURNS {success:false} — the shape production actually emits", async () => {
    // `settingsService` never throws; it returns this. A `catch`-only fix
    // passes the test above and leaves this one red.
    mockUpdatePreferences.mockResolvedValue({ success: false, error: "nope" });

    await clickFittingWindow();

    expect(mockRequestSync).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("import-plan-action-error")
    ).toBeInTheDocument();
  });

  it("the dropdown does not display a period that failed to save", async () => {
    // A select reading "Last 24 months" over a stored "All time" is the same
    // lie in a smaller font — and the estimate beneath it would then describe
    // a window no run would use.
    mockUpdatePreferences.mockResolvedValue({ success: false });

    await clickFittingWindow();

    await waitFor(() =>
      expect(screen.getByDisplayValue("All time")).toBeInTheDocument()
    );
  });

  it("CONTROL: the blue recommendation obeys the rule too (write REJECTS)", async () => {
    // The founder's round-3 primary action saves the recommended range and
    // runs in ONE click, so it carries exactly the hazard M13 was filed for.
    // Driven separately from the space dialog's fitting-window button because
    // it is a different callback on a different body — the rule is shared, the
    // wiring is not, and only a click through each can say both are wired.
    mockUpdatePreferences.mockRejectedValue(new Error("preferences unavailable"));
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection?: { lookbackMonths: number | null }) =>
        Promise.resolve(
          selection?.lookbackMonths === null
            ? FOUNDER_RESULT
            : { ...FOUNDER_RESULT, windowCount: 41000 }
        )
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();
    await act(async () => {
      fireEvent.click(
        await within(dialog).findByTestId("import-plan-change-range")
      );
    });

    expect(mockRequestSync).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("import-plan-action-error")
    ).toHaveTextContent(/could not save that time range/i);
    expect(screen.getByTestId("import-plan-dialog")).toBeInTheDocument();
  });

  it("CONTROL: the blue recommendation, write RETURNS {success:false}", async () => {
    mockUpdatePreferences.mockResolvedValue({ success: false, error: "nope" });
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection?: { lookbackMonths: number | null }) =>
        Promise.resolve(
          selection?.lookbackMonths === null
            ? FOUNDER_RESULT
            : { ...FOUNDER_RESULT, windowCount: 41000 }
        )
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();
    await act(async () => {
      fireEvent.click(
        await within(dialog).findByTestId("import-plan-change-range")
      );
    });

    expect(mockRequestSync).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("import-plan-action-error")
    ).toBeInTheDocument();
    // M14 carried over: the range that failed to save is not displayed as if
    // it had been.
    await waitFor(() =>
      expect(screen.getByDisplayValue("All time")).toBeInTheDocument()
    );
  });

  it("ANTI-VACUITY: the blue recommendation runs when the write LANDS", async () => {
    mockUpdatePreferences.mockResolvedValue({ success: true });
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection?: { lookbackMonths: number | null }) =>
        Promise.resolve(
          selection?.lookbackMonths === null
            ? FOUNDER_RESULT
            : { ...FOUNDER_RESULT, windowCount: 41000 }
        )
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();
    await act(async () => {
      fireEvent.click(
        await within(dialog).findByTestId("import-plan-change-range")
      );
    });

    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());
    expect(
      screen.queryByTestId("import-plan-action-error")
    ).not.toBeInTheDocument();
  });

  it("the text-only escape obeys the same rule", async () => {
    mockUpdatePreferences.mockRejectedValue(new Error("preferences unavailable"));

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("import-without-attachments"));
    });

    expect(mockRequestSync).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("import-plan-action-error")
    ).toHaveTextContent(/could not save that choice/i);
    // And the checkbox does not claim a preference that was never stored.
    expect(screen.getByTestId("skip-attachments-toggle")).not.toBeChecked();
  });

  it("ANTI-VACUITY: when the write LANDS, the run starts and no error shows", async () => {
    // Without this, every assertion above would be equally green for a button
    // that never started anything.
    mockUpdatePreferences.mockResolvedValue({ success: true });

    await clickFittingWindow();

    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());
    expect(
      screen.queryByTestId("import-plan-action-error")
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-plan-dialog")).not.toBeInTheDocument();
  });

  it("CONTROL: a second click cannot request a second import (text-only path)", async () => {
    /*
     * The re-entrancy guard, and a correction to my own measurement.
     *
     * I first tested this on the FITTING-WINDOW button, found the double-fire
     * unreachable, and generalised — writing in both the guard and this suite
     * that no test could pin it. The SR removed the guard and double-clicked
     * TEXT-ONLY: `requestSync` fired twice. Both halves of my claim were wrong
     * in the way that matters, because I sampled one path instead of sweeping
     * them.
     *
     * The mechanism I described is real but path-specific. `onChooseWindow`
     * calls `handleLookbackChange`, which moves the lookback; the estimate
     * effect then resets `windowCount`/`availableCount` to null and the
     * dialog's render guard unmounts it before a second click can land. That
     * is incidental protection, and TEXT-ONLY does not get it: it writes
     * `skipAttachments`, which touches neither the lookback nor the counts, so
     * the dialog stays mounted with a live button for the whole await.
     *
     * So the guard is LOAD-BEARING on this path, and this is the control that
     * says so. The fitting-window path stays unpinned for the reason above —
     * documented next to the guard, not used to justify deleting it.
     */
    let release!: (v: { success: boolean }) => void;
    // ONE shared pending promise for every call: a fresh deferred per call
    // would keep only the newest resolver, leaving the first click pending
    // forever and letting exactly one path complete either way.
    const pending = new Promise<{ success: boolean }>((res) => {
      release = res;
    });
    mockUpdatePreferences.mockImplementation(() => pending);

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();
    const textOnly = within(dialog).getByTestId("import-without-attachments");

    fireEvent.click(textOnly);
    fireEvent.click(textOnly);
    await act(async () => {
      release({ success: true });
    });

    await waitFor(() => expect(mockRequestSync).toHaveBeenCalledTimes(1));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The force re-import path uses the SAME gate
// ───────────────────────────────────────────────────────────────────────────

describe("BACKLOG-2749 — both entry points pass through one gate", () => {
  it("Force Re-import reaches the same dialog, with re-import verbs", async () => {
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Force Re-import/i })
      ).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /Force Re-import/i }));
    fireEvent.click(await screen.findByTestId("force-reimport-confirm"));

    const dialog = await screen.findByTestId("import-plan-dialog");
    expect(
      within(dialog).getByTestId("import-plan-import-all")
    ).toHaveTextContent("Re-import all 708,400 messages");
    // Same numbers, different verb — under D2' both modes cover one window.
    expect(
      within(dialog).getByText(/Your selected time range of/)
    ).toHaveTextContent("708,400");
    expect(mockRequestSync).not.toHaveBeenCalled();
  });

  it("the force confirm makes the safe way out prominent (founder c2300351)", async () => {
    // His words were "the cancel is red and the re import and unlink is gray";
    // his INTENT was safe-prominent / destructive-recessive. Red is the
    // convention for the destructive control, so the intent is implemented and
    // the literal colour swap is not — asserted here so the decision is
    // visible rather than buried in a class string. Final styling is his call
    // at QA.
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Force Re-import/i })
      ).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: /Force Re-import/i }));

    const confirm = await screen.findByTestId("force-reimport-confirm");
    const cancel = screen.getByTestId("force-reimport-cancel");

    // The safe action carries the filled, prominent treatment…
    expect(cancel.className).toMatch(/bg-blue-500/);
    // …and the destructive one is recessive but still reads destructive.
    expect(confirm.className).not.toMatch(/bg-red-600/);
    expect(confirm.className).toMatch(/text-red-700/);
    expect(confirm).toHaveTextContent(/unlink/i);
  });
});
