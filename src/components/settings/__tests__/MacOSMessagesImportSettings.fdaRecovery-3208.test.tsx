/**
 * BACKLOG-3208 — skipping the onboarding Full Disk Access step was a one-way
 * door. This is the way back.
 *
 * ─── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 *
 * BACKLOG-1842 gave the onboarding permissions step a "Skip for now" button, at
 * the founder's direction, and its own comment calls it "the FIRST escape hatch
 * this step has ever had". The escape hatch shipped; the way back did not.
 *
 * Verified on develop @ 4876986b4 before a line was written:
 *   - `checkPermissions` had ZERO callers under `src/components/settings/`.
 *   - `MacOSMessagesImportSettings.tsx` matched none of `permission`,
 *     `Full Disk`, `FDA`, `EPERM` or `grant` — no permission awareness at all.
 *   - `PermissionsStep.meta.shouldShow` is `permissionsGranted !== true`, so
 *     once onboarding completes the only FDA surface in the app is retired.
 *
 * The result was a panel that looked fully available, could not read a single
 * message, and explained nothing.
 *
 * ─── WHY THESE TESTS ARE SHAPED THIS WAY ─────────────────────────────────────
 *
 * The decisive question is not "does the code path exist" — it is "with Full
 * Disk Access absent, does the PANEL SAY SO". So every test here drives the
 * real `systemService` (only `settingsService` is stubbed, via
 * `requireActual` + override) down to the globally-mocked `window.api.system.*`
 * channel, and asserts the RENDERED UI. Mocking the service would have let the
 * service itself rot with these tests still green.
 *
 * The fixtures are transcribed from the producers, not invented:
 *   - `checkPermissions` denied is `{ hasPermission: false, error: <the raw
 *     fs.access message> }` — the exact shape `permissionHandlers.ts`
 *     `check-permissions` returns on its catch path.
 *   - the estimate refusal is the literal string `permissionService.ts`
 *     `checkFullDiskAccess` puts in `userMessage`, which
 *     `getAvailableMessageCount` returns as `error` when FDA is missing.
 *
 * Rendered in StrictMode, matching the app and the rest of this suite.
 */

import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";

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

/**
 * Only `settingsService` is stubbed. `systemService` is the REAL one, so these
 * tests exercise the trigger-then-open sequence and the permission decoding
 * inside it rather than a jest.fn() standing where it used to be.
 */
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

const USER_ID = "user-3208";

/**
 * What `check-permissions` returns when Full Disk Access is missing.
 * `permissionHandlers.ts`: `{ hasPermission: false, error: (error as Error).message }`
 * where the error is `fs.access(~/Library/Messages/chat.db, R_OK)` rejecting.
 */
const FDA_DENIED = {
  hasPermission: false,
  error:
    "EPERM: operation not permitted, access '/Users/<user>/Library/Messages/chat.db'",
};

/** What it returns once the toggle is on. */
const FDA_GRANTED = { hasPermission: true };

/**
 * What `messages:get-import-count` returns with FDA missing.
 * `getAvailableMessageCount` runs `permissionService.checkFullDiskAccess()`
 * FIRST and returns its `userMessage` verbatim — this exact sentence.
 */
const ESTIMATE_REFUSED_NO_FDA = {
  success: false,
  error: "Full Disk Access permission is required to read iMessages.",
};

/** A normal estimate, for the tests that are not about the estimate. */
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

describe("BACKLOG-3208 — the Messages panel offers Full Disk Access after onboarding was skipped", () => {
  /**
   * CONTROL 1. The decisive test: with FDA absent, the panel SAYS so.
   * Not "the code path exists" — the rendered notice.
   */
  it("says Full Disk Access is missing when the check reports it denied", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();

    const notice = await screen.findByTestId("macos-fda-denied-notice");
    expect(notice).toHaveTextContent("Keepr does not have Full Disk Access");
    expect(notice).toHaveTextContent(/cannot read any messages/i);
  });

  /** CONTROL 4. Granted is silent — no notice in front of a user who has it. */
  it("shows no permission notice when Full Disk Access is granted", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);

    renderStrict();

    await waitFor(() =>
      expect(systemApi().checkPermissions).toHaveBeenCalled()
    );
    await waitFor(() =>
      expect(screen.getByTestId("macos-messages-import")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("macos-fda-denied-notice")).toBeNull();
    expect(screen.queryByTestId("macos-fda-restart-notice")).toBeNull();
  });

  /**
   * An unanswerable check is NOT a denial. The panel must stay silent rather
   * than accuse a user who has granted access of not having done so.
   */
  it("stays silent when the permission check cannot answer", async () => {
    systemApi().checkPermissions.mockResolvedValue({
      fullDiskAccess: true,
      contacts: true,
    });

    renderStrict();

    await waitFor(() =>
      expect(systemApi().checkPermissions).toHaveBeenCalled()
    );
    expect(screen.queryByTestId("macos-fda-denied-notice")).toBeNull();
  });

  /**
   * CONTROL 2 — REVISED BY BACKLOG-3210 (part 2), deliberately.
   *
   * This control used to assert that the notice's button opened the macOS pane
   * DIRECTLY, and it was right for BACKLOG-3208: before it, nothing outside
   * onboarding mentioned Full Disk Access at all, so a raw pane beat silence.
   *
   * The founder tested that and asked for the step in between: the pane is a
   * list of apps with no statement of what Keepr wants or why, and landing
   * there cold is its own dead-end. So the button is now "Show me how", it
   * opens the explainer, and the explainer opens the pane.
   *
   * The assertion is INVERTED rather than deleted: System Settings must NOT
   * open on the first click. That is what separates "opens the explainer" from
   * "still dumps the user in the pane, with a sheet on top".
   */
  it("STATE 4 — the notice's button opens the explainer and does NOT open System Settings", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();

    const button = await screen.findByTestId("macos-fda-open-settings");
    expect(button).toHaveTextContent("Show me how");
    systemApi().triggerFullDiskAccess.mockClear();
    systemApi().openSystemSettings.mockClear();

    await act(async () => {
      fireEvent.click(button);
    });

    // The explainer — the SAME component the dashboard health banner opens
    // (`components/permissions/FdaHelpSheet`, testid asserted in
    // `src/components/__tests__/SystemHealthMonitor.test.tsx`), showing the
    // SAME instruction steps onboarding renders.
    expect(await screen.findByTestId("fda-help-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("fda-instruction-steps")).toBeInTheDocument();
    expect(screen.getByText("Flip the Keepr toggle on")).toBeInTheDocument();

    expect(systemApi().openSystemSettings).not.toHaveBeenCalled();
    expect(systemApi().triggerFullDiskAccess).not.toHaveBeenCalled();
  });

  /**
   * CONTROL 2b. The pane is still reachable — one click further in — and still
   * through the trigger-then-open sequence, so Keepr is pre-listed when it
   * opens (BACKLOG-2192: the trigger has to fire on every open, not once).
   */
  it("STATE 6 — the explainer opens the pane with Keepr pre-listed", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();

    const showMeHow = await screen.findByTestId("macos-fda-open-settings");
    await act(async () => {
      fireEvent.click(showMeHow);
    });
    await screen.findByTestId("fda-help-sheet");

    systemApi().triggerFullDiskAccess.mockClear();
    systemApi().openSystemSettings.mockClear();

    await act(async () => {
      fireEvent.click(
        screen.getByTestId("onboarding-permissions-open-settings")
      );
    });

    await waitFor(() =>
      expect(systemApi().openSystemSettings).toHaveBeenCalledTimes(1)
    );
    expect(systemApi().triggerFullDiskAccess).toHaveBeenCalledTimes(1);
  });

  /**
   * The panel re-checks its own status after the pane is opened, so the notice
   * updates when the user comes straight back. This is the behaviour the old
   * direct-open button had (`handleOpenFdaSettings` ended in
   * `refreshFdaStatus`), preserved through the explainer rather than lost with
   * the rewiring.
   */
  it("re-checks Full Disk Access after the explainer opens the pane", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();

    const showMeHow = await screen.findByTestId("macos-fda-open-settings");
    await act(async () => {
      fireEvent.click(showMeHow);
    });
    await screen.findByTestId("fda-help-sheet");

    const before = systemApi().checkPermissions.mock.calls.length;

    await act(async () => {
      fireEvent.click(
        screen.getByTestId("onboarding-permissions-open-settings")
      );
    });

    await waitFor(() =>
      expect(systemApi().checkPermissions.mock.calls.length).toBeGreaterThan(
        before
      )
    );
  });

  /** "Not now" dismisses and leaves the notice in place — nothing is granted. */
  it("'Not now' closes the explainer and the notice stays", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();

    const showMeHow = await screen.findByTestId("macos-fda-open-settings");
    await act(async () => {
      fireEvent.click(showMeHow);
    });
    await screen.findByTestId("fda-help-sheet");

    await act(async () => {
      fireEvent.click(screen.getByTestId("fda-help-not-now"));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("fda-help-sheet")).toBeNull()
    );
    expect(screen.getByTestId("macos-fda-denied-notice")).toBeInTheDocument();
    expect(systemApi().openSystemSettings).not.toHaveBeenCalled();
  });

  /**
   * BACKLOG-3210 (part 2) — dismissal on grant, at THIS surface.
   *
   * The explainer closes itself when it sees the permission granted, and hands
   * this panel a re-check so the notice around it goes too. Both halves are
   * asserted, and so is the inverse: still denied, both must REMAIN. A change
   * that simply hid either surface would pass the first half alone.
   */
  it("GRANTED — checking from the explainer clears the explainer AND the notice", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();

    const showMeHow = await screen.findByTestId("macos-fda-open-settings");
    await act(async () => {
      fireEvent.click(showMeHow);
    });
    await screen.findByTestId("fda-help-sheet");

    // The permission is now held, as it would be after the toggle + restart.
    systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);

    await act(async () => {
      fireEvent.click(screen.getByTestId("fda-help-check"));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("fda-help-sheet")).toBeNull()
    );
    await waitFor(() =>
      expect(screen.queryByTestId("macos-fda-denied-notice")).toBeNull()
    );
    // BACKLOG-3208's restart notice takes its place, because this process was
    // denied at launch and macOS does not revisit that until it restarts.
    // Silence here would tell the user she is done when she is not.
    expect(
      await screen.findByTestId("macos-fda-restart-notice")
    ).toBeInTheDocument();
  });

  it("STILL DENIED — both the explainer and the notice REMAIN", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();

    const showMeHow = await screen.findByTestId("macos-fda-open-settings");
    await act(async () => {
      fireEvent.click(showMeHow);
    });
    await screen.findByTestId("fda-help-sheet");

    await act(async () => {
      fireEvent.click(screen.getByTestId("fda-help-check"));
    });

    expect(
      await screen.findByTestId("fda-help-check-failed")
    ).toBeInTheDocument();
    expect(screen.getByTestId("fda-help-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("macos-fda-denied-notice")).toBeInTheDocument();
  });

  it("an UNANSWERABLE check clears nothing — it is not a grant", async () => {
    // The panel's own three-state contract, now reaching the explainer too.
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();

    const showMeHow = await screen.findByTestId("macos-fda-open-settings");
    await act(async () => {
      fireEvent.click(showMeHow);
    });
    await screen.findByTestId("fda-help-sheet");

    systemApi().checkPermissions.mockResolvedValue({ somethingElse: true });

    await act(async () => {
      fireEvent.click(screen.getByTestId("fda-help-check"));
    });

    expect(
      await screen.findByTestId("fda-help-check-failed")
    ).toBeInTheDocument();
    expect(screen.getByTestId("fda-help-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("macos-fda-denied-notice")).toBeInTheDocument();
  });

  /**
   * CONTROL 3. Granting FDA means leaving Keepr for System Settings, so the
   * moment the user comes back is exactly when the answer may have changed.
   */
  it("re-checks the permission when the window regains focus", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();

    await screen.findByTestId("macos-fda-denied-notice");
    const before = systemApi().checkPermissions.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(
        systemApi().checkPermissions.mock.calls.length
      ).toBeGreaterThan(before)
    );
  });

  /**
   * A grant made while Keepr is running is not usable access: macOS fixes an
   * app's Full Disk Access at process start. BACKLOG-1842 established this in
   * onboarding; the panel must not report success the import cannot deliver.
   */
  it("asks for a restart when the grant arrives while Keepr is running", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();
    await screen.findByTestId("macos-fda-denied-notice");

    systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    const restart = await screen.findByTestId("macos-fda-restart-notice");
    expect(restart).toHaveTextContent(/restart Keepr to finish/i);
    expect(screen.queryByTestId("macos-fda-denied-notice")).toBeNull();
  });

  it("relaunches only when the user asks — never from the focus re-check", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);

    renderStrict();
    await screen.findByTestId("macos-fda-denied-notice");

    systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await screen.findByTestId("macos-fda-restart-notice");

    // The flip alone must not quit the app out from under someone who is in
    // the middle of using Settings.
    expect(systemApi().relaunchApp).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("macos-fda-restart"));
    });

    expect(systemApi().relaunchApp).toHaveBeenCalledTimes(1);
  });

  /**
   * `relaunch-app` resolves `{ relaunched: false }` when the main-process
   * E2E/dev gate suppresses it. The process is still running, so the panel must
   * say what to do instead of spinning on a restart that is never coming.
   */
  it("tells the user to quit and reopen when the relaunch is suppressed", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);
    systemApi().relaunchApp.mockResolvedValue({ relaunched: false });

    renderStrict();
    await screen.findByTestId("macos-fda-denied-notice");

    systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await screen.findByTestId("macos-fda-restart-notice");

    await act(async () => {
      fireEvent.click(screen.getByTestId("macos-fda-restart"));
    });

    const fallback = await screen.findByTestId("macos-fda-restart-unavailable");
    expect(fallback).toHaveTextContent(/Quit Keepr and open it again/i);
    expect(screen.getByTestId("macos-fda-restart")).not.toBeDisabled();
  });

  /**
   * CONTROL 5. A permission refusal must not be reported as a disk-space
   * problem.
   *
   * `getAvailableMessageCount` checks Full Disk Access before it opens
   * anything, so its refusal resolves NORMALLY as `{success:false, error:
   * "Full Disk Access permission is required to read iMessages."}`. The panel
   * used to drop that `error` and render "Keepr could not work out how much
   * space this import needs" — the wrong answer, not a vague one.
   */
  it("does not blame disk space when the estimate was refused for want of permission", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
      ESTIMATE_REFUSED_NO_FDA
    );

    renderStrict();

    await screen.findByTestId("macos-fda-denied-notice");
    await waitFor(() =>
      expect(window.api.messages.getImportCount).toHaveBeenCalled()
    );

    expect(screen.queryByTestId("import-estimate-unavailable")).toBeNull();
  });

  /**
   * The two reads happen at different moments, so they can disagree: main can
   * refuse for want of Full Disk Access while this panel still holds `granted`
   * (or has not answered yet).
   *
   * That disagreement is the one state where suppressing the space copy could
   * do harm — suppressed AND no notice would be a refused import with nothing
   * on screen explaining it, which is exactly what BACKLOG-2760 exists to
   * prevent. The panel re-asks instead, and the notice arrives.
   */
  it("re-asks and shows the notice when main refuses for permission before the panel knows", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(() => {
      // From this point on the panel's own check would find it denied too —
      // it simply has not asked since.
      systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);
      return Promise.resolve(ESTIMATE_REFUSED_NO_FDA);
    });

    renderStrict();

    expect(
      await screen.findByTestId("macos-fda-denied-notice")
    ).toHaveTextContent("Keepr does not have Full Disk Access");
    expect(screen.queryByTestId("import-estimate-unavailable")).toBeNull();
  });

  /**
   * SR review of PR #2578 — the two findings, and why they are one test block.
   *
   * FINDING 1: the disabled Import button's tooltip had two branches, "still
   * checking" and "could not work out how much space", and neither described a
   * missing permission — so the disk-space misattribution survived in the one
   * place a user reads only AFTER trying to click.
   *
   * FINDING 2: `spaceBlocked` keys on the SIZE of the attachment copy, so it is
   * false whenever "import text only" is on. Import and Force Re-import
   * therefore stayed clickable with Full Disk Access denied, offering to run an
   * import that could not read one message.
   *
   * The three cases below are a DISCRIMINATING SET, not a happy path plus
   * decoration. The middle one is the one that matters: it holds a genuine
   * space-unknown refusal to the original wording and the original disabled
   * state, so "make it mention Full Disk Access" cannot be satisfied by making
   * it say that always — which would be this item's own defect class, pointing
   * the other way.
   */
  describe("SR review of PR #2578 — the import gate and its reason", () => {
    it("refuses the import and names Full Disk Access, even with attachments skipped", async () => {
      // "Import text only" makes the SPACE question moot — which is exactly
      // how the buttons stayed live with no permission to read anything.
      //
      // The key is `messageImport.filters.skipAttachments` (the panel reads
      // `messageImport.filters`, not `messageImport`). Written the shallow way
      // first, this test PASSED anyway — the button was disabled by the space
      // term, proving nothing about the permission one. Hence the explicit
      // assertion below that the toggle really is on: the premise of the test
      // is checked, not assumed.
      mockGetPreferences.mockResolvedValue({
        success: true,
        data: { messageImport: { filters: { skipAttachments: true } } },
      });
      systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);
      (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
        ESTIMATE_REFUSED_NO_FDA
      );

      renderStrict();

      await screen.findByTestId("macos-fda-denied-notice");
      await waitFor(() =>
        expect(screen.getByTestId("skip-attachments-toggle")).toBeChecked()
      );
      const importButton = screen.getByRole("button", {
        name: /Import Messages/i,
      });
      await waitFor(() => expect(importButton).toBeDisabled());
      expect(importButton).toHaveAttribute(
        "title",
        "Keepr needs Full Disk Access to read your messages"
      );
      expect(
        screen.getByRole("button", { name: /Force Re-import/i })
      ).toBeDisabled();
    });

    /**
     * The panel's OWN answer refuses the import, without waiting for the
     * estimate to agree.
     *
     * Written because a mutation exposed the gap: reducing the permission term
     * to the estimate-derived half alone left all other tests green. That half
     * requires the estimate to have RESOLVED unavailable, so with the estimate
     * still in flight and "import text only" on — the space term false — the
     * buttons would have been live for as long as the estimate took, while the
     * panel already knew Full Disk Access was denied.
     */
    it("refuses the import on the panel's own answer, before the estimate has resolved", async () => {
      mockGetPreferences.mockResolvedValue({
        success: true,
        data: { messageImport: { filters: { skipAttachments: true } } },
      });
      systemApi().checkPermissions.mockResolvedValue(FDA_DENIED);
      // The estimate never comes back, so nothing derived from it can be doing
      // the refusing here.
      (window.api.messages.getImportCount as jest.Mock).mockReturnValue(
        new Promise(() => {})
      );

      renderStrict();

      await screen.findByTestId("macos-fda-denied-notice");
      await waitFor(() =>
        expect(screen.getByTestId("skip-attachments-toggle")).toBeChecked()
      );
      expect(screen.queryByTestId("import-estimate-unavailable")).toBeNull();

      const importButton = screen.getByRole("button", {
        name: /Import Messages/i,
      });
      await waitFor(() => expect(importButton).toBeDisabled());
      expect(importButton).toHaveAttribute(
        "title",
        "Keepr needs Full Disk Access to read your messages"
      );
    });

    it("still refuses for an unknown size, in the original words, when permission is not the reason", async () => {
      systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
      (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
        success: false,
        error: "SQLITE_BUSY: database is locked",
      });

      renderStrict();

      await screen.findByTestId("import-estimate-unavailable");
      const importButton = screen.getByRole("button", {
        name: /Import Messages/i,
      });
      expect(importButton).toBeDisabled();
      expect(importButton).toHaveAttribute(
        "title",
        "Keepr could not work out how much space this import needs"
      );
    });

    it("leaves the import available, with no tooltip, when nothing is refusing it", async () => {
      systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
      (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(
        ESTIMATE_OK
      );

      renderStrict();

      const importButton = await screen.findByRole("button", {
        name: /Import Messages/i,
      });
      await waitFor(() => expect(importButton).toBeEnabled());
      expect(importButton).not.toHaveAttribute("title");
      expect(
        screen.getByRole("button", { name: /Force Re-import/i })
      ).toBeEnabled();
    });
  });

  /**
   * The other half of control 5: a refusal that is NOT about permission still
   * gets the space copy. Without this, "suppress the message" would pass by
   * deleting the message.
   */
  it("still says the size is unknown when the refusal has nothing to do with permission", async () => {
    systemApi().checkPermissions.mockResolvedValue(FDA_GRANTED);
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      success: false,
      error: "SQLITE_BUSY: database is locked",
    });

    renderStrict();

    expect(
      await screen.findByTestId("import-estimate-unavailable")
    ).toHaveTextContent(/could not work out how much space/i);
  });
});
