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
 * THE KEY vs THE RESTORE ARGUMENT ARE DIFFERENT IDS
 * ===========================================================================
 * The list is keyed on `id` (the junction row) because one contact can hold two
 * roles on one deal, but the restore call takes `contact_id`. Confusing the two
 * is the most likely defect in this file, so it is asserted explicitly.
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

  it("keys each row on the junction id, so ONE contact's two roles select independently", async () => {
    // The same person holding two roles on one deal, both removed.
    //
    // Asserting only that two cards render does NOT test this: React tolerates
    // duplicate keys and renders both children anyway, so that assertion passes
    // even when the rows are keyed on contact_id. (Verified — control U2 stayed
    // green against exactly that assertion, which is why this test asserts
    // SELECTION instead.) Sharing a key makes the two rows share a selection
    // entry, so ticking one role silently ticks the other and a bulk restore
    // brings back a role the user never chose.
    const janeSecondRole = makeRemovedTransactionContact({
      id: "tc-jane-2",
      contact_id: "contact-jane",
      contact_name: "Jane Example",
      specific_role: "buyer_agent",
    });
    (window.api.transactions.getRemovedContacts as jest.Mock).mockResolvedValue({
      success: true,
      removedContacts: [JANE, janeSecondRole],
    });

    renderSection();
    await openSection();
    expect(renderedNames()).toEqual(["Jane Example", "Jane Example"]);

    await act(async () => {
      await userEvent.click(screen.getByTestId("select-removed-transaction-contacts"));
    });

    const checkboxes = screen.getAllByTestId("removed-group-select");
    expect(checkboxes).toHaveLength(2);

    await act(async () => {
      await userEvent.click(checkboxes[0]);
    });

    // Exactly ONE of Jane's two roles is now selected.
    const pressed = screen
      .getAllByTestId("removed-group-select")
      .map((b) => b.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["true", "false"]);
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
