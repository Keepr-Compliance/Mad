/**
 * ContactRow — saying that a collapse happened (BACKLOG-2459).
 *
 * Founder: *"i like that we do dedup upon import but a user must have a way to
 * see that"*. Observed `picker: 1126 in -> dup-suppressed 21 -> shown 1105`.
 * Twenty-one people were folded together with nothing on screen to say so.
 *
 * A contact here is a party to a transaction under audit, so the row is held to
 * two things: it must STATE how many records were combined, and it must SHOW
 * which — naming each folded record and the detail the two agreed on.
 *
 * ## The sentence must be TRUE in every shape, not most of them
 *
 * The first version reused `summaryForReason("duplicate_source_record")`, which
 * asserts *"you already have X saved from one of them"* and *"Two entries in
 * your {source}"*. SR review found both false in the founder's own data: the
 * surviving row is routinely an UNIMPORTED address-book record (so nothing is
 * saved, and the row still shows its import button), and the two records
 * routinely come from DIFFERENT address books. The two `never …` cases below are
 * the regression guard for exactly those claims.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ContactRow } from "./ContactRow";
import type { ExtendedContact } from "../../types/components";
import type { FoldedRecord } from "../../utils/contactCollapseDisclosure";

function contact(overrides: Partial<ExtendedContact> = {}): ExtendedContact {
  return {
    id: "keeper-1",
    user_id: "user-1",
    name: "Alice Example",
    display_name: "Alice Example",
    email: "alice.example@example.test",
    source: "contacts_app",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as ExtendedContact;
}

function folded(overrides: Partial<FoldedRecord> = {}): FoldedRecord {
  return {
    key: "main:0",
    label: "Alice E",
    sourceLabel: "Outlook contacts",
    matchedOn: "email",
    matchedValue: "alice.example@example.test",
    ...overrides,
  };
}

const recordNames = (): string[] =>
  screen
    .getAllByTestId("contact-row-collapsed-record-name")
    .map((el) => el.textContent ?? "");

/** The SENTENCE only — not the record label above it. */
const detailText = (): string =>
  screen.getByTestId("contact-row-collapsed-record-reason").textContent ?? "";

describe("ContactRow — collapsed-record disclosure (BACKLOG-2459)", () => {
  it("renders nothing when nothing was folded into the row", () => {
    render(<ContactRow contact={contact()} />);

    expect(screen.queryByTestId("contact-row-collapsed-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("contact-row-collapsed-detail")).not.toBeInTheDocument();
  });

  it("renders nothing for an empty list (not '0 records combined')", () => {
    render(<ContactRow contact={contact()} collapsedRecords={[]} />);

    expect(screen.queryByTestId("contact-row-collapsed-toggle")).not.toBeInTheDocument();
  });

  it("states how many records were combined, and stays collapsed until asked", async () => {
    const records = [
      folded({ key: "main:0", label: "Alice E" }),
      folded({ key: "main:1", label: "A Example" }),
    ];

    render(<ContactRow contact={contact()} collapsedRecords={records} />);

    const toggle = screen.getByTestId("contact-row-collapsed-toggle");
    expect(toggle).toHaveTextContent("2 records combined");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("contact-row-collapsed-detail")).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // WHICH records — the exact set, by the label each one displays.
    expect(recordNames()).toEqual(["Alice E", "A Example"]);
  });

  it("says 'record' for one and 'records' for more than one", () => {
    render(<ContactRow contact={contact()} collapsedRecords={[folded()]} />);

    expect(screen.getByTestId("contact-row-collapsed-toggle")).toHaveTextContent(
      "1 record combined",
    );
  });

  it("expanding the evidence does NOT open the contact", async () => {
    const onSelect = jest.fn();
    render(
      <ContactRow contact={contact()} collapsedRecords={[folded()]} onSelect={onSelect} />,
    );
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    expect(screen.getByTestId("contact-row-collapsed-detail")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    // The row itself still opens the contact.
    await userEvent.click(screen.getByTestId("contact-row-name"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("ContactRow — the collapse sentence is true in every shape", () => {
  it("names the folded record, its source, and the agreed email — masked", async () => {
    render(
      <ContactRow
        contact={contact()}
        collapsedRecords={[
          folded({
            label: "Alice E",
            sourceLabel: "Outlook contacts",
            matchedOn: "email",
            matchedValue: "alice.example@example.test",
          }),
        ]}
      />,
    );
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    expect(detailText()).toBe(
      "Alice E from your Outlook contacts is shown on this row, because both list " +
        "the email address al…@example.test.",
    );
    // Recognisable, not harvestable — the full local part is never printed.
    expect(detailText()).not.toContain("alice.example@example.test");
  });

  it("names a phone collapse by the last four digits", async () => {
    render(
      <ContactRow
        contact={contact({ display_name: "Bea Example" })}
        collapsedRecords={[
          folded({
            label: "Bea E",
            sourceLabel: "Mac address book",
            matchedOn: "phone",
            matchedValue: "+1 (415) 555-0177",
          }),
        ]}
      />,
    );
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    expect(detailText()).toBe(
      "Bea E from your Mac address book is shown on this row, because both list " +
        "the phone number …0177.",
    );
    expect(detailText()).not.toContain("555-0177");
  });

  it("names a name-only collapse by the name as saved, with no source clause", async () => {
    render(
      <ContactRow
        contact={contact({ display_name: "Elm Example", email: "" })}
        collapsedRecords={[
          folded({
            label: "elm example",
            sourceLabel: null,
            matchedOn: "name",
            matchedValue: "elm example",
          }),
        ]}
      />,
    );
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    // The record has no address book behind it. A sentence that omits an unknown
    // is true; one that guesses is not.
    expect(detailText()).toBe(
      'elm example is shown on this row, because both list the name "elm example".',
    );
  });

  it("degrades to a true sentence when the folded record has no name", async () => {
    render(
      <ContactRow
        contact={contact()}
        collapsedRecords={[folded({ label: null, sourceLabel: "iPhone" })]}
      />,
    );
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    expect(recordNames()).toEqual(["No name"]);
    expect(detailText()).toBe(
      "A record with no name from your iPhone is shown on this row, because both " +
        "list the email address al…@example.test.",
    );
  });

  it("never claims the row is already saved — the keeper is often an UNIMPORTED record", async () => {
    // SR review, falsehood 1. The founder's own 1126 -> 1105 shape: two
    // address-book records collapse into one, and that row is NOT saved — it
    // still renders its own import button. The old sentence said "you already
    // have Alice Example saved from one of them" directly above that button.
    render(
      <ContactRow
        contact={contact({ is_message_derived: true })}
        isExternal
        showImportButton
        onImport={jest.fn()}
        collapsedRecords={[folded({ label: "Alice E", sourceLabel: "Mac address book" })]}
      />,
    );
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    const text = detailText().toLowerCase();
    expect(text).not.toContain("already have");
    expect(text).not.toContain("saved from one of them");
    // The row really does still offer to save it — the contradiction the old
    // sentence created was reachable on screen, not hypothetical.
    expect(screen.getByTestId("contact-row-import-button")).toBeInTheDocument();
  });

  it("never attributes BOTH records to one address book", async () => {
    // SR review, falsehood 2. The keeper is an Outlook contact and the folded
    // record came from the Mac address book; "Two entries in your Contacts App"
    // was wrong about one of them. The source clause is now scoped to the folded
    // record alone ("... from your Mac address book").
    render(
      <ContactRow
        contact={contact({ source: "outlook" })}
        collapsedRecords={[folded({ label: "Alice E", sourceLabel: "Mac address book" })]}
      />,
    );
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    expect(detailText()).not.toContain("Two entries");
    expect(detailText()).toContain("from your Mac address book");
    // Says nothing about where the SURVIVING row came from — the collapse never
    // established that, so it is not claimed.
    expect(detailText()).not.toContain("Outlook");
  });

  it("never emits a number that reads as a likelihood", async () => {
    render(<ContactRow contact={contact()} collapsedRecords={[folded()]} />);
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    const text = detailText();
    expect(text).not.toMatch(/\b0\.\d+\b/);
    expect(text.toLowerCase()).not.toContain("confidence");
    expect(text.toLowerCase()).not.toContain("score");
  });
});
