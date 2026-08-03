/**
 * Unit tests for contactCategoryUtils
 *
 * Tests for contact categorization and filtering utilities.
 * @see TASK-1769: Multi-Category Contact Filtering
 */

import {
  getContactCategory,
  shouldShowContact,
  loadCategoryFilter,
  saveCategoryFilter,
  DEFAULT_CATEGORY_FILTER,
  CATEGORY_FILTER_STORAGE_KEY,
  type CategoryFilter,
} from "../contactCategoryUtils";
import type { ExtendedContact } from "../../types/components";
import type { ContactSource } from "../../../electron/types/models";

// Helper to create a minimal ExtendedContact for testing
function createContact(
  overrides: Partial<ExtendedContact> = {}
): ExtendedContact {
  return {
    id: "test-id",
    name: "Test Contact",
    display_name: "Test Contact",
    email: "test@example.com",
    phone: "555-1234",
    user_id: "user-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
    // `source` is required on Contact but is deliberately left unset here so each
    // test supplies (or omits) it via `overrides` — including the "no source at
    // all" case that getContactCategory must fall back on.
  } as ExtendedContact;
}

describe("contactCategoryUtils", () => {
  describe("getContactCategory", () => {
    it('should return "external" for external contacts', () => {
      const contact = createContact({ source: "contacts_app" });
      expect(getContactCategory(contact, true)).toBe("external");
    });

    it('should return "external" for is_message_derived flag (number 1)', () => {
      // is_message_derived contacts show "External" badge in UI
      const contact = createContact({ is_message_derived: 1 });
      expect(getContactCategory(contact)).toBe("external");
    });

    it('should return "external" for is_message_derived flag (boolean true)', () => {
      // is_message_derived contacts show "External" badge in UI
      const contact = createContact({
        is_message_derived: true as unknown as number,
      });
      expect(getContactCategory(contact)).toBe("external");
    });

    it('should return "message_derived" for email source', () => {
      const contact = createContact({ source: "email" });
      expect(getContactCategory(contact)).toBe("message_derived");
    });

    it('should return "message_derived" for sms source', () => {
      const contact = createContact({ source: "sms" });
      expect(getContactCategory(contact)).toBe("message_derived");
    });

    it('should return "message_derived" for inferred source', () => {
      const contact = createContact({ source: "inferred" });
      expect(getContactCategory(contact)).toBe("message_derived");
    });

    it('should return "manually_added" for manual source', () => {
      const contact = createContact({ source: "manual" });
      expect(getContactCategory(contact)).toBe("manually_added");
    });

    it('should return "imported" for contacts_app source', () => {
      const contact = createContact({ source: "contacts_app" });
      expect(getContactCategory(contact)).toBe("imported");
    });

    it('should return "imported" for undefined source', () => {
      const contact = createContact({ source: undefined });
      expect(getContactCategory(contact)).toBe("imported");
    });

    it('should return "imported" for unknown source', () => {
      // Intentionally outside the ContactSource union: this test exists to prove
      // an unrecognised value from the DB still categorises as "imported".
      const contact = createContact({ source: "unknown_source" as ContactSource });
      expect(getContactCategory(contact)).toBe("imported");
    });

    it("should prioritize isExternal over other flags", () => {
      // Even with is_message_derived=1, if isExternal is true, it's external
      const contact = createContact({
        is_message_derived: 1,
        source: "manual",
      });
      expect(getContactCategory(contact, true)).toBe("external");
    });
  });

  describe("shouldShowContact", () => {
    it("should return true when imported filter is enabled for imported contact", () => {
      const contact = createContact({ source: "contacts_app" });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, imported: true };
      expect(shouldShowContact(contact, filter)).toBe(true);
    });

    it("should return false when imported filter is disabled for imported contact", () => {
      const contact = createContact({ source: "contacts_app" });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, imported: false };
      expect(shouldShowContact(contact, filter)).toBe(false);
    });

    it("should return true when manuallyAdded filter is enabled for manual contact", () => {
      const contact = createContact({ source: "manual" });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, manuallyAdded: true };
      expect(shouldShowContact(contact, filter)).toBe(true);
    });

    it("should return false when manuallyAdded filter is disabled for manual contact", () => {
      const contact = createContact({ source: "manual" });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, manuallyAdded: false };
      expect(shouldShowContact(contact, filter)).toBe(false);
    });

    it("should return true when external filter is enabled for external contact", () => {
      const contact = createContact({ source: "contacts_app" });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, external: true };
      expect(shouldShowContact(contact, filter, true)).toBe(true);
    });

    it("should return false when external filter is disabled for external contact", () => {
      const contact = createContact({ source: "contacts_app" });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, external: false };
      expect(shouldShowContact(contact, filter, true)).toBe(false);
    });

    it("should return true when external filter is enabled for is_message_derived contact", () => {
      // is_message_derived contacts show "External" badge, controlled by external filter
      const contact = createContact({ is_message_derived: 1 });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, external: true };
      expect(shouldShowContact(contact, filter)).toBe(true);
    });

    it("should return false when external filter is disabled for is_message_derived contact", () => {
      // is_message_derived contacts show "External" badge, controlled by external filter
      const contact = createContact({ is_message_derived: 1 });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, external: false };
      expect(shouldShowContact(contact, filter)).toBe(false);
    });

    it("should return true when messageDerived filter is enabled for email source contact", () => {
      // Contacts with message sources (email/sms/inferred) without is_message_derived flag
      const contact = createContact({ source: "email" });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, messageDerived: true };
      expect(shouldShowContact(contact, filter)).toBe(true);
    });

    it("should return false when messageDerived filter is disabled for email source contact", () => {
      const contact = createContact({ source: "email" });
      const filter: CategoryFilter = { ...DEFAULT_CATEGORY_FILTER, messageDerived: false };
      expect(shouldShowContact(contact, filter)).toBe(false);
    });

    it("should work with all filters enabled", () => {
      const allEnabled: CategoryFilter = {
        imported: true,
        manuallyAdded: true,
        external: true,
        messageDerived: true,
      };

      expect(shouldShowContact(createContact({ source: "contacts_app" }), allEnabled)).toBe(true);
      expect(shouldShowContact(createContact({ source: "manual" }), allEnabled)).toBe(true);
      expect(shouldShowContact(createContact({ is_message_derived: 1 }), allEnabled)).toBe(true);
      expect(shouldShowContact(createContact({}), allEnabled, true)).toBe(true);
    });

    it("should work with all filters disabled", () => {
      const allDisabled: CategoryFilter = {
        imported: false,
        manuallyAdded: false,
        external: false,
        messageDerived: false,
      };

      expect(shouldShowContact(createContact({ source: "contacts_app" }), allDisabled)).toBe(false);
      expect(shouldShowContact(createContact({ source: "manual" }), allDisabled)).toBe(false);
      expect(shouldShowContact(createContact({ is_message_derived: 1 }), allDisabled)).toBe(false);
      expect(shouldShowContact(createContact({}), allDisabled, true)).toBe(false);
    });
  });

  describe("loadCategoryFilter", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("should return default filter when nothing is stored", () => {
      expect(loadCategoryFilter()).toEqual(DEFAULT_CATEGORY_FILTER);
    });

    it("should return stored filter when valid", () => {
      const customFilter: CategoryFilter = {
        imported: false,
        manuallyAdded: true,
        external: false,
        messageDerived: true,
      };
      localStorage.setItem(CATEGORY_FILTER_STORAGE_KEY, JSON.stringify(customFilter));
      expect(loadCategoryFilter()).toEqual(customFilter);
    });

    it("should return default filter for invalid JSON", () => {
      localStorage.setItem(CATEGORY_FILTER_STORAGE_KEY, "invalid json");
      expect(loadCategoryFilter()).toEqual(DEFAULT_CATEGORY_FILTER);
    });

    it("should merge with defaults when partial filter stored", () => {
      // Store only some properties
      const partialFilter = { imported: false };
      localStorage.setItem(CATEGORY_FILTER_STORAGE_KEY, JSON.stringify(partialFilter));

      const result = loadCategoryFilter();
      // Should have the stored value merged with defaults
      expect(result.imported).toBe(false);
      expect(result.manuallyAdded).toBe(DEFAULT_CATEGORY_FILTER.manuallyAdded);
      expect(result.external).toBe(DEFAULT_CATEGORY_FILTER.external);
      expect(result.messageDerived).toBe(DEFAULT_CATEGORY_FILTER.messageDerived);
    });

    it("should handle empty object stored", () => {
      localStorage.setItem(CATEGORY_FILTER_STORAGE_KEY, JSON.stringify({}));
      expect(loadCategoryFilter()).toEqual(DEFAULT_CATEGORY_FILTER);
    });
  });

  describe("saveCategoryFilter", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("should save filter to localStorage", () => {
      const filter: CategoryFilter = {
        imported: false,
        manuallyAdded: true,
        external: true,
        messageDerived: true,
      };
      saveCategoryFilter(filter);
      expect(localStorage.getItem(CATEGORY_FILTER_STORAGE_KEY)).toBe(
        JSON.stringify(filter)
      );
    });

    it("should overwrite existing filter", () => {
      const filter1: CategoryFilter = {
        imported: true,
        manuallyAdded: true,
        external: true,
        messageDerived: true,
      };
      const filter2: CategoryFilter = {
        imported: false,
        manuallyAdded: false,
        external: false,
        messageDerived: false,
      };

      saveCategoryFilter(filter1);
      saveCategoryFilter(filter2);

      expect(localStorage.getItem(CATEGORY_FILTER_STORAGE_KEY)).toBe(
        JSON.stringify(filter2)
      );
    });
  });

  describe("DEFAULT_CATEGORY_FILTER", () => {
    it("should have correct default values", () => {
      expect(DEFAULT_CATEGORY_FILTER.imported).toBe(true);
      expect(DEFAULT_CATEGORY_FILTER.manuallyAdded).toBe(true);
      expect(DEFAULT_CATEGORY_FILTER.external).toBe(true);
      expect(DEFAULT_CATEGORY_FILTER.messageDerived).toBe(false);
    });
  });
});
