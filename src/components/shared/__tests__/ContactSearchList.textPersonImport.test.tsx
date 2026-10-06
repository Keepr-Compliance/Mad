/**
 * Live (2026-10-04): clicking a person found in texts (no name, phone only)
 * imported a NEW contact on every click and added another pill each time.
 * Now: a double-click while the import is pending starts ONE import, and an
 * import that returns a contact already selected adds no second pill.
 * Mutations: no in-flight ref guard; the selection appended unguarded → red.
 */
import React, { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContactSearchList } from "../ContactSearchList";
import type { ExtendedContact } from "../../../types/components";

jest.mock("../ContactRow", () => ({
  ContactRow: ({ contact, onSelect }: { contact: ExtendedContact; onSelect: () => void }) => (
    <div data-testid={`contact-row-${contact.id}`} onClick={onSelect} role="option" />
  ),
}));

const TEXT_PERSON = {
  id: "msg_tel_+15555550121",
  user_id: "u-1",
  display_name: "+1 (555) 555-0121",
  name: "+1 (555) 555-0121",
  email: null,
  phone: "+15555550121",
  company: null,
  source: "messages",
  is_imported: 0,
  is_message_derived: 1,
  last_communication_at: "2026-09-20T10:00:00.000Z",
} as unknown as ExtendedContact;

const SAVED_ID = "c-saved-0121";

function Harness({ onImport, selection }: { onImport: jest.Mock; selection: string[][] }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  return (
    <ContactSearchList
      contacts={[]}
      externalContacts={[TEXT_PERSON]}
      selectedIds={selectedIds}
      onSelectionChange={(ids) => {
        selection.push(ids);
        setSelectedIds(ids);
      }}
      onImportContact={onImport}
    />
  );
}

it("three quick clicks while the import is pending: ONE import, ONE pill", async () => {
  let release: (c: ExtendedContact) => void = () => undefined;
  const onImport = jest.fn(() => new Promise<ExtendedContact>((r) => (release = r)));
  const selection: string[][] = [];
  render(<Harness onImport={onImport} selection={selection} />);
  const row = screen.getByTestId("contact-row-msg_tel_+15555550121");
  // One batch: React has not re-rendered between the clicks (a real
  // double-click), so only a synchronous guard can stop the 2nd and 3rd.
  act(() => {
    fireEvent.click(row);
    fireEvent.click(row);
    fireEvent.click(row);
  });
  expect(onImport).toHaveBeenCalledTimes(1);
  await act(async () => {
    release({ ...TEXT_PERSON, id: SAVED_ID, is_message_derived: 0 } as ExtendedContact);
  });
  expect(selection[selection.length - 1]).toEqual([SAVED_ID]);
});

it("the import returns a contact already selected (the same number picked again): no second pill", async () => {
  const onImport = jest.fn(async () => ({ ...TEXT_PERSON, id: SAVED_ID, is_message_derived: 0 }) as ExtendedContact);
  const selection: string[][] = [];
  render(<Harness onImport={onImport} selection={selection} />);
  const row = screen.getByTestId("contact-row-msg_tel_+15555550121");
  await act(async () => {
    fireEvent.click(row);
  });
  await act(async () => {
    fireEvent.click(row);
  });
  const last = selection[selection.length - 1];
  expect(last.filter((id) => id === SAVED_ID)).toHaveLength(1);
});
