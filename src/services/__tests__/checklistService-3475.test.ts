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
 * That is the mutation this suite exists to catch, and exactly ONE test here
 * can catch it: "a success carrying NO templates key is not an empty
 * brokerage". Every other input in this file is blind to it. Under
 * `success: false` the shipped code and the `?? []` version both return early
 * with `data` undefined, so the refusal case below passes against either —
 * measured, not assumed: with the mutation applied the other ten tests stay
 * green (SR review `3f57d5e7` on pm_comments, MA4).
 *
 * The rest of the suite is the ordinary contract: which argument shape each
 * channel receives, and that a thrown bridge becomes a result rather than an
 * exception a component has to handle.
 *
 * `window.api.checklists` comes from `tests/setup.js`, whose defaults are the
 * REFUSED answers — so a test that forgets to arrange the allowed path sees the
 * same thing a user without the plan sees.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { checklistService } from "../checklistService";

const api = () => (window as any).api.checklists;

/**
 * The IMPLEMENTATIONS `tests/setup.js` ships, captured before any test replaces
 * them.
 *
 * `getMockImplementation()`, not a spread of the object. The spread was tried
 * first and does not work: it copies references to the same `jest.fn`s, so an
 * earlier `mockResolvedValue` reaches the assertions through it anyway —
 * measured, and it turned the check below into an "ipc died" rejection left
 * over from four tests earlier.
 *
 * `jest.clearAllMocks()` clears recorded calls but NOT implementations, which
 * is why nothing in `beforeEach` restores them either. Without this snapshot
 * the last describe would be order-dependent and prove nothing.
 */
const SHIPPED_DEFAULTS = Object.fromEntries(
  Object.entries((window as any).api.checklists).map(([name, fn]) => [
    name,
    (fn as jest.Mock).getMockImplementation() as (...args: unknown[]) => Promise<any>,
  ]),
) as Record<string, (...args: unknown[]) => Promise<any>>;

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
    // What this case does NOT prove: `data: result.templates ?? []`. Under
    // `success: false` both implementations return early, so `data` is
    // undefined either way and this assertion cannot separate them. What it
    // does prove is that the handler's message is carried through and no data
    // is invented alongside it. The test below is the one that can go red on
    // the `?? []` line.
    expect(result.data).toBeUndefined();
  });

  it("a success carrying NO templates key is not an empty brokerage", async () => {
    // THE runtime control for `data: result.templates ?? []`, and the only
    // input that can be: the two implementations differ only when `success`
    // is true and `templates` is absent.
    //
    // Since BACKLOG-3476 the handler, the bridge and `WindowApiChecklists`
    // share ONE union (`ListChecklistTemplatesResult`) in which a success
    // always carries `templates`. That guards the PRODUCER at compile time: a
    // handler branch answering `success: true` without a listing fails
    // `npm run type-check` (TS2322 in `checklistHandlers.ts`) — that is the
    // compile-time control, and jest cannot run it. What the union cannot see
    // is the IPC hop: `ipcRenderer.invoke` is `any`, so the renderer receives
    // whatever main actually sent. This test guards that hop at run time, and
    // it compiles under any declaration because it mocks through
    // `(window as any)`. Kept on purpose (SR plan review, condition 4).
    api().listTemplates.mockResolvedValue({ success: true, source: "live" });

    const result = await checklistService.listTemplates();

    expect(result.success).toBe(false);
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

  it("selectTemplate forwards replaceExisting as given and never forces it (BACKLOG-3476)", async () => {
    // A plain pick must reach main WITHOUT replaceExisting, so a second window
    // that picked first gets `exists` instead of having its checklist wiped.
    // Forcing `replaceExisting: true` here left every other test green.
    // Asserted on the argument itself: `toHaveBeenCalledWith({... replaceExisting:
    // undefined})` also matches an object with the key missing, which would
    // hide nothing here but reads as a stronger claim than it is.
    api().selectTemplate.mockResolvedValue({
      success: true,
      result: { status: "selected", checklistId: "c-1" },
    });

    await checklistService.selectTemplate("t-1", "tpl-1");
    await checklistService.selectTemplate("t-1", "tpl-1", false);

    expect(api().selectTemplate).toHaveBeenCalledTimes(2);
    expect(api().selectTemplate.mock.calls[0][0].replaceExisting).toBeUndefined();
    expect(api().selectTemplate.mock.calls[1][0].replaceExisting).toBe(false);
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
  it("every gated default refuses, and listTemplates carries no templates key", async () => {
    const listing = await SHIPPED_DEFAULTS.listTemplates();
    expect(listing.success).toBe(false);
    // Absent, not `[]`: a default that blurred the two would let a component
    // ship with "could not read" and "none exist" confused and still pass.
    expect("templates" in listing).toBe(false);

    for (const method of [
      "selectTemplate",
      "setItemChecked",
      "setItemNote",
      "addLink",
      "removeLink",
    ] as const) {
      await expect(SHIPPED_DEFAULTS[method]({})).resolves.toMatchObject({
        success: false,
      });
    }

    // The three the main process never gates default to the working answer:
    // `get`, `remove` and `invalidate-templates` (the unhide rule — a user
    // whose plan lapses can still read and clear his own rows).
    await expect(SHIPPED_DEFAULTS.get({})).resolves.toMatchObject({ success: true });
    await expect(SHIPPED_DEFAULTS.remove({})).resolves.toMatchObject({ success: true });
    await expect(SHIPPED_DEFAULTS.invalidateTemplates()).resolves.toMatchObject({
      success: true,
    });
  });
});
