/**
 * EditContactsModal — the Add Contacts commit control must stay IN FLOW.
 * BACKLOG-2639.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE CAN PROVE, AND WHAT IT CANNOT. READ BEFORE TRUSTING IT.
 * ---------------------------------------------------------------------------
 * The defect was a LAYOUT defect: a second, `fixed`-positioned copy of the
 * "Add Selected" button sat in the viewport's bottom-right corner below the
 * `sm` breakpoint and painted over the save button of whatever modal was open
 * underneath it — in the founder's report, `ContactFormModal`'s **"Add
 * Contact"** button.
 *
 * jsdom HAS NO LAYOUT ENGINE. It does not compute boxes, does not evaluate
 * media queries, does not resolve Tailwind classes to CSS, and
 * `getBoundingClientRect()` returns zeros. So this suite CANNOT prove:
 *
 *   - that no visual overlap occurs at any width,
 *   - that `sm:hidden` / `fixed` / `z-[71]` mean what we believe they mean,
 *   - that the real app is correct at 375px.
 *
 * It asserts STRUCTURE ONLY — the shape of the DOM that made the overlap
 * possible. The overlap itself was measured in real chromium over a continuous
 * 1px width sweep (360→900px): before the fix the floating copy won
 * `elementFromPoint` at the centre of the save button at every width from
 * 360px to 639px; after it, at none. **That sweep is owed again at UAT against
 * the real app** — a browser measurement of a replica does not discharge it.
 *
 * The structural rule this guards is deliberately about the CONTAINER, not
 * about any button's name: a control that participates in layout cannot paint
 * over anything, at any z-index. Add a second action to the footer and the
 * guard still holds. Add one as a new floating corner pill and it fails.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import { EditContactsModal, EditContactsModalProps } from "./EditContactsModal";
import type { Transaction } from "@/types";
import type { ExtendedContact } from "../../../../types/components";

const mockGetDetails = jest.fn();
const mockBatchUpdateContacts = jest.fn();
const mockGetAvailable = jest.fn();

beforeAll(() => {
  (window as unknown as { api: unknown }).api = {
    transactions: {
      getDetails: mockGetDetails,
      batchUpdateContacts: mockBatchUpdateContacts,
    },
    contacts: { getAvailable: mockGetAvailable },
  };
});

const janeUnassigned: ExtendedContact = {
  id: "c-jane",
  name: "Jane Doe",
  display_name: "Jane Doe",
  email: "jane@example.com",
  user_id: "user-1",
  source: "manual",
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
};

// A second contact so the real ContactSearchList renders MORE THAN ONE row —
// the subtree the guard sweeps must actually contain the list's own buttons,
// or it silently covers fewer elements than it appears to.
const samUnassigned: ExtendedContact = {
  id: "c-sam",
  name: "Sam Roe",
  display_name: "Sam Roe",
  email: "sam@example.com",
  user_id: "user-1",
  source: "manual",
  created_at: "2024-01-02",
  updated_at: "2024-01-02",
};

const externalNew: ExtendedContact = {
  id: "ext-zoe",
  name: "Zoe New",
  display_name: "Zoe New",
  email: "zoe@example.com",
  user_id: "user-1",
  source: "contacts_app",
  created_at: "2024-03-01",
  updated_at: "2024-03-01",
};

jest.mock("../../../../contexts/ContactsContext", () => ({
  ContactsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useContacts: () => ({
    contacts: [janeUnassigned, samUnassigned],
    loading: false,
    error: null,
    refreshContacts: jest.fn(),
    silentRefresh: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock("../../../shared/ContactRoleRow", () => ({
  ContactRoleRow: ({ contact }: { contact: ExtendedContact }) => (
    <div data-testid={`contact-role-row-${contact.id}`}>{contact.display_name}</div>
  ),
}));

jest.mock("../../../../services", () => ({
  contactService: { create: jest.fn() },
  settingsService: { getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false) },
}));

jest.mock("../../../../contexts/NetworkContext", () => ({
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

const createTestTransaction = (): Transaction =>
  ({
    id: "txn-1",
    user_id: "user-1",
    property_address: "123 Main St",
    transaction_type: "purchase",
    status: "active",
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
  }) as Transaction;

const createDefaultProps = (): EditContactsModalProps => ({
  transaction: createTestTransaction(),
  userId: "user-1",
  onClose: jest.fn(),
  onSave: jest.fn(),
});

/** Tailwind's `fixed` utility — the class that takes an element out of flow and
 *  anchors it to the viewport. Matched as a whole token so `sm:fixed` and any
 *  other variant prefix is caught too. */
const FIXED = /(?:^|\s)(?:[a-z0-9-]+:)*fixed(?:\s|$)/;

/** A corner anchor: an edge inset with a value (`bottom-4`, `right-4`, ...).
 *  `inset-0` — how a legitimate full-screen modal backdrop covers the window —
 *  is deliberately NOT matched. */
const CORNER = /(?:^|\s)(?:[a-z0-9-]+:)*(?:top|bottom|left|right)-(?!0(?:\s|$))[^\s]+/;

const cls = (el: Element): string =>
  typeof el.className === "string" ? el.className : "";

/** Ancestors of `el`, stopping at (and including) `root`. */
function ancestorsWithin(el: Element, root: Element): Element[] {
  const out: Element[] = [];
  let cur: Element | null = el.parentElement;
  while (cur) {
    out.push(cur);
    if (cur === root) break;
    cur = cur.parentElement;
  }
  return out;
}

async function openAddContactsOverlay(): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(<EditContactsModal {...createDefaultProps()} />);
  await waitFor(() => {
    expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
  });
  await user.click(screen.getByTestId("add-contacts-button"));
  // Wait for the async address-book load so the list's own rows/buttons exist.
  await screen.findByTestId("add-contacts-overlay");
  await waitFor(() => {
    expect(screen.queryAllByTestId("contact-row").length).toBeGreaterThan(0);
  });
  return screen.getByTestId("add-contacts-overlay");
}

describe("BACKLOG-2639 — the Add Contacts commit control participates in layout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // One contact already on the deal: that is what makes screen 1 render its
    // "Add Contacts" entry button (with none assigned it renders the empty
    // state's own button instead), and it leaves Sam + Zoe in Available.
    mockGetDetails.mockResolvedValue({
      success: true,
      transaction: {
        contact_assignments: [{ id: "a1", contact_id: "c-jane", role: "client" }],
      },
    });
    mockGetAvailable.mockResolvedValue({ success: true, contacts: [externalNew] });
    mockBatchUpdateContacts.mockResolvedValue({ success: true, autoLinkResults: [] });
  });

  it("renders exactly ONE commit control, inside the in-flow footer", async () => {
    await openAddContactsOverlay();

    // One control, not a desktop copy plus a floating copy. Two copies is how
    // the two drifted apart: only one of them was ever display-gated, so only
    // one of them was ever considered when the layout changed.
    const commits = screen.getAllByTestId("add-selected-button");
    expect(commits).toHaveLength(1);
    expect(screen.queryByTestId("add-selected-button-mobile")).toBeNull();

    const footer = screen.getByTestId("add-contacts-footer");
    expect(footer).toContainElement(commits[0]);
  });

  it("the commit control has NO viewport-fixed ancestor — it cannot paint over anything", async () => {
    const overlay = await openAddContactsOverlay();
    const commit = screen.getByTestId("add-selected-button");

    const floatingAncestors = ancestorsWithin(commit, overlay).filter((el) =>
      FIXED.test(cls(el)),
    );

    expect(
      floatingAncestors.map((el) => `<${el.tagName.toLowerCase()} class="${cls(el)}">`),
    ).toEqual([]);
  });

  it("the footer itself is unpositioned, so it reserves space instead of overlaying it", async () => {
    await openAddContactsOverlay();
    const footer = screen.getByTestId("add-contacts-footer");

    expect(FIXED.test(cls(footer))).toBe(false);
    expect(cls(footer)).not.toMatch(/(?:^|\s)absolute(?:\s|$)/);
    // A z-index on an in-flow, unpositioned element does nothing — its presence
    // would mean someone expected this element to win a paint-order race, which
    // is the thinking that produced the bug.
    expect(cls(footer)).not.toMatch(/(?:^|\s)z-/);
    // It must stay out of the content region's way by RESERVING height.
    expect(cls(footer)).toMatch(/(?:^|\s)flex-shrink-0(?:\s|$)/);
  });

  it("no corner-anchored floating control exists anywhere in the overlay", async () => {
    const overlay = await openAddContactsOverlay();

    // The generalized rule, and the reason this guard is about the container
    // rather than about `add-selected-button`: ANY element here that is both
    // taken out of flow and pinned to a corner can cover a control beneath it.
    // Full-screen layers (`fixed inset-0`, how ContactFormModal and every other
    // ResponsiveModal covers the window) are legitimate and excluded.
    const offenders = [overlay, ...Array.from(overlay.querySelectorAll("*"))]
      .filter((el) => FIXED.test(cls(el)) && CORNER.test(cls(el)))
      .map((el) => `<${el.tagName.toLowerCase()} class="${cls(el)}">`);

    expect(offenders).toEqual([]);
  });

  it("keeps the layout classes the wide-width footer rendered with, and is no longer display-gated", async () => {
    await openAddContactsOverlay();
    const footer = screen.getByTestId("add-contacts-footer");
    const c = cls(footer);

    // Every class the pre-fix `hidden sm:flex ...` footer used at sm+ is still
    // here, so the wide-width rendering is the one that already shipped.
    for (const kept of [
      "flex-shrink-0",
      "px-6",
      "py-4",
      "bg-gray-50",
      "rounded-b-xl",
      "items-center",
      "justify-between",
    ]) {
      expect(c).toMatch(new RegExp(`(?:^|\\s)${kept.replace(/[-]/g, "-")}(?:\\s|$)`));
    }
    // ...and it is a flex row at EVERY width now, not only at sm+.
    expect(c).toMatch(/(?:^|\s)flex(?:\s|$)/);
    expect(c).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
    expect(c).not.toMatch(/(?:^|\s)sm:flex(?:\s|$)/);
  });
});
