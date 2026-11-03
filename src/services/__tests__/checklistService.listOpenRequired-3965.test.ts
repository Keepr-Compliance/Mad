/**
 * BACKLOG-3965 PR-3 — checklistService.listOpenRequired never throws and never
 * rejects, and never hands the Dashboard a missing list.
 *
 * The Todo panel (PR-4b) mounts it on the Dashboard. An unguarded bridge call
 * on a mount reddened 189 of 243 tests in PR-2's probe P1; here every failure
 * shape must resolve to `success: false`, and a thrown call is logged with its
 * message and reported to Sentry. The empty answer stays an empty list.
 */
import * as Sentry from "@sentry/electron/renderer";
import logger from "../../utils/logger";
import { checklistService } from "../checklistService";
import { requiredItemsGroup, visibleTodoGroups } from "../todoGroups";
import type { OpenRequiredChecklistItem } from "../../../electron/types/checklistTodo";

const USER = "user-3965";
const api = () => window.api.checklists as unknown as Record<string, unknown>;

const ITEM: OpenRequiredChecklistItem = {
  itemId: "i1",
  checklistId: "c1",
  title: "Signed purchase agreement",
  transactionId: "d1",
  propertyAddress: "1 Elm St",
  closingDeadline: "2026-11-20",
  dealRequiredDone: 1,
  dealRequiredTotal: 3,
};

describe("checklistService.listOpenRequired", () => {
  let original: unknown;
  beforeEach(() => {
    jest.clearAllMocks();
    original = api().listOpenRequired;
    jest.spyOn(logger, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    api().listOpenRequired = original;
    jest.restoreAllMocks();
  });

  it("passes the user (and the limit only when given) and returns the rows and the total", async () => {
    const bridge = jest.fn().mockResolvedValue({
      success: true,
      result: { totalCount: 7, items: [ITEM] },
    });
    api().listOpenRequired = bridge;
    await expect(checklistService.listOpenRequired(USER)).resolves.toEqual({
      success: true,
      data: { totalCount: 7, items: [ITEM] },
    });
    expect(bridge).toHaveBeenLastCalledWith({ userId: USER });
    await checklistService.listOpenRequired(USER, 5);
    expect(bridge).toHaveBeenLastCalledWith({ userId: USER, limit: 5 });
  });

  it("nothing left is an empty list, not null or undefined", async () => {
    api().listOpenRequired = jest.fn().mockResolvedValue({
      success: true,
      result: { totalCount: 0, items: [] },
    });
    const res = await checklistService.listOpenRequired(USER);
    expect(res).toEqual({ success: true, data: { totalCount: 0, items: [] } });
  });

  it("the shipped jest default (the plan refusal) is a refusal, not an empty list", async () => {
    const res = await checklistService.listOpenRequired(USER);
    expect(res.success).toBe(false);
    expect(res.data).toBeUndefined();
  });

  it("main refused -> success false with main's message, no Sentry (main reported it)", async () => {
    api().listOpenRequired = jest.fn().mockResolvedValue({ success: false, error: "not on your plan" });
    await expect(checklistService.listOpenRequired(USER)).resolves.toEqual({
      success: false,
      error: "not on your plan",
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("a success without a list is a failure, never an invented empty list", async () => {
    api().listOpenRequired = jest.fn().mockResolvedValue({ success: true });
    const res = await checklistService.listOpenRequired(USER);
    expect(res.success).toBe(false);
    expect(res.data).toBeUndefined();
  });

  it("bridge missing -> resolves to success false", async () => {
    api().listOpenRequired = undefined;
    const res = await checklistService.listOpenRequired(USER);
    expect(res.success).toBe(false);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("the bridge rejects -> resolves to success false, logs the message, reports to Sentry", async () => {
    const err = new Error("ipc died");
    api().listOpenRequired = jest.fn().mockRejectedValue(err);
    const res = await checklistService.listOpenRequired(USER);
    expect(res.success).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Todo"), "ipc died");
    expect(Sentry.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ extra: expect.objectContaining({ operation: "list-open-required" }) }),
    );
  });

  it("the bridge throws synchronously and Sentry itself throws -> still resolves", async () => {
    api().listOpenRequired = jest.fn(() => {
      throw new Error("sync throw");
    });
    (Sentry.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    await expect(checklistService.listOpenRequired(USER)).resolves.toMatchObject({ success: false });
  });
});

describe("Todo groups", () => {
  it("the required-items group counts by the uncapped total and carries the rows in order", () => {
    const group = requiredItemsGroup({ totalCount: 12, items: [ITEM] });
    expect(group).toMatchObject({ id: "required-checklist-items", count: 12, rows: [ITEM], status: null });
  });

  it("a group with no rows and no status line is dropped; a status-only group is kept; order is kept", () => {
    const empty = requiredItemsGroup({ totalCount: 0, items: [] });
    const status = { id: "suggested", header: "Suggested", count: 0, rows: [], status: "Up to date" };
    const withRows = requiredItemsGroup({ totalCount: 1, items: [ITEM] });
    expect(visibleTodoGroups([empty])).toEqual([]);
    expect(visibleTodoGroups([status, empty, withRows]).map((g) => g.id)).toEqual([
      "suggested",
      "required-checklist-items",
    ]);
  });
});
