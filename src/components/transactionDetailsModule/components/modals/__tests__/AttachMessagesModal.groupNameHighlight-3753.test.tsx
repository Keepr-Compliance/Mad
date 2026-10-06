/**
 * BACKLOG-3753: when the Attach messages search matches a group chat's name,
 * the contact's row shows that group name with the match marked — by the
 * app's shared search highlighter (highlightMatch, `search-highlight`), the
 * same one LinkedContentSearch uses.
 *
 * Mutations (each red): the group line rendered as plain text again; the
 * matched name not moved to the front of the (truncated) line.
 */
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AttachMessagesModal } from "../AttachMessagesModal";

const NUM = "+15555550121";
const SHOWN = "Jordan Example";
const mockGetMessageContacts = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: jest.fn(),
        linkMessages: jest.fn(),
      },
      contacts: {
        getAll: jest.fn().mockResolvedValue({ success: true, contacts: [] }),
        resolveHandles: jest.fn().mockResolvedValue({ success: true, names: { [NUM]: SHOWN } }),
      },
    },
    writable: true,
  });
});

const props = { userId: "user-x", transactionId: "txn-x", onClose: jest.fn(), onAttached: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMessageContacts.mockResolvedValue({
    success: true,
    contacts: [
      {
        contact: NUM,
        messageCount: 2,
        lastMessageAt: "2026-09-20T10:00:00.000Z",
        threadNames: ["Book Club", "Kingfisher Lane Closing"],
      },
    ],
  });
});

function search(value: string): void {
  fireEvent.change(screen.getByTestId("search-input"), { target: { value } });
}

describe("BACKLOG-3753 — group name match is highlighted on the contact row", () => {
  it("marks the matched text inside the group name, matched name first", async () => {
    render(<AttachMessagesModal {...props} />);
    await screen.findByText(SHOWN);

    search("kingfisher");
    const line = screen.getByTestId("picker-contact-groups");
    const marks = within(line).getAllByTestId("search-highlight");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent(/^Kingfisher$/); // original casing kept
    expect(line).toHaveTextContent(/^Kingfisher Lane Closing, Book Club$/);
  });

  it("no search → plain group line, no highlight", async () => {
    render(<AttachMessagesModal {...props} />);
    await screen.findByText(SHOWN);
    const line = screen.getByTestId("picker-contact-groups");
    expect(within(line).queryByTestId("search-highlight")).toBeNull();
    expect(line).toHaveTextContent(/^Book Club, Kingfisher Lane Closing$/);
  });
});
