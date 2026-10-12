/**
 * BACKLOG-3910a — C10 (SR S7) and the UI half of C8.
 *
 * Force Re-cache no longer unlinks anything: emails tied to a deal are kept,
 * updated in place on an open deal, left alone on a submitted or approved one.
 * Every surface that described the old rule is pinned here, each with a
 * POSITIVE claim (what it must now say) and a NEGATIVE one ("unlink" claimed as
 * an effect is absent):
 *
 *   dialog body · confirm button · `?` popover · window line · result line
 *
 * plus the not-applied result (a connected mailbox did not finish, nothing was
 * changed) for both next steps: token expired -> reconnect, otherwise retry.
 *
 * Harness copied from EmailSettings.forceChecklistCopy-3476.test.tsx.
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EmailSettings } from "../EmailSettings";

jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({ isOnline: true }),
}));

jest.mock("../../../services", () => ({
  settingsService: { updatePreferences: jest.fn().mockResolvedValue({ success: true }) },
  authService: {
    googleConnectMailbox: jest.fn(),
    microsoftConnectMailbox: jest.fn(),
    googleDisconnectMailbox: jest.fn(),
    microsoftDisconnectMailbox: jest.fn(),
    onMailboxConnected: jest.fn(() => () => {}),
  },
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrecacheEmails = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { api: unknown }).api = {
    system: {
      checkAllConnections: jest.fn().mockResolvedValue({
        success: true,
        google: { connected: true, email: "me@example.com" },
        microsoft: { connected: false },
      }),
    },
    transactions: {
      precacheEmails: (...a: unknown[]) => mockPrecacheEmails(...a),
      cancelPrecacheEmails: jest.fn().mockResolvedValue({ success: true }),
      onPrecacheProgress: () => () => {},
    },
  };
});

/** "unlink" stated as something the run does — the claim that is now false. */
const UNLINK_CLAIM = /\bunlinks?\b(?! *is\b)|\bunlinked from\b|re-attach/i;
const flat = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

async function openDialog() {
  const user = userEvent.setup();
  render(<EmailSettings userId="user-1" initialPreferences={undefined as never} />);
  await waitFor(() => expect(screen.getByTestId("force-recache-emails")).toBeInTheDocument());
  await user.click(screen.getByTestId("force-recache-emails"));
  await screen.findByTestId("force-recache-confirm");
  return user;
}

async function runForce(result: unknown): Promise<HTMLElement> {
  mockPrecacheEmails.mockResolvedValue(result);
  const user = await openDialog();
  await user.click(screen.getByTestId("force-recache-confirm"));
  return screen.findByTestId("recache-result");
}

describe("BACKLOG-3910a C10 — Force Re-cache copy says attached emails are kept", () => {
  it("dialog body: kept, updated, locked untouched, Needs Review not kept; no unlink claim", async () => {
    await openDialog();
    const body = flat(screen.getByTestId("force-recache-dialog-body"));

    expect(body).toContain(
      "Emails attached to a deal or a checklist item, and suggestions you rejected, are kept — nothing is unlinked.",
    );
    expect(body).toContain("Kept emails on open deals are updated from the new download when it includes them.");
    expect(body).toContain("Emails on a deal that has been submitted or approved are left exactly as they are.");
    expect(body).toContain(
      "An email that is only waiting in Needs Review is not kept: it is downloaded again if it is within your Email History and its mailbox is connected, and its suggestion is cleared.",
    );
    expect(body).toContain(
      "Emails from a mailbox that is no longer connected are removed, apart from the kept emails described above.",
    );
    // Negative: the old rule's claims are gone.
    expect(body).not.toMatch(UNLINK_CLAIM);
    expect(body).not.toMatch(/review decisions/i);
    expect(body).not.toMatch(/removed too/i);
  });

  it("confirm button reads Re-cache, not Re-cache & unlink", async () => {
    await openDialog();
    const button = screen.getByTestId("force-recache-confirm");

    expect(flat(button)).toBe("Re-cache");
    expect(flat(button)).not.toMatch(/unlink/i);
  });

  it("window line: older emails are removed unless they are attached to a deal", async () => {
    await openDialog();
    const line = flat(screen.getByTestId("force-window-line"));

    expect(line).toBe(
      "Keeps emails from the last 1.5 months; older emails are removed from this computer unless they are attached to a deal.",
    );
    expect(line).not.toMatch(/unlink/i);
  });

  it("popover: attached emails stay attached; no unlink claim", async () => {
    render(<EmailSettings userId="user-1" initialPreferences={undefined as never} />);
    fireEvent.mouseDown(await screen.findByTestId("emails-import-info-button"));
    const force = flat(await screen.findByTestId("force-recache-description"));

    expect(force).toBe(
      "Re-downloads every email in your cache window and removes the rest. Emails attached to deals stay attached. Use after a fix to email importing.",
    );
    expect(force).not.toMatch(/unlink/i);
    expect(force).not.toMatch(/review decisions/i);
  });

  it("result line: counts re-cached, updated in place and locked; no unlink claim", async () => {
    const strip = await runForce({
      success: true,
      emailsFetched: 50,
      emailsStored: 50,
      forceSwap: {
        emailsDeleted: 45,
        emailsInserted: 40,
        emailsRefreshed: 7,
        emailsKeptLocked: 3,
        emailsKeptNoCopy: 2,
        participantsInserted: 94,
        providers: ["gmail"],
      },
    });
    const text = flat(strip);

    expect(text).toContain(
      "Re-cached 47 emails. 7 of them were updated in place and kept their links. 3 emails on submitted or approved deals were left unchanged.",
    );
    expect(text).not.toMatch(/unlink/i);
  });
});

describe("BACKLOG-3910a C8 (UI) — a mailbox that did not finish: nothing changed, and the next step", () => {
  it("token expired: names the mailbox and says to reconnect", async () => {
    const strip = await runForce({
      success: false,
      error: "Re-cache could not finish for me@example.com. Nothing was changed.",
      forceNotApplied: {
        mailboxes: [{ provider: "gmail", mailbox: "me@example.com", tokenExpired: true }],
      },
    });
    const text = flat(strip);

    expect(text).toContain(
      "Re-cache could not finish for me@example.com. Nothing was changed. Reconnect me@example.com in Settings, then run Re-cache again.",
    );
    expect(text).not.toMatch(/check your connection/i);
    expect(text).not.toMatch(/unlink/i);
  });

  it("not expired: names the mailbox and says to check the connection", async () => {
    const strip = await runForce({
      success: false,
      error: "Re-cache could not finish for me@example.com. Nothing was changed.",
      forceNotApplied: {
        mailboxes: [{ provider: "gmail", mailbox: "me@example.com", tokenExpired: false }],
      },
    });
    const text = flat(strip);

    expect(text).toContain(
      "Re-cache could not finish for me@example.com. Nothing was changed. Check your connection and try again.",
    );
    expect(text).not.toMatch(/reconnect/i);
    expect(text).not.toMatch(/unlink/i);
  });
});
