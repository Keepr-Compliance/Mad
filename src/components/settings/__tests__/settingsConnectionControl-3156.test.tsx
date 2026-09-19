/**
 * BACKLOG-3156 stage C — ONE CONNECTION CONTROL, AND DISCONNECT BEHIND A DOOR.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS FOR
 * ===========================================================================
 * Two of the three claims this change makes are claims a screenshot would
 * satisfy and a reader could not check:
 *
 *   1. "The green state is a LABEL — it does not disconnect you."
 *   2. "The confirmation says the connection feeds Contacts as well as Emails,
 *      and that nothing already stored is thrown away."
 *
 * The first is only true if the element is not a button AND clicking it calls
 * nothing; asserting either half alone passes on a mistake (a `<span>` inside a
 * `<button>` is not a button and still disconnects you). The second is a
 * sentence about what a destructive action does, and this panel's sibling has
 * shipped two of those that were false — BACKLOG-3029, and BACKLOG-3161 on
 * this very item. So the copy is pinned as CLAIMS: the two subjects must be
 * named, the keeping must be stated, and a set of loss-words must be absent.
 *
 * ===========================================================================
 * WHAT THE COPY IS CHECKED AGAINST
 * ===========================================================================
 * `handleDisconnectMailbox` (electron/handlers/sharedAuthHandlers.ts) resolves
 * the user and calls `deleteOAuthToken(userId, provider, "mailbox")` — one
 * `DELETE FROM oauth_tokens`. Nothing else on that path writes, and no listener
 * of `${provider}:mailbox-disconnected` deletes anything. Contact import reads
 * the SAME row: `GoogleContactProvider.canSync` calls `getOAuthToken(userId,
 * 'google', 'mailbox')`, and `OutlookContactProvider.canSync` reaches
 * `getOAuthToken(userId, "microsoft", "mailbox")` through
 * `outlookFetchService.initialize`.
 *
 * `auth-handlers.test.ts` holds the other half of that check — that the
 * disconnect handler performs exactly one database mutation — because a
 * renderer test cannot see the main process.
 *
 * ===========================================================================
 * MUTATIONS (each planted against the committed tree, confirmed red BY NAME,
 * then reverted)
 * ===========================================================================
 *   1. Wrap the "Connected" label in `<button onClick={onRequestDisconnect}>`
 *   2. Render the Disconnect item inline instead of inside the menu
 *   3. Wire the menu item straight to `handleDisconnectGoogle`
 *   4. Put the dot AFTER its label
 *   5. Restore an over-claim: "This deletes the emails stored on this computer"
 *   6. Drop the word "Contacts" from the scope sentence
 *  12. Make the menu's outside-press handler a no-op
 *  13. Drop the Escape `keydown` listener
 *  14. Make the trigger `setOpen(true)` instead of toggling
 *  15. Remove `close()` from the menu item's `onClick`
 *
 * Two more, run against the files this suite does not render, are recorded
 * where they belong: `contactsStoredNeutral-3156` (7-9) and
 * `auth-handlers.test.ts`, whose control adds a SECOND database write to the
 * disconnect handler and reds the "exactly twice" assertion.
 */

import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EmailSettings } from "../EmailSettings";

jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: mockIsOnline,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

let mockIsOnline = true;

const authService = {
  googleConnectMailbox: jest.fn(),
  microsoftConnectMailbox: jest.fn(),
  googleDisconnectMailbox: jest.fn(),
  microsoftDisconnectMailbox: jest.fn(),
  onMailboxConnected: jest.fn(() => () => {}),
};

jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: jest.fn().mockResolvedValue({ success: true, data: {} }),
    updatePreferences: jest.fn().mockResolvedValue({ success: true }),
  },
  get authService() {
    return authService;
  },
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const originalApi = window.api;

type ProviderState = {
  connected: boolean;
  email?: string;
  error?: { type: string; userMessage?: string; action?: string };
};

function setConnections(google: ProviderState, microsoft: ProviderState): void {
  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: {
        ...originalApi?.system,
        checkAllConnections: jest
          .fn()
          .mockResolvedValue({ success: true, google, microsoft }),
      },
      transactions: {
        precacheEmails: jest.fn(),
        cancelPrecacheEmails: jest.fn(),
        onPrecacheProgress: () => () => {},
      },
    },
    writable: true,
    configurable: true,
  });
}

const NOT_CONNECTED: ProviderState = { connected: false };

async function renderEmails(): Promise<void> {
  render(<EmailSettings userId="u" initialPreferences={undefined as never} />);
  await waitFor(() =>
    expect(screen.getByTestId("emails-block-sources")).toBeInTheDocument(),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsOnline = true;
  authService.googleDisconnectMailbox.mockResolvedValue({ success: true });
  authService.microsoftDisconnectMailbox.mockResolvedValue({ success: true });
  setConnections(NOT_CONNECTED, NOT_CONNECTED);
});

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
});

describe("BACKLOG-3156 stage C — the connected row", () => {
  beforeEach(() => {
    setConnections({ connected: true, email: "gmail-user@example.com" }, NOT_CONNECTED);
  });

  /**
   * The founder's one correction to the approved mockup, which drew the dot on
   * the right. Document order, not a class name, because a class could be
   * present on an element rendered second.
   */
  it("puts the status dot to the LEFT of the word it describes", async () => {
    await renderEmails();
    await screen.findByTestId("email-connection-google-status");

    const dot = screen.getByTestId("email-connection-google-dot");
    const label = screen.getByTestId("email-connection-google-status");
    expect(label).toHaveTextContent("Connected");
    expect(
      `dot then label: ${(dot.compareDocumentPosition(label) & 4) !== 0}`,
    ).toBe("dot then label: true");
  });

  /**
   * BOTH halves. A `<span>` nested inside a `<button>` satisfies the tagName
   * check on its own and still signs you out when tapped, which is the exact
   * accident the design rejected the hover-swap to avoid.
   */
  it("makes Connected inert — it is not a button, and clicking it disconnects nothing", async () => {
    await renderEmails();
    const label = await screen.findByTestId("email-connection-google-status");

    expect(label.tagName).not.toBe("BUTTON");
    expect(label.getAttribute("role")).not.toBe("button");
    expect(label.closest("button")).toBeNull();

    await userEvent.click(label);
    expect(authService.googleDisconnectMailbox).not.toHaveBeenCalled();
  });

  it("keeps Disconnect off the resting page and reachable from the row's menu", async () => {
    await renderEmails();
    await screen.findByTestId("email-connection-google-status");

    expect(
      screen.queryByRole("menuitem", { name: /disconnect gmail/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /disconnect gmail/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("email-connection-google-trigger"));

    expect(
      screen.getByRole("menuitem", { name: /disconnect gmail/i }),
    ).toBeInTheDocument();
  });

  /**
   * The four ways the menu closes, each asserted, because the component's own
   * header names all four and a comment may state intent but must not
   * guarantee behaviour. Written as four cases rather than one so a failure
   * names WHICH route stopped working.
   */
  it("closes the menu when a press lands outside it", async () => {
    await renderEmails();
    await screen.findByTestId("email-connection-google-status");

    await userEvent.click(screen.getByTestId("email-connection-google-trigger"));
    expect(screen.getByTestId("email-connection-google-menu")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(
      screen.queryByTestId("email-connection-google-menu"),
    ).not.toBeInTheDocument();
  });

  it("closes the menu on Escape", async () => {
    await renderEmails();
    await screen.findByTestId("email-connection-google-status");

    await userEvent.click(screen.getByTestId("email-connection-google-trigger"));
    expect(screen.getByTestId("email-connection-google-menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(
      screen.queryByTestId("email-connection-google-menu"),
    ).not.toBeInTheDocument();
  });

  it("closes the menu when the trigger is pressed a second time", async () => {
    await renderEmails();
    await screen.findByTestId("email-connection-google-status");

    const trigger = screen.getByTestId("email-connection-google-trigger");
    await userEvent.click(trigger);
    expect(screen.getByTestId("email-connection-google-menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(trigger);

    expect(
      screen.queryByTestId("email-connection-google-menu"),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * Asserted on the MENU, not on the dialog: the confirmation appearing proves
   * the item fired, and says nothing about whether the menu is still sitting
   * open behind it.
   */
  it("closes the menu when its item is chosen", async () => {
    await renderEmails();
    await screen.findByTestId("email-connection-google-status");

    await userEvent.click(screen.getByTestId("email-connection-google-trigger"));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /disconnect gmail/i }),
    );

    expect(
      screen.queryByTestId("email-connection-google-menu"),
    ).not.toBeInTheDocument();
  });

  /**
   * BACKLOG-2142 listed `isOnline` among the branches this redesign had to keep
   * alive. The tooltip moved from the full-width button to the menu item.
   */
  it("disables the Disconnect item while offline, and says why", async () => {
    mockIsOnline = false;
    await renderEmails();
    await screen.findByTestId("email-connection-google-status");

    await userEvent.click(screen.getByTestId("email-connection-google-trigger"));

    const item = screen.getByRole("menuitem", { name: /disconnect gmail/i });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "You are offline");
  });
});

describe("BACKLOG-3156 stage C — the confirmation gates the disconnect", () => {
  beforeEach(() => {
    setConnections({ connected: true, email: "gmail-user@example.com" }, NOT_CONNECTED);
  });

  async function openDisconnect(): Promise<void> {
    await renderEmails();
    await screen.findByTestId("email-connection-google-status");
    await userEvent.click(screen.getByTestId("email-connection-google-trigger"));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /disconnect gmail/i }),
    );
  }

  it("calls nothing when the item is chosen, and nothing when it is cancelled", async () => {
    await openDisconnect();

    expect(screen.getByTestId("disconnect-confirm-modal")).toBeInTheDocument();
    expect(authService.googleDisconnectMailbox).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("disconnect-cancel"));

    expect(
      screen.queryByTestId("disconnect-confirm-modal"),
    ).not.toBeInTheDocument();
    expect(authService.googleDisconnectMailbox).not.toHaveBeenCalled();
  });

  it("calls the disconnect exactly once when it is confirmed", async () => {
    await openDisconnect();
    await userEvent.click(screen.getByTestId("disconnect-confirm"));

    expect(authService.googleDisconnectMailbox).toHaveBeenCalledTimes(1);
    expect(authService.googleDisconnectMailbox).toHaveBeenCalledWith("u");
    expect(authService.microsoftDisconnectMailbox).not.toHaveBeenCalled();
  });

  it("routes Outlook's menu to Outlook's disconnect", async () => {
    setConnections(NOT_CONNECTED, { connected: true, email: "outlook-user@example.com" });
    await renderEmails();
    await screen.findByTestId("email-connection-microsoft-status");

    await userEvent.click(
      screen.getByTestId("email-connection-microsoft-trigger"),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /disconnect outlook/i }),
    );
    await userEvent.click(screen.getByTestId("disconnect-confirm"));

    expect(authService.microsoftDisconnectMailbox).toHaveBeenCalledTimes(1);
    expect(authService.googleDisconnectMailbox).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3156 stage C — what the confirmation claims", () => {
  beforeEach(() => {
    setConnections({ connected: true, email: "gmail-user@example.com" }, NOT_CONNECTED);
  });

  async function readCopy(): Promise<{ scope: HTMLElement; kept: HTMLElement }> {
    await renderEmails();
    await screen.findByTestId("email-connection-google-status");
    await userEvent.click(screen.getByTestId("email-connection-google-trigger"));
    await userEvent.click(
      screen.getByRole("menuitem", { name: /disconnect gmail/i }),
    );
    return {
      scope: screen.getByTestId("disconnect-confirm-scope"),
      kept: screen.getByTestId("disconnect-confirm-kept"),
    };
  }

  /**
   * The reason this item lists the shared connection as its one substantive
   * requirement: one account feeds two sections, and the old Disconnect said so
   * nowhere — it had no confirmation at all.
   */
  it("names BOTH things the connection feeds", async () => {
    const { scope } = await readCopy();

    expect(scope).toHaveTextContent(/emails/i);
    expect(scope).toHaveTextContent(/contacts/i);
    // …and says the disconnect reaches both, not merely that both exist.
    expect(scope).toHaveTextContent(/stops both/i);
  });

  it("says what survives", async () => {
    const { kept } = await readCopy();

    expect(kept).toHaveTextContent(/already stored on this computer/i);
    expect(kept).toHaveTextContent(/\bkept\b/i);
  });

  /**
   * THE ABSENCE HALF, and the half that matters.
   *
   * The disconnect deletes one row from `oauth_tokens` and nothing else, so any
   * word implying stored data goes away would be false — the BACKLOG-3029 and
   * BACKLOG-3161 shape, in the direction of over-warning. A presence check
   * alone would pass on a dialog that ALSO said "this deletes your emails".
   */
  it("claims no loss, because the code causes none", async () => {
    const { scope, kept } = await readCopy();
    const copy = `${scope.textContent ?? ""} ${kept.textContent ?? ""}`;

    for (const forbidden of [
      /delet/i,
      /\berase/i,
      /\bremov/i,
      /\bwipe/i,
      /\bclear(s|ed|ing)?\b/i,
      /\blos[et]\b/i,
      /permanent/i,
      /unlink/i,
    ]) {
      expect(`${forbidden} in copy: ${forbidden.test(copy)}`).toBe(
        `${forbidden} in copy: false`,
      );
    }
  });

  it("names the account it is about", async () => {
    await readCopy();
    expect(
      screen.getByRole("heading", { name: "Disconnect Gmail?" }),
    ).toBeInTheDocument();
  });
});

describe("BACKLOG-3156 stage C — the five states of one control", () => {
  it("not connected: offers Connect, and prints no separate status word", async () => {
    setConnections(NOT_CONNECTED, NOT_CONNECTED);
    await renderEmails();

    expect(
      await screen.findByRole("button", { name: "Connect Gmail" }),
    ).toBeInTheDocument();
    // The pill this control replaced is gone rather than sitting beside it.
    expect(screen.queryByText("Not Connected")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /reconnect gmail/i }),
    ).not.toBeInTheDocument();
  });

  it("connecting: the same control reads Connecting… and is disabled", async () => {
    setConnections(NOT_CONNECTED, NOT_CONNECTED);
    // Never resolves: the control must show the in-flight state, not flicker
    // through it.
    authService.googleConnectMailbox.mockReturnValue(new Promise(() => {}));
    await renderEmails();

    await userEvent.click(
      await screen.findByRole("button", { name: "Connect Gmail" }),
    );

    const control = screen.getByTestId("email-connection-google-connect");
    expect(control).toHaveTextContent("Connecting...");
    expect(control).toBeDisabled();
  });

  /**
   * BACKLOG-3281 (C3b) — and it must come BACK out of "Connecting...".
   *
   * The test directly above proves the in-flight state exists. It cannot prove
   * the state ever ends, because its mock never resolves. When the pre-flight
   * IPC call resolves `success: false`, `authService.onMailboxConnected` is
   * never called, so no mailbox-connected event will ever arrive to clear the
   * flag — and there is no `finally`. Before the `else` this asserts, the
   * control stayed disabled and reading "Connecting..." until the window was
   * reloaded.
   *
   * Asserted for BOTH providers: the two handlers are separate code paths with
   * the same defect, and a fix applied to one reads as a fix to both.
   *
   * MUTATION (each, separately): delete the
   * `} else { setConnectingProvider(null); }` block from the matching handler
   * in EmailSettings.tsx -> this test goes red on "Connecting..." / disabled.
   */
  it.each([
    ["google", "googleConnectMailbox", "Connect Gmail", "email-connection-google-connect"],
    [
      "microsoft",
      "microsoftConnectMailbox",
      "Connect Outlook",
      "email-connection-microsoft-connect",
    ],
  ] as const)(
    "%s: a pre-flight failure returns the control to %s, enabled",
    async (_provider, method, label, testId) => {
      setConnections(NOT_CONNECTED, NOT_CONNECTED);
      authService[method].mockResolvedValue({
        success: false,
        error: "No valid user session",
      });
      await renderEmails();

      await userEvent.click(await screen.findByRole("button", { name: label }));

      await waitFor(() => {
        expect(screen.getByTestId(testId)).not.toHaveTextContent("Connecting...");
      });
      const control = screen.getByTestId(testId);
      expect(control).toHaveTextContent(label);
      expect(control).toBeEnabled();
      // The pre-flight failed, so no listener was ever registered: nothing else
      // could have cleared the state.
      expect(authService.onMailboxConnected).not.toHaveBeenCalled();
    },
  );

  it("connected: a label, not a button", async () => {
    setConnections({ connected: true, email: "gmail-user@example.com" }, NOT_CONNECTED);
    await renderEmails();

    expect(
      await screen.findByTestId("email-connection-google-status"),
    ).toHaveTextContent("Connected");
    expect(
      screen.queryByRole("button", { name: /connect gmail/i }),
    ).not.toBeInTheDocument();
  });

  /**
   * BACKLOG-2142 drew a line between "never linked", "session expired" and
   * "erroring". The merged control reads `Reconnect` in the two broken states
   * and `Connect` in the never-linked one, so the FIRST distinction survives in
   * the control itself. The distinction BETWEEN the two broken states moved
   * entirely to the provider's own message, which is asserted here rather than
   * assumed — dropping the "Session Expired" / "Connection Issue" pills would
   * otherwise have quietly cost the difference.
   */
  it("session expired: offers Reconnect, and the provider's own wording is what distinguishes it", async () => {
    setConnections(
      {
        connected: false,
        email: "gmail-user@example.com",
        error: {
          type: "TOKEN_REFRESH_FAILED",
          userMessage: "Your Gmail connection expired. Reconnect to keep capturing email.",
          action: "Reconnect",
        },
      },
      NOT_CONNECTED,
    );
    await renderEmails();

    expect(
      await screen.findByRole("button", { name: "Reconnect Gmail" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Gmail" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Your Gmail connection expired. Reconnect to keep capturing email.",
      ),
    ).toBeInTheDocument();
  });

  it("connection issue: also Reconnect, and also carries its own message", async () => {
    setConnections(NOT_CONNECTED, {
      connected: false,
      email: "outlook-user@example.com",
      error: {
        type: "CONNECTION_CHECK_FAILED",
        userMessage: "Could not verify Outlook connection",
        action: "Check your Outlook connection",
      },
    });
    await renderEmails();

    expect(
      await screen.findByRole("button", { name: "Reconnect Outlook" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Could not verify Outlook connection"),
    ).toBeInTheDocument();
  });

  /**
   * A never-connected provider reports `NOT_CONNECTED` as an ERROR type, and
   * treating that as a broken connection would offer Reconnect to someone who
   * has never connected. That branch is easy to lose in a rewrite, so it is
   * asserted separately from the plain not-connected case above.
   */
  it("NOT_CONNECTED is not a broken connection: Connect, never Reconnect", async () => {
    setConnections(
      {
        connected: false,
        error: { type: "NOT_CONNECTED", userMessage: "Gmail is not connected" },
      },
      NOT_CONNECTED,
    );
    await renderEmails();

    expect(
      await screen.findByRole("button", { name: "Connect Gmail" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /reconnect gmail/i }),
    ).not.toBeInTheDocument();
  });
});
