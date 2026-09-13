/**
 * BACKLOG-3213 — a Mac with no Messages database is not a Mac that refuses
 * access, and must not be told to grant a permission.
 *
 * ─── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 *
 * BACKLOG-3208 gave this panel a Full Disk Access notice. Both probes of
 * `~/Library/Messages/chat.db` collapsed every `fs.access` rejection into one
 * diagnosis, so a Mac that has never run Messages — `chat.db` absent, ENOENT —
 * got the FDA notice, the "Show me how" button and the explainer. The user
 * grants Full Disk Access, comes back, and nothing has changed, because the
 * permission was never the problem.
 *
 * ─── WHY THESE TESTS ARE SHAPED THIS WAY ─────────────────────────────────────
 *
 * Mirrors `MacOSMessagesImportSettings.fdaRecovery-3208.test.tsx` exactly: the
 * REAL `systemService` down to the globally-mocked `window.api.system.*`
 * channel, rendered in StrictMode, asserting the RENDERED UI. Mocking the
 * service would let the service rot with these green.
 *
 * THE FIXTURES ARE TRANSCRIBED, NOT INVENTED. The absent refusal below is
 * built from `tests/fixtures/fdaDeniedIssue-3219.ts`, whose absent constant is
 * tied to the REAL `permissionService.checkFullDiskAccess()` by
 * `permissionService.fdaDeniedShape-3219.test.ts`. That matters more than
 * usual here, because the panel matches main's refusal by SUBSTRING across a
 * boundary it cannot import across — so the fragment assertion below is the
 * only thing standing between a producer reword and a panel that silently
 * stops recognising the refusal.
 *
 * ─── THE FIXTURE RULE, AND IT IS A PROPERTY OF THE CODE ──────────────────────
 *
 * `estimateResolved` is `estimateStatus === "ready"` and an estimate that ends
 * `"unavailable"` is NEVER "ready", so `spaceUnknown = !skipAttachments &&
 * !estimateResolved` makes two of these assertions mutually exclusive:
 *
 *   skipAttachments ON   "buttons disabled" is informative; the space copy is
 *                        not rendered at all (its block is gated on
 *                        `!skipAttachments`), so asserting it null proves
 *                        nothing.
 *   skipAttachments OFF  the space copy's null is informative; the buttons are
 *                        disabled by the space term regardless of permission,
 *                        so asserting them proves nothing.
 *
 * So C13 and C14 cannot share a fixture, and neither can C22a and C22b. Where
 * a test needs the opposite side, it says so.
 */

import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  MacOSMessagesImportSettings,
  MESSAGES_ABSENT_REASON_FRAGMENT,
} from "../MacOSMessagesImportSettings";
import { MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT } from "../../../../tests/fixtures/fdaDeniedIssue-3219";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({
    queue: [],
    requestSync: jest.fn(),
    markCancelRequested: jest.fn(),
    getQueueItem: jest.fn(),
  })),
}));

const mockGetPreferences = jest.fn();
const mockUpdatePreferences = jest.fn();

/** Only `settingsService` is stubbed. `systemService` is the REAL one. */
jest.mock("../../../services", () => {
  const actual = jest.requireActual("../../../services");
  return {
    ...actual,
    settingsService: {
      getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
      updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
    },
  };
});

const USER_ID = "user-3213";

/**
 * What `check-permissions` returns when `chat.db` is not on this Mac.
 * `permissionHandlers.ts`: `{ hasPermission: false, error: <errno message>,
 * errorCode: "MESSAGES_STORE_NOT_FOUND" }`.
 */
const FDA_ABSENT = {
  hasPermission: false,
  error:
    "ENOENT: no such file or directory, access '/Users/<user>/Library/Messages/chat.db'",
  errorCode: "MESSAGES_STORE_NOT_FOUND",
};

/** A TCC refusal, for the discriminating denied cases. */
const FDA_DENIED = {
  hasPermission: false,
  error:
    "EPERM: operation not permitted, access '/Users/<user>/Library/Messages/chat.db'",
  errorCode: "FULL_DISK_ACCESS_DENIED",
};

const FDA_GRANTED = { hasPermission: true };

/**
 * What `messages:get-import-count` returns when the database is absent.
 * `getAvailableMessageCount` runs `permissionService.checkFullDiskAccess()`
 * FIRST and returns its `userMessage` verbatim — so this is the producer's own
 * sentence, taken from the shared fixture rather than retyped.
 */
const ESTIMATE_REFUSED_ABSENT = {
  success: false,
  error: MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT.userMessage,
};

/** A refusal that has nothing to do with permission OR with a missing file. */
const ESTIMATE_REFUSED_UNRELATED = {
  success: false,
  error: "SQLITE_BUSY: database is locked",
};

const ESTIMATE_OK = {
  success: true,
  count: 1200,
  filteredCount: 1200,
  windowCount: 1200,
  attachmentBytes: 1_000_000,
  attachmentCount: 4,
  availableDiskBytes: 500_000_000_000,
  fitsOnDisk: true,
};

/**
 * The Import button's tooltip in the absent state. Used as the SETTLE SIGNAL
 * by every test below except C14, and that is deliberate: it proves the panel
 * has resolved to `absent` WITHOUT touching the notice, so exactly one test in
 * this file positively asserts the notice exists. Delete the notice block and
 * only that one test reds — which is what makes it a control for "something is
 * on screen" rather than a duplicate of the other five.
 */
const ABSENT_TOOLTIP = "Keepr couldn't find a Messages database on this Mac";

/** Wait until the panel has resolved to the absent state. */
const settleToAbsent = () =>
  waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Import Messages/i })
    ).toHaveAttribute("title", ABSENT_TOOLTIP)
  );

const systemApi = () => window.api.system as unknown as Record<string, jest.Mock>;

const renderStrict = () =>
  render(
    <React.StrictMode>
      <MacOSMessagesImportSettings userId={USER_ID} />
    </React.StrictMode>
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPreferences.mockResolvedValue({ success: true, data: {} });
  mockUpdatePreferences.mockResolvedValue({ success: true });
  (window.api.messages.getImportStatus as jest.Mock).mockResolvedValue({
    success: true,
    messageCount: 0,
  });
  (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
    success: true,
    source: "preference",
    lookbackMonths: null,
    effectiveCutoffISO: null,
  });
  (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(ESTIMATE_OK);
  systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
  systemApi().triggerFullDiskAccess.mockResolvedValue({ granted: true });
  systemApi().openSystemSettings.mockResolvedValue({ success: true });
  systemApi().relaunchApp.mockResolvedValue({ relaunched: true });
});

describe("BACKLOG-3213 — the panel tells an absent database from a refused one", () => {
  /**
   * THE DRIFT GUARD for the substring the panel classifies on.
   *
   * The panel matches main's refusal by substring because the producer lives
   * in `electron/` and the renderer cannot import from there. Reword either
   * side alone and the panel silently stops recognising the refusal — no
   * error, no red, just the disk-space copy back on a Mac with no database.
   * This ties the two together.
   *
   * THE CONSTANT IS IMPORTED, NEVER RE-TYPED. A re-typed literal would tie the
   * fixture to the producer and leave the panel's own constant free to drift
   * away from both — so the test would pass while the panel stopped
   * recognising the refusal, which is the one direction this guard exists for.
   */
  it("main's real absent sentence still contains the fragment the panel matches on", () => {
    expect(
      MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT.userMessage.toLowerCase()
    ).toContain(MESSAGES_ABSENT_REASON_FRAGMENT);
    // And it names no permission, which is the point of the whole item.
    expect(
      MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT.userMessage
    ).not.toMatch(/full disk access/i);
  });

  /**
   * C13 — THE GATE STAYS CLOSED, on the panel's OWN answer, before the
   * estimate has resolved.
   *
   * The wrong fix this catches prints the right sentence and re-enables
   * Import: `fdaStatus = "absent"` set and rendered correctly, but `absent`
   * never added to `permissionBlocked`. Every other test in this file passes
   * against it.
   *
   * Three fixture requirements, each load-bearing, and this control is
   * worthless without all three:
   *
   *  1. `{ messageImport: { filters: { skipAttachments: true } } }` — NOTE THE
   *     NESTING. The panel reads `messageImport.filters.skipAttachments`; the
   *     shallow form is silently ignored, and that was BACKLOG-3208's original
   *     failure in this exact fixture.
   *  2. The premise assertion that the toggle really IS on. Without it the
   *     space term does the disabling and this proves nothing about permission.
   *  3. A `getImportCount` that NEVER resolves, so `estimateStatus` stays
   *     "pending" and `estimateBlockedByPermission` — which requires
   *     "unavailable" — cannot be holding the gate instead.
   *
   * Sited to mirror `fdaRecovery-3208.test.tsx:628-655`, which is the denied
   * analogue and the ONLY test in that 21-test suite sensitive to the same
   * term.
   */
  it("refuses the import on the panel's own answer, before the estimate has resolved", async () => {
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: { messageImport: { filters: { skipAttachments: true } } },
    });
    systemApi().checkPermissions.mockResolvedValue(FDA_ABSENT);
    (window.api.messages.getImportCount as jest.Mock).mockReturnValue(
      new Promise(() => {})
    );

    renderStrict();

    await waitFor(() =>
      expect(screen.getByTestId("skip-attachments-toggle")).toBeChecked()
    );
    await settleToAbsent();

    expect(
      screen.getByRole("button", { name: /Import Messages/i })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Force Re-import/i })
    ).toBeDisabled();
  });

  /**
   * C14 — SOMETHING IS ON SCREEN, and it is the honest thing.
   *
   * The pair is the control. `importBlockedReason` has exactly one render site
   * in the whole file — a `title=` attribute on Import — and Force Re-import
   * carries a static title instead, so with the FDA notice correctly withheld
   * (C15) and the space copy correctly suppressed (C17), a fix that stopped
   * there would leave two disabled buttons and NO SENTENCE ON SCREEN.
   *
   * Asserted separately, "suppressed" and "something visible" would each pass
   * that screen-blank state. Asserted in ONE RENDER they cannot. The in-repo
   * precedent for this coupling is `fdaRecovery-3208.test.tsx:515-528`, which
   * is the denied analogue and passes today.
   *
   * `skipAttachments` is OFF here — the default (`useState(false)`), and the
   * OPPOSITE of what C13 requires. It is stated rather than left implicit
   * because the space copy's block is gated on `!skipAttachments`, so with the
   * toggle on the null assertion would be vacuous.
   */
  it("shows the absent notice and suppresses the disk-space copy in the same render", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_ABSENT);
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
      ESTIMATE_REFUSED_ABSENT
    );

    renderStrict();

    const notice = await screen.findByTestId("macos-messages-absent-notice");
    expect(notice).toHaveTextContent(
      "Keepr couldn't find a Messages database on this Mac"
    );
    expect(notice).toHaveTextContent("There is nothing here for Keepr to import");
    // The sentence must name no permission. That IS the item.
    expect(notice.textContent ?? "").not.toMatch(/full disk access/i);

    // ORDERING GUARD. `queryByTestId` is null before the estimate resolves for
    // reasons that have nothing to do with suppression.
    await waitFor(() =>
      expect(window.api.messages.getImportCount).toHaveBeenCalled()
    );
    expect(screen.queryByTestId("import-estimate-unavailable")).toBeNull();
  });

  /**
   * C15 — no FDA affordance anywhere in the absent state.
   *
   * Not just the notice: the "Show me how" button is what opens `FdaHelpSheet`,
   * which reports Full Disk Access as "not detected" — a permission report for
   * a problem that is not a permission.
   */
  it("renders no Full Disk Access notice, button or explainer when the database is absent", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_ABSENT);
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
      ESTIMATE_REFUSED_ABSENT
    );

    renderStrict();

    await settleToAbsent();

    expect(screen.queryByTestId("macos-fda-denied-notice")).toBeNull();
    expect(screen.queryByTestId("macos-fda-open-settings")).toBeNull();
    expect(screen.queryByTestId("fda-help-sheet")).toBeNull();
    expect(screen.queryByText(/Show me how/i)).toBeNull();
  });

  /**
   * C16 — an absence is not a denial, so a later grant is not a recovery.
   *
   * `fdaWasDenied` gates the "Full Disk Access granted — restart Keepr to
   * finish" notice. Setting it on the absent path would tell a Mac that has no
   * messages to restart to finish something that never started.
   */
  it("does not offer the restart notice after an absent state resolves to granted", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_ABSENT);
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
      ESTIMATE_REFUSED_ABSENT
    );

    renderStrict();

    await settleToAbsent();

    // The focus re-check is the panel's own way back — the same path a user
    // takes returning from System Settings.
    systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(ESTIMATE_OK);
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Import Messages/i })
      ).not.toHaveAttribute("title", ABSENT_TOOLTIP)
    );
    expect(screen.queryByTestId("macos-fda-restart-notice")).toBeNull();
  });

  /**
   * C17 — the panel's OWN answer suppresses the disk-space copy, without the
   * estimate's wording agreeing.
   *
   * THE FIXTURE IS THE CONTROL. The estimate here fails for a reason that
   * names neither Full Disk Access nor a missing database, so the two STRING
   * disjuncts in `estimateBlockedByPermission` are both false and only the
   * STATE disjunct (`fdaStatus === "absent"`) can be doing the suppressing.
   * With the natural fixture — the absent refusal — the string term covers it
   * and removing the state term reds nothing.
   *
   * The shape is marked as one the producers do not normally emit
   * (`getAvailableMessageCount` checks the database first, so an absent Mac
   * usually gets the absent sentence) and is asserted only to pin the
   * mechanism. It IS reachable: the two reads happen at different moments.
   */
  it("suppresses the disk-space copy on the panel's own answer, whatever the estimate said", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_ABSENT);
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
      ESTIMATE_REFUSED_UNRELATED
    );

    renderStrict();

    await settleToAbsent();
    await waitFor(() =>
      expect(window.api.messages.getImportCount).toHaveBeenCalled()
    );
    await waitFor(() =>
      expect(screen.queryByTestId("import-estimate-pending")).toBeNull()
    );

    expect(screen.queryByTestId("import-estimate-unavailable")).toBeNull();
  });

  /**
   * C18 — the DENIED path is untouched.
   *
   * The regression this item could cause, asserted directly rather than
   * inferred from the 3208 suite staying green.
   */
  it("still shows the Full Disk Access notice, unchanged, when the check reports a refusal", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      success: false,
      error: "Full Disk Access permission is required to read iMessages.",
    });

    renderStrict();

    const notice = await screen.findByTestId("macos-fda-denied-notice");
    expect(notice).toHaveTextContent("Keepr does not have Full Disk Access");
    expect(screen.getByTestId("macos-fda-open-settings")).toHaveTextContent(
      "Show me how"
    );
    expect(screen.queryByTestId("macos-messages-absent-notice")).toBeNull();

    const importButton = screen.getByRole("button", {
      name: /Import Messages/i,
    });
    await waitFor(() => expect(importButton).toBeDisabled());
    expect(importButton).toHaveAttribute(
      "title",
      "Keepr needs Full Disk Access to read your messages"
    );
  });

  /**
   * THE STALE-READ WINDOW — main refuses before the panel's own check knows.
   *
   * The panel resolved `granted` at mount; main then refuses because the
   * database is not there. Without the `:638` classifier recognising the
   * absent reason, the panel never re-asks and holds stale `granted` until the
   * next window FOCUS — which never fires in a test and need not fire for a
   * user sitting reading the panel.
   *
   * Mirrors the harness at `fdaRecovery-3208.test.tsx:541-558`, which is the
   * denied analogue and the ONLY test in that suite sensitive to `:638`.
   */
  describe("the stale-read window", () => {
    /**
     * C22a — the re-ask fires, and the gate closes.
     *
     * THE BASELINE IS CAPTURED INSIDE THE `getImportCount` MOCK, and that is
     * the whole assertion. Two other forms were measured and neither works:
     *
     *   `calls.length >= 2`  VACUOUS. `renderStrict` is StrictMode and React
     *                        18 double-invokes the mount effect, so 2 is
     *                        reached with ZERO re-asks.
     *   baseline captured after the estimate resolved  FALSE RED against
     *                        correct code — by the time `waitFor` returns, the
     *                        re-ask has already run in the same continuation.
     *
     * `skipAttachments` is ON here so that "buttons disabled" is informative;
     * the space copy assertion lives in C22b for the opposite reason.
     */
    it("re-asks and closes the gate when main refuses for an absent database", async () => {
      mockGetPreferences.mockResolvedValue({
        success: true,
        data: { messageImport: { filters: { skipAttachments: true } } },
      });
      systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);

      let countAtEstimate = -1;
      (window.api.messages.getImportCount as jest.Mock).mockImplementation(() => {
        // Captured BEFORE the re-ask can possibly have fired.
        countAtEstimate = systemApi().checkPermissions.mock.calls.length;
        systemApi().checkPermissions.mockResolvedValue(FDA_ABSENT);
        return Promise.resolve(ESTIMATE_REFUSED_ABSENT);
      });

      renderStrict();

      await waitFor(() =>
        expect(screen.getByTestId("skip-attachments-toggle")).toBeChecked()
      );
      await settleToAbsent();
      await waitFor(() =>
        expect(systemApi().checkPermissions.mock.calls.length).toBeGreaterThan(
          countAtEstimate
        )
      );

      expect(
        screen.getByRole("button", { name: /Import Messages/i })
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: /Force Re-import/i })
      ).toBeDisabled();
    });

    /**
     * C22b — and nothing blames the disk on the way through.
     *
     * `skipAttachments` OFF, the opposite of C22a, because the space copy's
     * block is gated on `!skipAttachments`. Once the re-ask lands, the null is
     * held by the STATE disjunct; before it lands, by the string one. Either
     * way the user never sees the disk-space sentence.
     */
    it("converges to the absent state with no disk-space copy through the stale-read window", async () => {
      systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
      (window.api.messages.getImportCount as jest.Mock).mockImplementation(() => {
        systemApi().checkPermissions.mockResolvedValue(FDA_ABSENT);
        return Promise.resolve(ESTIMATE_REFUSED_ABSENT);
      });

      renderStrict();

      await settleToAbsent();
      await waitFor(() =>
        expect(window.api.messages.getImportCount).toHaveBeenCalled()
      );
      expect(screen.queryByTestId("import-estimate-unavailable")).toBeNull();
    });

    /**
     * C22c — the estimate-refusal STRING term, on its own.
     *
     * The trick is a `checkPermissions` that NEVER RESOLVES from the moment
     * the estimate runs: `refreshFdaStatus` awaits it, so `fdaStatus` stays
     * `granted` indefinitely, the STATE disjunct at `:975` is false, and the
     * string disjunct is the only thing that can suppress the copy.
     *
     * This term had NO guard at all before this item — neutering the existing
     * Full Disk Access half of it left all 21 tests in
     * `fdaRecovery-3208.test.tsx` green. Adding an unguarded disjunct beside an
     * unguarded disjunct is how the second one never gets a test either.
     * (The wider sweep across the panel's other gate terms is BACKLOG-3292.)
     *
     * TWO PRECONDITIONS, both required, both asserted rather than assumed:
     *
     *  1. ORDERING. `getImportCount` must have been called AND the estimate
     *     must have left "pending", or the null below is null for a reason
     *     that has nothing to do with suppression.
     *  2. THE PREMISE — `fdaStatus` never resolved. Asserted as the absent
     *     notice being absent. Without it, the day someone changes this mock
     *     so `checkPermissions` resolves, the state disjunct silently takes
     *     over, this test degrades into a duplicate of C22b, and nothing reds.
     */
    it("suppresses the disk-space copy from the refusal's own words while the panel's check is unresolved", async () => {
      systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
      (window.api.messages.getImportCount as jest.Mock).mockImplementation(() => {
        // Never resolves — `refreshFdaStatus` awaits this forever, so the
        // panel's own answer can never arrive.
        systemApi().checkPermissions.mockReturnValue(new Promise(() => {}));
        return Promise.resolve(ESTIMATE_REFUSED_ABSENT);
      });

      renderStrict();

      // (1) ordering
      await waitFor(() =>
        expect(window.api.messages.getImportCount).toHaveBeenCalled()
      );
      await waitFor(() =>
        expect(screen.queryByTestId("import-estimate-pending")).toBeNull()
      );

      // (2) premise: the panel's own check never answered, so no resolved
      // state can be doing the suppressing.
      // Asserted on the TOOLTIP as well as the notice: a premise that only
      // checked the notice would pass vacuously if the notice block were ever
      // deleted, which is the state C14 exists to prevent.
      expect(
        screen.getByRole("button", { name: /Import Messages/i })
      ).not.toHaveAttribute("title", ABSENT_TOOLTIP);
      expect(screen.queryByTestId("macos-messages-absent-notice")).toBeNull();
      expect(screen.queryByTestId("macos-fda-denied-notice")).toBeNull();

      expect(screen.queryByTestId("import-estimate-unavailable")).toBeNull();
    });
  });
});
