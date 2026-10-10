/**
 * BACKLOG-3837 follow-up — Attach Messages while the names from the people found in
 * messages are still being read off the main thread.
 *
 * `transactions:get-message-contacts` (and the `contacts:get-all` read beside it) now
 * answer at once with the full roster, plus `contactsStatus.messageDerivedPending: true`
 * when the message-derived names are not ready (emailLinkingHandlers.ts,
 * contactHandlers.ts). The modal must then
 *  - show the roster with a "Loading names..." note (not a spinner replacing it);
 *  - show "Loading contacts...", never "No contacts with unlinked messages", when the
 *    roster is empty and names are pending (BACKLOG-3832 rule);
 *  - re-read silently on `contacts:message-derived-ready`, and every 15 s meanwhile.
 * Response shapes are the handlers' (roster rows as transactionService.getMessageContacts
 * returns them; the shape the 2816 suite already pins).
 */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AttachMessagesModal } from "../AttachMessagesModal";

const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockLinkMessages = jest.fn();
const mockGetAllContacts = jest.fn();
const mockResolveHandles = jest.fn();
let readyListener: ((p: { userId: string }) => void) | null = null;
const mockOnMessageDerivedReady = jest.fn((cb: (p: { userId: string }) => void) => {
  readyListener = cb;
  return () => {
    if (readyListener === cb) readyListener = null;
  };
});

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: mockLinkMessages,
      },
      contacts: {
        getAll: mockGetAllContacts,
        resolveHandles: mockResolveHandles,
        onMessageDerivedReady: mockOnMessageDerivedReady,
      },
    },
    writable: true,
  });
});

const USER = "user-3837";
const props = {
  userId: USER,
  transactionId: "txn-3837",
  propertyAddress: "1 Test St",
  onClose: jest.fn(),
  onAttached: jest.fn(),
};

const PENDING = { messageDerivedPending: true };
const row = (contact: string, contactName: string | null) => ({
  contact,
  contactName,
  messageCount: 3,
  lastMessageAt: "2026-01-18T10:00:00Z",
  threadNames: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  readyListener = null;
  mockGetAllContacts.mockResolvedValue({ success: true, contacts: [] });
  mockResolveHandles.mockResolvedValue({ success: true, names: {} });
  mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-3837: Attach Messages while message-derived names are pending", () => {
  it("roster + pending: the roster shows with a 'Loading names' note; the ready event re-reads and clears it", async () => {
    mockGetMessageContacts
      .mockResolvedValueOnce({ success: true, contacts: [row("Jordan Lee", null)], contactsStatus: PENDING })
      .mockResolvedValueOnce({ success: true, contacts: [row("Jordan Lee", "Jordan Lee")] });
    render(<AttachMessagesModal {...props} />);
    await waitFor(() => expect(screen.getByTestId("names-pending")).toBeInTheDocument());
    expect(screen.getAllByText("Jordan Lee").length).toBeGreaterThan(0);
    expect(screen.queryByText("Loading contacts...")).not.toBeInTheDocument();
    await waitFor(() => expect(readyListener).not.toBeNull());

    await act(async () => {
      readyListener?.({ userId: USER });
    });
    await waitFor(() => expect(mockGetMessageContacts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("names-pending")).not.toBeInTheDocument());
    expect(screen.getAllByText("Jordan Lee").length).toBeGreaterThan(0);
    expect(readyListener).toBeNull();
  });

  it("empty roster + pending: 'Loading contacts...', never 'No contacts with unlinked messages'", async () => {
    mockGetMessageContacts.mockResolvedValue({ success: true, contacts: [], contactsStatus: PENDING });
    render(<AttachMessagesModal {...props} />);
    await waitFor(() => expect(mockGetMessageContacts).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readyListener).not.toBeNull());
    expect(screen.getByText("Loading contacts...")).toBeInTheDocument();
    expect(screen.queryByText("No contacts with unlinked messages")).not.toBeInTheDocument();
  });

  it("pending reported by the contacts read alone also counts; the 15 s backstop re-reads", async () => {
    jest.useFakeTimers();
    mockGetMessageContacts.mockResolvedValue({ success: true, contacts: [row("+14155550100", null)] });
    mockGetAllContacts
      .mockResolvedValueOnce({ success: true, contacts: [], contactsStatus: PENDING })
      .mockResolvedValue({ success: true, contacts: [] });
    render(<AttachMessagesModal {...props} />);
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    await waitFor(() => expect(screen.getByTestId("names-pending")).toBeInTheDocument());
    await waitFor(() => expect(readyListener).not.toBeNull());
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    await waitFor(() => expect(mockGetMessageContacts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("names-pending")).not.toBeInTheDocument());
  });

  it("not pending: an empty roster is a real empty roster (control)", async () => {
    mockGetMessageContacts.mockResolvedValue({ success: true, contacts: [] });
    render(<AttachMessagesModal {...props} />);
    await waitFor(() => expect(screen.getByText("No contacts with unlinked messages")).toBeInTheDocument());
    expect(readyListener).toBeNull();
  });
});
