/**
 * BACKLOG-4263 PR-6 — the Checklist tab's Keepr Cloud parts (plan §7): the due date ("Due Nov 20" and the
 * editor), the AI-app marker, the notice strip with the other version and "Use this version", History, Recently
 * removed (and where it sits), History's Dismiss, the one-line notices and the live refresh. Offline, the tab shows
 * no notice of its own.
 *
 * Checklists come from the transcribed main fixture (checklistFixture.ts); main's Keepr Cloud answers are the
 * shapes of electron/types/ipc/window-api-cloud-todos.ts, as cloudTodoScreens-4263.test.ts produces them.
 *
 * Wrong implementations this suite is here to catch: any Keepr Cloud part shown to a user who never turned it
 * on; "Use this version" writing more than one change, or none; a template row gaining Rename or Delete; History
 * or Recently removed calling out while offline; a blending (ghost) action button on a tinted strip.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionChecklistTab, type TransactionChecklistTabProps } from "../TransactionChecklistTab";
import { useTransactionChecklist } from "../../../hooks/useTransactionChecklist";
import type { ChecklistsForTransaction } from "../../../../../../electron/types/checklist";
import type { CloudTodoNotice, CloudTodosForDeal } from "../../../../../../electron/types/ipc/window-api-cloud-todos";
import { fixtureAttachments, fixtureChecklistsWithMyItems, fixtureEmailCommunications } from "./checklistFixture";

jest.mock("../../modals/AttachmentPreviewModal", () => ({ AttachmentPreviewModal: () => null }));
jest.mock("../../modals/EmailThreadViewModal", () => ({ EmailThreadViewModal: () => null }));
jest.mock("../../../../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-4263", email: "agent@example.test" } }),
}));

type Mocks = Record<string, jest.Mock>;
const checklists = () => window.api.checklists as unknown as Mocks;
let cloud: Mocks;
let changed: (() => void) | null = null;

const data = fixtureChecklistsWithMyItems();
const template = data.checklists.find((d) => !d.checklist.isPrivate)!;
const mine = data.checklists.find((d) => d.checklist.isPrivate)!;
const T_ITEM = template.items[0];
const M_ITEM = mine.items[0];

function withDue(dueDate: string): ChecklistsForTransaction {
  const d = fixtureChecklistsWithMyItems();
  d.checklists.find((c) => !c.checklist.isPrivate)!.items[0].dueDate = dueDate;
  return d;
}

const ON: CloudTodosForDeal = { on: true, online: true, notices: [], markers: {} };
const conflict = (over: Partial<CloudTodoNotice> = {}): CloudTodoNotice => ({
  id: 7, kind: "conflict", itemId: T_ITEM.id, title: T_ITEM.title, part: "note", otherText: "mine, older", otherValue: "mine, older", who: "Claude", ...over,
});

function Harness({ overrides = {} }: { overrides?: Partial<TransactionChecklistTabProps> }) {
  const checklist = useTransactionChecklist("txn-1");
  return (
    <TransactionChecklistTab
      checklist={checklist}
      gate="allowed"
      attachments={fixtureAttachments()}
      attachmentsLoading={false}
      emailCommunications={fixtureEmailCommunications()}
      ensureEmailsLoaded={() => Promise.resolve()}
      onRefreshLinkTargets={jest.fn()}
      onShowSuccess={jest.fn()}
      onShowError={jest.fn()}
      transactionId="txn-1"
      {...overrides}
    />
  );
}

async function show(answer: CloudTodosForDeal, list: ChecklistsForTransaction = data, overrides: Partial<TransactionChecklistTabProps> = {}) {
  checklists().get.mockResolvedValue({ success: true, checklists: list });
  cloud.getForDeal.mockResolvedValue(answer);
  render(<Harness overrides={overrides} />);
  await screen.findByTestId(`checklist-item-${T_ITEM.id}`);
  await waitFor(() => expect(cloud.getForDeal).toHaveBeenCalledWith({ transactionId: overrides.transactionId ?? "txn-1" }));
  await act(async () => undefined);
}

beforeEach(() => {
  changed = null;
  cloud = {
    getForDeal: jest.fn(),
    dismissNotice: jest.fn().mockResolvedValue({ success: true }),
    history: jest.fn(),
    listRemoved: jest.fn().mockResolvedValue({ success: true, items: [] }),
    restore: jest.fn().mockResolvedValue({ success: true }),
    onChanged: jest.fn((cb: () => void) => {
      changed = cb;
      return () => undefined;
    }),
  };
  (window.api as unknown as { cloudTodos: Mocks }).cloudTodos = cloud;
  const c = checklists();
  for (const f of Object.values(c)) if (typeof f?.mockClear === "function") f.mockClear();
  c.setItemDueDate = jest.fn().mockResolvedValue({ success: true, changed: true });
  c.setItemNote.mockResolvedValue({ success: true, changed: true });
  c.setItemChecked.mockResolvedValue({ success: true, changed: true });
});

describe("Checklist tab — Keepr Cloud parts (PR-6)", () => {
  it("never turned on: no due date, no template ⋯, no marker, no strip, no Recently removed, nothing asked of the cloud", async () => {
    await show({ on: false, online: true, notices: [conflict()], markers: { [T_ITEM.id]: { kind: "ticked", who: "Claude", at: new Date().toISOString() } } }, withDue("2026-11-20"));
    expect(screen.queryByTestId(`checklist-due-${T_ITEM.id}`)).toBeNull();
    expect(screen.queryByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`)).toBeNull();
    expect(screen.queryByTestId(`checklist-marker-${T_ITEM.id}`)).toBeNull();
    expect(screen.queryByTestId("checklist-conflict-7")).toBeNull();
    expect(screen.queryByTestId("checklist-recently-removed")).toBeNull();
    expect(screen.queryByTestId("checklist-cloud-offline")).toBeNull();
    fireEvent.click(screen.getByTestId(`my-item-menu-toggle-${M_ITEM.id}`));
    expect(screen.queryByTestId(`my-item-due-${M_ITEM.id}`)).toBeNull();
    expect(cloud.listRemoved).not.toHaveBeenCalled();
    expect(cloud.history).not.toHaveBeenCalled();
  });

  it("the due date shows as Due Nov 20 on the row", async () => {
    await show(ON, withDue("2026-11-20"));
    expect(screen.getByTestId(`checklist-due-${T_ITEM.id}`)).toHaveTextContent("Due Nov 20");
  });

  it("a template row gets a ⋯ with only Due date… and History; a My items row's ⋯ gains the same two", async () => {
    await show(ON);
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    const menu = screen.getByTestId(`cloud-item-menu-${T_ITEM.id}`);
    expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual(["Due date…", "History"]);
    fireEvent.click(screen.getByTestId(`my-item-menu-toggle-${M_ITEM.id}`));
    const myMenu = screen.getByTestId(`my-item-menu-${M_ITEM.id}`);
    expect(within(myMenu).getAllByRole("button").map((b) => b.textContent)).toEqual(["Rename", "Move up", "Move down", "Due date…", "History", "Delete"]);
  });

  it("the due-date editor saves one change, and Clear clears it", async () => {
    await show(ON, withDue("2026-11-20"));
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`cloud-item-due-${T_ITEM.id}`));
    const editor = screen.getByTestId(`checklist-due-editor-${T_ITEM.id}`);
    fireEvent.change(within(editor).getByLabelText("Due date"), { target: { value: "2026-11-21" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(checklists().setItemDueDate).toHaveBeenCalledTimes(1));
    expect(checklists().setItemDueDate).toHaveBeenCalledWith({ itemId: T_ITEM.id, dueDate: "2026-11-21" });
    await waitFor(() => expect(screen.queryByTestId(`checklist-due-editor-${T_ITEM.id}`)).toBeNull());
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`cloud-item-due-${T_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`checklist-due-clear-${T_ITEM.id}`));
    await waitFor(() => expect(checklists().setItemDueDate).toHaveBeenLastCalledWith({ itemId: T_ITEM.id, dueDate: null }));
  });

  it("the AI-app marker names the app and how long ago", async () => {
    await show({ ...ON, markers: { [T_ITEM.id]: { kind: "ticked", who: "Claude", at: new Date(Date.now() - 2 * 3_600_000).toISOString() } } });
    expect(screen.getByTestId(`checklist-marker-${T_ITEM.id}`)).toHaveTextContent("Ticked by Claude · 2 h ago");
  });

  it("a notice shows the other version; Use this version sends exactly one change (the note) and dismisses the notice", async () => {
    await show({ ...ON, notices: [conflict()] });
    const strip = screen.getByTestId("checklist-conflict-7");
    expect(strip).toHaveTextContent("This note was also changed by Claude. Keepr kept the later change.");
    expect(strip).toHaveTextContent("Other version: “mine, older”");
    const use = within(strip).getByRole("button", { name: "Use this version" });
    expect(use.className).toContain("bg-blue-600");
    expect(within(strip).getByRole("button", { name: "Dismiss" }).className).toContain("bg-white");
    const before = Object.fromEntries(Object.entries(checklists()).map(([k, f]) => [k, f.mock.calls.length]));
    fireEvent.click(use);
    await waitFor(() => expect(cloud.dismissNotice).toHaveBeenCalledWith({ noticeId: 7 }));
    const writes = Object.entries(checklists())
      .filter(([k]) => k !== "get")
      .map(([k, f]) => [k, f.mock.calls.length - (before[k] ?? 0)] as const)
      .filter(([, n]) => n > 0);
    expect(writes).toEqual([["setItemNote", 1]]);
    expect(checklists().setItemNote).toHaveBeenCalledWith({ itemId: T_ITEM.id, note: "mine, older" });
  });

  it("a tick notice uses the tick write; a long other version is cut at 200 characters with Show all", async () => {
    const long = "x".repeat(250);
    await show({ ...ON, notices: [conflict({ part: "done", otherText: "not ticked", otherValue: { is_checked: false } }), conflict({ id: 8, otherText: long, otherValue: long })] });
    expect(screen.getByTestId("checklist-conflict-7")).toHaveTextContent("This tick was also changed by Claude.");
    const strip8 = screen.getByTestId("checklist-conflict-8");
    expect(strip8).toHaveTextContent(`“${"x".repeat(200)}…”`);
    fireEvent.click(within(strip8).getByRole("button", { name: "Show all" }));
    expect(strip8).toHaveTextContent(`“${long}”`);
    fireEvent.click(within(screen.getByTestId("checklist-conflict-7")).getByRole("button", { name: "Use this version" }));
    await waitFor(() => expect(checklists().setItemChecked).toHaveBeenCalledWith({ itemId: T_ITEM.id, checked: false }));
    expect(checklists().setItemNote).not.toHaveBeenCalled();
  });

  it("History lists the rows in words; offline it says it needs an internet connection", async () => {
    cloud.history.mockResolvedValueOnce({
      success: true,
      rows: [
        { who: "You, on a computer", at: new Date(Date.now() - 5 * 60_000).toISOString(), what: "changed", part: "note", oldText: "from ai", newText: "from desk", kept: false },
        { who: "Claude", at: null, what: "removed", part: null, oldText: null, newText: null, kept: true },
      ],
    });
    await show(ON);
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`cloud-item-history-${T_ITEM.id}`));
    const list = await screen.findByTestId(`checklist-history-${T_ITEM.id}`);
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    // BACKLOG-4263 hand-test fixes 4: two lines per row (line 1 what, with screen-reader "from … to"; line 2 who · when).
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Note from from ai →  to from desk (not kept)You, on a computer · 5 min ago",
      "RemovedClaude",
    ]);
    cloud.history.mockResolvedValueOnce({ success: false, error: "offline", rows: [] });
    fireEvent.click(screen.getByTestId(`my-item-menu-toggle-${M_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`my-item-history-${M_ITEM.id}`));
    expect(await screen.findByText("History needs an internet connection.")).toBeInTheDocument();
  });

  it("Recently removed lists this deal's removed todos with a solid Restore; restore says when it shows", async () => {
    cloud.listRemoved.mockResolvedValue({ success: true, items: [{ entity: "item", cloudId: "c-9", title: "Wire instructions", removedAt: "2026-11-12T10:00:00Z" }] });
    await show(ON);
    const row = await screen.findByTestId("checklist-removed-c-9");
    expect(row).toHaveTextContent("Wire instructions · removed Nov 12");
    const restore = within(row).getByRole("button", { name: "Restore" });
    expect(restore.className).toContain("bg-blue-600");
    cloud.listRemoved.mockResolvedValue({ success: true, items: [] });
    fireEvent.click(restore);
    await waitFor(() => expect(cloud.restore).toHaveBeenCalledWith({ transactionId: "txn-1", entity: "item", cloudId: "c-9" }));
    expect(await screen.findByTestId("checklist-removed-line")).toHaveTextContent("Restored. It shows here within a minute.");
  });

  it("Recently removed offline: says it needs an internet connection; a restore answered offline says the same", async () => {
    cloud.listRemoved.mockResolvedValue({ success: false, error: "offline", items: [] });
    await show(ON);
    expect(await screen.findByTestId("checklist-recently-removed")).toHaveTextContent("Recently removed needs an internet connection.");
    expect(within(screen.getByTestId("checklist-recently-removed")).queryByRole("button")).toBeNull();
  });

  it("a locked deal: Recently removed has no Restore and says why", async () => {
    cloud.listRemoved.mockResolvedValue({ success: true, items: [{ entity: "item", cloudId: "c-9", title: "Wire instructions", removedAt: null }] });
    await show(ON, data, { lockedTooltip: "This deal is with your broker for review, so it can't be changed until it's returned to you." });
    const section = await screen.findByTestId("checklist-recently-removed");
    expect(section).toHaveTextContent("This deal is locked, so nothing can be restored.");
    expect(within(section).queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("one-line notices say what happened and can be dismissed", async () => {
    await show({
      ...ON,
      notices: [
        { id: 1, kind: "dropped_not_online", itemId: null, title: "Call lender", part: null, otherText: null, otherValue: null, who: null },
        { id: 3, kind: "local_write_failed", itemId: T_ITEM.id, title: "Inspection", part: "note", otherText: null, otherValue: null, who: null },
        { id: 2, kind: "links_not_restored", itemId: T_ITEM.id, title: T_ITEM.title, part: null, otherText: null, otherValue: null, who: null, count: 3 },
      ],
    });
    expect(screen.getByTestId("checklist-cloud-notice-1")).toHaveTextContent("A change to “Call lender” could not be saved online because the todo was removed there.");
    expect(screen.getByTestId("checklist-cloud-notice-2")).toHaveTextContent("Restored. 3 links to emails or texts that no longer exist could not come back.");
    expect(screen.getByTestId("checklist-cloud-notice-3")).toHaveTextContent(
      "A change to “Inspection” from an AI app or another device could not be applied here yet. Keepr tries again.",
    );
    fireEvent.click(within(screen.getByTestId("checklist-cloud-notice-1")).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(cloud.dismissNotice).toHaveBeenCalledWith({ noticeId: 1 }));
  });

  it("a double click on Use this version sends one change (SR probe)", async () => {
    await show({ ...ON, notices: [conflict()] });
    const use = within(screen.getByTestId("checklist-conflict-7")).getByRole("button", { name: "Use this version" });
    fireEvent.click(use);
    fireEvent.click(use);
    await waitFor(() => expect(cloud.dismissNotice).toHaveBeenCalled());
    await act(async () => undefined);
    expect(checklists().setItemNote).toHaveBeenCalledTimes(1);
  });

  it("a locked deal: the strip offers Dismiss only, and the row's ⋯ offers History only", async () => {
    await show({ ...ON, notices: [conflict()] }, data, { lockedTooltip: "This deal is with your broker for review, so it can't be changed until it's returned to you." });
    const strip = screen.getByTestId("checklist-conflict-7");
    expect(within(strip).queryByRole("button", { name: "Use this version" })).toBeNull();
    expect(within(strip).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    expect(within(screen.getByTestId(`cloud-item-menu-${T_ITEM.id}`)).getAllByRole("button").map((b) => b.textContent)).toEqual(["History"]);
  });

  it("offline: no notice of its own on the tab; History and Recently removed still say they need an internet connection", async () => {
    cloud.listRemoved.mockResolvedValue({ success: false, error: "offline", items: [] });
    cloud.history.mockResolvedValueOnce({ success: false, error: "offline", rows: [] });
    await show({ ...ON, online: false });
    expect(await screen.findByTestId("checklist-recently-removed")).toHaveTextContent("Recently removed needs an internet connection.");
    expect(screen.queryByTestId("checklist-cloud-offline")).toBeNull();
    expect(screen.queryByText(/You're offline/)).toBeNull();
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`cloud-item-history-${T_ITEM.id}`));
    expect(await screen.findByText("History needs an internet connection.")).toBeInTheDocument();
  });

  it("History has one close control, a plain ×, that closes it; the due-date editor still opens and closes", async () => {
    cloud.history.mockResolvedValueOnce({ success: true, rows: [{ who: "Claude", at: null, what: "removed", part: null, oldText: null, newText: null, kept: true }] });
    await show(ON);
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`cloud-item-history-${T_ITEM.id}`));
    const list = await screen.findByTestId(`checklist-history-${T_ITEM.id}`);
    await within(list).findByRole("listitem");
    const buttons = within(list).getAllByRole("button");
    // BACKLOG-4263 hand-test fixes 4: the bottom Dismiss became a × on the heading line (the founder's ask).
    expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-label")])).toEqual([["×", "Close history"]]);
    fireEvent.click(buttons[0]);
    expect(screen.queryByTestId(`checklist-history-${T_ITEM.id}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`cloud-item-due-${T_ITEM.id}`));
    const editor = screen.getByTestId(`checklist-due-editor-${T_ITEM.id}`);
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId(`checklist-due-editor-${T_ITEM.id}`)).toBeNull();
  });

  it("Recently removed sits directly under My items: before the template chooser when there is no template checklist", async () => {
    const onlyMine = fixtureChecklistsWithMyItems();
    onlyMine.checklists = onlyMine.checklists.filter((d) => d.checklist.isPrivate);
    cloud.listRemoved.mockResolvedValue({ success: true, items: [{ entity: "item", cloudId: "c-9", title: "Wire", removedAt: null }] });
    checklists().get.mockResolvedValue({ success: true, checklists: onlyMine });
    cloud.getForDeal.mockResolvedValue(ON);
    render(<Harness />);
    const removed = await screen.findByTestId("checklist-recently-removed");
    const chooser = await screen.findByTestId("checklist-chooser");
    expect(removed.compareDocumentPosition(chooser) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const myItems = screen.getByTestId(`checklist-item-${M_ITEM.id}`);
    expect(myItems.compareDocumentPosition(removed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Recently removed still shows when the deal has a template checklist, before that checklist", async () => {
    cloud.listRemoved.mockResolvedValue({ success: true, items: [{ entity: "item", cloudId: "c-9", title: "Wire", removedAt: null }] });
    await show(ON);
    const removed = await screen.findByTestId("checklist-recently-removed");
    expect(screen.queryByTestId("checklist-chooser")).toBeNull();
    expect(removed.compareDocumentPosition(screen.getByTestId(`checklist-item-${T_ITEM.id}`)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("History cuts each value at 200 characters (SR probe: a 4,000-character note)", async () => {
    const big = "y".repeat(4000);
    cloud.history.mockResolvedValueOnce({ success: true, rows: [{ who: "Claude", at: null, what: "changed", part: "note", oldText: big, newText: big, kept: true }] });
    await show(ON);
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`cloud-item-history-${T_ITEM.id}`));
    const li = await screen.findByRole("listitem");
    expect(li.textContent).toBe(`Note from ${"y".repeat(200)}… →  to ${"y".repeat(200)}…Claude`);
  });

  it("a History row of a kind this screen does not know shows only who (SR probe)", async () => {
    cloud.history.mockResolvedValueOnce({ success: true, rows: [{ who: "Claude", at: null, what: "weird", part: null, oldText: null, newText: null, kept: true }] });
    await show(ON);
    fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
    fireEvent.click(screen.getByTestId(`cloud-item-history-${T_ITEM.id}`));
    expect((await screen.findByRole("listitem")).textContent).toBe("Claude");
  });

  it("Recently removed is read again when the checklists change (a delete here shows without reopening)", async () => {
    await show(ON);
    const before = cloud.listRemoved.mock.calls.length;
    checklists().get.mockResolvedValue({ success: true, checklists: fixtureChecklistsWithMyItems() });
    await act(async () => changed!());
    await waitFor(() => expect(cloud.listRemoved.mock.calls.length).toBeGreaterThan(before));
  });

  it("the Recently removed heading has the tab's section-heading style", async () => {
    cloud.listRemoved.mockResolvedValue({ success: true, items: [{ entity: "item", cloudId: "c-9", title: "Wire", removedAt: null }] });
    await show(ON);
    const h = within(await screen.findByTestId("checklist-recently-removed")).getByText("Recently removed");
    expect(h.tagName).toBe("H4");
    expect(h.className).toContain("text-lg font-semibold");
  });

  // ---- fix 7: the event now also follows the user's own changes once the server has answered them ----
  // Recently removed item: the shape main's listRemovedTodos returns (todoScreens.ts, CloudTodoRemovedResult).
  const REMOVED_ITEM = { entity: "item" as const, cloudId: "c-own", title: "Order the appraisal", removedAt: "2026-11-22T10:00:00Z" };

  it.each([
    // Over IPC every answer is a new object: both the checklists and the Keepr Cloud parts change identity.
    ["both change (as over IPC)", true, true],
    ["only the Keepr Cloud parts change identity", false, true],
    ["only the checklists change identity", true, false],
  ])("own removal: the event after the server's answer shows it in Recently removed without reopening (%s)", async (_n, freshChecklists, freshCloud) => {
    const same = { success: true, checklists: data };
    checklists().get.mockImplementation(async () => (freshChecklists ? { success: true, checklists: fixtureChecklistsWithMyItems() } : same));
    cloud.getForDeal.mockImplementation(async () => (freshCloud ? { ...ON, notices: [], markers: {} } : ON));
    render(<Harness />);
    await screen.findByTestId(`checklist-item-${T_ITEM.id}`);
    await waitFor(() => expect(cloud.listRemoved).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId("checklist-removed-c-own")).toBeNull();
    cloud.listRemoved.mockResolvedValue({ success: true, items: [REMOVED_ITEM] });
    await act(async () => changed!());
    expect(await screen.findByTestId("checklist-removed-c-own")).toHaveTextContent("Order the appraisal");
  });

  describe("the event while the user is editing (it now follows his own edits about once a minute)", () => {
    // As over IPC: a new object per answer, and the checklist answer arrives in a later task (held, then released),
    // so a frame between the event and the answer is rendered.
    const fireAsOverIpc = async () => {
      let release: () => void = () => undefined;
      checklists().get.mockImplementation(
        () => new Promise((r) => (release = () => r({ success: true, checklists: fixtureChecklistsWithMyItems() }))),
      );
      cloud.getForDeal.mockImplementation(async () => ({ ...ON, notices: [], markers: {} }));
      const gets = checklists().get.mock.calls.length;
      await act(async () => changed!());
      await act(async () => undefined);
      expect(checklists().get.mock.calls.length).toBe(gets + 1);
      await act(async () => release());
      await act(async () => undefined);
    };

    it("a note being typed keeps its text", async () => {
      await show(ON);
      fireEvent.click(screen.queryByTestId(`checklist-add-note-${T_ITEM.id}`) ?? screen.getByTestId(`checklist-edit-note-${T_ITEM.id}`));
      const box = within(screen.getByTestId(`checklist-note-editor-${T_ITEM.id}`)).getByRole("textbox");
      fireEvent.change(box, { target: { value: "half typed" } });
      await fireAsOverIpc();
      expect(within(screen.getByTestId(`checklist-note-editor-${T_ITEM.id}`)).getByRole("textbox")).toHaveValue("half typed");
    });

    it("a My item name being typed keeps its text", async () => {
      await show(ON);
      fireEvent.click(screen.getByTestId(`my-item-menu-toggle-${M_ITEM.id}`));
      fireEvent.click(screen.getByTestId(`my-item-rename-${M_ITEM.id}`));
      fireEvent.change(screen.getByTestId(`my-item-rename-input-${M_ITEM.id}`), { target: { value: "new na" } });
      await fireAsOverIpc();
      expect(screen.getByTestId(`my-item-rename-input-${M_ITEM.id}`)).toHaveValue("new na");
      expect(checklists().renameMyItem).not.toHaveBeenCalled();
    });

    it("an open row menu stays open (My items and template rows)", async () => {
      await show(ON);
      fireEvent.click(screen.getByTestId(`my-item-menu-toggle-${M_ITEM.id}`));
      expect(screen.getByTestId(`my-item-menu-${M_ITEM.id}`)).toBeInTheDocument();
      await fireAsOverIpc();
      expect(screen.getByTestId(`my-item-menu-${M_ITEM.id}`)).toBeInTheDocument();
      fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T_ITEM.id}`));
      expect(screen.getByTestId(`cloud-item-history-${T_ITEM.id}`)).toBeInTheDocument();
      await fireAsOverIpc();
      expect(screen.getByTestId(`cloud-item-history-${T_ITEM.id}`)).toBeInTheDocument();
    });
  });

  it("cloud-todos:changed re-reads the checklists and the Keepr Cloud parts", async () => {
    await show(ON);
    const gets = checklists().get.mock.calls.length;
    const reads = cloud.getForDeal.mock.calls.length;
    expect(changed).not.toBeNull();
    await act(async () => changed!());
    await waitFor(() => expect(checklists().get.mock.calls.length).toBeGreaterThan(gets));
    expect(cloud.getForDeal.mock.calls.length).toBeGreaterThan(reads);
  });
});
