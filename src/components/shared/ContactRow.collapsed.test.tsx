/**
 * ContactRow — saying that a collapse happened (BACKLOG-2459).
 *
 * Founder: *"i like that we do dedup upon import but a user must have a way to
 * see that"*. Observed `picker: 1126 in -> dup-suppressed 21 -> shown 1105`.
 * Twenty-one people were folded together with nothing on screen to say so.
 *
 * A contact here is a party to a transaction under audit, so these tests hold
 * the row to two things: it must STATE how many records were combined, and it
 * must be able to SHOW which — naming each folded record and the detail the two
 * agreed on, in the words BACKLOG-2410 already established.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ContactRow } from "./ContactRow";
import type { ExtendedContact } from "../../types/components";
import type { CollapsedContactRecord } from "../../utils/contactPickerList";

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

const recordNames = (): string[] =>
  screen
    .getAllByTestId("contact-row-collapsed-record-name")
    .map((el) => el.textContent ?? "");

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
    const collapsed: CollapsedContactRecord[] = [
      {
        contact: contact({ id: "ext-1", display_name: "Alice E", email: "alice.example@example.test" }),
        matchedOn: "email",
        matchedValue: "alice.example@example.test",
      },
      {
        contact: contact({ id: "ext-2", display_name: "A Example", email: "alice.example@example.test" }),
        matchedOn: "email",
        matchedValue: "alice.example@example.test",
      },
    ];

    render(<ContactRow contact={contact()} collapsedRecords={collapsed} />);

    const toggle = screen.getByTestId("contact-row-collapsed-toggle");
    expect(toggle).toHaveTextContent("2 records combined");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("contact-row-collapsed-detail")).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // WHICH records — the exact set, by the label each one displays.
    expect(recordNames()).toEqual(["Alice E", "A Example"]);
  });

  it("says 'record' for one and 'records' for more than one", async () => {
    const one: CollapsedContactRecord[] = [
      {
        contact: contact({ id: "ext-1", display_name: "Alice E" }),
        matchedOn: "email",
        matchedValue: "alice.example@example.test",
      },
    ];
    render(<ContactRow contact={contact()} collapsedRecords={one} />);

    expect(screen.getByTestId("contact-row-collapsed-toggle")).toHaveTextContent(
      "1 record combined",
    );
  });

  it("explains an email collapse with the BACKLOG-2410 sentence, masking the address", async () => {
    const collapsed: CollapsedContactRecord[] = [
      {
        contact: contact({
          id: "ext-1",
          display_name: "Alice E",
          source: "contacts_app",
          email: "alice.example@example.test",
        }),
        matchedOn: "email",
        matchedValue: "alice.example@example.test",
      },
    ];

    render(<ContactRow contact={contact()} collapsedRecords={collapsed} />);
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    const detail = screen.getByTestId("contact-row-collapsed-detail");
    expect(detail).toHaveTextContent(
      'Two entries in your Contacts App both list the email address al…@example.test, ' +
        "and you already have Alice Example saved from one of them. This is usually one " +
        "person saved twice.",
    );
    // Recognisable, not harvestable — the full local part is never printed.
    expect(detail).not.toHaveTextContent("alice.example@example.test");
  });

  it("explains a phone collapse by the last four digits", async () => {
    const collapsed: CollapsedContactRecord[] = [
      {
        contact: contact({
          id: "ext-1",
          display_name: "Bea E",
          source: "outlook",
          email: "",
          phone: "+1 (415) 555-0177",
        }),
        matchedOn: "phone",
        matchedValue: "+1 (415) 555-0177",
      },
    ];

    render(
      <ContactRow contact={contact({ display_name: "Bea Example" })} collapsedRecords={collapsed} />,
    );
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    const detail = screen.getByTestId("contact-row-collapsed-detail");
    expect(detail).toHaveTextContent("the phone number …0177");
    expect(detail).toHaveTextContent("Two entries in your Outlook both list");
    expect(detail).not.toHaveTextContent("555-0177");
  });

  it("explains a name-only collapse by naming the name as saved", async () => {
    const collapsed: CollapsedContactRecord[] = [
      {
        contact: contact({
          id: "ext-1",
          display_name: "elm example",
          source: "contacts_app",
          email: "",
        }),
        matchedOn: "name",
        matchedValue: "elm example",
      },
    ];

    render(
      <ContactRow
        contact={contact({ display_name: "Elm Example", email: "" })}
        collapsedRecords={collapsed}
      />,
    );
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    expect(screen.getByTestId("contact-row-collapsed-detail")).toHaveTextContent(
      'the name "elm example"',
    );
  });

  it("never emits a number that reads as a likelihood", async () => {
    const collapsed: CollapsedContactRecord[] = [
      {
        contact: contact({ id: "ext-1", display_name: "Alice E" }),
        matchedOn: "email",
        matchedValue: "alice.example@example.test",
      },
    ];

    render(<ContactRow contact={contact()} collapsedRecords={collapsed} />);
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    const text = screen.getByTestId("contact-row-collapsed-detail").textContent ?? "";
    expect(text).not.toMatch(/\b0\.\d+\b/);
    expect(text.toLowerCase()).not.toContain("confidence");
    expect(text.toLowerCase()).not.toContain("score");
  });

  it("expanding the evidence does NOT open the contact", async () => {
    const onSelect = jest.fn();
    const collapsed: CollapsedContactRecord[] = [
      {
        contact: contact({ id: "ext-1", display_name: "Alice E" }),
        matchedOn: "email",
        matchedValue: "alice.example@example.test",
      },
    ];

    render(<ContactRow contact={contact()} collapsedRecords={collapsed} onSelect={onSelect} />);
    await userEvent.click(screen.getByTestId("contact-row-collapsed-toggle"));

    expect(screen.getByTestId("contact-row-collapsed-detail")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    // The row itself still opens the contact.
    await userEvent.click(screen.getByTestId("contact-row-name"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
