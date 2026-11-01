/**
 * BACKLOG-3968 PR-4b — `checklistService.linkText`, the renderer method the
 * picker's Texts tab (U2) will call with `messages.id` values. It sends ONE
 * add-link request of kind `text`, hands main's answer back, passes a locked
 * deal's reason through, and NEVER throws: a bridge that rejects becomes
 * `success: false`, the shape every caller already renders.
 */
import { checklistService } from "../checklistService";

const api = () => (window as unknown as { api: { checklists: Record<string, jest.Mock> } }).api.checklists;
const ITEM = "00000000-0000-4000-8000-0000000039b1"; // pii-allow-uuid: invented fixture id
const MSG_1 = "00000000-0000-4000-8000-0000000039b2"; // pii-allow-uuid: invented fixture id
const MSG_2 = "00000000-0000-4000-8000-0000000039b3"; // pii-allow-uuid: invented fixture id

describe("BACKLOG-3968 checklistService.linkText", () => {
  beforeEach(() => api().addLink.mockReset());

  it("one text: a single add-link request of kind text naming that messages.id; main's result back", async () => {
    const result = { status: "added", linkId: "L", memberCount: 1 };
    api().addLink.mockResolvedValueOnce({ success: true, result });
    expect(await checklistService.linkText(ITEM, MSG_1)).toEqual({ success: true, data: result });
    expect(api().addLink).toHaveBeenCalledTimes(1);
    expect(api().addLink).toHaveBeenCalledWith({ itemId: ITEM, kind: "text", targetIds: [MSG_1] });
  });

  it("several texts go as one group", async () => {
    api().addLink.mockResolvedValueOnce({ success: true, result: { status: "added", linkId: "L", memberCount: 2 } });
    await checklistService.linkText(ITEM, [MSG_1, MSG_2]);
    expect(api().addLink).toHaveBeenCalledWith({ itemId: ITEM, kind: "text", targetIds: [MSG_1, MSG_2] });
  });

  it("main's refusal is passed through: the writer's result, and a locked deal's reason", async () => {
    const refused = { status: "targets_not_in_transaction", rejectedIds: [MSG_1] };
    api().addLink.mockResolvedValueOnce({ success: true, result: refused });
    expect(await checklistService.linkText(ITEM, MSG_1)).toEqual({ success: true, data: refused });

    api().addLink.mockResolvedValueOnce({
      success: false,
      error: "This deal is with the brokerage.",
      dealLocked: "submitted",
      refusedEdit: "link-checklist-item",
    });
    expect(await checklistService.linkText(ITEM, MSG_1)).toEqual({
      success: false,
      error: "This deal is with the brokerage.",
      dealLocked: "submitted",
      refusedEdit: "link-checklist-item",
    });
  });

  it("a bridge that rejects becomes a failure, never an exception", async () => {
    api().addLink.mockRejectedValueOnce(new Error("ipc died"));
    await expect(checklistService.linkText(ITEM, MSG_1)).resolves.toEqual({
      success: false,
      error: "ipc died",
    });
  });
});
