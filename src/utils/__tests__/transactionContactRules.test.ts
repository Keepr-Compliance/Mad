/**
 * @jest-environment node
 *
 * BACKLOG-2680 / BACKLOG-2681 — the rules the two add surfaces now share.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR, GIVEN THE OTHER TWO SUITES EXIST
 * ---------------------------------------------------------------------------
 * `useAuditSteps.blankedRoleNotDropped-2680` drives the real wizard, and
 * `transaction-handlers.lastClient-2681` drives the real IPC channel. Both are
 * end-to-end and neither sweeps the shape space.
 *
 * This one sweeps it — and pins the message text, which is the thing BACKLOG-2680's
 * control 3 is actually about: *"whatever rule is chosen matches Edit
 * Contacts"*. Both surfaces call `missingRolesMessage`, so the two sentences
 * cannot drift; if someone inlines a string on one surface again, the wizard
 * suite's exact-text assertion goes red.
 *
 * `toRoleContactIds` is tested against the WIZARD's shape specifically, because
 * that adapter is the only place the two surfaces' data models meet and a
 * mistake there would silently exempt the wizard from both rules.
 */

import {
  contactIdsWithRoles,
  findContactsMissingRoles,
  missingRolesMessage,
  toRoleContactIds,
} from "../transactionContactRules";

describe("toRoleContactIds narrows the wizard's shape", () => {
  it("keeps the ids under their roles", () => {
    expect(
      toRoleContactIds({
        client: [{ contactId: "c1" }, { contactId: "c2" }],
        inspector: [{ contactId: "c3" }],
      }),
    ).toEqual({ client: ["c1", "c2"], inspector: ["c3"] });
  });

  it("drops an undefined role list rather than emitting undefined", () => {
    expect(toRoleContactIds({ client: undefined })).toEqual({});
  });

  it("keeps an EMPTY role list, because an empty list is not a holder", () => {
    expect(toRoleContactIds({ client: [] })).toEqual({ client: [] });
  });
});

describe("contactIdsWithRoles", () => {
  it("collects across every role", () => {
    expect([...contactIdsWithRoles({ client: ["c1"], inspector: ["c2"] })].sort()).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("counts a contact once when it somehow appears twice", () => {
    expect(contactIdsWithRoles({ client: ["c1"], buyer: ["c1"] }).size).toBe(1);
  });

  it("is empty for empty and undefined lists", () => {
    expect(contactIdsWithRoles({ client: [], inspector: undefined }).size).toBe(0);
  });
});

describe("findContactsMissingRoles", () => {
  /** BACKLOG-2680's exact case: three selected, one blanked. */
  it("names the selected contact that holds no role", () => {
    expect(
      findContactsMissingRoles(["c1", "c2", "c3"], { client: ["c1"], seller_agent: ["c2"] }),
    ).toEqual(["c3"]);
  });

  it("is empty when everyone holds a role", () => {
    expect(findContactsMissingRoles(["c1"], { client: ["c1"] })).toEqual([]);
  });

  it("returns every role-less contact, not just the first", () => {
    expect(findContactsMissingRoles(["c1", "c2", "c3"], { client: ["c1"] })).toEqual([
      "c2",
      "c3",
    ]);
  });

  /**
   * A contact holding a role but NOT selected is not reported. The rule is
   * about the people the user chose, not about stale entries in the map — and
   * `handleRoleChange` can leave an empty array behind under an old role.
   */
  it("ignores a role holder that is not selected", () => {
    expect(findContactsMissingRoles(["c1"], { client: ["c1"], inspector: ["c9"] })).toEqual([]);
  });

  it("treats an emptied role list as holding nobody", () => {
    expect(findContactsMissingRoles(["c1"], { client: [] })).toEqual(["c1"]);
  });

  it("is empty when nothing is selected", () => {
    expect(findContactsMissingRoles([], { client: ["c1"] })).toEqual([]);
  });
});

describe("missingRolesMessage matches the string Edit Contacts already shipped", () => {
  it("is singular for one", () => {
    expect(missingRolesMessage(1)).toBe(
      "Please assign a role to all contacts (1 contact missing roles)",
    );
  });

  it("is plural for two", () => {
    expect(missingRolesMessage(2)).toBe(
      "Please assign a role to all contacts (2 contacts missing roles)",
    );
  });

  /** The shipped string pluralises the noun and not "roles". Preserved verbatim. */
  it("leaves 'roles' plural in both cases", () => {
    expect(missingRolesMessage(1)).toContain("missing roles");
    expect(missingRolesMessage(5)).toContain("missing roles");
  });
});

/**
 * There is no `hasClientAssigned` suite here, and no last-Client message
 * parity test, because BACKLOG-2683's founder decision deleted the rule they
 * covered on 13 Aug. Both this module's Client helper and its main-process
 * mirror (`electron/utils/transactionClientRule.ts`) are gone. The wizard no
 * longer refuses a deal with no Client; see
 * `useAuditSteps.saveSucceedsUntouched-2677.test.tsx`, which now asserts that
 * such a save SUCCEEDS.
 */
