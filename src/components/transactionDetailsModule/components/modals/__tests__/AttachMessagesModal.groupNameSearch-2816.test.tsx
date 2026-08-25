/**
 * BACKLOG-2816 — the attach-messages picker finds a group by the name the user
 * gave it in Messages.
 *
 * ===========================================================================
 * WHY THE ASSERTION IS ABOUT CONTACTS AND NOT ABOUT THREADS
 * ===========================================================================
 * This picker is contact-first: the search box filters a roster of PEOPLE, and
 * a conversation is reached by selecting one of them. A group's name belongs to
 * no single person, so "find the group by its name" means: the members of that
 * group survive the filter, and nobody else does.
 *
 * That is why the roster rows carry `threadNames` — the search cannot consult
 * data the picker never loaded, and before this change the group name reached
 * the renderer through no path at all.
 *
 * ===========================================================================
 * CONTROL (run and recorded — see the PR body)
 * ===========================================================================
 * Delete `c.threadNames.some(...)` from the filter -> only the two "finds by
 * group name" tests below go red; every other test in this file and all 26 in
 * the sibling AttachMessagesModal suite stay green.
 *
 * Every group name and handle here is invented for the fixture.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AttachMessagesModal } from "../AttachMessagesModal";

const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockLinkMessages = jest.fn();
const mockGetAllContacts = jest.fn();
const mockResolveHandles = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: mockLinkMessages,
      },
      contacts: { getAll: mockGetAllContacts, resolveHandles: mockResolveHandles },
    },
    writable: true,
  });
});

const GROUP_NAME = "Kingfisher Lane Closing";

/**
 * Four roster shapes. The two group members carry the group's name; nobody's
 * person-name or handle contains the query, so a hit can only come from the
 * name — and `SOLO_NAME` deliberately shares no substring with it.
 */
const IN_GROUP_A = "Dana Whitfield";
const IN_GROUP_B = "Marcus Otero";
const NO_GROUP = "Priya Raman";
const SOLO_NAME = "Tobias Vance";

const roster = [
  {
    contact: "+14155550100",
    contactName: IN_GROUP_A,
    messageCount: 5,
    lastMessageAt: "2026-01-18T10:00:00Z",
    threadNames: [GROUP_NAME],
  },
  {
    contact: "+14155550101",
    contactName: IN_GROUP_B,
    messageCount: 4,
    lastMessageAt: "2026-01-17T10:00:00Z",
    threadNames: [GROUP_NAME],
  },
  {
    // An unnamed group: threads, but no name row for any of them.
    contact: "+14155550102",
    contactName: NO_GROUP,
    messageCount: 3,
    lastMessageAt: "2026-01-16T10:00:00Z",
    threadNames: [],
  },
  {
    // A 1:1 contact. Older API shims omit the field entirely — that must not
    // throw, so this row leaves `threadNames` undefined rather than [].
    contact: "+14155550103",
    contactName: SOLO_NAME,
    messageCount: 2,
    lastMessageAt: "2026-01-15T10:00:00Z",
  },
];

const props = {
  userId: "user-2816",
  transactionId: "txn-2816",
  propertyAddress: "1 Test St",
  onClose: jest.fn(),
  onAttached: jest.fn(),
};

async function renderAndSearch(query: string): Promise<void> {
  render(<AttachMessagesModal {...props} />);
  await waitFor(() => expect(screen.getByText(IN_GROUP_A)).toBeInTheDocument());
  const input = screen.getByPlaceholderText(
    /Search by name, phone number, or group chat name/i,
  );
  fireEvent.change(input, { target: { value: query } });
}

/** Assert the EXACT set of roster entries on screen, by identity. */
function expectRoster(present: string[]): void {
  const all = [IN_GROUP_A, IN_GROUP_B, NO_GROUP, SOLO_NAME];
  for (const name of all) {
    if (present.includes(name)) {
      expect(screen.getByText(name)).toBeInTheDocument();
    } else {
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    }
  }
}

describe("BACKLOG-2816 — attach-messages picker matches group chat names", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMessageContacts.mockResolvedValue({ success: true, contacts: roster });
    mockGetAllContacts.mockResolvedValue({ success: true, contacts: [] });
    mockResolveHandles.mockResolvedValue({ success: true, names: {} });
    mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [] });
  });

  it("finds the group's members by the group name, and nobody else", async () => {
    await renderAndSearch(GROUP_NAME);
    expectRoster([IN_GROUP_A, IN_GROUP_B]);
  });

  it("matches a substring of the group name, case-insensitively", async () => {
    await renderAndSearch("fisher lane");
    expectRoster([IN_GROUP_A, IN_GROUP_B]);
  });

  it("leaves a contact with no group name unaffected", async () => {
    await renderAndSearch(NO_GROUP.split(" ")[0]);
    expectRoster([NO_GROUP]);
  });

  it("leaves a 1:1 contact with no threadNames field unaffected", async () => {
    await renderAndSearch(SOLO_NAME.split(" ")[0]);
    expectRoster([SOLO_NAME]);
  });

  it("still matches a contact by person name exactly as before", async () => {
    await renderAndSearch(IN_GROUP_A.split(" ")[0]);
    expectRoster([IN_GROUP_A]);
  });

  it("still matches a contact by phone number exactly as before", async () => {
    await renderAndSearch("4155550102");
    expectRoster([NO_GROUP]);
  });

  it("shows the whole roster when the query is cleared", async () => {
    await renderAndSearch(GROUP_NAME);
    expectRoster([IN_GROUP_A, IN_GROUP_B]);
    const input = screen.getByPlaceholderText(
      /Search by name, phone number, or group chat name/i,
    );
    fireEvent.change(input, { target: { value: "" } });
    expectRoster([IN_GROUP_A, IN_GROUP_B, NO_GROUP, SOLO_NAME]);
  });
});
