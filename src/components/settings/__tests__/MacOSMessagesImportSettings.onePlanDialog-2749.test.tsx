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
  it("CONTROL: cap, coverage and window are three DIFFERENT numbers, each in its own place", async () => {
    /*
     * The mutation this is built to catch: a dialog that reconstructs the cap
     * from the counts. Every plausible reconstruction is wrong here and lands
     * on a number this test names:
     *
     *   - cap from `filteredCount`          -> "exceeds the 62,824 limit"
     *   - admitted from `min(window, cap)`  -> "cover 50,000 of 708,400"
     *   - cap from `min(window, admitted)`  -> "exceeds the 62,824 limit"
     *
     * With a no-deals fixture all three of those print 50,000 and nothing goes
     * red, which is precisely how this defect survived a full SR review.
     */
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();
    const body = within(dialog);

    // The lead: the WINDOW against the CAP. Founder decision `1e8baa69`.
    const lead = body.getByText(/This time period contains/);
    expect(lead).toHaveTextContent("708,400");
    expect(lead).toHaveTextContent("exceeds the 50,000 limit");
    expect(lead).not.toHaveTextContent("62,824");

    // The coverage line: the ADMITTED count against the WINDOW.
    const coverage = body.getByTestId("import-plan-coverage");
    expect(coverage).toHaveTextContent("cover 62,824 of 708,400");
    // Founder decision `1e8baa69`: coverage, NOT download volume. He read
    // 62,823 as "Keepr will re-download 62,823 messages".
    expect(coverage).toHaveTextContent(/not a download size/i);
    expect(coverage).toHaveTextContent(/already has are not fetched again/i);
    // And the exclusion arithmetic, stated here as it is at completion.
    expect(coverage).toHaveTextContent("645,576");
    expect(coverage).not.toHaveTextContent(String(WRONG_EXCLUDED));
  });

  it("the keep-the-limit button states the protected-history TOTAL", async () => {
    // Founder decision `3a4fc2b2`: "Import most recent 50,000 only" actually
    // delivered 62,823. It understates in the user's favour, and he asked for
    // the real total to be said.
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    const keep = within(dialog).getByTestId("import-plan-keep-limit");
    expect(keep).toHaveTextContent("Keep the 50,000 newest");
    expect(keep).toHaveTextContent("protected history");
    expect(keep).toHaveTextContent("62,824 total");
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

  it("renders the plan's overrides[] as the reason the window is wider than the setting", async () => {
    // `overrides` is DATA the resolver emits for exactly this consumer
    // (BACKLOG-2772). The dialog renders it; it never re-derives "did anything
    // get overridden?" from the dates.
    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    expect(
      within(dialog).getByTestId("import-plan-window-extended")
    ).toHaveTextContent(/audit periods? needs? it/i);
  });

  it("ANTI-VACUITY: with an EMPTY overrides[], the deal explanation is absent", async () => {
    // Without this, the assertion above would be equally green for a dialog
    // that showed the sentence unconditionally.
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      ...FOUNDER_RESULT,
      plan: { ...FOUNDER_RESULT.plan, overrides: [] },
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    expect(
      within(dialog).queryByTestId("import-plan-window-extended")
    ).not.toBeInTheDocument();
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

    expect(within(dialog).getByText(/This time period contains/)).toHaveTextContent(
      "exceeds the 50,000 limit"
    );
    expect(
      within(dialog).getByTestId("import-plan-keep-limit")
    ).toHaveTextContent("62,824 total");
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
    const dialog = await openDialog();

    const panel = screen.getByTestId("macos-messages-import");
    expect(panel).not.toHaveTextContent(/up to 50,000/i);
    // …while the coverage the run really delivers IS on screen.
    expect(dialog).toHaveTextContent("62,824");
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

  it("ANTI-VACUITY: with nothing protected the keep-limit button keeps its 2772 wording", async () => {
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      ...FOUNDER_RESULT,
      filteredCount: CAP,
      plan: { ...FOUNDER_RESULT.plan, overrides: [] },
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);
    const dialog = await openDialog();

    expect(
      within(dialog).getByTestId("import-plan-keep-limit")
    ).toHaveTextContent("Import most recent 50,000 only");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CONTROL 3 — the completion arithmetic
// ───────────────────────────────────────────────────────────────────────────

describe("BACKLOG-2749 — completion reports coverage, not fetch volume", () => {
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

  it("CONTROL: 645,576 excluded, never 659,619", async () => {
    /*
     * The founder's live restore. `window - imported-this-run` counts the
     * 14,042 messages already in his store as excluded and produces 659,619;
     * `window - admitted coverage` produces 645,576. Both are "a big number
     * next to the word excluded", which is why the wrong one survived — this
     * test names them BOTH so the two cannot be confused for one another.
     */
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={USER_ID} />
    );

    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByTestId("import-plan-keep-limit"));
    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());

    await completeRun(
      rerender,
      `${WRONG_EXCLUDED.toLocaleString()} messages excluded by import limit. Adjust in Settings.`
    );

    const coverage = await screen.findByTestId("import-coverage");
    expect(coverage).toHaveTextContent("cover 62,824 of 708,400");
    expect(coverage).toHaveTextContent(`${CORRECT_EXCLUDED.toLocaleString()}`);

    // And the wrong figure is nowhere on the panel — not in the result card,
    // not in the orchestrator's warning, which is stripped for exactly this.
    expect(screen.getByTestId("macos-messages-import")).not.toHaveTextContent(
      WRONG_EXCLUDED.toLocaleString()
    );
  });

  it("keeps the disk-space clause when the orchestrator sends both", async () => {
    // The cap clause and the space clause arrive concatenated in one string.
    // Removing the wrong one must not take the accurate one with it — that
    // clause is the ONLY notice that attachments were skipped.
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={USER_ID} />
    );

    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByTestId("import-plan-keep-limit"));
    await waitFor(() => expect(mockRequestSync).toHaveBeenCalled());

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
    const { rerender } = renderStrict(
      <MacOSMessagesImportSettings userId={USER_ID} />
    );

    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByTestId("import-plan-import-all"));
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
    expect(within(dialog).getByTestId("import-plan-keep-limit")).toHaveTextContent(
      "62,824 total"
    );
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
