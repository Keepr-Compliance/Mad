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
 * BLANK, showing that contact as having no default role at all.
 *
 * It does not corrupt the stored value: the save reads React state, not the
 * DOM, so an untouched form still writes `listing_agent` either way (measured
 * in SR review of PR #2351). The blank field is the whole defect.
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

describe("BACKLOG-2859: Default Role picker offers the LIVE vocabulary only", () => {
  /**
   * This picker sets a contact's `default_role`, which has no transaction and
   * therefore no side — so every option is a static label.
   *
   * The distinction it has to get right is OFFERED vs RENDERED.
   * ROLE_DISPLAY_NAMES deliberately retains entries for the retired values so
   * an un-migrated row still humanizes; this picker is built from that map and
   * must not turn those entries back into offers, or it would quietly write the
   * very values migration v66 collapsed back into the database.
   */
  it("offers the collapsed agent role, and NONE of the three it replaced", () => {
    renderModal();
    const byValue = new Map(optionsOf(roleSelect()).map((o) => [o.value, o.label]));

    expect(byValue.get("agent")).toBe("Agent");
    // Identity, not absence-of-one: all three retired values are gone.
    expect(byValue.has("buyer_agent")).toBe(false);
    expect(byValue.has("seller_agent")).toBe(false);
    expect(byValue.has("listing_agent")).toBe(false);
  });

  it("offers co_agent, and the retired principals are gone", () => {
    renderModal();
    const byValue = new Map(optionsOf(roleSelect()).map((o) => [o.value, o.label]));

    expect(byValue.get("co_agent")).toBe("Co-Agent");
    expect(byValue.has("buyer")).toBe(false);
    expect(byValue.has("seller")).toBe(false);
  });

  it("still offers every unrelated role", () => {
    // The negative control. Filtering too broadly — dropping every option whose
    // label contains "Agent", say — would pass both cases above.
    renderModal();
    const byValue = new Map(optionsOf(roleSelect()).map((o) => [o.value, o.label]));

    expect(byValue.get("insurance_agent")).toBe("Insurance Agent");
    expect(byValue.get("inspector")).toBe("Inspector");
    expect(byValue.get("client")).toBe("Client (Buyer/Seller)");
    expect(byValue.get("escrow_officer")).toBe("Escrow Officer");
  });

  it("offers EXACTLY the live vocabulary — an exact set, so nothing creeps back", () => {
    renderModal();
    const values = optionsOf(roleSelect())
      .map((o) => o.value)
      .filter((v) => v !== "");

    expect(values.sort()).toEqual(
      [
        "client",
        "agent",
        "co_agent",
        "appraiser",
        "inspector",
        "surveyor",
        "title_company",
        "escrow_officer",
        "mortgage_broker",
        "lender",
        "real_estate_attorney",
        "transaction_coordinator",
        "insurance_agent",
        "hoa_management",
        "condo_management",
        "other",
      ].sort(),
    );
  });

  /**
   * THE ESCAPE HATCH, generalised from BACKLOG-2804.
   *
   * Previously hardcoded for `listing_agent`; it now covers every retired value.
   * Without it, a contact still carrying one renders a BLANK select — the form
   * claims she has no default role at all and the user cannot tell what it
   * actually is. The stored value is not at risk either way (the save reads
   * React state, not the DOM); the defect is the blank field.
   */
  it.each(["listing_agent", "seller_agent", "buyer_agent", "buyer", "seller"])(
    "keeps the option for a contact already stored as %s",
    (storedRole) => {
      renderModal({
        id: "contact-omar",
        user_id: "user-1",
        name: "Omar Example",
        default_role: storedRole,
      } as unknown as ExtendedContact);

      const select = roleSelect();
      expect(select.value).toBe(storedRole);

      const byValue = new Map(optionsOf(select).map((o) => [o.value, o.label]));
      expect(byValue.has(storedRole)).toBe(true);
      // It renders under a name a person recognises, not a raw enum.
      expect(byValue.get(storedRole)).not.toBe(storedRole);
    },
  );

  it("preserves the 2804 wording for a retired seller-side value", () => {
    renderModal({
      id: "contact-omar",
      user_id: "user-1",
      name: "Omar Example",
      default_role: "seller_agent",
    } as unknown as ExtendedContact);

    const byValue = new Map(optionsOf(roleSelect()).map((o) => [o.value, o.label]));
    expect(byValue.get("seller_agent")).toBe("Listing Agent");
    expect(byValue.get("seller_agent")).not.toBe("Seller Agent");
  });

  it("does NOT leak a retired option onto a contact stored as something else", () => {
    // Boundary: the escape hatch is keyed to the CURRENT value, so it must not
    // put every retired value on every other contact's form.
    renderModal({
      id: "contact-dana",
      user_id: "user-1",
      name: "Dana Example",
      default_role: "agent",
    } as unknown as ExtendedContact);

    const byValue = new Map(optionsOf(roleSelect()).map((o) => [o.value, o.label]));
    expect(byValue.has("listing_agent")).toBe(false);
    expect(byValue.has("seller_agent")).toBe(false);
    expect(byValue.has("buyer_agent")).toBe(false);
  });
});
