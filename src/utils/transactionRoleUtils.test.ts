import {
  filterRolesByTransactionType,
  flipRoleForTransactionType,
  getTransactionTypeContext,
  validateRoleAssignments,
  getRoleDisplayName,
  formatRoleLabel,
  resolveDefaultContactRole,
  type RoleConfig,
  type ContactAssignments,
  type TransactionType,
} from "./transactionRoleUtils";
import { SPECIFIC_ROLES } from "../constants/contactRoles";

describe("transactionRoleUtils", () => {
  /**
   * BACKLOG-2850 — the second half of the same inversion.
   *
   * flipRoleForTransactionType decided which roles count as "the other side"
   * for a transaction type, and had the two sides swapped: it treated a
   * `purchase` as a buy-side deal, so it called the SELLER side valid there.
   * A `purchase` displays as "Listing" and the user is the listing agent, so
   * the other side is the BUYER side.
   *
   * The sets are not exported, so every assertion below DERIVES them BY
   * EXECUTION over the whole SPECIFIC_ROLES universe and compares EXACT SETS.
   * Membership assertions were rejected deliberately: "buyer_agent is valid on
   * a purchase" passes just as well while seller_agent is wrongly valid too.
   */
  describe("flipRoleForTransactionType (BACKLOG-2850: sides corrected)", () => {
    const ALL_ROLES = Object.values(SPECIFIC_ROLES);

    /**
     * A role is in the valid set for a type exactly when the function returns
     * it unchanged. Nothing in the flip map sends a role to itself, so this
     * cannot produce a false member.
     */
    const validSetFor = (type: TransactionType): string[] =>
      ALL_ROLES.filter((r) => flipRoleForTransactionType(r, type) === r).sort();

    it("a purchase (a Listing) counts EXACTLY the buyer side as the other side", () => {
      expect(validSetFor("purchase")).toEqual([
        SPECIFIC_ROLES.BUYER,
        SPECIFIC_ROLES.BUYER_AGENT,
      ].sort());
    });

    it("a sale counts EXACTLY the seller side as the other side", () => {
      // Three values, not two: listing_agent is a second stored value for the
      // same role as seller_agent, and a contact carrying it must not be
      // flipped off the correct side of a Sale.
      expect(validSetFor("sale")).toEqual([
        SPECIFIC_ROLES.LISTING_AGENT,
        SPECIFIC_ROLES.SELLER,
        SPECIFIC_ROLES.SELLER_AGENT,
      ].sort());
    });

    it("the two sides are disjoint and symmetric — principal plus agent on each", () => {
      const purchase = validSetFor("purchase");
      const sale = validSetFor("sale");
      expect(purchase.filter((r) => sale.includes(r))).toEqual([]);
      // Symmetry is the founder's wording: the principal and their agent.
      expect(purchase).toContain(SPECIFIC_ROLES.BUYER);
      expect(purchase).toContain(SPECIFIC_ROLES.BUYER_AGENT);
      expect(sale).toContain(SPECIFIC_ROLES.SELLER);
      expect(sale).toContain(SPECIFIC_ROLES.SELLER_AGENT);
    });

    it("flips a role on the user's OWN side to the specific counterpart role", () => {
      // Not "something changed" — the exact landing is asserted each way.
      expect(flipRoleForTransactionType(SPECIFIC_ROLES.SELLER_AGENT, "purchase"))
        .toBe(SPECIFIC_ROLES.BUYER_AGENT);
      expect(flipRoleForTransactionType(SPECIFIC_ROLES.SELLER, "purchase"))
        .toBe(SPECIFIC_ROLES.BUYER);
      expect(flipRoleForTransactionType(SPECIFIC_ROLES.BUYER_AGENT, "sale"))
        .toBe(SPECIFIC_ROLES.SELLER_AGENT);
      expect(flipRoleForTransactionType(SPECIFIC_ROLES.BUYER, "sale"))
        .toBe(SPECIFIC_ROLES.SELLER);
    });

    it("leaves a listing_agent alone on a sale", () => {
      expect(flipRoleForTransactionType(SPECIFIC_ROLES.LISTING_AGENT, "sale"))
        .toBe(SPECIFIC_ROLES.LISTING_AGENT);
    });

    it("returns null for a role with no counterpart", () => {
      expect(flipRoleForTransactionType(SPECIFIC_ROLES.INSPECTOR, "sale")).toBeNull();
      expect(flipRoleForTransactionType(SPECIFIC_ROLES.CLIENT, "purchase")).toBeNull();
    });

    /**
     * `other` names no side, so the set it gets is arbitrary. It is pinned to
     * the set it had BEFORE the 2850 correction, which is why the ternary in
     * the implementation tests `=== "sale"` instead of `=== "purchase"`.
     *
     * COLLATERAL GUARD, NOT A DISCRIMINATOR: this must stay GREEN when the
     * side swap is reverted. If it ever goes red in that control, the control
     * moved something it was not supposed to move.
     */
    it("leaves `other` on exactly the set it had before the correction", () => {
      expect(validSetFor("other")).toEqual([
        SPECIFIC_ROLES.BUYER,
        SPECIFIC_ROLES.BUYER_AGENT,
      ].sort());
      expect(flipRoleForTransactionType(SPECIFIC_ROLES.SELLER_AGENT, "other"))
        .toBe(SPECIFIC_ROLES.BUYER_AGENT);
    });

    /**
     * ROUND-TRIP — asked for explicitly, and the answer is NOT clean.
     *
     * Flip a role off the type where it is valid, then flip the result off the
     * type where THAT is valid, and you should get the original back.
     */
    describe("round-trip A -> B -> A", () => {
      it("round-trips cleanly for the four roles with a unique counterpart", () => {
        const cases: Array<[string, TransactionType, TransactionType]> = [
          [SPECIFIC_ROLES.SELLER_AGENT, "purchase", "sale"],
          [SPECIFIC_ROLES.BUYER_AGENT, "sale", "purchase"],
          [SPECIFIC_ROLES.SELLER, "purchase", "sale"],
          [SPECIFIC_ROLES.BUYER, "sale", "purchase"],
        ];

        for (const [role, away, back] of cases) {
          const flipped = flipRoleForTransactionType(role, away);
          expect(flipped).not.toBeNull();
          expect(flipRoleForTransactionType(flipped as string, back)).toBe(role);
        }
      });

      it("does NOT round-trip listing_agent — it lands on seller_agent (KNOWN, not fixed here)", () => {
        // listing_agent -> buyer_agent -> seller_agent. The contact comes back
        // carrying a DIFFERENT stored value than they started with, purely from
        // being assigned across two deals.
        //
        // This is unavoidable while two enum values name one role: the flip map
        // is a function, so buyer_agent can have only one counterpart, and it
        // cannot be both. Invisible today because seller_agent and
        // listing_agent both render "Listing Agent" (BACKLOG-2804).
        //
        // Closing it requires consolidating the enum values plus a data
        // migration, which is filed separately. NOT invented here. Pinned so
        // the door cannot widen — if this ever returns listing_agent, the
        // consolidation happened and this test should be deleted, not edited.
        const flipped = flipRoleForTransactionType(SPECIFIC_ROLES.LISTING_AGENT, "purchase");
        expect(flipped).toBe(SPECIFIC_ROLES.BUYER_AGENT);

        const back = flipRoleForTransactionType(flipped as string, "sale");
        expect(back).toBe(SPECIFIC_ROLES.SELLER_AGENT);
        expect(back).not.toBe(SPECIFIC_ROLES.LISTING_AGENT);
      });
    });
  });

  describe("resolveDefaultContactRole (BACKLOG-2358)", () => {
    /**
     * BACKLOG-2850 — THIS PREDICATE WAS INVERTED, and two assertions with it.
     *
     * It previously said buyer-side roles are the valid ones on a SALE. That is
     * the pre-2850 premise. On a `sale` the user is the buyer's agent, so the
     * OTHER side — the side a counterparty contact is assigned to — is the
     * SELLER side. `listing_agent` is included because it is a second stored
     * value for the same role as `seller_agent` (both render "Listing Agent").
     */
    const saleValid = (r: string) =>
      r === SPECIFIC_ROLES.SELLER ||
      r === SPECIFIC_ROLES.SELLER_AGENT ||
      r === SPECIFIC_ROLES.LISTING_AGENT ||
      r === SPECIFIC_ROLES.CLIENT;

    /**
     * The predicate BOTH REAL CALLERS build today, reproduced rather than
     * imagined: `roleOptions` in ContactAssignmentStep and `validRoles` in
     * EditContactsModal are both derived from filterRolesByTransactionType,
     * which still carries the pre-2850 premise (re-scoping it is BACKLOG-2859).
     * On a purchase it therefore offers the SELLER side.
     */
    const callerValidOnPurchaseToday = (r: string) =>
      r === SPECIFIC_ROLES.CLIENT ||
      r === SPECIFIC_ROLES.SELLER ||
      r === SPECIFIC_ROLES.SELLER_AGENT;

    it("falls back to Client when the contact has no default_role", () => {
      expect(
        resolveDefaultContactRole(true, null, "sale", saleValid)
      ).toBe(SPECIFIC_ROLES.CLIENT);
      expect(
        resolveDefaultContactRole(true, undefined, "purchase", () => true)
      ).toBe(SPECIFIC_ROLES.CLIENT);
    });

    it("falls back to Client (baseline) when auto-role is OFF, even with a default_role", () => {
      // The Client baseline always applies regardless of the auto-role setting.
      expect(
        resolveDefaultContactRole(false, SPECIFIC_ROLES.BUYER_AGENT, "sale", saleValid)
      ).toBe(SPECIFIC_ROLES.CLIENT);
    });

    // BACKLOG-2850: INVERTED. Was buyer_agent-is-valid-on-a-sale.
    it("uses a valid default_role directly when auto-role is ON", () => {
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.SELLER_AGENT, "sale", saleValid)
      ).toBe(SPECIFIC_ROLES.SELLER_AGENT);
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.SELLER_AGENT, "sale", saleValid)
      ).not.toBe(SPECIFIC_ROLES.BUYER_AGENT);
    });

    // BACKLOG-2850: INVERTED. Was "seller_agent is not valid for a sale".
    it("flips an other-side default_role to the equivalent role when auto-role is ON", () => {
      // buyer_agent is the USER's own side on a sale → flips to seller_agent.
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.BUYER_AGENT, "sale", saleValid)
      ).toBe(SPECIFIC_ROLES.SELLER_AGENT);
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.BUYER_AGENT, "sale", saleValid)
      ).not.toBe(SPECIFIC_ROLES.BUYER_AGENT);
    });

    it("does NOT flip a contact saved as listing_agent on a sale", () => {
      // listing_agent and seller_agent are one role under two stored values.
      // The contact is already on the correct side; flipping would move a
      // seller-side person to the buyer side on the strength of a duplicate
      // enum. The stored value is returned untouched, not normalised.
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.LISTING_AGENT, "sale", saleValid)
      ).toBe(SPECIFIC_ROLES.LISTING_AGENT);
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.LISTING_AGENT, "sale", saleValid)
      ).not.toBe(SPECIFIC_ROLES.BUYER_AGENT);
    });

    /**
     * THE GUARD (BACKLOG-2850). flipRoleForTransactionType now returns the
     * correct side, but both real callers still decide validity from the
     * pre-2850 filter, so the two disagree until BACKLOG-2859 lands.
     */
    it("discards a flip result the CALLER would not offer, rather than assigning an unpickable role", () => {
      // A contact saved buyer_agent, added to a Listing. The flip correctly
      // yields buyer_agent — but today's picker on a Listing offers only the
      // seller side, so assigning it would leave a blank dropdown over a
      // stored role. The Client baseline is returned instead, and it renders
      // "Seller (Client)", which is true on a Listing.
      expect(
        resolveDefaultContactRole(
          true,
          SPECIFIC_ROLES.BUYER_AGENT,
          "purchase",
          callerValidOnPurchaseToday,
        )
      ).toBe(SPECIFIC_ROLES.CLIENT);
    });

    it("is NOT a blanket clamp — a flip result the caller DOES offer is returned", () => {
      // The same input against a caller whose options agree with the corrected
      // sides (what BACKLOG-2859 will produce) yields the flip result. Without
      // this, a guard that always returned CLIENT would pass the test above.
      const callerValidOnPurchaseAfter2859 = (r: string) =>
        r === SPECIFIC_ROLES.CLIENT ||
        r === SPECIFIC_ROLES.BUYER ||
        r === SPECIFIC_ROLES.BUYER_AGENT;

      expect(
        resolveDefaultContactRole(
          true,
          SPECIFIC_ROLES.SELLER_AGENT,
          "purchase",
          callerValidOnPurchaseAfter2859,
        )
      ).toBe(SPECIFIC_ROLES.BUYER_AGENT);
    });

    it("falls back to Client when a default_role cannot be flipped to a valid role", () => {
      // A professional-services role has no buyer/seller flip.
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.INSPECTOR, "sale", saleValid)
      ).toBe(SPECIFIC_ROLES.CLIENT);
    });

    it("never returns an empty role", () => {
      for (const enabled of [true, false]) {
        const role = resolveDefaultContactRole(enabled, "", "other", () => false);
        expect(role).toBeTruthy();
        expect(role).toBe(SPECIFIC_ROLES.CLIENT);
      }
    });
  });

  describe("filterRolesByTransactionType", () => {
    it("should not filter professional services roles", () => {
      const roles: RoleConfig[] = [
        { role: "inspector", required: false, multiple: true },
        { role: "appraiser", required: false, multiple: false },
        { role: "title_company", required: false, multiple: false },
      ];

      const result = filterRolesByTransactionType(
        roles,
        "purchase",
        "Professional Services",
      );

      expect(result).toEqual(roles);
      expect(result.length).toBe(3);
    });

    it("should filter roles for purchase transaction", () => {
      const roles: RoleConfig[] = [
        { role: SPECIFIC_ROLES.CLIENT, required: true, multiple: false },
        { role: SPECIFIC_ROLES.BUYER_AGENT, required: false, multiple: false },
        { role: SPECIFIC_ROLES.SELLER_AGENT, required: false, multiple: false },
        {
          role: SPECIFIC_ROLES.LISTING_AGENT,
          required: false,
          multiple: false,
        },
      ];

      const result = filterRolesByTransactionType(
        roles,
        "purchase",
        "Client & Agents",
      );

      expect(result.length).toBe(3);
      expect(result.map((r) => r.role)).toContain(SPECIFIC_ROLES.CLIENT);
      expect(result.map((r) => r.role)).toContain(SPECIFIC_ROLES.SELLER_AGENT);
      expect(result.map((r) => r.role)).toContain(SPECIFIC_ROLES.LISTING_AGENT);
      expect(result.map((r) => r.role)).not.toContain(
        SPECIFIC_ROLES.BUYER_AGENT,
      );
    });

    it("should filter roles for sale transaction", () => {
      const roles: RoleConfig[] = [
        { role: SPECIFIC_ROLES.CLIENT, required: true, multiple: false },
        { role: SPECIFIC_ROLES.BUYER_AGENT, required: false, multiple: false },
        { role: SPECIFIC_ROLES.SELLER_AGENT, required: false, multiple: false },
        {
          role: SPECIFIC_ROLES.LISTING_AGENT,
          required: false,
          multiple: false,
        },
      ];

      const result = filterRolesByTransactionType(
        roles,
        "sale",
        "Client & Agents",
      );

      expect(result.length).toBe(2);
      expect(result.map((r) => r.role)).toContain(SPECIFIC_ROLES.CLIENT);
      expect(result.map((r) => r.role)).toContain(SPECIFIC_ROLES.BUYER_AGENT);
      expect(result.map((r) => r.role)).not.toContain(
        SPECIFIC_ROLES.SELLER_AGENT,
      );
      expect(result.map((r) => r.role)).not.toContain(
        SPECIFIC_ROLES.LISTING_AGENT,
      );
    });

    it("should always include client role", () => {
      const roles: RoleConfig[] = [
        { role: SPECIFIC_ROLES.CLIENT, required: true, multiple: false },
      ];

      const purchaseResult = filterRolesByTransactionType(
        roles,
        "purchase",
        "Client & Agents",
      );
      const saleResult = filterRolesByTransactionType(
        roles,
        "sale",
        "Client & Agents",
      );

      expect(purchaseResult.some((r) => r.role === SPECIFIC_ROLES.CLIENT)).toBe(
        true,
      );
      expect(saleResult.some((r) => r.role === SPECIFIC_ROLES.CLIENT)).toBe(
        true,
      );
    });

    it("should handle empty roles array", () => {
      const result = filterRolesByTransactionType(
        [],
        "purchase",
        "Client & Agents",
      );
      expect(result.length).toBe(0);
    });

    it("should filter out non-matching roles for 'other' transaction type", () => {
      const roles: RoleConfig[] = [
        { role: SPECIFIC_ROLES.CLIENT, required: true, multiple: false },
        { role: SPECIFIC_ROLES.BUYER_AGENT, required: false, multiple: false },
        { role: SPECIFIC_ROLES.SELLER_AGENT, required: false, multiple: false },
        { role: "custom_role", required: false, multiple: false },
      ];

      const result = filterRolesByTransactionType(
        roles,
        "other",
        "Client & Agents",
      );

      // Only CLIENT should be included since 'other' matches neither purchase nor sale
      expect(result.length).toBe(1);
      expect(result.map((r) => r.role)).toContain(SPECIFIC_ROLES.CLIENT);
      expect(result.map((r) => r.role)).not.toContain(SPECIFIC_ROLES.BUYER_AGENT);
      expect(result.map((r) => r.role)).not.toContain(SPECIFIC_ROLES.SELLER_AGENT);
      expect(result.map((r) => r.role)).not.toContain("custom_role");
    });
  });

  describe("getTransactionTypeContext", () => {
    it("should return purchase context", () => {
      const result = getTransactionTypeContext("purchase");

      expect(result.title).toBe("Transaction Type: Purchase");
      expect(result.message).toContain("representing the buyer");
      expect(result.message).toContain("seller's agent");
    });

    it("should return sale context", () => {
      const result = getTransactionTypeContext("sale");

      expect(result.title).toBe("Transaction Type: Sale");
      expect(result.message).toContain("representing the seller");
      expect(result.message).toContain("buyer's agent");
    });

    it("should return sale context as default for 'other' transaction type", () => {
      // 'other' transaction type falls through to default (sale context)
      const result = getTransactionTypeContext("other");

      expect(result.title).toBe("Transaction Type: Sale");
      expect(result.message).toContain("representing the seller");
    });
  });

  describe("validateRoleAssignments", () => {
    it("should pass when all required roles are assigned", () => {
      const contactAssignments: ContactAssignments = {
        client: ["contact-1"],
        seller_agent: ["contact-2"],
      };

      const roles: RoleConfig[] = [
        { role: "client", required: true, multiple: false },
        { role: "seller_agent", required: false, multiple: false },
      ];

      const result = validateRoleAssignments(contactAssignments, roles);

      expect(result.isValid).toBe(true);
      expect(result.missingRoles.length).toBe(0);
    });

    it("should fail when required role is missing", () => {
      const contactAssignments: ContactAssignments = {
        seller_agent: ["contact-2"],
      };

      const roles: RoleConfig[] = [
        { role: "client", required: true, multiple: false },
        { role: "seller_agent", required: false, multiple: false },
      ];

      const result = validateRoleAssignments(contactAssignments, roles);

      expect(result.isValid).toBe(false);
      expect(result.missingRoles).toContain("client");
      expect(result.missingRoles.length).toBe(1);
    });

    it("should fail when assignment array is empty", () => {
      const contactAssignments: ContactAssignments = {
        client: [],
      };

      const roles: RoleConfig[] = [
        { role: "client", required: true, multiple: false },
      ];

      const result = validateRoleAssignments(contactAssignments, roles);

      expect(result.isValid).toBe(false);
      expect(result.missingRoles).toContain("client");
    });

    it("should pass when optional roles are missing", () => {
      const contactAssignments: ContactAssignments = {
        client: ["contact-1"],
      };

      const roles: RoleConfig[] = [
        { role: "client", required: true, multiple: false },
        { role: "inspector", required: false, multiple: true },
        { role: "appraiser", required: false, multiple: false },
      ];

      const result = validateRoleAssignments(contactAssignments, roles);

      expect(result.isValid).toBe(true);
      expect(result.missingRoles.length).toBe(0);
    });
  });

  describe("getRoleDisplayName", () => {
    /**
     * BACKLOG-2850 — THE NEXT TWO ASSERTIONS WERE DELIBERATELY INVERTED.
     *
     * They previously pinned "Buyer (Client)" on a purchase and "Seller
     * (Client)" on a sale. That was not the specification — it was the defect,
     * and these tests were holding it in place. The founder reported it on
     * screen: a transaction whose Type read "Listing" showed a client pill
     * reading "Buyer (Client)".
     *
     * The enum `purchase` displays as "Listing". On a Listing the user is the
     * listing agent, so the user's client is the SELLER. On a `sale` the user
     * is the buyer's agent, so the client is the BUYER.
     *
     * Each direction also asserts the WRONG string is ABSENT. A presence-only
     * check cannot tell the two worlds apart: the function is self-consistent
     * under either premise, which is exactly why the original unit tests
     * passed while the screen was wrong.
     */
    it('returns "Seller (Client)", never "Buyer (Client)", for CLIENT on a purchase (a Listing)', () => {
      const result = getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "purchase");
      expect(result).toBe("Seller (Client)");
      expect(result).not.toBe("Buyer (Client)");
      expect(result).not.toContain("Buyer");
    });

    it('returns "Buyer (Client)", never "Seller (Client)", for CLIENT on a sale', () => {
      const result = getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "sale");
      expect(result).toBe("Buyer (Client)");
      expect(result).not.toBe("Seller (Client)");
      expect(result).not.toContain("Seller");
    });

    it("should return standard display name for non-CLIENT roles", () => {
      const result = getRoleDisplayName(SPECIFIC_ROLES.BUYER_AGENT, "purchase");
      expect(result).toBe("Buyer Agent");
    });

    it("should return standard display name for inspector", () => {
      const result = getRoleDisplayName(SPECIFIC_ROLES.INSPECTOR, "sale");
      expect(result).toBe("Inspector");
    });

    it("should return standard display name for transaction coordinator", () => {
      const result = getRoleDisplayName(
        SPECIFIC_ROLES.TRANSACTION_COORDINATOR,
        "purchase",
      );
      expect(result).toBe("Transaction Coordinator (TC)");
    });

    it("should fall back to ROLE_DISPLAY_NAMES for CLIENT role with 'other' transaction type", () => {
      // When transaction type is 'other', CLIENT role should use standard display name
      const result = getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "other");
      // Falls through to ROLE_DISPLAY_NAMES lookup
      expect(result).toBe("Client (Buyer/Seller)");
      // BACKLOG-2850: `other` has no side, so it must take NEITHER side label.
      // Pinned so the client-label inversion fix cannot quietly move it — this
      // assertion is a collateral guard, not a discriminator for the fix, and
      // it must stay GREEN when the fix is reverted.
      expect(result).not.toBe("Seller (Client)");
      expect(result).not.toBe("Buyer (Client)");
    });

    it("should format unknown roles using formatRoleLabel", () => {
      const result = getRoleDisplayName("unknown_custom_role", "purchase");
      // When role is not in ROLE_DISPLAY_NAMES, format it using formatRoleLabel
      expect(result).toBe("Unknown Custom Role");
    });

    it("should handle empty string role", () => {
      const result = getRoleDisplayName("", "sale");
      expect(result).toBe("");
    });
  });

  describe("validateRoleAssignments edge cases", () => {
    it("should handle undefined assignment value", () => {
      const contactAssignments: ContactAssignments = {
        client: undefined,
      };

      const roles: RoleConfig[] = [
        { role: "client", required: true, multiple: false },
      ];

      const result = validateRoleAssignments(contactAssignments, roles);

      expect(result.isValid).toBe(false);
      expect(result.missingRoles).toContain("client");
    });

    it("should handle multiple required roles missing", () => {
      const contactAssignments: ContactAssignments = {};

      const roles: RoleConfig[] = [
        { role: "client", required: true, multiple: false },
        { role: "inspector", required: true, multiple: false },
        { role: "appraiser", required: false, multiple: false },
      ];

      const result = validateRoleAssignments(contactAssignments, roles);

      expect(result.isValid).toBe(false);
      expect(result.missingRoles).toHaveLength(2);
      expect(result.missingRoles).toContain("client");
      expect(result.missingRoles).toContain("inspector");
    });

    it("should handle empty roles array", () => {
      const contactAssignments: ContactAssignments = {};
      const roles: RoleConfig[] = [];

      const result = validateRoleAssignments(contactAssignments, roles);

      expect(result.isValid).toBe(true);
      expect(result.missingRoles).toHaveLength(0);
    });
  });

  describe("formatRoleLabel", () => {
    it("should return display name for known roles", () => {
      // BACKLOG-2804: the seller's agent is named by the industry term.
      // The stored enum is still `seller_agent`; only the label moved.
      expect(formatRoleLabel(SPECIFIC_ROLES.SELLER_AGENT)).toBe("Listing Agent");
      expect(formatRoleLabel(SPECIFIC_ROLES.LISTING_AGENT)).toBe("Listing Agent");
      expect(formatRoleLabel(SPECIFIC_ROLES.BUYER_AGENT)).toBe("Buyer Agent");
      expect(formatRoleLabel(SPECIFIC_ROLES.INSPECTOR)).toBe("Inspector");
      expect(formatRoleLabel(SPECIFIC_ROLES.APPRAISER)).toBe("Appraiser");
      expect(formatRoleLabel(SPECIFIC_ROLES.LENDER)).toBe("Lender");
      expect(formatRoleLabel(SPECIFIC_ROLES.OTHER)).toBe("Other");
    });

    it("should format unknown roles by splitting on underscores and title-casing", () => {
      expect(formatRoleLabel("custom_role")).toBe("Custom Role");
      expect(formatRoleLabel("my_special_agent")).toBe("My Special Agent");
    });

    it("should handle single word roles", () => {
      expect(formatRoleLabel("seller")).toBe("Seller");
      expect(formatRoleLabel("buyer")).toBe("Buyer");
    });

    it("should handle empty string", () => {
      expect(formatRoleLabel("")).toBe("");
    });

    it("should handle roles with mixed case in input", () => {
      expect(formatRoleLabel("CUSTOM_ROLE")).toBe("Custom Role");
      expect(formatRoleLabel("Custom_Role")).toBe("Custom Role");
    });
  });
});
