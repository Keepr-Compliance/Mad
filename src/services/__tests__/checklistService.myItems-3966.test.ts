/**
 * BACKLOG-3966 PR-2 — the renderer service over the agent's own items
 * ("My items"). Each method passes its arguments through as one object, hands
 * back main's answer, and NEVER throws: a bridge that rejects (IPC torn down,
 * main crashed) becomes `success: false`, the shape every caller already
 * renders. A rethrow would surface as an unhandled rejection in the section
 * that called it.
 */
import { checklistService } from "../checklistService";

const api = () => (window as unknown as { api: { checklists: Record<string, jest.Mock> } }).api.checklists;
const DEAL = "00000000-0000-4000-8000-000000003966"; // pii-allow-uuid: invented fixture id
const ITEM = "00000000-0000-4000-8000-0000000039a1"; // pii-allow-uuid: invented fixture id
const ITEM_2 = "00000000-0000-4000-8000-0000000039a2"; // pii-allow-uuid: invented fixture id

describe("BACKLOG-3966 checklistService — My items", () => {
  it("each call names the deal and passes main's answer through", async () => {
    api().addMyItem.mockResolvedValueOnce({
      success: true,
      result: { status: "added", checklistId: "c", itemId: ITEM },
    });
    expect(await checklistService.addMyItem(DEAL, "Call the lender")).toEqual({
      success: true,
      data: { status: "added", checklistId: "c", itemId: ITEM },
    });
    expect(api().addMyItem).toHaveBeenCalledWith({ transactionId: DEAL, title: "Call the lender" });

    api().renameMyItem.mockResolvedValueOnce({ success: true, changed: true });
    expect(await checklistService.renameMyItem(DEAL, ITEM, "Renamed")).toEqual({ success: true, data: true });
    expect(api().renameMyItem).toHaveBeenCalledWith({ transactionId: DEAL, itemId: ITEM, title: "Renamed" });

    api().reorderMyItems.mockResolvedValueOnce({ success: true, result: { status: "reordered" } });
    expect(await checklistService.reorderMyItems(DEAL, [ITEM_2, ITEM])).toEqual({
      success: true,
      data: { status: "reordered" },
    });
    expect(api().reorderMyItems).toHaveBeenCalledWith({ transactionId: DEAL, itemIds: [ITEM_2, ITEM] });

    api().removeMyItem.mockResolvedValueOnce({ success: true, changed: false });
    expect(await checklistService.removeMyItem(DEAL, ITEM)).toEqual({ success: true, data: false });
    expect(api().removeMyItem).toHaveBeenCalledWith({ transactionId: DEAL, itemId: ITEM });
  });

  it("a refusal from main (a locked deal) is success: false with main's sentence", async () => {
    const locked = { success: false, error: "This deal is sealed, so it can't be changed." };
    api().addMyItem.mockResolvedValueOnce(locked);
    expect(await checklistService.addMyItem(DEAL, "x")).toEqual({ success: false, error: locked.error });
    api().reorderMyItems.mockResolvedValueOnce(locked);
    expect(await checklistService.reorderMyItems(DEAL, [ITEM])).toEqual({ success: false, error: locked.error });
  });

  it("a bridge that rejects becomes a failure, never an exception — all four", async () => {
    for (const m of ["addMyItem", "renameMyItem", "reorderMyItems", "removeMyItem"]) {
      api()[m].mockRejectedValueOnce(new Error("ipc died"));
    }
    const results = await Promise.all([
      checklistService.addMyItem(DEAL, "x"),
      checklistService.renameMyItem(DEAL, ITEM, "x"),
      checklistService.reorderMyItems(DEAL, [ITEM]),
      checklistService.removeMyItem(DEAL, ITEM),
    ]);
    for (const r of results) {
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/ipc died/);
    }
  });
});
