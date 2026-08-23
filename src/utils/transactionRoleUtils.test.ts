import {
  filterRolesByTransactionType,
  getTransactionTypeContext,
  validateRoleAssignments,
  getRoleDisplayName,
  formatRoleLabel,
  resolveDefaultContactRole,
  type RoleConfig,
  type ContactAssignments,
} from "./transactionRoleUtils";
import { SPECIFIC_ROLES } from "../constants/contactRoles";

describe("transactionRoleUtils", () => {
  describe("resolveDefaultContactRole (BACKLOG-2358)", () => {
    // For a sale, buyer-side roles are valid; seller-side get flipped.
    const saleValid = (r: string) =>
      r === SPECIFIC_ROLES.BUYER ||
      r === SPECIFIC_ROLES.BUYER_AGENT ||
      r === SPECIFIC_ROLES.CLIENT;

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

    it("uses a valid default_role directly when auto-role is ON", () => {
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.BUYER_AGENT, "sale", saleValid)
      ).toBe(SPECIFIC_ROLES.BUYER_AGENT);
    });

    it("flips an other-side default_role to the equivalent role when auto-role is ON", () => {
      // seller_agent is not valid for a sale → flips to buyer_agent.
      expect(
        resolveDefaultContactRole(true, SPECIFIC_ROLES.SELLER_AGENT, "sale", saleValid)
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
    it('should return "Buyer (Client)" for CLIENT role in purchase transaction', () => {
      const result = getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "purchase");
      expect(result).toBe("Buyer (Client)");
    });

    it('should return "Seller (Client)" for CLIENT role in sale transaction', () => {
      const result = getRoleDisplayName(SPECIFIC_ROLES.CLIENT, "sale");
      expect(result).toBe("Seller (Client)");
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
