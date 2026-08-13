/**
 * @jest-environment node
 *
 * BACKLOG-2681 — the last Client may not be taken off a transaction, and the
 * refusal is NOT renderer-only.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RULE IS TESTED AS A PURE FUNCTION *AND* THROUGH THE IPC HANDLER
 * ---------------------------------------------------------------------------
 * This file sweeps the decision table. `transaction-handlers.lastClient-2681`
 * drives the registered `transactions:batchUpdateContacts` handler against real
 * SQLite, because control 2 of the item is that the same end state reached
 * THROUGH THE IPC CHANNEL gets the same answer — that is the leg that fails if
 * only `EditContactsModal` is changed, and a unit test of this function cannot
 * see it.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER-SENSITIVE CASE IS THE ONE THAT MATTERS
 * ---------------------------------------------------------------------------
 * `EditContactsModal` emits a remove-then-add pair for a row whose role did not
 * change, whenever some OTHER contact changed. A set-difference implementation
 * would see the remove, see no net Client, and refuse a save the user is
 * entitled to make. Replaying the operations in order is what gets that right,
 * and `remove Dana(client) then add Dana(client)` below is the control that
 * catches it.
 */

import {
  wouldRemoveLastClient,
  clientHoldersOf,
  LAST_CLIENT_REMOVED_ERROR,
  type AssignedContactRow,
  type ContactOperation,
} from "../transactionClientRule";

const dana: AssignedContactRow = { contact_id: "c-dana", role: "client" };
const agent: AssignedContactRow = { contact_id: "c-agent", role: "seller_agent" };
const inspector: AssignedContactRow = { contact_id: "c-insp", role: "inspector" };

describe("clientHoldersOf", () => {
  it("reads the Client role off `role`", () => {
    expect([...clientHoldersOf([dana, agent])]).toEqual(["c-dana"]);
  });

  it("reads it off `specific_role` when `role` is absent", () => {
    expect([
      ...clientHoldersOf([{ contact_id: "c-x", specific_role: "client" }]),
    ]).toEqual(["c-x"]);
  });

  it("is empty for a deal with no Client", () => {
    expect(clientHoldersOf([agent, inspector]).size).toBe(0);
  });

  it("counts two Clients separately", () => {
    expect(
      clientHoldersOf([dana, { contact_id: "c-2", role: "client" }]).size,
    ).toBe(2);
  });
});

describe("wouldRemoveLastClient", () => {
  /**
   * THE REPORTED DEFECT, VERBATIM. Sam changes Dana from Client to Buyer Agent.
   * `UNIQUE(transaction_id, contact_id)` means a contact holds at most one
   * role, so this arrives as an ADD that replaces what she held.
   */
  it("REFUSES changing the only Client's role to something else", () => {
    const ops: ContactOperation[] = [
      { action: "add", contactId: "c-dana", role: "buyer_agent" },
    ];
    expect(wouldRemoveLastClient([dana, agent], ops)).toBe(true);
  });

  it("REFUSES removing the only Client from the deal outright", () => {
    const ops: ContactOperation[] = [{ action: "remove", contactId: "c-dana" }];
    expect(wouldRemoveLastClient([dana, agent], ops)).toBe(true);
  });

  it("REFUSES a role-scoped remove of the only Client", () => {
    const ops: ContactOperation[] = [
      { action: "remove", contactId: "c-dana", role: "client" },
    ];
    expect(wouldRemoveLastClient([dana, agent], ops)).toBe(true);
  });

  it("REFUSES removing both Clients when there were two", () => {
    const two = [dana, { contact_id: "c-2", role: "client" }];
    const ops: ContactOperation[] = [
      { action: "remove", contactId: "c-dana" },
      { action: "remove", contactId: "c-2" },
    ];
    expect(wouldRemoveLastClient(two, ops)).toBe(true);
  });

  // --- allowed -------------------------------------------------------------

  it("ALLOWS removing one of two Clients", () => {
    const two = [dana, { contact_id: "c-2", role: "client" }];
    const ops: ContactOperation[] = [{ action: "remove", contactId: "c-dana" }];
    expect(wouldRemoveLastClient(two, ops)).toBe(false);
  });

  /**
   * THE ORDER-SENSITIVE CONTROL. A set-difference implementation reds here.
   */
  it("ALLOWS a remove-then-add pair that puts the same Client back", () => {
    const ops: ContactOperation[] = [
      { action: "remove", contactId: "c-dana", role: "client" },
      { action: "add", contactId: "c-dana", role: "client" },
    ];
    expect(wouldRemoveLastClient([dana], ops)).toBe(false);
  });

  it("ALLOWS swapping the Client role from one person to another", () => {
    const ops: ContactOperation[] = [
      { action: "add", contactId: "c-dana", role: "buyer_agent" },
      { action: "add", contactId: "c-agent", role: "client" },
    ];
    expect(wouldRemoveLastClient([dana, agent], ops)).toBe(false);
  });

  it("ALLOWS edits that do not touch the Client at all", () => {
    const ops: ContactOperation[] = [
      { action: "remove", contactId: "c-insp" },
      { action: "add", contactId: "c-new", role: "inspector" },
    ];
    expect(wouldRemoveLastClient([dana, inspector], ops)).toBe(false);
  });

  /**
   * A role-scoped remove naming a DIFFERENT role does not take the row off —
   * this mirrors `batchUpdateContactAssignments`'s own predicate, which only
   * removes when the role matches.
   */
  it("ALLOWS a role-scoped remove naming a role the Client does not hold", () => {
    const ops: ContactOperation[] = [
      { action: "remove", contactId: "c-dana", role: "inspector" },
    ];
    expect(wouldRemoveLastClient([dana], ops)).toBe(false);
  });

  /**
   * ===========================================================================
   * THE NON-REGRESSION LEG, AND THE REASON THE RULE IS THE NARROW ONE
   * ===========================================================================
   * A deal that ALREADY has no Client stays editable. A blanket "every
   * transaction must have a Client" would refuse every future edit to such a
   * deal — auto-detected deals, imported deals, and every deal created before
   * this rule existed — and that set cannot be bounded from here; it lives in
   * each user's local SQLite.
   *
   * This is the control that goes red if someone later "tightens" the rule to
   * the blanket form.
   */
  it("ALLOWS any edit to a deal that already had no Client", () => {
    const ops: ContactOperation[] = [
      { action: "remove", contactId: "c-agent" },
    ];
    expect(wouldRemoveLastClient([agent, inspector], ops)).toBe(false);
  });

  it("ALLOWS emptying a deal that already had no Client", () => {
    const ops: ContactOperation[] = [
      { action: "remove", contactId: "c-agent" },
      { action: "remove", contactId: "c-insp" },
    ];
    expect(wouldRemoveLastClient([agent, inspector], ops)).toBe(false);
  });

  it("ALLOWS an empty operation list", () => {
    expect(wouldRemoveLastClient([dana], [])).toBe(false);
  });

  /** Whitespace is not a role. */
  it("treats a whitespace-only role as no role", () => {
    const ops: ContactOperation[] = [
      { action: "add", contactId: "c-dana", role: "   " },
    ];
    expect(wouldRemoveLastClient([dana], ops)).toBe(true);
  });
});

describe("the refusal states a reason", () => {
  it("names what is wrong and what to do", () => {
    expect(LAST_CLIENT_REMOVED_ERROR).toMatch(/no Client/i);
    expect(LAST_CLIENT_REMOVED_ERROR).toMatch(/assign/i);
  });
});
