/**
 * Tests for Settings.tsx
 * Covers settings UI, email connections, and preferences
 */

import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Settings from "../Settings";
import { PlatformProvider } from "../../contexts/PlatformContext";
import { NotificationProvider } from "../../contexts/NotificationContext";
import { IPhoneSyncProvider } from "../../contexts/IPhoneSyncContext";
import { rcsImportService } from "../../services/rcsImportService";

// Polyfill Element.scrollTo for jsdom (SettingsTabBar uses it)
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = jest.fn();
}

// Mock the useLicense hook (still used by some sub-components)
jest.mock("@/contexts/LicenseContext", () => ({
  useLicense: jest.fn(() => ({
    licenseType: "individual" as const,
    hasAIAddon: true,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  })),
}));

// TASK-2159: Mock the useFeatureGate hook (Settings + FeatureGate now use this)
const mockIsAllowed = jest.fn().mockReturnValue(true); // Default: all features allowed
jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: mockIsAllowed,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

// TASK-2056: Mock the useNetwork hook for offline testing
// BACKLOG-2414: both timestamps are `Date | null` on the real context. Without
// these annotations the default literal narrows them to `Date` and `null`, so the
// offline-mode `mockReturnValue` further down (null / new Date()) cannot be
// assigned. The values here are unchanged.
const mockUseNetwork = jest.fn(() => ({
  isOnline: true,
  isChecking: false,
  lastOnlineAt: new Date() as Date | null,
  lastOfflineAt: null as Date | null,
  connectionError: null,
  checkConnection: jest.fn().mockResolvedValue(true),
  clearError: jest.fn(),
  setConnectionError: jest.fn(),
}));
jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => mockUseNetwork(),
}));

// Wrap Settings in PlatformProvider for tests
const renderSettings = async (props: { onClose: () => void; userId: string; onImportIphone?: () => void }) => {
  const result = render(
    <NotificationProvider>
      <PlatformProvider>
        <Settings {...props} />
      </PlatformProvider>
    </NotificationProvider>
  );
  // Wait for preferences to load (spinner to disappear) before returning
  await waitFor(() => {
    expect(screen.queryByText("Loading settings...")).not.toBeInTheDocument();
  });
  return result;
};

describe("Settings", () => {
  const mockUserId = "user-123";
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
      success: true,
      google: { connected: false },
      microsoft: { connected: false },
    });
    jest.mocked(window.api.preferences.get).mockResolvedValue({
      success: true,
      preferences: {
        export: { defaultFormat: "combined-pdf" },
      },
    });
    jest.mocked(window.api.preferences.update).mockResolvedValue({ success: true });
    jest.mocked(window.api.auth.googleConnectMailbox).mockResolvedValue({ success: true });
    jest.mocked(window.api.auth.microsoftConnectMailbox).mockResolvedValue({
      success: true,
    });
    jest.mocked(window.api.auth.googleDisconnectMailbox).mockResolvedValue({
      success: true,
    });
    jest.mocked(window.api.auth.microsoftDisconnectMailbox).mockResolvedValue({
      success: true,
    });
    jest.mocked(window.api.onGoogleMailboxConnected).mockReturnValue(jest.fn());
    jest.mocked(window.api.onMicrosoftMailboxConnected).mockReturnValue(jest.fn());
    jest.mocked(window.api.onGoogleMailboxDisconnected).mockReturnValue(jest.fn());
    jest.mocked(window.api.onMicrosoftMailboxDisconnected).mockReturnValue(jest.fn());

    // Messages mocks for MacOSMessagesImportSettings component
    jest.mocked(window.api.messages.onImportProgress).mockReturnValue(jest.fn());
    // BACKLOG-2414: the import result also declares `attachmentsImported` /
    // `attachmentsSkipped` as required; this fixture predates them and the tests
    // here only read the message counters. Cast, so the payload the component
    // receives is unchanged.
    jest.mocked(window.api.messages.importMacOSMessages).mockResolvedValue({
      success: true,
      messagesImported: 0,
      messagesSkipped: 0,
      duration: 100,
    } as Awaited<ReturnType<typeof window.api.messages.importMacOSMessages>>);

    // LLM mocks for LLMSettings component
    // BACKLOG-2414 / REAL DRIFT, NOT A TYPING NIT: none of these keys exist on
    // `LLMUserConfig`. The real field names are `hasOpenAI`, `hasAnthropic`,
    // `hasConsent`, `autoDetectEnabled`, `roleExtractionEnabled`, and
    // `preferredProvider`/`openAIModel`/`anthropicModel`/`tokensUsed`/
    // `platformAllowanceRemaining` are missing entirely — so LLMSettings renders
    // here with every one of those undefined. Left verbatim because correcting the
    // key names would change what the component under test receives, which is a
    // behavioural fix and needs its own review, not a silent edit inside a
    // type-only pass.
    jest.mocked(window.api.llm.getConfig).mockResolvedValue({
      success: true,
      data: {
        hasOpenAIKey: false,
        hasAnthropicKey: false,
        consentGiven: true,
        usePlatformAllowance: true,
        enableAutoDetect: false,
        enableRoleExtraction: false,
      },
    } as unknown as Awaited<ReturnType<typeof window.api.llm.getConfig>>);
    jest.mocked(window.api.llm.getUsage).mockResolvedValue({
      success: true,
      data: {
        tokensThisMonth: 0,
        platformAllowance: 10000,
        platformUsed: 0,
      },
    });

    // Update mocks for GeneralSettings (Check for Updates button)
    window.api.update.checkForUpdates = jest.fn().mockResolvedValue({ updateAvailable: false });

    // Security mocks for SecuritySettings
    window.api.auth.getActiveDevices = jest.fn().mockResolvedValue({ success: true, devices: [] });
    window.api.auth.signOutAllDevices = jest.fn().mockResolvedValue({ success: true });

    // Email re-cache mock for EmailSettings (BACKLOG-1362)
    window.api.transactions.precacheEmails = jest.fn().mockResolvedValue({ success: true, emailsFetched: 0, emailsStored: 0 });

    // Preferences save mock (used by settingsService.savePreferences)
    window.api.preferences.save = jest.fn().mockResolvedValue({ success: true });
  });

  describe("Rendering", () => {
    it("should render settings modal with title", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Responsive layout renders both mobile and desktop headers
      expect(screen.getAllByText("Settings").length).toBeGreaterThanOrEqual(1);
    });

    it("should show all settings sections", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getAllByText("General").length).toBeGreaterThanOrEqual(1);
      });

      expect(screen.getAllByText("Email").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Security").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("AI Settings")).toBeInTheDocument();
      expect(screen.getAllByText("Data & Privacy").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("About").length).toBeGreaterThanOrEqual(1);
    });

    it("should show copyright", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByText(/© 2026 Blue Spaces LLC/)).toBeInTheDocument();
    });
  });

  /**
   * BACKLOG-3156 stage A: the section heading is now "Emails", and the panel
   * carries a "Stored on this computer" grid whose cells are labelled Gmail and
   * Outlook. That makes a bare getByText("Gmail") ambiguous, so these queries
   * are scoped to the Sources block — which asserts MORE than before: the
   * provider label is in the sources block specifically, not merely somewhere
   * on the page.
   */
  const sources = () => within(screen.getByTestId("emails-block-sources"));

  describe("Emails", () => {
    /**
     * BACKLOG-3156 stage C: the status pill and the action button merged into
     * ONE control per row, so "Not Connected" is no longer printed beside a
     * "Connect Gmail" button — the button IS the status. Updated deliberately;
     * the assertion did not weaken, it moved onto the control that replaced the
     * words.
     */
    it("should show Gmail connection status", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(sources().getByText("Gmail")).toBeInTheDocument();
      });

      expect(
        sources().getByRole("button", { name: /connect gmail/i }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Not Connected")).not.toBeInTheDocument();
    });

    it("should show Outlook connection status", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(sources().getByText("Outlook")).toBeInTheDocument();
      });
    });

    it("should show connected status when Gmail is connected", async () => {
      jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
        success: true,
        google: { connected: true, email: "user@gmail.com" },
        microsoft: { connected: false },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
      });

      expect(screen.getByText("user@gmail.com")).toBeInTheDocument();
    });

    it("should show connected status when Outlook is connected", async () => {
      jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
        success: true,
        google: { connected: false },
        microsoft: { connected: true, email: "user@outlook.com" },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
      });

      expect(screen.getByText("user@outlook.com")).toBeInTheDocument();
    });

    it("should show loading state while checking connections", async () => {
      jest.mocked(window.api.system.checkAllConnections).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getAllByText("Checking...").length).toBeGreaterThan(0);
    });

    it("should call connect Gmail when button is clicked", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(sources().getByText("Gmail")).toBeInTheDocument();
      });

      const connectGmailButton = screen.getByRole("button", {
        name: /connect gmail/i,
      });
      await userEvent.click(connectGmailButton);

      expect(window.api.auth.googleConnectMailbox).toHaveBeenCalledWith(
        mockUserId,
      );
    });

    it("should call connect Outlook when button is clicked", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(sources().getByText("Outlook")).toBeInTheDocument();
      });

      const connectOutlookButton = screen.getByRole("button", {
        name: /connect outlook/i,
      });
      await userEvent.click(connectOutlookButton);

      expect(window.api.auth.microsoftConnectMailbox).toHaveBeenCalledWith(
        mockUserId,
      );
    });

    /**
     * BACKLOG-3156 stage C: Disconnect moved OFF the resting page and into the
     * row's overflow, so that a glance-and-tap on a green row cannot sign you
     * out. The old test asserted the button was visible while connected; this
     * asserts the opposite half AND that it is still reachable and enabled, so
     * "moved" cannot pass as "deleted".
     */
    it("keeps Disconnect out of the resting page and behind the row's menu", async () => {
      jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
        success: true,
        google: { connected: true, email: "user@gmail.com" },
        microsoft: { connected: false },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByTestId("email-connection-google-status"),
        ).toHaveTextContent("Connected");
      });
      expect(
        screen.queryByRole("button", { name: /disconnect gmail/i }),
      ).not.toBeInTheDocument();

      await userEvent.click(screen.getByTestId("email-connection-google-trigger"));

      const disconnectItem = screen.getByRole("menuitem", {
        name: /disconnect gmail/i,
      });
      expect(disconnectItem).toBeEnabled();
    });

    /**
     * BACKLOG-3156 stage C: choosing Disconnect now opens a confirmation, so
     * the API call is asserted at the END of menu -> item -> confirm. The
     * "not yet called" assertion between the two clicks is the part that would
     * red if the menu item were ever wired straight to the handler again.
     */
    it("should call disconnect Gmail after the confirmation is accepted", async () => {
      jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
        success: true,
        google: { connected: true, email: "user@gmail.com" },
        microsoft: { connected: false },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByTestId("email-connection-google-trigger"),
        ).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTestId("email-connection-google-trigger"));
      await userEvent.click(
        screen.getByRole("menuitem", { name: /disconnect gmail/i }),
      );

      expect(window.api.auth.googleDisconnectMailbox).not.toHaveBeenCalled();

      await userEvent.click(screen.getByTestId("disconnect-confirm"));

      expect(window.api.auth.googleDisconnectMailbox).toHaveBeenCalledWith(
        mockUserId,
      );
    });

    it("should call disconnect Outlook after the confirmation is accepted", async () => {
      jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
        success: true,
        google: { connected: false },
        microsoft: { connected: true, email: "user@outlook.com" },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByTestId("email-connection-microsoft-trigger"),
        ).toBeInTheDocument();
      });

      await userEvent.click(
        screen.getByTestId("email-connection-microsoft-trigger"),
      );
      await userEvent.click(
        screen.getByRole("menuitem", { name: /disconnect outlook/i }),
      );

      expect(window.api.auth.microsoftDisconnectMailbox).not.toHaveBeenCalled();

      await userEvent.click(screen.getByTestId("disconnect-confirm"));

      expect(window.api.auth.microsoftDisconnectMailbox).toHaveBeenCalledWith(
        mockUserId,
      );
    });

    /**
     * BACKLOG-2142: distinguish the THREE states — connected / expired (broken
     * token) / not-connected — so a broken token is not misread as
     * "disconnected". The render keys off the typed `error.type` discriminator
     * (no message string-matching).
     *
     * BACKLOG-3156 stage C changed WHERE that distinction is legible, and these
     * three were updated deliberately rather than deleted. The status pill is
     * gone — one merged control replaced pill-plus-button — so the words
     * "Session Expired" and "Connection Issue" are no longer printed. What the
     * user can still tell apart:
     *
     *   - broken vs never-linked: the control reads `Reconnect`, not `Connect`
     *   - expired vs erroring: the provider's own `userMessage` panel, which
     *     renders in both error states and is asserted below
     *
     * Each test therefore asserts the surviving signal AND the absence of the
     * pill, so a change that quietly reinstates a second status element beside
     * the control is a red rather than a pass.
     */
    describe("broken-token state (BACKLOG-2142)", () => {
      it("offers Reconnect (not Connect) plus the expired message for a TOKEN_REFRESH_FAILED Gmail token", async () => {
        jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
          success: true,
          google: {
            connected: false,
            email: "user@gmail.com",
            error: {
              type: "TOKEN_REFRESH_FAILED",
              userMessage:
                "Your Gmail connection expired. Reconnect to keep capturing email.",
              action: "Reconnect",
            },
          },
          microsoft: { connected: false },
        });

        await renderSettings({ userId: mockUserId, onClose: mockOnClose });

        // Distinct from "Connect" — offers Reconnect directly.
        await waitFor(() => {
          expect(
            screen.getByRole("button", { name: "Reconnect Gmail" }),
          ).toBeInTheDocument();
        });
        expect(
          screen.queryByRole("button", { name: "Connect Gmail" }),
        ).not.toBeInTheDocument();
        // The expired-connection userMessage is what now separates this state
        // from a plain connection issue.
        expect(
          screen.getByText(
            "Your Gmail connection expired. Reconnect to keep capturing email.",
          ),
        ).toBeInTheDocument();
        // The pill the merged control replaced is gone, not sitting beside it.
        expect(screen.queryByText("Session Expired")).not.toBeInTheDocument();
      });

      it("offers Reconnect plus its own message for a CONNECTION_CHECK_FAILED Outlook token", async () => {
        jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
          success: true,
          google: { connected: false },
          microsoft: {
            connected: false,
            email: "user@outlook.com",
            error: {
              type: "CONNECTION_CHECK_FAILED",
              userMessage: "Could not verify Outlook connection",
              action: "Check your Outlook connection",
            },
          },
        });

        await renderSettings({ userId: mockUserId, onClose: mockOnClose });

        await waitFor(() => {
          expect(
            screen.getByRole("button", { name: "Reconnect Outlook" }),
          ).toBeInTheDocument();
        });
        expect(
          screen.getByText("Could not verify Outlook connection"),
        ).toBeInTheDocument();
        expect(screen.queryByText("Connection Issue")).not.toBeInTheDocument();
      });

      it("still offers Connect, never Reconnect, for a NOT_CONNECTED provider", async () => {
        jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
          success: true,
          google: {
            connected: false,
            error: { type: "NOT_CONNECTED", userMessage: "Gmail is not connected" },
          },
          microsoft: { connected: false },
        });

        await renderSettings({ userId: mockUserId, onClose: mockOnClose });

        // BACKLOG-2487: gate on the control this test is about, not on the
        // <h4> beside it. The provider heading renders unconditionally, so a
        // wait on it opens on the FIRST render — while the row still reads
        // "Checking..." and carries no button at all, and the synchronous read
        // that followed then missed a button that was merely not there YET.
        // Waiting for the button itself makes the wait and the read the same
        // element.
        expect(
          await screen.findByRole("button", { name: "Connect Gmail" }),
        ).toBeInTheDocument();
        // ...and it is the Emails Sources block that offers it.
        expect(sources().getByText("Gmail")).toBeInTheDocument();
        expect(
          sources().getByRole("button", { name: "Connect Gmail" }),
        ).toBeInTheDocument();
        // A never-connected provider offers Connect, NOT Reconnect — the
        // NOT_CONNECTED error type must not be read as a broken connection.
        expect(
          screen.queryByRole("button", { name: /reconnect gmail/i }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText("Session Expired")).not.toBeInTheDocument();
        expect(screen.queryByText("Not Connected")).not.toBeInTheDocument();
      });
    });
  });

  /**
   * BACKLOG-3156 stage C — the Messages section takes the same shape as its two
   * siblings.
   *
   * Emails and Contacts each open with a `Sources` eyebrow above their source
   * cards; Messages had the card (the import-source picker) and not the
   * eyebrow, so the "one shape" the redesign promised stopped one section
   * short. The eyebrow now lives in `ImportSourceSettings`, which
   * `Settings.tsx` renders above BOTH message panels — the macOS one and the
   * Android one — so neither has to carry a copy.
   *
   * The order is asserted HERE, against the real composition in `Settings.tsx`,
   * rather than in the panel's own suite: the sources block and the preferences
   * block live in different components, and a test that assembled them itself
   * would be asserting the order of its own fixture.
   */
  describe("Messages section shape (BACKLOG-3156)", () => {
    it("runs Sources -> Import Preferences -> actions", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const sourcesBlock = await screen.findByTestId("messages-block-sources");
      const preferences = await screen.findByTestId("messages-block-preferences");
      const actions = await screen.findByTestId("messages-block-actions");

      expect(
        `sources then preferences: ${
          (sourcesBlock.compareDocumentPosition(preferences) & 4) !== 0
        }`,
      ).toBe("sources then preferences: true");
      expect(
        `preferences then actions: ${
          (preferences.compareDocumentPosition(actions) & 4) !== 0
        }`,
      ).toBe("preferences then actions: true");
    });

    /**
     * The Android branch, asserted separately and for a specific reason.
     *
     * `AndroidMessagesSettings.tsx` does NOT render `ImportSourceSettings` —
     * checked, it contains no reference to it. It does not need to: the picker
     * is its SIBLING one level up, rendered by `Settings.tsx` above the
     * `activeImportSource === 'android-companion'` ternary, inside the same
     * `space-y-4` wrapper. So both branches of that ternary get the same
     * Sources block from the same element, and neither panel carries a copy.
     *
     * A reader cannot verify that from either panel's source, which is exactly
     * why it is asserted here — with the macOS panel's absence checked too, so
     * the test cannot pass by silently having rendered the other branch.
     */
    // BACKLOG-3659 P3d. Mutation: the android-messages-web branch removed → red.
    // BACKLOG-1467 stands; BACKLOG-3749: a Mac that skips its Messages because
    // Google Messages is selected SHOWS that selection (radio + section),
    // never a blank or greyed panel. Mutation: the macOS panel shown → red.
    it("Android with Google Messages: the radio and the Google Messages section; no macOS or companion panel", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: { source: "android-messages-web" },
        },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(await screen.findByTestId("google-messages-settings")).toBeInTheDocument();
      expect(screen.queryByTestId("android-block-actions")).not.toBeInTheDocument();
      expect(screen.queryByTestId("macos-messages-import")).not.toBeInTheDocument();
      await waitFor(() =>
        expect((document.querySelector('input[value="android-messages-web"]') as HTMLInputElement | null)?.checked).toBe(true),
      );
    });

    // BACKLOG-3749: a stored value this build does not know (e.g. from a newer
    // build) is read as the platform default — on a Mac, macOS Messages,
    // checked and live; nothing is written back. Mutation: the raw value used
    // (no radio checked, the panel disabled) → red.
    it("an unknown stored source: on a Mac, the macOS radio is checked and its panel is live; nothing written", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: { source: "some-future-source" },
        },
      });

      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(await screen.findByTestId("macos-messages-import")).toBeInTheDocument();
      await waitFor(() =>
        expect((container.querySelector('input[value="macos-native"]') as HTMLInputElement | null)?.checked).toBe(true),
      );
      expect(screen.queryByTestId("google-messages-settings")).not.toBeInTheDocument();
      expect(window.api.preferences.update).not.toHaveBeenCalled();
    });

    // SR C6 (founder): the Companion panel is no longer mounted — a stored
    // "android-companion" shows the Google Messages section, under the same
    // Sources block. Mutation: the Companion branch back → red.
    it("Android (a stored Companion source): the same Sources block sits above the Google Messages section", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: { source: "android-companion" },
        },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const sourcesBlock = await screen.findByTestId("messages-block-sources");
      const gm = await screen.findByTestId("google-messages-settings");
      expect(screen.queryByTestId("android-block-preferences")).not.toBeInTheDocument();
      expect(screen.queryByTestId("android-block-actions")).not.toBeInTheDocument();
      expect(screen.queryByTestId("macos-messages-import")).not.toBeInTheDocument();
      expect(`sources then google messages: ${(sourcesBlock.compareDocumentPosition(gm) & 4) !== 0}`).toBe(
        "sources then google messages: true",
      );
      expect(within(sourcesBlock).getByText("Sources")).toBeInTheDocument();
    });

    /**
     * BACKLOG-3156 stage E rewrote what this asserts, because the thing it
     * reached for is gone.
     *
     * It used to pin `Sources` (the eyebrow) above `Import Source` (an `<h4>`
     * inside the card) — two headings for one block, which is the doubling the
     * founder reported on the shipped screen. The `<h4>` was deleted, so an
     * assertion naming it could only be deleted or rewritten; deleting it would
     * leave the block's shape unasserted, which is how this file has drifted
     * three times.
     *
     * The shape it holds instead is the one the approved artifact draws: the
     * block IS the card, the eyebrow is that card's FIRST CHILD, and the
     * description is the line under it — the slot the `<h4>` used to occupy. It
     * is asserted here rather than in the panel's own suite for the reason the
     * surrounding describe() gives: this is the real composition from
     * `Settings.tsx`, not a fixture the test assembled.
     */
    it("makes the Sources block one card whose first line is its own label", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const card = await screen.findByTestId("messages-block-sources");

      // The block and the card are the same element — nothing wraps it.
      expect(card.className).toMatch(/(^|\s)rounded-lg(\s|$)/);
      expect(card.className).toMatch(/(^|\s)border(\s|$)/);

      // The eyebrow is the card's first child, INSIDE it.
      const eyebrow = within(card).getByText("Sources");
      expect(card.firstElementChild).toBe(eyebrow);

      // The description is the next line, still inside the same card.
      const description = within(card).getByText(
        "Choose where to import your text messages from.",
      );
      expect(eyebrow.nextElementSibling).toBe(description);

      // …and the card opens with the eyebrow, not with a heading repeating it.
      expect(card.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
      expect(within(card).queryByText("Import Source")).toBeNull();
    });
  });

  // BACKLOG-3156 stage G (SR review, required changes 1-3).
  describe("Messages panes: wiring guards (BACKLOG-3156 G)", () => {
    const withSource = (source: string) =>
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: { export: { defaultFormat: "combined-pdf" }, messages: { source } },
      });

    // Founder: the macOS pane no longer shows "Last imported: <date> | N messages".
    // The status IS available from the bridge here, so a pane that still read and
    // printed it would show the line. Mutation: the line re-added -> red.
    it("macOS pane: no 'Last imported' line, even when an import status exists", async () => {
      (window.api.messages as unknown as { getImportStatus: jest.Mock }).getImportStatus = jest
        .fn()
        .mockResolvedValue({ success: true, messageCount: 1234, lastImportAt: new Date().toISOString() });
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });
      await screen.findByTestId("macos-messages-import");
      await waitFor(() => expect(screen.getByTestId("messages-block-stored")).toBeInTheDocument());
      expect(document.body.textContent).not.toMatch(/last imported/i);
      expect(document.body.textContent).not.toMatch(/1,234 messages/);
    });

    // SR M7: Settings dropped onImportIphone and the whole suite stayed green.
    it("iPhone source: Import from iPhone is in the Messages section and calls onImportIphone once", async () => {
      withSource("iphone-sync");
      const onImportIphone = jest.fn();
      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose, onImportIphone });
      const button = await screen.findByTestId("iphone-import");
      expect(container.querySelector("#settings-messages")!.contains(button)).toBe(true);
      await userEvent.click(button);
      expect(onImportIphone).toHaveBeenCalledTimes(1);
    });

    // SR M10: the Google pane re-read the link state on mount and nothing noticed.
    it("Google source: the extension state is read exactly once per Settings open", async () => {
      withSource("android-messages-web");
      const read = jest.spyOn(rcsImportService, "getExtensionState").mockResolvedValue({
        success: true,
        data: {
          extensionVersion: "0.3.4",
          extensionSeenAt: "2026-10-01T10:00:00.000Z",
          pairedAt: "2026-10-01T10:00:00.000Z",
          optedIn: true,
          lastCacheFinishedAt: "2026-10-01T11:00:00.000Z",
          consentVersion: 1,
          consentRequired: 1,
          consentAt: "2026-10-01T09:00:00.000Z",
          autoDeleteDays: null,
        },
      });
      try {
        await renderSettings({ userId: mockUserId, onClose: mockOnClose });
        await screen.findByTestId("google-messages-settings");
        await waitFor(() => expect(read).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 50));
        expect(read).toHaveBeenCalledTimes(1);
      } finally {
        read.mockRestore();
      }
    });
  });

  describe("Export Settings", () => {
    it("should show export format section with card buttons", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Card buttons should be present
      expect(screen.getByText("One PDF")).toBeInTheDocument();
      expect(screen.getByText("Audit Package")).toBeInTheDocument();
      expect(screen.getByText("Summary PDF")).toBeInTheDocument();
    });

    it("should show all export format options", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Check all format card buttons are available
      expect(screen.getByText("One PDF")).toBeInTheDocument();
      expect(screen.getByText("Audit Package")).toBeInTheDocument();
      expect(screen.getByText("Summary PDF")).toBeInTheDocument();
    });

    it("should load saved export format preference", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "folder" },
        },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // The "Audit Package" button (value "folder") should be the active one (purple bg)
      await waitFor(() => {
        const auditBtn = screen.getByText("Audit Package").closest("button");
        expect(auditBtn).toHaveClass("bg-purple-500");
      });
    });

    it("should save export format when changed", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Click the "Summary PDF" button (value "pdf")
      const summaryBtn = screen.getByText("Summary PDF").closest("button")!;
      await userEvent.click(summaryBtn);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        export: { defaultFormat: "pdf" },
      });
    });

    it("should show loading spinner while loading preferences", async () => {
      jest.mocked(window.api.preferences.get).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      render(
        <NotificationProvider>
          <PlatformProvider>
            <Settings userId={mockUserId} onClose={mockOnClose} />
          </PlatformProvider>
        </NotificationProvider>
      );

      expect(screen.getByText("Loading settings...")).toBeInTheDocument();
    });
  });

  describe("General Settings", () => {
    it("should show notifications toggle as enabled and toggleable", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByText("Notifications")).toBeInTheDocument();
      expect(
        screen.getByText(/show desktop notifications/i),
      ).toBeInTheDocument();

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /desktop notifications/i,
        });
        expect(toggle).not.toBeDisabled();
      });
    });

    it("should default notifications to ON", async () => {
      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /desktop notifications/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "true");
      });
    });

    it("should load saved notification preference (OFF)", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          notifications: { enabled: false },
        },
      });

      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /desktop notifications/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "false");
      });
    });

    it("should load saved notification preference (ON)", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          notifications: { enabled: true },
        },
      });

      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /desktop notifications/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "true");
      });
    });

    it("should toggle notifications and save preference", async () => {
      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByRole("switch", { name: /desktop notifications/i }),
        ).toBeInTheDocument();
      });

      const toggle = screen.getByRole("switch", {
        name: /desktop notifications/i,
      });
      await userEvent.click(toggle);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        notifications: { enabled: false },
      });
    });

    it("should render Test Notification button", async () => {
      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Test Notification")).toBeInTheDocument();
      });
    });

    it("should call notification.send when Test Notification is clicked", async () => {
      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Test Notification")).toBeInTheDocument();
      });

      const testButton = screen.getByRole("button", {
        name: /test notification/i,
      });
      await userEvent.click(testButton);

      expect(window.api.notification.send).toHaveBeenCalledWith(
        "Test Notification",
        "Desktop notifications are working correctly."
      );
    });

    it("should disable Test Notification button when notifications are OFF", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          notifications: { enabled: false },
        },
      });

      renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const testButton = screen.getByRole("button", {
          name: /test notification/i,
        });
        expect(testButton).toBeDisabled();
      });
    });

  });

  describe("Auto-Download Updates Toggle", () => {
    it("should show auto-download updates toggle", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Auto-download Updates")).toBeInTheDocument();
      });

      expect(
        screen.getByText(/automatically download new software updates/i),
      ).toBeInTheDocument();
    });

    it("should default to off (disabled)", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /auto-download updates/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "false");
      });
    });

    it("should load saved auto-download preference", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          updates: { autoDownload: true },
        },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /auto-download updates/i,
        });
        expect(toggle).toHaveAttribute("aria-checked", "true");
      });
    });

    it("should toggle auto-download and save preference", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(
          screen.getByRole("switch", { name: /auto-download updates/i }),
        ).toBeInTheDocument();
      });

      const toggle = screen.getByRole("switch", {
        name: /auto-download updates/i,
      });
      await userEvent.click(toggle);

      expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
        updates: { autoDownload: true },
      });
    });

    it("should show loading spinner while loading preferences", async () => {
      jest.mocked(window.api.preferences.get).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      render(
        <NotificationProvider>
          <PlatformProvider>
            <Settings userId={mockUserId} onClose={mockOnClose} />
          </PlatformProvider>
        </NotificationProvider>
      );

      expect(screen.getByText("Loading settings...")).toBeInTheDocument();
    });
  });

  describe("Data & Privacy", () => {
    it("should show the Troubleshooting reset/uninstall actions (BACKLOG-2112)", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // The old disabled "Clear All Data" placeholder was replaced by the
      // dedicated Troubleshooting section (reset + uninstall).
      expect(screen.getByText("Reset app data…")).toBeInTheDocument();
      expect(screen.getByText("Uninstall Keepr…")).toBeInTheDocument();
    });

    it("should show reindex database button", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByText("Reindex Database")).toBeInTheDocument();
      expect(
        screen.getByText(/optimize database performance/i),
      ).toBeInTheDocument();
    });

    it("should call reindexDatabase when button is clicked", async () => {
      // Mock window.confirm to return true (user confirms)
      const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);

      jest.mocked(window.api.system.reindexDatabase).mockResolvedValue({
        success: true,
        indexesRebuilt: 14,
        durationMs: 150,
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const reindexButton = screen
        .getByText("Reindex Database")
        .closest("button");
      expect(reindexButton).not.toBeDisabled();

      await userEvent.click(reindexButton!);

      expect(window.api.system.reindexDatabase).toHaveBeenCalled();

      confirmSpy.mockRestore();
    });

    it("should show success message after reindex", async () => {
      // Mock window.confirm to return true (user confirms)
      const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);

      jest.mocked(window.api.system.reindexDatabase).mockResolvedValue({
        success: true,
        indexesRebuilt: 14,
        durationMs: 150,
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const reindexButton = screen
        .getByText("Reindex Database")
        .closest("button");
      await userEvent.click(reindexButton!);

      // TASK-2150: Reindex now goes through orchestrator, so the success message
      // is simplified (detailed result data like indexesRebuilt is not surfaced)
      await waitFor(() => {
        expect(
          screen.getByText(/database optimized successfully/i),
        ).toBeInTheDocument();
      });

      confirmSpy.mockRestore();
    });

    it("should show error message when reindex fails", async () => {
      // Mock window.confirm to return true (user confirms)
      const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);

      jest.mocked(window.api.system.reindexDatabase).mockResolvedValue({
        success: false,
        indexesRebuilt: 0,
        durationMs: 50,
        error: "Database is locked",
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const reindexButton = screen
        .getByText("Reindex Database")
        .closest("button");
      await userEvent.click(reindexButton!);

      await waitFor(() => {
        expect(screen.getByText(/database is locked/i)).toBeInTheDocument();
      });

      confirmSpy.mockRestore();
    });
  });

  describe("About Section", () => {
    it("should show action links", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByText("View Release Notes")).toBeInTheDocument();
      expect(screen.getByText("Privacy Policy")).toBeInTheDocument();
      expect(screen.getByText("Terms of Service")).toBeInTheDocument();
    });
  });

  describe("Close Modal", () => {
    it("should call onClose when close button is clicked", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const closeButton = screen
        .getAllByRole("button")
        .find((btn) => btn.querySelector('svg path[d*="M6 18L18 6"]'));

      if (closeButton) {
        await userEvent.click(closeButton);
        expect(mockOnClose).toHaveBeenCalled();
      }
    });

    it("should call onClose when done button is clicked", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      const doneButton = screen.getByRole("button", { name: /done/i });
      await userEvent.click(doneButton);

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe("API Integration", () => {
    it("should check connections on mount", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(window.api.system.checkAllConnections).toHaveBeenCalledWith(
          mockUserId,
        );
      });
    });

    it("should load preferences on mount", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(window.api.preferences.get).toHaveBeenCalledWith(mockUserId);
      });
    });

    it("should have all required APIs available", async () => {
      expect(window.api.system.checkAllConnections).toBeDefined();
      expect(window.api.preferences.get).toBeDefined();
      expect(window.api.preferences.update).toBeDefined();
      expect(window.api.auth.googleConnectMailbox).toBeDefined();
      expect(window.api.auth.microsoftConnectMailbox).toBeDefined();
      expect(window.api.auth.googleDisconnectMailbox).toBeDefined();
      expect(window.api.auth.microsoftDisconnectMailbox).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    // BACKLOG-2414: the three failure fixtures in this block each attach an
    // `error` string that the corresponding IPC response type does not declare —
    // a gap in the production contract, not in the tests: the handlers really do
    // return `{ success: false, error }`. The fixtures stay verbatim (they are the
    // failure payload under test) and each is cast; widening the contract types is
    // a production change and out of scope for a type-only pass.
    it("should handle connection check failure gracefully", async () => {
      jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
        success: false,
        error: "Network error",
      } as unknown as Awaited<
        ReturnType<typeof window.api.system.checkAllConnections>
      >);

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Should still render without crashing (responsive layout has mobile + desktop headers)
      await waitFor(() => {
        expect(screen.getAllByText("Settings").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("should handle preferences load failure gracefully", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: false,
        error: "Failed to load preferences",
      } as unknown as Awaited<ReturnType<typeof window.api.preferences.get>>);

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Should still render with default values — "One PDF" (combined-pdf) should be active
      await waitFor(() => {
        const onePdfBtn = screen.getByText("One PDF").closest("button");
        expect(onePdfBtn).toHaveClass("bg-purple-500");
      });
    });

    it("should handle preferences update failure gracefully", async () => {
      jest.mocked(window.api.preferences.update).mockResolvedValue({
        success: false,
        error: "Failed to save preferences",
      } as unknown as Awaited<ReturnType<typeof window.api.preferences.update>>);

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Click a different format button
      const summaryBtn = screen.getByText("Summary PDF").closest("button")!;
      await userEvent.click(summaryBtn);

      // Should not crash, preference update fails silently
      expect(window.api.preferences.update).toHaveBeenCalled();
    });
  });

  describe("Accessibility", () => {
    it("should have accessible form controls", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("Format")).toBeInTheDocument();
      });

      // Export format buttons should be accessible
      const onePdfBtn = screen.getByText("One PDF").closest("button");
      const auditBtn = screen.getByText("Audit Package").closest("button");
      const summaryBtn = screen.getByText("Summary PDF").closest("button");
      expect(onePdfBtn).toBeInTheDocument();
      expect(auditBtn).toBeInTheDocument();
      expect(summaryBtn).toBeInTheDocument();
    });

    it("should have accessible buttons", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
    });
  });

  describe("AI Settings Feature Gating (BACKLOG-462, TASK-2159)", () => {
    it("should show AI Settings section when ai_detection feature is allowed", async () => {
      mockIsAllowed.mockReturnValue(true); // All features allowed

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("AI Settings")).toBeInTheDocument();
      });
    });

    it("should hide AI Settings section when ai_detection feature is not allowed", async () => {
      mockIsAllowed.mockImplementation((key: string) => key !== "ai_detection");

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        // AI Settings should NOT be visible
        expect(screen.queryByText("AI Settings")).not.toBeInTheDocument();
      });
    });

    it("should show AI Settings when ai_detection feature is allowed regardless of license type", async () => {
      mockIsAllowed.mockReturnValue(true); // All features allowed

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        expect(screen.getByText("AI Settings")).toBeInTheDocument();
      });
    });
  });

  // BACKLOG-2320: the guided Android install→pair→sync wizard MOVED out of
  // Settings to a Dashboard button (mirroring iOS). Settings keeps only the
  // Android device/status management (AndroidMessagesSettings). The wizard
  // (android-sync-setup) must no longer render inline in Settings.
  describe("Android Sync Wizard relocated to Dashboard (BACKLOG-2320)", () => {
    // SR C6 (founder): no Companion UI at all — no wizard, no Companion panel,
    // no Companion radio; a stored "android-companion" gets Google Messages.
    it("does NOT render the inline guided wizard, or any Companion UI, for an Android user", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: { source: "android-companion" },
        },
      });

      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(await screen.findByTestId("google-messages-settings")).toBeInTheDocument();
      expect(screen.queryByTestId("android-sync-setup")).not.toBeInTheDocument();
      expect(screen.queryByText("Install Keepr Companion")).not.toBeInTheDocument();
      expect(container.querySelector("#settings-android-companion")).not.toBeInTheDocument();
      expect(container.querySelector('input[value="android-companion"]')).not.toBeInTheDocument();
      expect(screen.queryByText(/Android Companion/)).not.toBeInTheDocument();
      // The stored value is shown as Google Messages, and not rewritten.
      expect((container.querySelector('input[value="android-messages-web"]') as HTMLInputElement).checked).toBe(true);
      expect(window.api.preferences.update).not.toHaveBeenCalled();
    });

    it("does NOT render the wizard for a non-Android import source either", async () => {
      // Default test platform is macOS with no saved source → macos-native.
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      expect(screen.queryByTestId("android-sync-setup")).not.toBeInTheDocument();
    });
  });

  // BACKLOG-1937: merged iPhone Sync category + gray-out gating
  describe("iPhone Sync Category (BACKLOG-1937)", () => {
    // BACKLOG-3423: the nav entry is gone for every user on every platform; the
    // SECTION stays on the page, grayed out, so a user can see the feature is
    // there and currently off.
    //
    // The tab and the section <h3> render the SAME literal text, "iPhone Sync",
    // so a bare `getAllByText("iPhone Sync")` cannot tell them apart. The
    // previous assertion here (`.length >= 1`) was measured against the tab
    // deletion and stayed GREEN — it could not see the change at all. Both
    // assertions below are therefore anchored: one inside the tab strip, one
    // inside `#settings-iphone-sync`.
    it("should NOT offer an 'iPhone Sync' nav tab (BACKLOG-3423)", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Anti-vacuity: the strip rendered and has tabs, so a "no iPhone tab"
      // result cannot come from an empty or missing tab bar.
      const tabStrip = screen.getByTestId("settings-tabs");
      expect(within(tabStrip).getAllByRole("tab").length).toBeGreaterThan(0);

      // No iPhone Sync entry among them — checked by testid and by accessible
      // name, scoped to the strip so the section <h3> cannot satisfy either.
      expect(screen.queryByTestId("settings-tab-iphone-sync")).not.toBeInTheDocument();
      expect(
        within(tabStrip).queryByRole("tab", { name: "iPhone Sync" }),
      ).not.toBeInTheDocument();
      // Old standalone "Sync" tab gone as well
      expect(within(tabStrip).queryByRole("tab", { name: "Sync" })).not.toBeInTheDocument();
    });

    // BACKLOG-3156 stage G (founder approved 2026-10-13): the iPhone USB toggle
    // moved into the Messages section's iPhone pane, shown only while iPhone is
    // the selected source. #settings-iphone-sync remains on Windows only, for the
    // Apple driver tools, still grayed out unless the source is iPhone.
    it("macOS: no separate iPhone Sync section; Windows: the section and its heading remain (BACKLOG-3423 / 3156 G)", async () => {
      const first = await renderSettings({ userId: mockUserId, onClose: mockOnClose });
      expect(first.container.querySelector("#settings-iphone-sync")).toBeNull();
      expect(first.container.querySelector("#settings-sync")).toBeNull();
      first.unmount();

      const sys = window.api.system as unknown as { platform: string };
      const before = sys.platform;
      sys.platform = "win32";
      try {
        const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });
        const section = container.querySelector<HTMLElement>("#settings-iphone-sync");
        expect(section).toBeInTheDocument();
        expect(within(section as HTMLElement).getByRole("heading", { name: "iPhone Sync" })).toBeInTheDocument();
        expect(within(section as HTMLElement).getByText(/available when your import source is set to iphone/i)).toBeInTheDocument();
        // The USB toggle is not in this section any more.
        expect(within(section as HTMLElement).queryByRole("switch", { name: /enable iphone sync over usb/i })).toBeNull();
      } finally {
        sys.platform = before;
      }
    });

    it("macOS native selected: no iPhone USB toggle anywhere (it is the iPhone pane's)", async () => {
      // Default test platform is macOS; no saved source → defaults to macos-native
      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });
      await waitFor(() => expect(screen.getByTestId("messages-block-preferences")).toBeInTheDocument());
      expect(container.querySelector("#settings-messages")?.textContent).not.toContain("iPhone Sync (USB)");
      expect(screen.queryByRole("switch", { name: /enable iphone sync over usb/i })).toBeNull();
    });

    it("a stored android-companion (shown as Google Messages): no iPhone USB toggle", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: { source: "android-companion" },
        },
      });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });
      await waitFor(() => expect(screen.getByTestId("google-messages-settings")).toBeInTheDocument());
      expect(screen.queryByRole("switch", { name: /enable iphone sync over usb/i })).toBeNull();
    });

    it("iPhone selected: the enabled USB toggle is in the Messages section's iPhone pane", async () => {
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: { source: "iphone-sync" },
        },
      });

      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const toggle = screen.getByRole("switch", {
          name: /enable iphone sync over usb/i,
        });
        expect(toggle).not.toBeDisabled();
        expect(container.querySelector("#settings-messages")!.contains(toggle)).toBe(true);
      });

      // Hint should NOT be shown when active
      expect(
        screen.queryByText(/available when your import source is set to iphone/i),
      ).not.toBeInTheDocument();
    });
  });

  // BACKLOG-3418 Q3 (founder 2026-10-07, pm_comments 66f5b114): a Windows user
  // who chose no phone and no source sees NO source selected, and the iPhone
  // Sync (USB) toggle stays disabled. Settings, the source radio, the Dashboard
  // button and detection all read one rule (importSourcePolicy
  // `chosenImportSource`, SR C-1). Fixtures: `preferences:get` returns the
  // Supabase `preferences` jsonb (which carries `phone_type`); `user:get-phone-type`
  // returns `{ success, phoneType }` from users_local.
  describe("BACKLOG-3418: the chosen source on Windows (Q3)", () => {
    const checkedSources = (container: HTMLElement) =>
      Array.from(
        container.querySelectorAll<HTMLInputElement>('#settings-messages input[type="radio"]'),
      )
        .filter((r) => r.checked)
        .map((r) => r.value);
    let platformBefore: string;

    beforeEach(() => {
      const sys = window.api.system as unknown as { platform: string };
      platformBefore = sys.platform;
      sys.platform = "win32";
    });
    afterEach(() => {
      (window.api.system as unknown as { platform: string }).platform = platformBefore;
      // window.api is built once per file (tests/setup.js): restore the default.
      jest
        .mocked(window.api.user.getPhoneType)
        .mockResolvedValue({ success: true, phoneType: null } as Awaited<
          ReturnType<typeof window.api.user.getPhoneType>
        >);
    });

    const servePhoneType = (phoneType: "iphone" | "android" | null) =>
      jest
        .mocked(window.api.user.getPhoneType)
        .mockResolvedValue({ success: true, phoneType } as Awaited<
          ReturnType<typeof window.api.user.getPhoneType>
        >);

    it("no source and no phone type: no radio checked, no USB toggle", async () => {
      servePhoneType(null);
      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Barrier: both readers consulted the phone type (the "nothing" is an
      // answer, not a read that has not finished).
      await waitFor(() =>
        expect(jest.mocked(window.api.user.getPhoneType).mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      // Anti-vacuity: the radios rendered (Windows: iPhone Sync + Google Messages).
      await waitFor(() =>
        expect(
          container.querySelectorAll('#settings-messages input[type="radio"]').length,
        ).toBe(2),
      );
      await waitFor(() =>
        expect(screen.queryByText(/available when your import source is set to iphone/i)).toBeInTheDocument(),
      );
      expect(checkedSources(container)).toEqual([]);
      // BACKLOG-3156 stage G: no source chosen → no iPhone pane, so no USB toggle at all.
      expect(screen.queryByRole("switch", { name: /enable iphone sync over usb/i })).toBeNull();
    });

    it.each([
      ["a local iPhone phone type", {}, "iphone" as const],
      ["only a cloud phone_type of iphone", { phone_type: "iphone" }, null],
    ])(
      "no source, %s: iPhone Sync checked and the USB toggle enabled (the 4 production users)",
      async (_label, extra, local) => {
        jest.mocked(window.api.preferences.get).mockResolvedValue({
          success: true,
          preferences: { export: { defaultFormat: "combined-pdf" }, ...extra },
        });
        servePhoneType(local);
        const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

        await waitFor(() => expect(checkedSources(container)).toEqual(["iphone-sync"]));
        await waitFor(() =>
          expect(screen.getByRole("switch", { name: /enable iphone sync over usb/i })).not.toBeDisabled(),
        );
      },
    );

    it("macOS unchanged: no source, no phone type -> macOS Messages checked, no USB toggle", async () => {
      (window.api.system as unknown as { platform: string }).platform = "darwin";
      servePhoneType(null);
      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => expect(checkedSources(container)).toEqual(["macos-native"]));
      expect(screen.queryByRole("switch", { name: /enable iphone sync over usb/i })).toBeNull();
    });
  });

  // BACKLOG-3423: the source radio must re-gate iPhone USB detection live.
  // These render Settings inside the REAL IPhoneSyncProvider — the tests above
  // deliberately do not, and so exercise the provider-less fallback. Without the
  // provider none of this is observable: it owns the enablement and the single
  // `useIPhoneSync` instance that talks to `window.api.sync`.
  describe("iPhone Sync source gate — the Settings wire (BACKLOG-3423)", () => {
    const syncApi = () =>
      (window as unknown as {
        api: { sync: { startDetection: jest.Mock; stopDetection: jest.Mock } };
      }).api.sync;

    beforeEach(() => {
      (window as unknown as { api: Record<string, unknown> }).api.sync = {
        startDetection: jest.fn(),
        stopDetection: jest.fn(),
        getUnifiedStatus: jest
          .fn()
          .mockResolvedValue({ isAnyOperationRunning: false, currentOperation: null }),
        start: jest.fn().mockResolvedValue({ success: true }),
        cancel: jest.fn().mockResolvedValue(undefined),
        onDeviceConnected: jest.fn(() => jest.fn()),
        onDeviceDisconnected: jest.fn(() => jest.fn()),
        onProgress: jest.fn(() => jest.fn()),
        onPasswordRequired: jest.fn(() => jest.fn()),
        onError: jest.fn(() => jest.fn()),
        onComplete: jest.fn(() => jest.fn()),
        onWaitingForPasscode: jest.fn(() => jest.fn()),
        onPasscodeEntered: jest.fn(() => jest.fn()),
        onStorageComplete: jest.fn(() => jest.fn()),
        onStorageError: jest.fn(() => jest.fn()),
      };

      // The founder's stored state on 2026-09-17: the USB opt-in is ON and the
      // source is macOS Messages. Preferences follow the account, which is why a
      // clean QA profile still showed the toggle ON.
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          integrations: { iphoneSyncEnabled: true },
          messages: { source: "macos-native" },
        },
      });
    });

    const renderWithSyncProvider = async () => {
      const result = render(
        <NotificationProvider>
          <PlatformProvider>
            <IPhoneSyncProvider userId={mockUserId}>
              <Settings userId={mockUserId} onClose={mockOnClose} />
            </IPhoneSyncProvider>
          </PlatformProvider>
        </NotificationProvider>,
      );
      await waitFor(() => {
        expect(screen.queryByText("Loading settings...")).not.toBeInTheDocument();
      });
      return result;
    };

    const usbToggle = () =>
      screen.getByRole("switch", { name: /enable iphone sync over usb/i });

    it("starts detection when the source changes to iPhone, and stops it on the way back", async () => {
      await renderWithSyncProvider();

      // macOS Messages + stored ON: nothing may be detecting. BACKLOG-3156
      // stage G: the USB toggle is the iPhone pane's, so it is not on screen.
      await waitFor(() => expect(screen.getByRole("radio", { name: /macOS Messages/i })).toBeChecked());
      expect(screen.queryByRole("switch", { name: /enable iphone sync over usb/i })).toBeNull();
      expect(syncApi().startDetection).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole("radio", { name: /iPhone Sync/i }));

      await waitFor(() => expect(syncApi().startDetection).toHaveBeenCalled());
      expect(usbToggle()).toHaveAttribute("aria-checked", "true");

      await userEvent.click(screen.getByRole("radio", { name: /macOS Messages/i }));

      await waitFor(() => expect(syncApi().stopDetection).toHaveBeenCalled());
      expect(screen.queryByRole("switch", { name: /enable iphone sync over usb/i })).toBeNull();
    });

    it("writes only the source — the stored iPhone-sync opt-in is left alone", async () => {
      await renderWithSyncProvider();

      await userEvent.click(screen.getByRole("radio", { name: /iPhone Sync/i }));
      await userEvent.click(screen.getByRole("radio", { name: /macOS Messages/i }));

      const writtenKeys = jest
        .mocked(window.api.preferences.update)
        .mock.calls.flatMap((call) => Object.keys(call[1] ?? {}));
      expect(writtenKeys).toContain("messages");
      expect(writtenKeys).not.toContain("integrations");
    });
  });

  // TASK-2056: Offline action blocking tests
  describe("Offline Action Blocking (TASK-2056)", () => {
    beforeEach(() => {
      // Set network to offline
      mockUseNetwork.mockReturnValue({
        isOnline: false,
        isChecking: false,
        lastOnlineAt: null,
        lastOfflineAt: new Date(),
        connectionError: null,
        checkConnection: jest.fn().mockResolvedValue(false),
        clearError: jest.fn(),
        setConnectionError: jest.fn(),
      });
    });

    afterEach(() => {
      // Reset to online
      mockUseNetwork.mockReturnValue({
        isOnline: true,
        isChecking: false,
        lastOnlineAt: new Date(),
        lastOfflineAt: null,
        connectionError: null,
        checkConnection: jest.fn().mockResolvedValue(true),
        clearError: jest.fn(),
        setConnectionError: jest.fn(),
      });
    });

    it("should disable Check for Updates button when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const checkButton = screen.getByRole("button", { name: /check for updates/i });
        expect(checkButton).toBeDisabled();
      });
    });

    it("should show 'You are offline' tooltip on Check for Updates when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const checkButton = screen.getByRole("button", { name: /check for updates/i });
        expect(checkButton).toHaveAttribute("title", "You are offline");
      });
    });

    it("should disable Sign Out All Devices button when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const signOutButton = screen.getByRole("button", { name: /sign out all devices/i });
        expect(signOutButton).toBeDisabled();
      });
    });

    it("should show 'You are offline' tooltip on Sign Out All Devices when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const signOutButton = screen.getByRole("button", { name: /sign out all devices/i });
        expect(signOutButton).toHaveAttribute("title", "You are offline");
      });
    });

    it("should disable Connect Gmail button when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const connectButton = screen.getByRole("button", { name: /connect gmail/i });
        expect(connectButton).toBeDisabled();
        expect(connectButton).toHaveAttribute("title", "You are offline");
      });
    });

    it("should disable Connect Outlook button when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      await waitFor(() => {
        const connectButton = screen.getByRole("button", { name: /connect outlook/i });
        expect(connectButton).toBeDisabled();
        expect(connectButton).toHaveAttribute("title", "You are offline");
      });
    });

    it("should re-enable buttons when back online", async () => {
      const { rerender } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Verify buttons are disabled
      await waitFor(() => {
        const checkButton = screen.getByRole("button", { name: /check for updates/i });
        expect(checkButton).toBeDisabled();
      });

      // Go back online
      mockUseNetwork.mockReturnValue({
        isOnline: true,
        isChecking: false,
        lastOnlineAt: new Date(),
        lastOfflineAt: null,
        connectionError: null,
        checkConnection: jest.fn().mockResolvedValue(true),
        clearError: jest.fn(),
        setConnectionError: jest.fn(),
      });

      rerender(
        <NotificationProvider>
          <PlatformProvider>
            <Settings userId={mockUserId} onClose={mockOnClose} />
          </PlatformProvider>
        </NotificationProvider>
      );

      await waitFor(() => {
        const checkButton = screen.getByRole("button", { name: /check for updates/i });
        expect(checkButton).not.toBeDisabled();
        expect(checkButton).not.toHaveAttribute("title", "You are offline");
      });
    });

    it("should keep local-only operations enabled when offline", async () => {
      await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Reindex is a local-only operation, should remain enabled
      await waitFor(() => {
        const reindexButton = screen.getByText("Reindex Database").closest("button");
        expect(reindexButton).not.toBeDisabled();
      });

      // Done button should remain enabled
      const doneButton = screen.getByRole("button", { name: /done/i });
      expect(doneButton).not.toBeDisabled();
    });
  });

  /**
   * BACKLOG-3892 S3 — C1 + C4. ONE "How far back to import texts" picker under
   * the source selection, for every source on Mac AND Windows, outside the
   * per-source panels. The likely wrong build is mounting it inside the macOS
   * panel, which renders nothing off a Mac (`if (!isMacOS) return null`) — so the
   * Windows rows are the ones that matter. Each row: the picker is present once,
   * is the deep-link target (#settings-texts-lookback, C4), and saves
   * `messageImport.filters.lookbackMonths` — the key all three sources read.
   */
  describe("BACKLOG-3892 S3: the shared texts lookback picker (C1, C4)", () => {
    let platformBefore: string;
    beforeEach(() => {
      platformBefore = (window.api.system as unknown as { platform: string }).platform;
    });
    afterEach(() => {
      (window.api.system as unknown as { platform: string }).platform = platformBefore;
    });

    /**
     * BACKLOG-3156 stage F: the iPhone picker sits in a different section from
     * the Messages panels, and must still share their ONE value. Observable
     * through the (greyed) macOS panel, which re-reads its effective window
     * once per save that lands on the shared value. A second, private copy of
     * the value under the iPhone section would save the same key but never
     * tell the macOS panel.
     */
    // BACKLOG-3156 stage G: the macOS panel is not mounted while iPhone is the
    // source (one pane per source); the shared value reaches it when the user
    // switches back.
    it("darwin, source iphone-sync: a change in the iPhone picker reaches the macOS pane", async () => {
      (window.api.system as unknown as { platform: string }).platform = "darwin";
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: { source: "iphone-sync" },
          messageImport: { filters: { lookbackMonths: 6 } },
        },
      });
      jest.mocked(window.api.preferences.update).mockResolvedValue({ success: true });

      await renderSettings({ userId: mockUserId, onClose: mockOnClose });
      const block = await screen.findByTestId("iphone-block-preferences");
      expect(screen.queryByTestId("macos-messages-import")).toBeNull();
      const select = await within(block).findByRole("combobox", { name: "Import messages from" });
      await waitFor(() => expect(select).not.toBeDisabled());

      await userEvent.selectOptions(select, "3");
      await waitFor(() =>
        expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
          messageImport: { filters: { lookbackMonths: 3 } },
        }),
      );
      await userEvent.click(screen.getByRole("radio", { name: /macOS Messages/i }));
      const macBlock = await screen.findByTestId("messages-block-preferences");
      const macSelect = await within(macBlock).findByRole("combobox", { name: "Import messages from" });
      await waitFor(() => expect((macSelect as HTMLSelectElement).value).toBe("3"));
    });

    /**
     * BACKLOG-3156 stage F: the picker is a row of the LIVE source panel's
     * Import Preferences — macOS Messages (Mac), Google Messages, iPhone. Only
     * with no such panel (Windows with no source, or a stored macos-native off
     * a Mac, which `isKnownImportSource` lets through and the macOS panel
     * renders nothing for) is it the standalone card. Counted across the WHOLE
     * page, because the iPhone panel is a separate section.
     */
    it.each([
      ["darwin", "macos-native", "messages-block-preferences"],
      ["darwin", "iphone-sync", "iphone-block-preferences"],
      ["darwin", "android-messages-web", "gm-block-preferences"],
      ["win32", "iphone-sync", "iphone-block-preferences"],
      ["win32", "android-messages-web", "gm-block-preferences"],
      ["win32", "macos-native", null],
      ["win32", undefined, null],
    ])("%s, source %s: one picker, in %s, saving messageImport.filters", async (platform, source, home) => {
      (window.api.system as unknown as { platform: string }).platform = platform;
      jest.mocked(window.api.preferences.get).mockResolvedValue({
        success: true,
        preferences: {
          export: { defaultFormat: "combined-pdf" },
          messages: source ? { source } : {},
          messageImport: { filters: { lookbackMonths: 6 } },
        },
      });

      const { container } = await renderSettings({ userId: mockUserId, onClose: mockOnClose });

      // Anti-vacuity: the per-source branch for THIS source rendered.
      if (source === "android-messages-web") {
        expect(await screen.findByTestId("google-messages-settings")).toBeInTheDocument();
      }
      if (home !== null) {
        await screen.findByTestId(home);
        await waitFor(() =>
          expect(within(screen.getByTestId(home)).queryByTestId("texts-lookback")).not.toBeNull(),
        );
      }
      const target = container.querySelector<HTMLElement>("#settings-texts-lookback");
      expect(target).not.toBeNull();

      // Exactly one months picker on the whole page.
      expect(within(container).getAllByRole("combobox", { name: "Import messages from" })).toHaveLength(1);
      expect(container.querySelectorAll("#settings-texts-lookback")).toHaveLength(1);

      // Where it is: inside the owning Import Preferences block, or standalone.
      const blocks = [
        "messages-block-preferences",
        "gm-block-preferences",
        "iphone-block-preferences",
      ].filter((id) => screen.queryByTestId(id)?.contains(target!));
      expect(`picker inside: ${JSON.stringify(blocks)}`).toBe(
        `picker inside: ${JSON.stringify(home === null ? [] : [home])}`,
      );
      if (home === null) {
        expect(within(target!).getByText("How far back to import texts")).toBeInTheDocument();
        expect(container.querySelector("#settings-messages")!.contains(target!)).toBe(true);
      } else {
        expect(within(target!).queryByText("How far back to import texts")).toBeNull();
      }
      if (home === "messages-block-preferences") {
        const prefs = screen.getByTestId(home);
        const maxRow = within(prefs).getByText("Maximum messages").parentElement!;
        expect(`picker is the row right after Maximum messages: ${maxRow.nextElementSibling === target}`).toBe(
          "picker is the row right after Maximum messages: true",
        );
      }

      // BACKLOG-3156 stage F sweep: every setting control in the Messages and
      // iPhone Sync sections sits in a block card that opens with one of the
      // three block labels — so a panel added later cannot put its settings
      // outside the shape without this going red. The one exception is the
      // standalone picker card, which exists only when no source panel can
      // host the picker (asserted above), and is named by its id.
      const BLOCK_LABELS = ["Sources", "Import Preferences", "Stored on this computer"];
      const isLabelledBlock = (el: Element) =>
        el.tagName === "DIV" &&
        /(^|\s)rounded-lg(\s|$)/.test(el.className) &&
        /(^|\s)border(\s|$)/.test(el.className) &&
        (el.firstElementChild?.matches("p.text-xs.font-medium.text-gray-500.uppercase.tracking-wide") ?? false) &&
        BLOCK_LABELS.includes((el.firstElementChild?.textContent ?? "").trim());
      const controlsOutsideBlocks = ["#settings-messages", "#settings-iphone-sync"]
        // BACKLOG-3156 stage G: #settings-iphone-sync is Windows-only now (driver tools).
        .flatMap((sel) => {
          const section = container.querySelector(sel);
          return section
            ? Array.from(
                section.querySelectorAll("select, textarea, input:not([type=hidden]), [role=switch], [role=checkbox], [role=radio], button[aria-pressed]"),
              )
            : [];
        })
        .filter((control) => {
          if (home === null && target!.contains(control)) return false;
          const want = control.matches("input[type=radio], [role=radio]") ? "Sources" : "Import Preferences";
          for (let node = control.parentElement; node; node = node.parentElement) {
            if (isLabelledBlock(node)) return (node.firstElementChild?.textContent ?? "").trim() !== want;
          }
          return true;
        })
        .map((control) => control.getAttribute("aria-label") ?? control.getAttribute("data-testid") ?? control.outerHTML.slice(0, 60));
      expect(`setting controls outside a labelled block: ${JSON.stringify(controlsOutsideBlocks)}`).toBe(
        "setting controls outside a labelled block: []",
      );

      const select = within(target!).getByRole("combobox", { name: "Import messages from" }) as HTMLSelectElement;
      await waitFor(() => expect(select).not.toBeDisabled());
      expect(select.value).toBe("6");

      await userEvent.selectOptions(select, "3");
      await waitFor(() =>
        expect(window.api.preferences.update).toHaveBeenCalledWith(mockUserId, {
          messageImport: { filters: { lookbackMonths: 3 } },
        }),
      );
      expect(select.value).toBe("3");
    });
  });
});
