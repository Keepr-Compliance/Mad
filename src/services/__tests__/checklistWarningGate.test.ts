/**
 * BACKLOG-3477 — which required items the pre-submit checklist warning lists,
 * and what a failed read does. No rendering: the flow (where the warning shows,
 * what its buttons do) is owned by
 * src/components/__tests__/TransactionDetails.checklistWarningGate-3477.test.tsx.
 *
 * FIXTURE PROVENANCE: `checklistFixtures-3476.json` is the real
 * `getChecklistsForTransaction` output over the real schema, kept honest by
 * electron/services/db/__tests__/checklistRendererFixtures-3476.test.ts
 * (real-sqlite, Electron runner). Its three checklists hold:
 *   Probe template        item 1 req ticked, item 2 req NOT ticked,
 *                         item 3 opt ticked, item 4 opt NOT ticked
 *   Other probe template  item 1 req ticked, items 2 + 3 req NOT ticked
 *   Done probe template   everything ticked
 * The empty envelope is tests/setup.js's default, which is what the producer
 * returns for a transaction with no checklists.
 *
 * Moved from SubmitForReviewModal.checklistWarning-3477 (E-C1, E-1, the
 * malformed-data case) when the warning moved out of the modal.
 */
import {
  listUncheckedRequiredItems,
  readUncheckedRequiredItems,
} from "../checklistWarningGate";
import type { ChecklistsForTransaction } from "../../../electron/types/checklist";
import fixtures from "../../components/transactionDetailsModule/components/checklist/__tests__/fixtures/checklistFixtures-3476.json";

const REAL: ChecklistsForTransaction = fixtures.checklists as unknown as ChecklistsForTransaction;
const EMPTY: ChecklistsForTransaction = { checklists: [], requiredDone: 0, requiredTotal: 0 };
const only = (name: string): ChecklistsForTransaction => {
  const checklists = REAL.checklists.filter((c) => c.checklist.templateName === name);
  return {
    checklists,
    requiredDone: checklists.reduce((s, c) => s + c.requiredDone, 0),
    requiredTotal: checklists.reduce((s, c) => s + c.requiredTotal, 0),
  };
};

const getMock = () => window.api.checklists.get as jest.Mock;

describe("BACKLOG-3477 E-C1 — required items unticked across every checklist", () => {
  it("lists exactly the required, unticked items, in order, never an optional one", () => {
    const items = listUncheckedRequiredItems(REAL);
    expect(items.map((i) => i.title)).toEqual(["Probe item 2", "Other item 2", "Other item 3"]);
    expect(items.map((i) => i.title)).not.toContain("Probe item 4");
  });

  it("everything ticked, or no checklists → nothing", () => {
    expect(listUncheckedRequiredItems(only("Done probe template"))).toEqual([]);
    expect(listUncheckedRequiredItems(EMPTY)).toEqual([]);
  });
});

describe("BACKLOG-3477 E-1 — rows name their checklist only when there are two or more", () => {
  it("with 2+ checklists, each item carries its own checklist's name", () => {
    expect(listUncheckedRequiredItems(REAL).map((i) => [i.title, i.checklistName])).toEqual([
      ["Probe item 2", "Probe template"],
      ["Other item 2", "Other probe template"],
      ["Other item 3", "Other probe template"],
    ]);
  });

  it("with exactly 1 checklist, the name is null", () => {
    expect(listUncheckedRequiredItems(only("Probe template")).map((i) => [i.title, i.checklistName])).toEqual([
      ["Probe item 2", null],
    ]);
  });
});

describe("BACKLOG-3477 — malformed checklist data never throws", () => {
  it("a checklist with no items array reads as empty; the others are still listed", () => {
    const broken = REAL.checklists.map((c) =>
      c.checklist.templateName === "Probe template"
        ? ({ ...c, items: undefined } as unknown as (typeof REAL.checklists)[number])
        : c,
    );
    expect(listUncheckedRequiredItems({ ...REAL, checklists: broken }).map((i) => i.title)).toEqual([
      "Other item 2",
      "Other item 3",
    ]);
  });

  it("no checklists array at all reads as empty", () => {
    expect(
      listUncheckedRequiredItems({ requiredDone: 0, requiredTotal: 0 } as unknown as ChecklistsForTransaction),
    ).toEqual([]);
  });
});

describe("BACKLOG-3477 E-C5 — readUncheckedRequiredItems fails open", () => {
  beforeEach(() => getMock().mockReset());

  it("reads the transaction's checklists and lists the unticked required items", async () => {
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    const items = await readUncheckedRequiredItems("txn-3477");
    expect(getMock()).toHaveBeenCalledWith({ transactionId: "txn-3477" });
    expect(items).toHaveLength(3);
  });

  it.each([
    ["the read is refused", () => getMock().mockResolvedValue({ success: false, error: "boom" })],
    ["the IPC throws", () => getMock().mockRejectedValue(new Error("ipc down"))],
  ])("%s → [] (no warning)", async (_label, arrange) => {
    arrange();
    await expect(readUncheckedRequiredItems("txn-3477")).resolves.toEqual([]);
  });
});
