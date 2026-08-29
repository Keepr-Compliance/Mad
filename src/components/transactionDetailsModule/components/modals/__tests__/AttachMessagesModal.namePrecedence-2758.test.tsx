/**
 * BACKLOG-2758 — THE ATTACH PICKER MUST NOT INVENT A SINGLE NAME FOR A SHARED
 * LINE.
 *
 * ===========================================================================
 * THE DEFECT, AS THE FOUNDER SAW IT
 * ===========================================================================
 * A number held by two saved contacts showed ONE name in the "Select Contact"
 * roster, and searching for the SECOND contact's name found nothing at all.
 *
 * The cause was precedence, not resolution. `contactNamesRecord` wrote three
 * sources into one object with a bare `rec[handle] = name`, in this order:
 *
 *     for (const c of allContacts)           add(c.phone, c.name);
 *     for (const [h, n] of resolvedNames)    add(h, n);        // "A or B"
 *     for (const c of contacts)              add(c.contact, c.contactName);
 *
 * The third loop carries ONE name off the message-contact row, so it overwrote
 * the shared resolver's ambiguous label. The resolver was answering correctly
 * the whole time and its answer was discarded one line later. The row therefore
 * named whichever contact that query happened to carry — chosen by overwrite
 * order, which is to say by nothing — and because the search box matches the
 * rendered `displayName`, the other contact became unreachable in this screen.
 *
 * That is the same silent-winner defect BACKLOG-2757 removed from the export,
 * still live in the picker. This file keeps it dead.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY *NOT* FIXED HERE
 * ===========================================================================
 * The picker still does NOT pass a `transactionId` (founder-ratified
 * 2026-08-27) — it lists threads that are not on the deal yet, so preferring
 * this deal's contact would be a guess printed as fact. Ambiguity is the honest
 * answer here, which is precisely why the label must survive to the screen.
 * That call-site arity is pinned in
 * `../../__tests__/resolveHandlesScope-2758.test.tsx`.
 *
 * ===========================================================================
 * CONTROLS — MEASURED with `--bail=0` (jest.config.js sets `bail: 1`; a count
 * taken without the flag is a FLOOR). Counts recorded in the PR body.
 * ===========================================================================
 *   P1  RESTORE THE OVERWRITE — in AttachMessagesModal.tsx, change the two
 *       `fill(...)` loops back to `write(..., false)` so the weaker sources
 *       clobber the resolver again. This is the defect itself.
 *
 *   P2  NARROW THE GUARD TO ONE KEY — make `fill` test `resolverClaimed.has(handle)`
 *       instead of the handle's whole alias set.
 *       -> MEASURED 5/5 GREEN. **This control did NOT red, and the note that
 *          once claimed it would was wrong.** The resolver returns a phone
 *          answer under BOTH the raw handle and the last-ten digits (probed, see
 *          RESOLVER_NAMES below), so it has already claimed the key
 *          `resolveDisplayName` reads first, and the single-key guard suffices
 *          for every handle the picker passes. The alias set is defensive
 *          redundancy against a weak source writing a normalized key the
 *          resolver did not claim — a case this component cannot currently
 *          produce, because "(503) 555-0155" fails its own `isPhone` test.
 *          Recorded rather than deleted: the next person to simplify `fill`
 *          should know it is unguarded by tests, not that it is pointless.
 *
 * RUNNER: npx jest --bail=0 src/components/transactionDetailsModule/components/modals/__tests__/AttachMessagesModal.namePrecedence-2758.test.tsx
 *
 * Every name is invented (FICTIONAL_NAMES in scripts/ci/check-fixture-pii.mjs)
 * and every number is reserved-for-fiction 555-01xx. None refers to anyone.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AttachMessagesModal } from "../AttachMessagesModal";

const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockGetAllContacts = jest.fn();
const mockResolveHandles = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: jest.fn(),
      },
      contacts: { getAll: mockGetAllContacts, resolveHandles: mockResolveHandles },
    },
    writable: true,
  });
});

// ---------------------------------------------------------------------------
// The shared line, and the two people on it.
// ---------------------------------------------------------------------------
const SHARED_RAW = "+15035550155";
const SHARED_DIGITS = "5035550155";
/** The same number as the contacts table might store it — a DIFFERENT spelling. */
const SHARED_FORMATTED = "(503) 555-0155";
const FIRST_NAME = "Chris Alvarez";
const SECOND_NAME = "Pat Riverton";
const AMBIGUOUS_LABEL = `${FIRST_NAME} or ${SECOND_NAME}`;

/** A second roster row the resolver cannot answer — the fallback must survive. */
const UNRESOLVED_RAW = "+15035550160";
const FALLBACK_NAME = "Robin Marsh";

/**
 * The resolver's REAL output shape, transcribed from a probe of the live
 * resolver over a migrated database (see inAppHandleScope-2758.test.ts for the
 * fixture that produces it): a phone answer is written under BOTH the last-ten
 * digit key and the raw handle. Invented by nobody — read off the real thing,
 * because a hand-made single-key shape would have made the alias-set leg below
 * pass for the wrong reason.
 */
const RESOLVER_NAMES: Record<string, string> = {
  [SHARED_DIGITS]: AMBIGUOUS_LABEL,
  [SHARED_RAW]: AMBIGUOUS_LABEL,
};

const props = {
  userId: "user-2758",
  transactionId: "txn-2758",
  propertyAddress: "1 Test St",
  onClose: jest.fn(),
  onAttached: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [] });
  mockGetAllContacts.mockResolvedValue({ success: true, contacts: [] });
  mockResolveHandles.mockResolvedValue({ success: true, names: RESOLVER_NAMES });
  mockGetMessageContacts.mockResolvedValue({
    success: true,
    contacts: [
      {
        // THE ROW. The message-contact query carries ONE of the two names — this
        // is the value that used to win and hide the other person.
        contact: SHARED_RAW,
        contactName: FIRST_NAME,
        messageCount: 5,
        lastMessageAt: "2026-01-18T10:00:00Z",
        threadNames: [],
      },
      {
        contact: UNRESOLVED_RAW,
        contactName: FALLBACK_NAME,
        messageCount: 2,
        lastMessageAt: "2026-01-17T10:00:00Z",
        threadNames: [],
      },
    ],
  });
});

async function renderPicker(): Promise<void> {
  render(<AttachMessagesModal {...props} />);
  await waitFor(() => expect(mockResolveHandles).toHaveBeenCalled());
}

function search(query: string): void {
  const input = screen.getByPlaceholderText(
    /Search by name, phone number, or group chat name/i,
  );
  fireEvent.change(input, { target: { value: query } });
}

describe("BACKLOG-2758 — a shared line reaches the picker as 'A or B'", () => {
  it("renders the ambiguous label, not one of the two names", async () => {
    await renderPicker();
    await waitFor(() => expect(screen.getByText(AMBIGUOUS_LABEL)).toBeInTheDocument());
    // Asserted as an EXACT label, not as "contains Pat": the defect produced a
    // valid-looking single name, so a substring check would pass on it.
    expect(screen.queryByText(FIRST_NAME)).not.toBeInTheDocument();
    expect(screen.queryByText(SECOND_NAME)).not.toBeInTheDocument();
  });

  it("finds the row by searching the SECOND contact's name", async () => {
    // THE FOUNDER'S OBSERVATION. The search matches the rendered displayName, so
    // while the label was being overwritten with the first name, the second
    // person was unreachable in this screen — not merely mislabelled.
    await renderPicker();
    await waitFor(() => expect(screen.getByText(AMBIGUOUS_LABEL)).toBeInTheDocument());
    search("Riverton");
    expect(screen.getByText(AMBIGUOUS_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(FALLBACK_NAME)).not.toBeInTheDocument();
  });

  it("still finds the row by the FIRST contact's name", async () => {
    // The fix must not trade one unreachable person for the other.
    await renderPicker();
    await waitFor(() => expect(screen.getByText(AMBIGUOUS_LABEL)).toBeInTheDocument());
    search("Alvarez");
    expect(screen.getByText(AMBIGUOUS_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(FALLBACK_NAME)).not.toBeInTheDocument();
  });

  it("still names a handle the resolver could NOT answer", async () => {
    // Proves the overwrite was NARROWED and not deleted. The message-contact row
    // is the only source for this handle; if `fill` had become "never write",
    // this row would fall back to a formatted phone number and this reds.
    await renderPicker();
    await waitFor(() => expect(screen.getByText(FALLBACK_NAME)).toBeInTheDocument());
  });

  it("is not overwritten by a DIFFERENTLY FORMATTED spelling from the contacts table", async () => {
    // `getAll` returns contacts-table phones in whatever format they were
    // stored, so the SAME number arrives a second time wearing a different
    // spelling. The label must survive that too.
    //
    // HONEST ABOUT ITS REACH: this leg passes under BOTH the alias-set guard and
    // the narrower single-key one (control P2, measured 5/5 green), so it pins
    // the BEHAVIOUR and not the choice of guard. It is a regression leg, not a
    // discriminating one, and saying so here is cheaper than the next reader
    // re-deriving it.
    mockGetAllContacts.mockResolvedValue({
      success: true,
      contacts: [{ id: "c-1", name: FIRST_NAME, phone: SHARED_FORMATTED }],
    });
    await renderPicker();
    await waitFor(() => expect(screen.getByText(AMBIGUOUS_LABEL)).toBeInTheDocument());
    expect(screen.queryByText(FIRST_NAME)).not.toBeInTheDocument();
  });
});
