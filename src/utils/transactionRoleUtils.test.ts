import {
  buildRoleOptions,
  offeredRoleValues,
  validateRoleAssignments,
  getRoleDisplayName,
  formatRoleLabel,
  resolveDefaultContactRole,
  type RoleConfig,
  type ContactAssignments,
  type TransactionType,
} from "./transactionRoleUtils";
import * as roleUtils from "./transactionRoleUtils";
import { SPECIFIC_ROLES, AUDIT_WORKFLOW_STEPS } from "../constants/contactRoles";

/**
 * BACKLOG-2859 — the role model, asserted as SETS.
 *
 * Every assertion about what a picker offers compares an EXACT SET, never
 * membership. That choice is the whole point of the file: "buyer_agent is not
 * offered on a Listing" passes just as well in a world where `listing_agent` —
 * the USER'S OWN ROLE — is still sitting in the dropdown. Only an exact set
 * catches a role that should have been removed and wasn't.
 *
 * Likewise every label assertion checks the WRONG label is ABSENT as well as the
 * right one present. A presence check passes in both worlds when a resolver
 * returns a list, or when a fallback happens to contain the substring.
 */
describe("transactionRoleUtils", () => {
  const SERVICE_PROVIDER_ROLES = [
    SPECIFIC_ROLES.TITLE_COMPANY,
    SPECIFIC_ROLES.ESCROW_OFFICER,
    SPECIFIC_ROLES.INSPECTOR,
    SPECIFIC_ROLES.APPRAISER,
    SPECIFIC_ROLES.SURVEYOR,
    SPECIFIC_ROLES.MORTGAGE_BROKER,
    SPECIFIC_ROLES.REAL_ESTATE_ATTORNEY,
    SPECIFIC_ROLES.TRANSACTION_COORDINATOR,
    SPECIFIC_ROLES.INSURANCE_AGENT,
    SPECIFIC_ROLES.HOA_MANAGEMENT,
    SPECIFIC_ROLES.CONDO_MANAGEMENT,
    SPECIFIC_ROLES.OTHER,
  ];

  /** The three party roles + the type-independent service providers. */
  const EXPECTED_OFFERED = [
    SPECIFIC_ROLES.CLIENT,
    SPECIFIC_ROLES.AGENT,
    SPECIFIC_ROLES.CO_AGENT,
    ...SERVICE_PROVIDER_ROLES,
  ].sort();

  describe("the offered role set (BACKLOG-2859)", () => {
    it.each(["purchase", "sale", "other"] as TransactionType[])(
      "offers EXACTLY {client, agent, co_agent} + service providers on a %s",
      (type) => {
        expect([...offeredRoleValues(type)].sort()).toEqual(EXPECTED_OFFERED);
      },
    );

    /**
     * THE ASSERTION THIS WHOLE ITEM EXISTS FOR.
     *
     * On a Listing the user IS the listing agent; on a Sale the user IS the
     * buyer's agent. Neither is a contact, so neither may be offered. Before
     * BACKLOG-2859 the app offered "Listing Agent" on a Listing — i.e. the user
     * themselves — as an assignable contact role.
     */
    it("never offers the USER'S OWN role", () => {
      const onListing = offeredRoleValues("purchase");
      expect(onListing.has("listing_agent")).toBe(false);
      expect(onListing.has("seller_agent")).toBe(false);

      const onSale = offeredRoleValues("sale");
      expect(onSale.has("buyer_agent")).toBe(false);
    });

    it("never offers the other side's PRINCIPAL", () => {
      for (const type of ["purchase", "sale", "other"] as TransactionType[]) {
        expect(offeredRoleValues(type).has("buyer")).toBe(false);
        expect(offeredRoleValues(type).has("seller")).toBe(false);
      }
    });

    it("offers the SAME stored set on every transaction type — only labels move", () => {
      const listing = [...offeredRoleValues("purchase")].sort();
      const sale = [...offeredRoleValues("sale")].sort();
      const other = [...offeredRoleValues("other")].sort();
      expect(listing).toEqual(sale);
      expect(sale).toEqual(other);
    });

    it("offers exactly THREE party roles, so a fourth cannot creep in unnoticed", () => {
      const partyRoles = AUDIT_WORKFLOW_STEPS.find(
        (s) => s.title === "Client & Agents",
      )?.roles.map((r) => r.role);
      expect(partyRoles).toEqual([
        SPECIFIC_ROLES.CLIENT,
        SPECIFIC_ROLES.AGENT,
        SPECIFIC_ROLES.CO_AGENT,
      ]);
    });

    it("marks client required and nothing else", () => {
      const required = buildRoleOptions("purchase")
        .map((o) => o.value)
        .filter((v) =>
          AUDIT_WORKFLOW_STEPS.some((s) => s.roles.some((r) => r.role === v && r.required)),
        );
      expect(required).toEqual([SPECIFIC_ROLES.CLIENT]);
    });
  });

  describe("label resolution by transaction type (BACKLOG-2859)", () => {
    /**
     * Asserted in BOTH directions per type, with the wrong label asserted
     * ABSENT. A resolver that returned "Seller (Client) / Buyer (Client)" for
     * every type would satisfy a presence-only check on both.
     */
    it("resolves `client` to the side the USER represents", () => {
      expect(getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "purchase")).toBe("Seller (Client)");
      expect(getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "purchase")).not.toBe("Buyer (Client)");

      expect(getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "sale")).toBe("Buyer (Client)");
      expect(getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "sale")).not.toBe("Seller (Client)");
    });

    it("resolves `agent` to the OTHER side's agent", () => {
      expect(getRoleDisplayName(SPECIFIC_ROLES.AGENT, "purchase")).toBe("Buyer's Agent");
      expect(getRoleDisplayName(SPECIFIC_ROLES.AGENT, "purchase")).not.toBe("Listing Agent");

      expect(getRoleDisplayName(SPECIFIC_ROLES.AGENT, "sale")).toBe("Listing Agent");
      expect(getRoleDisplayName(SPECIFIC_ROLES.AGENT, "sale")).not.toBe("Buyer's Agent");
    });

    /**
     * BACKLOG-2804 SURVIVES THE COLLAPSE. The founder's support-ticket-111
     * ruling was that the agent representing the seller must read "Listing
     * Agent". Under this model that is a label rule on a Sale rather than a
     * stored enum — and it still holds.
     */
    it("keeps the founder's 'Listing Agent' ruling in force on a Sale", () => {
      expect(getRoleDisplayName(SPECIFIC_ROLES.AGENT, "sale")).toBe("Listing Agent");
      expect(getRoleDisplayName(SPECIFIC_ROLES.AGENT, "sale")).not.toBe("Seller's Agent");
      expect(getRoleDisplayName(SPECIFIC_ROLES.AGENT, "sale")).not.toBe("Seller Agent");
    });

    /**
     * Founder: "same as the other, not dynamic co agent." Asserted as EQUALITY
     * ACROSS THE TWO TYPES, which is what catches someone later making it
     * dynamic — two separate `toBe("Co-Agent")` assertions would both need
     * editing to break, this one breaks on the first edit.
     */
    it("renders `co_agent` IDENTICALLY on both transaction types", () => {
      const onListing = getRoleDisplayName(SPECIFIC_ROLES.CO_AGENT, "purchase");
      const onSale = getRoleDisplayName(SPECIFIC_ROLES.CO_AGENT, "sale");
      expect(onListing).toBe(onSale);
      expect(onListing).toBe("Co-Agent");
      expect(onListing).not.toContain("Buyer");
      expect(onListing).not.toContain("Listing");
      expect(onListing).not.toContain("Seller");
    });

    it("falls back to a side-free label on `other`, guessing no side", () => {
      expect(getRoleDisplayName(SPECIFIC_ROLES.AGENT, "other")).toBe("Agent");
      expect(getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "other")).toBe("Client (Buyer/Seller)");
    });

    it("leaves service-provider labels type-independent", () => {
      for (const role of SERVICE_PROVIDER_ROLES) {
        expect(getRoleDisplayName(role, "purchase")).toBe(getRoleDisplayName(role, "sale"));
      }
    });

    it("labels every offered option — no option falls through to a raw enum", () => {
      for (const type of ["purchase", "sale", "other"] as TransactionType[]) {
        for (const opt of buildRoleOptions(type)) {
          expect(opt.label).toBeTruthy();
          expect(opt.label).not.toBe(opt.value);
          expect(opt.label).not.toMatch(/_/);
        }
      }
    });
  });

  /**
   * The deletions are asserted, not assumed. A function removed from the source
   * but still exported somewhere gets re-used by the next person who greps for
   * it.
   */
  describe("what BACKLOG-2859 deleted", () => {
    it("no longer exports flipRoleForTransactionType", () => {
      expect(roleUtils).not.toHaveProperty("flipRoleForTransactionType");
    });

    it("no longer exports filterRolesByTransactionType", () => {
      expect(roleUtils).not.toHaveProperty("filterRolesByTransactionType");
    });

    it("no longer exports the dead getTransactionTypeContext", () => {
      expect(roleUtils).not.toHaveProperty("getTransactionTypeContext");
    });
  });

  describe("resolveDefaultContactRole", () => {
    const offered = (type: TransactionType) => (r: string) => offeredRoleValues(type).has(r);

    it("uses a saved role that this transaction offers", () => {
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.AGENT, "sale", offered("sale")),
      ).toBe(SPECIFIC_ROLES.AGENT);
    });

    /**
     * THE REASON THE #2374 GUARD COULD GO. A saved `agent` is valid on every
     * transaction type, so the blank-dropdown case the guard was written for
     * cannot arise. Asserted on all three types rather than argued.
     */
    it("accepts a saved `agent` on EVERY transaction type", () => {
      for (const type of ["purchase", "sale", "other"] as TransactionType[]) {
        expect(resolveDefaultContactRole(true, SPECIFIC_ROLES.AGENT, type, offered(type))).toBe(
          SPECIFIC_ROLES.AGENT,
        );
      }
    });

    it("falls back to the client baseline for a role no longer offered", () => {
      // A contact whose default_role was never migrated.
      expect(resolveDefaultContactRole(true, "seller_agent", "sale", offered("sale"))).toBe(
        SPECIFIC_ROLES.CLIENT,
      );
      expect(resolveDefaultContactRole(true, "buyer", "purchase", offered("purchase"))).toBe(
        SPECIFIC_ROLES.CLIENT,
      );
    });

    it("falls back to the client baseline when auto-role is off", () => {
      expect(
        resolveDefaultContactRole(false, SPECIFIC_ROLES.AGENT, "sale", offered("sale")),
      ).toBe(SPECIFIC_ROLES.CLIENT);
    });

    it("never returns an empty role", () => {
      for (const saved of [null, undefined, ""]) {
        for (const enabled of [true, false]) {
          expect(
            resolveDefaultContactRole(enabled, saved, "other", offered("other")),
          ).toBe(SPECIFIC_ROLES.CLIENT);
        }
      }
    });

    it("never returns a role the caller would not offer", () => {
      for (const type of ["purchase", "sale", "other"] as TransactionType[]) {
        for (const saved of ["buyer_agent", "seller_agent", "listing_agent", "buyer", "seller"]) {
          const resolved = resolveDefaultContactRole(true, saved, type, offered(type));
          expect(offeredRoleValues(type).has(resolved)).toBe(true);
        }
      }
    });
  });

  describe("formatRoleLabel", () => {
    it("humanizes the live vocabulary", () => {
      expect(formatRoleLabel(SPECIFIC_ROLES.AGENT)).toBe("Agent");
      expect(formatRoleLabel(SPECIFIC_ROLES.CO_AGENT)).toBe("Co-Agent");
      expect(formatRoleLabel(SPECIFIC_ROLES.INSPECTOR)).toBe("Inspector");
    });

    /**
     * Retired values still RENDER even though they are never OFFERED. An export
     * or a restored backup can carry one, and a compliance document is the worst
     * possible place to print "Seller Agent" or a raw enum.
     */
    it("still humanizes retired values, keeping the 2804 wording", () => {
      expect(formatRoleLabel("seller_agent")).toBe("Listing Agent");
      expect(formatRoleLabel("listing_agent")).toBe("Listing Agent");
      expect(formatRoleLabel("buyer_agent")).toBe("Buyer's Agent");
      expect(formatRoleLabel("buyer")).toBe("Buyer");
      expect(formatRoleLabel("seller")).toBe("Seller");
    });

    it("title-cases an unknown role", () => {
      expect(formatRoleLabel("custom_role")).toBe("Custom Role");
      expect(formatRoleLabel("")).toBe("");
    });
  });

  describe("validateRoleAssignments", () => {
    const roles: RoleConfig[] = [
      { role: SPECIFIC_ROLES.CLIENT, required: true, multiple: true },
      { role: SPECIFIC_ROLES.AGENT, required: false, multiple: true },
    ];

    it("reports a missing required role", () => {
      const assignments: ContactAssignments = { [SPECIFIC_ROLES.AGENT]: ["c1"] };
      expect(validateRoleAssignments(assignments, roles)).toEqual({
        isValid: false,
        missingRoles: [SPECIFIC_ROLES.CLIENT],
      });
    });

    it("passes when every required role is filled", () => {
      const assignments: ContactAssignments = { [SPECIFIC_ROLES.CLIENT]: ["c1"] };
      expect(validateRoleAssignments(assignments, roles)).toEqual({
        isValid: true,
        missingRoles: [],
      });
    });
  });
});
