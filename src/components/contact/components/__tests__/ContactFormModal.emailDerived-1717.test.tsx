/**
 * BACKLOG-1717 — editing a person found in email must not lose their address.
 *
 * ---------------------------------------------------------------------------
 * THE PATH
 * ---------------------------------------------------------------------------
 * In Clients & Contacts, the Edit action on an unsaved record opens this form.
 * The form's first effect asks main for the contact's stored email and phone
 * entries — a sensible thing to do for a SAVED contact, and meaningless for a
 * record that has never been saved.
 *
 * It skipped that call for text-derived records (`msg_` ids) and nothing else.
 * An email person's id is `email_<address>`, which is not a UUID, so:
 *
 *   getEditData("email_avery@example.com")
 *     -> validateContactId rejects a non-UUID
 *     -> the handler returns { success: false }
 *     -> the `.then` seeds NOTHING, because seeding lives inside `if (success)`
 *     -> and `.catch` never runs, because a resolved `{success:false}` is not
 *        a rejection
 *
 * so the form opens with the address field EMPTY, and saving creates a contact
 * without the one piece of information the record carried. The person the user
 * was looking at becomes a name with no way to reach them.
 *
 * The fix is one term: the effect skips unsaved records of BOTH kinds.
 *
 * Mutation that reds this: drop `email_` from that guard.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import ContactFormModal from "../ContactFormModal";
import type { ExtendedContact } from "../../types";

const AVERY = "avery@example.com";

const getEditData = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  /**
   * What the real handler answers for a non-UUID id. Transcribed from the
   * handler's own failure arm rather than invented: `validateContactId` throws
   * on anything that is not a UUID and the catch returns `{ success: false }`.
   * A rejected promise would be the WRONG fixture — it would exercise the
   * `.catch` branch, which seeds the address and would hide the defect.
   */
  getEditData.mockResolvedValue({ success: false, error: "Invalid contact ID" });

  (window as unknown as { api: unknown }).api = {
    contacts: {
      getEditData,
      create: jest.fn().mockResolvedValue({ success: true, contact: { id: "new-id" } }),
      update: jest.fn().mockResolvedValue({ success: true }),
      import: jest.fn().mockResolvedValue({ success: true, contact: { id: "new-id" } }),
    },
  };
});

/** The record the producer hands the picker, as the picker passes it on. */
const EMAIL_PERSON = {
  id: `email_${AVERY}`,
  name: "Avery Example",
  display_name: "Avery Example",
  email: AVERY,
  phone: null,
  company: null,
  source: "email_derived",
  // `useContactDirectory` stamps this on every address-book row.
  is_message_derived: true,
} as unknown as ExtendedContact;

function renderForm(contact: ExtendedContact) {
  return render(
    <ContactFormModal
      userId="550e8400-e29b-41d4-a716-446655440000" // pii-allow-uuid: invented, not from any live row
      contact={contact}
      onClose={jest.fn()}
      onSuccess={jest.fn()}
    />,
  );
}

describe("BACKLOG-1717 — editing a person found in email", () => {
  it("does not ask main for stored entries a record cannot have", async () => {
    renderForm(EMAIL_PERSON);
    await waitFor(() => expect(screen.getByDisplayValue("Avery Example")).toBeInTheDocument());
    expect(getEditData).not.toHaveBeenCalled();
  });

  /**
   * ASSERTED ON THE SETTLED FORM, NOT A PASSING FRAME.
   *
   * The first version of this control just waited for the address to appear,
   * and it PASSED on the unfixed code — because the form flips to its
   * single-field layout while the lookup is in flight, and that layout renders
   * the flat `email`. `waitFor` caught that frame and called it a pass. The
   * address then disappeared again when the lookup resolved.
   *
   * So: settle first (the name is stable throughout), flush the microtask
   * queue the lookup would have used, and only then look for the address.
   */
  it("shows the address the record carried, once the form has settled", async () => {
    renderForm(EMAIL_PERSON);
    await waitFor(() => expect(screen.getByDisplayValue("Avery Example")).toBeInTheDocument());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue(AVERY)).toBeInTheDocument();
  });

  /**
   * THE HARNESS CONTROL. A saved contact must STILL be looked up — otherwise
   * "does not call getEditData" could be satisfied by a form that never calls
   * it for anybody, and the two assertions above would prove nothing.
   */
  it("still looks up a saved contact's stored entries", async () => {
    getEditData.mockResolvedValue({
      success: true,
      emails: [{ id: "e1", email: "saved@example.com", is_primary: true }],
      phones: [],
    });
    renderForm({
      id: "550e8400-e29b-41d4-a716-446655440111", // pii-allow-uuid: invented, not from any live row
      name: "Saved Person",
      display_name: "Saved Person",
      email: "saved@example.com",
      source: "manual",
    } as unknown as ExtendedContact);

    await waitFor(() => expect(getEditData).toHaveBeenCalledTimes(1));
    expect(getEditData).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440111"); // pii-allow-uuid: invented, not from any live row
  });

  /** And the text-derived guard that was already there still holds. */
  it("still skips the lookup for a person found in texts", async () => {
    renderForm({
      id: "msg_dana example",
      name: "Dana Example",
      display_name: "Dana Example",
      source: "messages",
      is_message_derived: true,
    } as unknown as ExtendedContact);

    await waitFor(() => expect(screen.getByDisplayValue("Dana Example")).toBeInTheDocument());
    expect(getEditData).not.toHaveBeenCalled();
  });
});
