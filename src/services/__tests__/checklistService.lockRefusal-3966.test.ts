/**
 * BACKLOG-3966 PR-3 — every lock-gated checklist write keeps main's lock flags.
 *
 * Main refuses a write on a locked deal with
 * `{ success: false, error, dealLocked, refusedEdit }` (refuseIfDealLocked,
 * electron/services/dealLockState.ts). The set below is every service method
 * whose handler calls it: `git grep -n "refuseIfDealLocked\|refuseIfChecklistDealLocked"
 * -- electron/handlers/checklistHandlers.ts electron/handlers/checklistMyItemsHandlers.ts`
 * = 11 call sites (select-template, set-item-checked, set-item-note, add-link,
 * include-link-outside-dates, remove-link, remove, and the four My-items writes).
 * The refusal shape is transcribed from refuseIfDealLocked's return statement.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { checklistService, lockRefusalOf } from "../checklistService";

const api = () => (window as any).api.checklists as Record<string, jest.Mock>;

const LOCK_TEXT = "This deal is with your broker for review, so it can't be changed until it's returned to you.";

const WRITES: Array<[string, string, () => Promise<any>]> = [
  ["selectTemplate", "add-checklist", () => checklistService.selectTemplate("txn-1", "tpl-1")],
  ["setItemChecked", "tick-checklist-item", () => checklistService.setItemChecked("item-1", true)],
  ["setItemNote", "edit-checklist-note", () => checklistService.setItemNote("item-1", "n")],
  ["addLink", "link-checklist-item", () => checklistService.addLink("item-1", "attachment", ["a-1"])],
  ["includeLinkOutsideDates", "include-outside-dates", () => checklistService.includeLinkOutsideDates("txn-1", "l-1")],
  ["removeLink", "unlink-checklist-item", () => checklistService.removeLink("l-1")],
  ["remove", "take-off-checklist", () => checklistService.remove("txn-1", "cl-1")],
  ["addMyItem", "add-my-item", () => checklistService.addMyItem("txn-1", "Call the lender")],
  ["renameMyItem", "rename-my-item", () => checklistService.renameMyItem("txn-1", "item-1", "Renamed")],
  ["reorderMyItems", "reorder-my-items", () => checklistService.reorderMyItems("txn-1", ["item-1"])],
  ["removeMyItem", "remove-my-item", () => checklistService.removeMyItem("txn-1", "item-1")],
];

// tests/setup.js has no `includeLinkOutsideDates` mock; give it one here.
beforeAll(() => {
  api().includeLinkOutsideDates ??= jest.fn();
});
beforeEach(() => jest.clearAllMocks());

describe("lock refusal flags reach the caller", () => {
  it.each(WRITES)("%s keeps dealLocked and refusedEdit", async (method, edit, call) => {
    api()[method].mockResolvedValueOnce({ success: false, error: LOCK_TEXT, dealLocked: "submitted", refusedEdit: edit });
    await expect(call()).resolves.toEqual({
      success: false,
      error: LOCK_TEXT,
      dealLocked: "submitted",
      refusedEdit: edit,
    });
  });

  it.each(WRITES)("%s: a failure that is not a lock carries no lock flags", async (method, _edit, call) => {
    api()[method].mockResolvedValueOnce({ success: false, error: "Something else." });
    await expect(call()).resolves.toEqual({ success: false, error: "Something else." });
  });
});

describe("lockRefusalOf", () => {
  it("keeps a sealed lock without an edit name", () => {
    expect(lockRefusalOf({ success: false, dealLocked: "sealed" })).toEqual({ dealLocked: "sealed" });
  });

  it.each([[{ dealLocked: "other", refusedEdit: "x" }], [{ dealLocked: true }], [{ refusedEdit: "x" }], [{}]])(
    "ignores a shape main does not send: %j",
    (shape) => {
      expect(lockRefusalOf(shape)).toEqual({});
    },
  );
});
