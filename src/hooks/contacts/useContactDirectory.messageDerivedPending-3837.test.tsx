/**
 * BACKLOG-3837 follow-up — the wizard's contact picker while the people found in
 * messages are still being read off the main thread.
 *
 * Main now answers `contacts:get-sorted-by-activity` / `contacts:get-all` within a short
 * budget: the saved contacts, plus `contactsStatus.messageDerivedPending: true` when the
 * message-derived people are not ready (contactHandlers.ts). The picker must then
 *  - show the saved contacts at once when there are any (no spinner replacing them);
 *  - show "Loading contacts..." — never "No contacts available" — when the saved half is
 *    empty and the rest is pending (BACKLOG-3832 rule: an empty list must not stand for
 *    "not loaded");
 *  - fill in the message-derived people when main sends `contacts:message-derived-ready`,
 *    and re-read every 15 s meanwhile (a failed read sends no event).
 *
 * The harness wires the hook into the real ContactSearchList exactly as the wizard does
 * (ContactAssignmentStep.tsx: `isLoading={contactsLoading || externalContactsLoading}`).
 * Response shapes are the handler's: `{ success, contacts, contactsStatus? }`.
 */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useContactDirectory } from "./useContactDirectory";
import ContactSearchList from "../../components/shared/ContactSearchList";
import type { Contact } from "../../../electron/types/models";

const USER_ID = "user-3837";
const ADDRESS = "12 Example Lane";

const saved = {
  id: "c-saved-1",
  user_id: USER_ID,
  name: "Bianca Okafor",
  display_name: "Bianca Okafor",
  phone: "+15035550130",
  source: "manual",
  is_imported: 1,
} as unknown as Contact;

/** As getContactsSortedByActivity maps a message-derived row. */
const fromMessages = {
  id: "msg_jordan lee",
  user_id: USER_ID,
  name: "Jordan Lee",
  display_name: "Jordan Lee",
  phone: "Jordan Lee",
  source: "messages",
  is_imported: 0,
  is_message_derived: 1,
} as unknown as Contact;

const PENDING = { messageDerivedPending: true };

let readyListener: ((p: { userId: string }) => void) | null = null;

function Picker(): React.ReactElement {
  const dir = useContactDirectory({ userId: USER_ID, propertyAddress: ADDRESS, autoLoadExternal: false });
  return (
    <ContactSearchList
      contacts={dir.contacts}
      selectedIds={[]}
      onSelectionChange={() => undefined}
      filterMode="off"
      isLoading={dir.contactsLoading || dir.externalContactsLoading}
    />
  );
}

beforeEach(() => {
  readyListener = null;
  localStorage.clear();
  jest.mocked(window.api.contacts.getSortedByActivity).mockReset();
  (window.api.contacts as unknown as Record<string, unknown>).onMessageDerivedReady = jest.fn(
    (cb: (p: { userId: string }) => void) => {
      readyListener = cb;
      return () => {
        if (readyListener === cb) readyListener = null;
      };
    },
  );
});

afterEach(() => {
  jest.useRealTimers();
  delete (window.api.contacts as unknown as Record<string, unknown>).onMessageDerivedReady;
});

const sorted = () => jest.mocked(window.api.contacts.getSortedByActivity);

describe("BACKLOG-3837: the picker while message-derived people are pending", () => {
  it("empty saved half + pending: shows loading, never 'No contacts available'; the ready event fills the list", async () => {
    sorted()
      .mockResolvedValueOnce({ success: true, contacts: [], contactsStatus: PENDING })
      .mockResolvedValueOnce({ success: true, contacts: [fromMessages] });
    render(<Picker />);
    await waitFor(() => expect(sorted()).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readyListener).not.toBeNull());
    expect(screen.getByTestId("loading-state")).toBeInTheDocument();
    expect(screen.queryByText("No contacts available")).not.toBeInTheDocument();

    await act(async () => {
      readyListener?.({ userId: USER_ID });
    });
    await waitFor(() => expect(screen.getAllByText("Jordan Lee")[0]).toBeInTheDocument());
    expect(sorted()).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
    expect(readyListener).toBeNull(); // no longer pending: unsubscribed
  });

  it("saved contacts + pending: the saved rows show at once (no spinner); the 15 s backstop re-reads", async () => {
    jest.useFakeTimers();
    sorted()
      .mockResolvedValueOnce({ success: true, contacts: [saved], contactsStatus: PENDING })
      .mockResolvedValueOnce({ success: true, contacts: [saved, fromMessages] });
    render(<Picker />);
    await waitFor(() => expect(screen.getByText("Bianca Okafor")).toBeInTheDocument());
    expect(screen.queryByTestId("loading-state")).not.toBeInTheDocument();
    expect(sorted()).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await waitFor(() => expect(screen.getAllByText("Jordan Lee")[0]).toBeInTheDocument());
    expect(sorted()).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Bianca Okafor")).toBeInTheDocument();
  });

  it("a ready event for another user is ignored", async () => {
    sorted().mockResolvedValue({ success: true, contacts: [saved], contactsStatus: PENDING });
    render(<Picker />);
    await waitFor(() => expect(readyListener).not.toBeNull());
    await act(async () => {
      readyListener?.({ userId: "someone-else" });
    });
    expect(sorted()).toHaveBeenCalledTimes(1);
  });

  it("not pending: an empty list is a real empty list (the control: the flag is what separates the two)", async () => {
    sorted().mockResolvedValue({ success: true, contacts: [] });
    render(<Picker />);
    await waitFor(() => expect(screen.getByText("No contacts available")).toBeInTheDocument());
    expect(readyListener).toBeNull();
  });
});
