/**
 * BACKLOG-2804 (support ticket 111) — the Default Role picker after the rename.
 *
 * `seller_agent` now renders as "Listing Agent" so the chip on a transaction
 * says what the industry says. This modal's "Default Role" select is the only
 * picker built from the WHOLE of ROLE_DISPLAY_NAMES, so it is the only place
 * that rename could put two options reading the same word in front of a user
 * with no way to tell them apart.
 *
 * `seller_agent` is the survivor: it is the value the audit wizard actually
 * assigns (AUDIT_WORKFLOW_STEPS offers it and never offers `listing_agent`).
 * The collapse is display-only — a contact already saved as `listing_agent`
 * keeps its option, because a <select> whose value matches no <option> renders
 * blank and would rewrite that contact's role on the next save.
 *
 * Assertions name the exact option and its VALUE, never a count of matches:
 * "one option says Listing Agent" is satisfied by the wrong one surviving.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContactFormModal from "../ContactFormModal";
import type { ExtendedContact } from "../../types";

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window as any).api = (window as any).api ?? {};
  (window as any).api.contacts = {
    ...((window as any).api.contacts ?? {}),
    // Editing an existing contact loads its email/phone entries on mount.
    getEditData: jest.fn().mockResolvedValue({
      success: true,
      emails: [],
      phones: [],
    }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

function renderModal(contact?: ExtendedContact) {
  return render(
    <ContactFormModal
      userId="user-1"
      contact={contact}
      onClose={jest.fn()}
      onSuccess={jest.fn()}
    />,
  );
}

/**
 * The Default Role <select>. Found by test id, not by label text: the visible
 * "Default Role" label is not associated with the control (no htmlFor, not
 * wrapping it), so getByLabelText finds nothing here.
 */
function roleSelect(): HTMLSelectElement {
  return screen.getByTestId("contact-default-role") as HTMLSelectElement;
}

function optionsOf(select: HTMLSelectElement) {
  return Array.from(select.options).map((o) => ({
    value: o.value,
    label: o.textContent ?? "",
  }));
}

describe("BACKLOG-2804: Default Role picker offers one seller-side agent", () => {
  it('offers exactly one "Listing Agent" option, and it is seller_agent', () => {
    renderModal();

    const listing = optionsOf(roleSelect()).filter(
      (o) => o.label === "Listing Agent",
    );

    // Identity, not count: the surviving option must be the value the wizard
    // assigns. Dropping the wrong one of the pair also leaves exactly one.
    expect(listing).toHaveLength(1);
    expect(listing[0].value).toBe("seller_agent");
  });

  it('no longer offers "Seller Agent" anywhere in the list', () => {
    renderModal();

    expect(
      optionsOf(roleSelect()).some((o) => o.label === "Seller Agent"),
    ).toBe(false);
  });

  it("still offers every other role, including the buyer-side agent", () => {
    // The negative control. Filtering too broadly — dropping every option that
    // says "Agent", say — would pass both cases above.
    renderModal();
    const byValue = new Map(optionsOf(roleSelect()).map((o) => [o.value, o.label]));

    expect(byValue.get("buyer_agent")).toBe("Buyer Agent");
    expect(byValue.get("insurance_agent")).toBe("Insurance Agent");
    expect(byValue.get("inspector")).toBe("Inspector");
    expect(byValue.get("client")).toBe("Client (Buyer/Seller)");
  });

  it("keeps the option for a contact already stored as listing_agent", () => {
    // The escape hatch. Without it this contact's select renders blank and the
    // next save writes the blank back — a display fix silently editing data.
    renderModal({
      id: "contact-omar",
      user_id: "user-1",
      name: "Omar Example",
      default_role: "listing_agent",
    } as unknown as ExtendedContact);

    const select = roleSelect();
    expect(select.value).toBe("listing_agent");

    const byValue = new Map(optionsOf(select).map((o) => [o.value, o.label]));
    expect(byValue.get("listing_agent")).toBe("Listing Agent");
    // And the pair is still not both on offer for someone else's contact.
    expect(byValue.get("seller_agent")).toBe("Listing Agent");
  });

  it("hides listing_agent for a contact stored as something else", () => {
    // Boundary: the escape hatch is keyed to the CURRENT value, so it must not
    // leak the vestigial option onto every other contact's form.
    renderModal({
      id: "contact-dana",
      user_id: "user-1",
      name: "Dana Example",
      default_role: "buyer_agent",
    } as unknown as ExtendedContact);

    const byValue = new Map(optionsOf(roleSelect()).map((o) => [o.value, o.label]));
    expect(byValue.has("listing_agent")).toBe(false);
    expect(byValue.get("seller_agent")).toBe("Listing Agent");
  });
});
