/**
 * "{Name} removed" undo toast on the Clients & Contacts delete (BACKLOG-2501)
 *
 * Founder QA on the BACKLOG-2367 restore screens: *"can we have a {Name}
 * removed toast with undo button"*. The removed-contacts section at the foot of
 * the list is a RECOVERY surface — it only helps once the user has noticed
 * something is missing and gone looking for it. The toast catches the mistake in
 * the seconds where they still know they made it.
 *
 * ===========================================================================
 * THE DRIVE PATH IS TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * The click sequence below (open the card -> `/^remove$/i` -> wait for "Remove
 * Contact" -> `getAllByRole(...)[0]`) is lifted verbatim from the passing case
 * "should call remove API when confirmation is accepted" in
 * `Contacts.deletionPrevention.test.tsx`, as are the contact fixtures. Two
 * details would have been wrong if typed from memory and both are load-bearing:
 *
 *   - The Remove button query must be ANCHORED. Clients & Contacts also renders
 *     a "Show removed contacts" toggle, and a loose `/remove/i` matches both.
 *   - The confirm modal's button ALSO matches `/^remove$/i`, so the confirm step
 *     is `getAllByRole(...)[0]`, not `getByRole`.
 *
 * ===========================================================================
 * EXACT IDENTITY, NEVER COUNTS
 * ===========================================================================
 * "restore was called once" is satisfied by restoring the wrong person, which is
 * the defect that would actually hurt here. Every assertion names who.
 *
 * Fixture values are reserved-for-documentation only: `example.com` and the
 * `+1 555 01xx` reserved fictional range.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import { NotificationProvider } from "../../contexts/NotificationContext";
import type { Contact } from "../../../electron/types/models";

jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({
    isDatabaseInitialized: true,
  }),
}));

jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

const USER_ID = "user-2501";

/**
 * Same partial-row shape `Contacts.deletionPrevention.test.tsx` uses: only the
 * fields the list actually renders. `default_role` is required — the
 * Clients-only default view (BACKLOG-1898 T3) hides a contact without one.
 *
 * DANA carries the legacy flat `name`, not `display_name`, on purpose:
 * `labelForContact` resolves `display_name || name`, and the toast has to name
 * the person the same way the card the user was looking at does.
 */
const DANA = {
  id: "contact-dana",
  name: "Dana Example",
  email: "dana@example.com",
  phone: "+15550100",
  company: "Example Realty",
  source: "contacts_app",
  default_role: "buyer",
} as unknown as Contact;

const REESE = {
  id: "contact-reese",
  name: "Reese Example",
  email: "reese@example.com",
  phone: "+15550101",
  company: "Example Realty",
  source: "contacts_app",
  default_role: "buyer",
} as unknown as Contact;

beforeAll(() => {
  // Not present on the setup double — the restore channel landed in #2211.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.contacts as any).restore = jest.fn();
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({
    success: true,
    contacts: [DANA, REESE],
  });
  jest.mocked(window.api.contacts.remove).mockResolvedValue({ success: true });
  (window.api.contacts.restore as jest.Mock).mockResolvedValue({
    success: true,
    restored: true,
  });
});

/**
 * Drive a real removal of `name` through the UI, all the way to confirm.
 * Transcribed from `Contacts.deletionPrevention.test.tsx` — see the docblock.
 */
async function removeContactNamed(name: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText(name)).toBeInTheDocument();
  });

  await userEvent.click(screen.getByText(name));
  await waitFor(() => {
    expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
  });

  await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
  await waitFor(() => {
    expect(screen.getByText("Remove Contact")).toBeInTheDocument();
  });

  await act(async () => {
    await userEvent.click(
      screen.getAllByRole("button", { name: /^remove$/i })[0],
    );
  });
}

describe("Contacts — undo toast on removal (BACKLOG-2501)", () => {
  it("names the removed person in the toast and offers Undo", async () => {
    render(
      <NotificationProvider>
        <Contacts userId={USER_ID} onClose={jest.fn()} />
      </NotificationProvider>,
    );

    await removeContactNamed("Dana Example");

    // The removal really happened, and to the right person.
    await waitFor(() => {
      expect(window.api.contacts.remove).toHaveBeenCalledWith("contact-dana");
    });

    // The toast names HER, not "Contact removed" and not the other fixture.
    await waitFor(() => {
      expect(screen.getByText("Dana Example removed")).toBeInTheDocument();
    });
    expect(screen.queryByText("Reese Example removed")).not.toBeInTheDocument();

    // The Undo affordance is the shared notification action button — the same
    // one the message-move undo uses (BACKLOG-2390), not a bespoke control.
    const undo = screen.getByTestId("notification-action");
    expect(undo).toHaveTextContent("Undo");

    // Undo has NOT fired yet. Without this the next assertion cannot tell a
    // wired-up button from a restore that ran on its own.
    expect(window.api.contacts.restore).not.toHaveBeenCalled();
  });

  it("restores exactly the removed contact when Undo is clicked", async () => {
    render(
      <NotificationProvider>
        <Contacts userId={USER_ID} onClose={jest.fn()} />
      </NotificationProvider>,
    );

    await removeContactNamed("Reese Example");
    await waitFor(() => {
      expect(screen.getByText("Reese Example removed")).toBeInTheDocument();
    });

    await act(async () => {
      await userEvent.click(screen.getByTestId("notification-action"));
    });

    // Identity, not count: the id passed is the one that was removed.
    await waitFor(() => {
      expect(window.api.contacts.restore).toHaveBeenCalledWith("contact-reese");
    });
    expect(
      (window.api.contacts.restore as jest.Mock).mock.calls.map((c) => c[0]),
    ).toEqual(["contact-reese"]);

    // Undo goes through the EXISTING contacts:restore channel. It must not
    // reach for a second un-remove route, and it must not re-issue the removal.
    expect(window.api.contacts.remove).toHaveBeenCalledTimes(1);

    // The restored person is pulled back into the list by the silent refresh:
    // one getAll on mount, a second after the restore.
    await waitFor(() => {
      expect(window.api.contacts.getAll).toHaveBeenCalledTimes(2);
    });
  });

  it("raises no toast when the removal fails", async () => {
    jest.mocked(window.api.contacts.remove).mockResolvedValue({
      success: false,
      error: "database is locked",
    });
    // The failure path alerts; jsdom has no implementation.
    const alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});

    render(
      <NotificationProvider>
        <Contacts userId={USER_ID} onClose={jest.fn()} />
      </NotificationProvider>,
    );

    await removeContactNamed("Dana Example");

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalled();
    });
    // A toast here would offer Undo for a removal that never happened.
    expect(screen.queryByText("Dana Example removed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notification-action")).not.toBeInTheDocument();

    alertSpy.mockRestore();
  });

  /**
   * BACKLOG-2367 regression guard. Wiring toasts into this screen with the
   * `useNotification()` HOOK crashed the whole of Clients & Contacts when it was
   * rendered outside `NotificationProvider`, because that hook throws on a
   * missing provider. The fix reads the context directly and optional-chains it.
   * A missing provider must cost the toast, not the screen.
   */
  it("still removes the contact with no NotificationProvider mounted", async () => {
    render(<Contacts userId={USER_ID} onClose={jest.fn()} />);

    await removeContactNamed("Dana Example");

    await waitFor(() => {
      expect(window.api.contacts.remove).toHaveBeenCalledWith("contact-dana");
    });
    // No provider, so no toast — and no crash: the list is still on screen.
    expect(screen.queryByTestId("notification-action")).not.toBeInTheDocument();
    expect(screen.getByText("Reese Example")).toBeInTheDocument();
  });
});
