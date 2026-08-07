/**
 * RemovedTransactionContactsSection tests (BACKLOG-2367)
 *
 * The "Show removed contacts (N)" section under Key Contacts on a transaction:
 * it must list the right parties and restore the right one, on the right deal.
 *
 * ===========================================================================
 * THE FIXTURE IS TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * `makeRemovedTransactionContact` reproduces the actual output of
 * `transactionContactDbService.getRemovedTransactionContacts`, captured by
 * running that function against a real SQLite database built from
 * `electron/database/schema.sql` plus migration v56's DDL. Details that would
 * have been wrong if typed from memory:
 *
 *   - `is_primary` comes back as the NUMBER 1, not `true`.
 *   - `removed_at` / `created_at` are SQLite `"YYYY-MM-DD HH:MM:SS"` strings
 *     (a SPACE), not ISO 8601 with `T`/`Z`.
 *   - The row carries `contact_name` / `contact_email` / `contact_phone`, not a
 *     nested contact object — the query flattens them with aliases.
 *   - Unlike the LIVE read, this query selects no `contact_email_count` /
 *     `contact_phone_count`; a card relying on them would render `undefined`.
 *
 * ===========================================================================
 * THE KEY AND THE RESTORE ARGUMENT ARE DIFFERENT IDS
 * ===========================================================================
 * The list is keyed on `id` (the junction row) while the restore call takes
 * `contact_id`. Confusing the two is the most likely defect in this file, so
 * the restore argument is asserted explicitly — passing the junction id there
 * restores nothing, and that IS observable.
 *
 * The KEY choice is a different matter and is not observable: UNIQUE(
 * transaction_id, contact_id) means `contact_id` is unique within this list
 * too, so either key behaves identically. The selection test below says so
 * rather than pretending otherwise.
 *
 * Fixture values are reserved-for-documentation only.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RemovedTransactionContactsSection } from "../RemovedTransactionContactsSection";

const TXN_ID = "txn-alpha";

/** BulkSelectionBar renders its action button twice (responsive layouts). */
const first = (testId: string) => screen.getAllByTestId(testId)[0];

/**
 * Transcribed from a real `getRemovedTransactionContacts` row. The captured row:
 *   {
 *     "id": "tc-probe", "transaction_id": "txn-probe", "contact_id": "c-probe",
 *     "role": "listing_agent", "role_category": "agent",
 *     "specific_role": "listing_agent", "is_primary": 1,
 *     "notes": "Primary listing contact",
 *     "created_at": "2026-08-05 03:08:06", "updated_at": "2026-08-05 03:08:06",
 *     "removed_at": "2026-08-05 03:08:06",
 *     "removed_reason": "Removed from transaction by user",
 *     "contact_name": "Dana Example", "contact_email": "dana@example.com",
 *     "contact_phone": "+15550100", "contact_company": "Example Realty",
 *     "contact_title": "Broker", "contact_source": "manual"
 *   }
 */
function makeRemovedTransactionContact(o: {
  id: string;
  contact_id: string;
  contact_name: string;
  specific_role?: string;
  removed_reason?: string;
  /**
   * BACKLOG-2568 — the CONTACT tombstone (`contacts.removed_at`), added to this
   * projection by that task. Defaults to null: the person is still in the
   * address book, which is the common case and the state every pre-existing
   * test in this file was implicitly assuming. Format verified against the real
   * driver in transactionContactDbService.tombstone.test.ts — "YYYY-MM-DD
   * HH:MM:SS", the same SQLite shape as `removed_at`, NOT ISO-8601.
   */
  contact_removed_at?: string | null;
}) {
  return {
    id: o.id,
    transaction_id: TXN_ID,
    contact_id: o.contact_id,
    role: o.specific_role ?? "listing_agent",
    role_category: "agent",
    specific_role: o.specific_role ?? "listing_agent",
    is_primary: 1,
    notes: "Primary listing contact",
    created_at: "2026-08-05 03:08:06",
    updated_at: "2026-08-05 03:08:06",
    removed_at: "2026-08-05 03:08:06",
    removed_reason: o.removed_reason ?? "Removed from transaction by user",
    contact_removed_at: o.contact_removed_at ?? null,
    contact_name: o.contact_name,
    contact_email: "dana@example.com",
    contact_phone: "+15550100",
    contact_company: "Example Realty",
    contact_title: "Broker",
    contact_source: "manual",
  };
}

const JANE = makeRemovedTransactionContact({
  id: "tc-jane",
  contact_id: "contact-jane",
  contact_name: "Jane Example",
  specific_role: "listing_agent",
});
const OMAR = makeRemovedTransactionContact({
  id: "tc-omar",
  contact_id: "contact-omar",
  contact_name: "Omar Example",
  specific_role: "lender",
});

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).getRemovedContacts = jest.fn();
  (window.api.transactions as any).restoreContact = jest.fn();
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.transactions.restoreContact as jest.Mock).mockResolvedValue({
    success: true,
    restored: true,
    restoredCount: 1,
  });
});

async function openSection() {
  await act(async () => {
    await userEvent.click(screen.getByTestId("show-removed-transaction-contacts-toggle"));
  });
  await waitFor(() => {
    expect(
      screen.getByTestId("removed-transaction-contacts-section"),
    ).toBeInTheDocument();
  });
}

/** Party names currently rendered, sorted — the identity set under test. */
function renderedNames(): string[] {
  return screen
    .getAllByTestId("removed-transaction-contact-card")
    .map((card) => card.querySelector("span")?.textContent ?? "")
    .sort();
}

function renderSection(props: Record<string, unknown> = {}) {
  return render(
    <RemovedTransactionContactsSection
      transactionId={TXN_ID}
      transactionType="purchase"
      {...props}
    />,
  );
}

describe("RemovedTransactionContactsSection", () => {
  it("does not fetch until the section is opened", () => {
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE],
    });

    renderSection();

    expect(window.api.transactions.getRemovedContacts).not.toHaveBeenCalled();
  });

  it("lists exactly the parties removed from THIS transaction", async () => {
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE, OMAR],
    });

    renderSection();
    await openSection();

    expect(renderedNames()).toEqual(["Jane Example", "Omar Example"]);
    expect(window.api.transactions.getRemovedContacts).toHaveBeenCalledWith(TXN_ID);
  });

  /**
   * BACKLOG-2501 — the removal reason line is gone from the card.
   *
   * This card printed `removed_reason` RAW, so every row read "Removed from
   * transaction by user" — `DEFAULT_REMOVAL_REASON`, byte-identical on every
   * card. Both fixtures carry it, so a restored reason span shows up twice.
   *
   * Counting the metadata row's children is the part that can actually fail in
   * both directions: 2 if the reason comes back, 0 if the date is lost with it.
   */
  it("prints the removal date and no removal reason", async () => {
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE, OMAR],
    });

    renderSection();
    await openSection();

    const meta = screen.getAllByTestId("removed-transaction-contact-meta");
    expect(meta.map((el) => el.children.length)).toEqual([1, 1]);
    expect(meta.map((el) => el.textContent?.startsWith("Removed "))).toEqual([
      true,
      true,
    ]);
    expect(
      screen.queryByText("Removed from transaction by user"),
    ).not.toBeInTheDocument();
  });

  it("restores using contact_id and the transaction id — NOT the junction row id", async () => {
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE],
    });
    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);

    renderSection({ onRestoreComplete });
    await openSection();

    await act(async () => {
      await userEvent.click(screen.getByTestId("restore-transaction-contact-button"));
    });

    expect(window.api.transactions.restoreContact).toHaveBeenCalledTimes(1);
    // The junction id is "tc-jane"; passing it here would restore nothing.
    expect(window.api.transactions.restoreContact).toHaveBeenCalledWith(
      TXN_ID,
      "contact-jane",
    );
    expect(onRestoreComplete).toHaveBeenCalledTimes(1);
  });

  it("drops only the restored party from the list", async () => {
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE, OMAR],
    });

    renderSection();
    await openSection();

    const janeCard = screen
      .getAllByTestId("removed-transaction-contact-card")
      .find((c) => c.textContent?.includes("Jane Example"))!;
    await act(async () => {
      await userEvent.click(
        janeCard.parentElement!.querySelector(
          '[data-testid="restore-transaction-contact-button"]',
        )!,
      );
    });

    await waitFor(() => {
      expect(renderedNames()).toEqual(["Omar Example"]);
    });
  });

  it("selects each removed party independently, by junction row", async () => {
    // WHAT THIS DOES AND DOES NOT PROVE — stated plainly, because the earlier
    // version of this test was built on a state the database cannot produce.
    //
    // It first seeded ONE contact twice on ONE deal, to show that keying on
    // `contact_id` collapses two rows into one selection. But
    // `transaction_contacts` declares UNIQUE(transaction_id, contact_id)
    // (asserted in the DB suite for this feature), so that row pair can never
    // exist. The fixture described an impossible state, which makes any
    // conclusion drawn from it worthless — the same defect class this PR
    // removed from the transactionContactDbService header comment.
    //
    // Under the real schema `contact_id` is ALSO unique within this list, so
    // the key choice is genuinely not observable from behaviour. Keying on the
    // row's own id is a defensive preference, not a fix for a live bug, and
    // this test therefore asserts the property that IS reachable and does
    // matter: two removed parties select independently of one another.
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE, OMAR],
    });

    renderSection();
    await openSection();

    await act(async () => {
      await userEvent.click(screen.getByTestId("select-removed-transaction-contacts"));
    });

    const checkboxes = screen.getAllByTestId("removed-group-select");
    expect(checkboxes).toHaveLength(2);

    await act(async () => {
      await userEvent.click(checkboxes[0]);
    });

    // Exactly one selected — ticking Jane must not tick Omar.
    expect(
      screen.getAllByTestId("removed-group-select").map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["true", "false"]);
  });

  it("surfaces a backend failure and keeps the row in the list", async () => {
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE],
    });
    (window.api.transactions.restoreContact as jest.Mock).mockResolvedValue({
      success: false,
      error: "transaction not found",
    });
    const onShowError = jest.fn();
    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);

    renderSection({ onShowError, onRestoreComplete });
    await openSection();

    await act(async () => {
      await userEvent.click(screen.getByTestId("restore-transaction-contact-button"));
    });

    expect(onShowError).toHaveBeenCalledWith("transaction not found");
    expect(renderedNames()).toEqual(["Jane Example"]);
    expect(onRestoreComplete).not.toHaveBeenCalled();
  });

  it("shows the empty state when nobody has been removed from the deal", async () => {
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [],
    });

    renderSection();
    await openSection();

    expect(screen.getByText("No removed contacts found.")).toBeInTheDocument();
  });

  it("bulk-restores exactly the selected parties, with one parent refresh", async () => {
    const KIM = makeRemovedTransactionContact({
      id: "tc-kim",
      contact_id: "contact-kim",
      contact_name: "Kim Example",
      specific_role: "escrow_officer",
    });
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE, OMAR, KIM],
    });
    const onRestoreComplete = jest.fn().mockResolvedValue(undefined);

    renderSection({ onRestoreComplete });
    await openSection();

    await act(async () => {
      await userEvent.click(screen.getByTestId("select-removed-transaction-contacts"));
    });

    for (const el of screen.getAllByTestId("removed-group-selectable")) {
      if (
        el.textContent?.includes("Jane Example") ||
        el.textContent?.includes("Kim Example")
      ) {
        await act(async () => {
          await userEvent.click(el.querySelector('[data-testid="removed-group-select"]')!);
        });
      }
    }

    await act(async () => {
      await userEvent.click(
        first("removed-transaction-contacts-section-bulk-restore"),
      );
    });

    const restoredContactIds = (
      window.api.transactions.restoreContact as jest.Mock
    ).mock.calls
      .map((c) => c[1])
      .sort();
    expect(restoredContactIds).toEqual(["contact-jane", "contact-kim"]);

    await waitFor(() => {
      expect(renderedNames()).toEqual(["Omar Example"]);
    });
    expect(onRestoreComplete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-2568 — the two removal labels, and which comes first.
//
// The founder removed a contact and found him still on a transaction with
// nothing explaining why. The behaviour is correct; the explanation was
// missing. FOUNDER DECISION (2026-08-06): TWO DISTINCT LABELS. One pill
// covering both states was explicitly rejected — it would tell the user the
// wrong thing half the time, because the states are independent:
//
//   "removed from this deal"  -> transaction_contacts.removed_at  (this list)
//   "deleted contact"         -> contacts.removed_at              (address book)
//
// Every row in THIS section is deal-removed by construction (the query filters
// `tc.removed_at IS NOT NULL`), so the deal pill is unconditional here and the
// contact pill is the conditional one.
// ---------------------------------------------------------------------------
describe("BACKLOG-2568: removal labels", () => {
  const DEAL_PILL = "contact-tombstone-pill-deal-removed";
  const CONTACT_PILL = "contact-tombstone-pill-contact-removed";

  it("labels every row as removed from this deal", async () => {
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE, OMAR],
    });

    renderSection();
    await openSection();

    expect(screen.getAllByTestId(DEAL_PILL)).toHaveLength(2);
  });

  it("shows NO deleted-contact pill for a party who is still in the address book", async () => {
    // The negative case. Without it, a pill rendered unconditionally would pass
    // the co-occurrence test below — presence alone cannot separate "correct"
    // from "always on".
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE],
    });

    renderSection();
    await openSection();

    expect(screen.getByTestId(DEAL_PILL)).toBeInTheDocument();
    expect(screen.queryByTestId(CONTACT_PILL)).not.toBeInTheDocument();
  });

  it("shows BOTH pills, deal-removal FIRST, when the party was also deleted", async () => {
    // C4 — the co-occurrence case and the precedence rule.
    //
    // ORDER IS THE ASSERTION, not just presence. The deal fact explains why the
    // row is in this section; the address-book fact has to be seen BEFORE
    // clicking Restore, because restoring the role returns someone to the deal
    // who is still absent from Clients & Contacts and from the Edit Contacts
    // picker. Swap the two elements in renderGroup and this goes red.
    const deletedToo = makeRemovedTransactionContact({
      id: "tc-pete",
      contact_id: "contact-pete",
      contact_name: "Pete Example",
      specific_role: "lender",
      contact_removed_at: "2026-08-06 14:22:41",
    });
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [deletedToo],
    });

    renderSection();
    await openSection();

    const dealPill = screen.getByTestId(DEAL_PILL);
    const contactPill = screen.getByTestId(CONTACT_PILL);
    expect(dealPill).toBeInTheDocument();
    expect(contactPill).toBeInTheDocument();

    // DOCUMENT_POSITION_FOLLOWING === the contact pill comes AFTER the deal pill.
    expect(
      dealPill.compareDocumentPosition(contactPill) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The two labels say different things — the whole point of the founder's
    // decision. Asserted verbatim so a future edit cannot quietly merge them.
    expect(dealPill).toHaveTextContent("Removed from this deal");
    expect(contactPill).toHaveTextContent("Deleted contact");
  });

  it("keeps the party's name and restore button intact alongside the pills", async () => {
    // The pills sit in the same row as the name and next to the restore
    // cluster. This pins that adding them did not displace either.
    const deletedToo = makeRemovedTransactionContact({
      id: "tc-pete",
      contact_id: "contact-pete",
      contact_name: "Pete Example",
      contact_removed_at: "2026-08-06 14:22:41",
    });
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [deletedToo],
    });

    renderSection();
    await openSection();

    expect(screen.getByText("Pete Example")).toBeInTheDocument();
    expect(
      screen.getByTestId("restore-transaction-contact-button"),
    ).toBeInTheDocument();
  });
  it("treats an empty-string contact tombstone as no tombstone", async () => {
    // Boundary, matching ContactSummaryCard's guard. A `!= null` check lights
    // the pill on "" — that is how this defect was caught on the other site.
    const emptyTombstone = makeRemovedTransactionContact({
      id: "tc-dana",
      contact_id: "contact-dana",
      contact_name: "Dana Example",
      contact_removed_at: "",
    });
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [emptyTombstone],
    });

    renderSection();
    await openSection();

    expect(screen.getByTestId(DEAL_PILL)).toBeInTheDocument();
    expect(screen.queryByTestId(CONTACT_PILL)).not.toBeInTheDocument();
  });
});
