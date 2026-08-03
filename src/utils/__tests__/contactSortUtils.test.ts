/**
 * Unit tests for contactSortUtils
 *
 * Tests for contact sorting utilities.
 * @see TASK-1770: Sort Contacts by Most Recent Communication
 */

import { sortByRecentCommunication, sortByName } from "../contactSortUtils";

/**
 * Row shape accepted by sortByRecentCommunication's generic constraint
 * (Pick<ExtendedContact, "last_communication_at">), used to narrow the two
 * fixtures below that pass real `Date` objects — a form parseDate() handles at
 * runtime but ExtendedContact does not model.
 */
type DateSortableContact = { id: string; last_communication_at: string };

describe("contactSortUtils", () => {
  describe("sortByRecentCommunication", () => {
    it("should sort contacts by most recent first", () => {
      const contacts = [
        { id: "1", last_communication_at: "2026-01-01T10:00:00Z" },
        { id: "2", last_communication_at: "2026-01-15T10:00:00Z" },
        { id: "3", last_communication_at: "2026-01-10T10:00:00Z" },
      ];

      const sorted = sortByRecentCommunication(contacts);

      expect(sorted.map((c) => c.id)).toEqual(["2", "3", "1"]);
    });

    it("should place contacts without communication at the end", () => {
      const contacts = [
        { id: "1", last_communication_at: null },
        { id: "2", last_communication_at: "2026-01-15T10:00:00Z" },
        { id: "3", last_communication_at: undefined },
      ];

      const sorted = sortByRecentCommunication(contacts);

      // Contact with date should be first
      expect(sorted[0].id).toBe("2");
      // Contacts without dates should be at end (order between them doesn't matter)
      expect(["1", "3"]).toContain(sorted[1].id);
      expect(["1", "3"]).toContain(sorted[2].id);
    });

    it("should not mutate the original array", () => {
      const contacts = [
        { id: "1", last_communication_at: "2026-01-01T10:00:00Z" },
        { id: "2", last_communication_at: "2026-01-15T10:00:00Z" },
      ];
      const original = [...contacts];

      sortByRecentCommunication(contacts);

      expect(contacts).toEqual(original);
    });

    it("should handle empty array", () => {
      expect(sortByRecentCommunication([])).toEqual([]);
    });

    it("should handle single contact", () => {
      const contacts = [
        { id: "1", last_communication_at: "2026-01-01T10:00:00Z" },
      ];

      const sorted = sortByRecentCommunication(contacts);

      expect(sorted).toEqual(contacts);
    });

    it("should handle Date objects", () => {
      const contacts = [
        { id: "1", last_communication_at: new Date("2026-01-01T10:00:00Z") },
        { id: "2", last_communication_at: new Date("2026-01-15T10:00:00Z") },
      ];

      // parseDate() handles real Date instances at runtime, but ExtendedContact
      // types last_communication_at as `string | null`, so the fixture (Dates and
      // all) is narrowed only at the call boundary. Values are untouched.
      const sorted = sortByRecentCommunication(
        contacts as unknown as DateSortableContact[],
      );

      expect(sorted.map((c) => c.id)).toEqual(["2", "1"]);
    });

    it("should handle mixed Date objects and strings", () => {
      const contacts = [
        { id: "1", last_communication_at: "2026-01-01T10:00:00Z" },
        { id: "2", last_communication_at: new Date("2026-01-15T10:00:00Z") },
        { id: "3", last_communication_at: "2026-01-10T10:00:00Z" },
      ];

      // See note above: Date values are supported at runtime, not in the type.
      const sorted = sortByRecentCommunication(
        contacts as unknown as DateSortableContact[],
      );

      expect(sorted.map((c) => c.id)).toEqual(["2", "3", "1"]);
    });

    it("should handle contacts with same timestamp", () => {
      const contacts = [
        { id: "1", last_communication_at: "2026-01-15T10:00:00Z" },
        { id: "2", last_communication_at: "2026-01-15T10:00:00Z" },
      ];

      const sorted = sortByRecentCommunication(contacts);

      // Both should be present, order doesn't matter for same timestamp
      expect(sorted.length).toBe(2);
      expect(sorted.map((c) => c.id).sort()).toEqual(["1", "2"]);
    });

    it("should handle invalid date strings", () => {
      const contacts = [
        { id: "1", last_communication_at: "invalid-date" },
        { id: "2", last_communication_at: "2026-01-15T10:00:00Z" },
        { id: "3", last_communication_at: "not-a-date" },
      ];

      const sorted = sortByRecentCommunication(contacts);

      // Valid date should come first
      expect(sorted[0].id).toBe("2");
      // Invalid dates should be at end (treated as 0)
      expect(["1", "3"]).toContain(sorted[1].id);
      expect(["1", "3"]).toContain(sorted[2].id);
    });

    it("should handle all contacts without communication dates", () => {
      const contacts = [
        { id: "1", last_communication_at: null },
        { id: "2", last_communication_at: undefined },
        { id: "3", last_communication_at: null },
      ];

      const sorted = sortByRecentCommunication(contacts);

      // All contacts should be present
      expect(sorted.length).toBe(3);
    });
  });

  describe("sortByName", () => {
    it("should sort contacts alphabetically", () => {
      const contacts = [
        { id: "1", name: "Charlie" },
        { id: "2", name: "Alice" },
        { id: "3", name: "Bob" },
      ];

      const sorted = sortByName(contacts);

      expect(sorted.map((c) => c.name)).toEqual(["Alice", "Bob", "Charlie"]);
    });

    it("should be case-insensitive", () => {
      const contacts = [
        { id: "1", name: "charlie" },
        { id: "2", name: "Alice" },
        { id: "3", name: "BOB" },
      ];

      const sorted = sortByName(contacts);

      expect(sorted.map((c) => c.name)).toEqual(["Alice", "BOB", "charlie"]);
    });

    it("should handle null/undefined names", () => {
      const contacts = [
        { id: "1", name: "Alice" },
        { id: "2", name: null as unknown as string },
        { id: "3", name: undefined as unknown as string },
      ];

      // Should not throw
      expect(() => sortByName(contacts)).not.toThrow();

      const sorted = sortByName(contacts);
      // Alice should come after empty names (empty string sorts before 'a')
      expect(sorted.length).toBe(3);
    });

    it("should not mutate the original array", () => {
      const contacts = [
        { id: "1", name: "Charlie" },
        { id: "2", name: "Alice" },
      ];
      const original = [...contacts];

      sortByName(contacts);

      expect(contacts).toEqual(original);
    });

    it("should handle empty array", () => {
      expect(sortByName([])).toEqual([]);
    });

    it("should handle single contact", () => {
      const contacts = [{ id: "1", name: "Alice" }];

      const sorted = sortByName(contacts);

      expect(sorted).toEqual(contacts);
    });

    it("should handle names with special characters", () => {
      const contacts = [
        { id: "1", name: "O'Brien" },
        { id: "2", name: "Adams" },
        { id: "3", name: "Mc'Donald" },
      ];

      const sorted = sortByName(contacts);

      expect(sorted.map((c) => c.name)).toEqual([
        "Adams",
        "Mc'Donald",
        "O'Brien",
      ]);
    });
  });
});
