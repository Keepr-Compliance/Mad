/**
 * BACKLOG-3475 — the renderer service, and the one line that could undo the
 * whole main-process design.
 *
 * `checklistTemplateService` answers `null` rather than `[]` when a read fails,
 * and the handler turns that into `success: false` with `templates` ABSENT. All
 * of that is thrown away by `data: result.templates ?? []` here — one character
 * sequence, in the file closest to the surface, that turns "we could not read
 * your brokerage's checklists" into "your brokerage has not set up any".
 *
 * That is the mutation this suite exists to catch. The rest of it is the
 * ordinary contract: which argument shape each channel receives, and that a
 * thrown bridge becomes a result rather than an exception a component has to
 * handle.
 *
 * `window.api.checklists` comes from `tests/setup.js`, whose defaults are the
 * REFUSED answers — so a test that forgets to arrange the allowed path sees the
 * same thing a user without the plan sees.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { checklistService } from "../checklistService";

const api = () => (window as any).api.checklists;

const TEMPLATE = {
  id: "<fixture:template-p1-active>",
  name: "Probe template",
  description: "shown in the list only",
  sortOrder: 10,
  updatedAt: "<timestamp>",
  items: [],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("listTemplates — a failed read is not an empty brokerage", () => {
  it("a refusal comes back as a failure with NO data, never as an empty list", async () => {
    api().listTemplates.mockResolvedValue({
      success: false,
      error: "Your brokerage's checklist templates could not be loaded right now.",
    });

    const result = await checklistService.listTemplates();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/could not be loaded/);
    // The line that must never be written: `data: result.templates ?? []`.
    expect(result.data).toBeUndefined();
  });

  it("an organization with no templates IS a success, carrying an empty list", async () => {
    api().listTemplates.mockResolvedValue({ success: true, templates: [], source: "live" });

    const result = await checklistService.listTemplates();

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ templates: [], source: "live" });
  });

  it("templates are passed through with their source", async () => {
    api().listTemplates.mockResolvedValue({
      success: true,
      templates: [TEMPLATE],
      source: "cache",
    });

    const result = await checklistService.listTemplates();

    expect(result.data!.templates.map((t) => t.name)).toEqual(["Probe template"]);
    expect(result.data!.source).toBe("cache");
  });

  it("a bridge that throws becomes a failure, not an exception", async () => {
    api().listTemplates.mockRejectedValue(new Error("ipc died"));

    await expect(checklistService.listTemplates()).resolves.toEqual({
      success: false,
      error: "ipc died",
    });
  });
});

describe("the write channels pass the shapes the Zod schemas expect", () => {
  it("selectTemplate", async () => {
    api().selectTemplate.mockResolvedValue({
      success: true,
      result: { status: "selected", checklistId: "c-1" },
    });

    const result = await checklistService.selectTemplate("t-1", "tpl-1", true);

    expect(api().selectTemplate).toHaveBeenCalledWith({
      transactionId: "t-1",
      templateId: "tpl-1",
      replaceExisting: true,
    });
    expect(result.data).toEqual({ status: "selected", checklistId: "c-1" });
  });

  it("a declined write still arrives as data, because the call ran and answered", async () => {
    api().selectTemplate.mockResolvedValue({
      success: true,
      result: { status: "exists", checklistId: "c-1" },
    });

    const result = await checklistService.selectTemplate("t-1", "tpl-1");

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ status: "exists", checklistId: "c-1" });
  });

  it("get maps an absent checklist to null rather than undefined", async () => {
    api().get.mockResolvedValue({ success: true, checklist: null });

    await expect(checklistService.get("t-1")).resolves.toEqual({ success: true, data: null });
    expect(api().get).toHaveBeenCalledWith({ transactionId: "t-1" });
  });

  it("setItemChecked / setItemNote / removeLink / remove report whether a row changed", async () => {
    api().setItemChecked.mockResolvedValue({ success: true, changed: true });
    api().setItemNote.mockResolvedValue({ success: true, changed: false });
    api().removeLink.mockResolvedValue({ success: true, changed: true });
    api().remove.mockResolvedValue({ success: true, changed: false });

    await expect(checklistService.setItemChecked("i-1", true)).resolves.toEqual({
      success: true,
      data: true,
    });
    await expect(checklistService.setItemNote("i-1", null)).resolves.toEqual({
      success: true,
      data: false,
    });
    await expect(checklistService.removeLink("l-1")).resolves.toEqual({
      success: true,
      data: true,
    });
    await expect(checklistService.remove("t-1")).resolves.toEqual({
      success: true,
      data: false,
    });

    expect(api().setItemChecked).toHaveBeenCalledWith({ itemId: "i-1", checked: true });
    expect(api().setItemNote).toHaveBeenCalledWith({ itemId: "i-1", note: null });
    expect(api().removeLink).toHaveBeenCalledWith({ linkId: "l-1" });
    expect(api().remove).toHaveBeenCalledWith({ transactionId: "t-1" });
  });

  it("addLink sends the kind and the target list unchanged", async () => {
    api().addLink.mockResolvedValue({
      success: true,
      result: { status: "added", linkId: "l-1", memberCount: 2 },
    });

    const result = await checklistService.addLink("i-1", "email", ["e-1", "e-2"]);

    expect(api().addLink).toHaveBeenCalledWith({
      itemId: "i-1",
      kind: "email",
      targetIds: ["e-1", "e-2"],
    });
    expect(result.data).toEqual({ status: "added", linkId: "l-1", memberCount: 2 });
  });
});

describe("the shipped test defaults are the refused answers", () => {
  it("an unarranged listTemplates refuses, and carries no data", async () => {
    const result = await checklistService.listTemplates();

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });
});
