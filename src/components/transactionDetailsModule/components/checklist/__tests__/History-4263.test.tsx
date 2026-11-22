/**
 * BACKLOG-4263 — the History panel on a checklist row: the newest 5 rows and "Show more", two-line rows.
 *
 * The real tab, hook and Keepr Cloud context over the window.api mocks (set-up of
 * TransactionChecklistTab.cloud-4263.test.tsx).
 *
 * Row fixtures are main's history() OUTPUT as pinned by the producer suite
 * electron/services/cloudSync/__tests__/cloudSyncTodoScreens-4263.test.ts ("HIST: history", :317-357), which runs
 * the real mapper over rows transcribed from cloud_todo_history on the test database. The one exception is the
 * due-date row: no transcribed history row has part "due", so it is derived from partText() (todoScreens.ts:93-102,
 * a string passes through unchanged) and is marked below.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionChecklistTab } from "../TransactionChecklistTab";
import { useTransactionChecklist } from "../../../hooks/useTransactionChecklist";
import type { CloudTodoHistoryResult, CloudTodosForDeal } from "../../../../../../electron/types/ipc/window-api-cloud-todos";
import { ago } from "../cloud/cloudTodoCopy";
import { fixtureAttachments, fixtureChecklistsWithMyItems, fixtureEmailCommunications } from "./checklistFixture";

jest.mock("../../modals/AttachmentPreviewModal", () => ({ AttachmentPreviewModal: () => null }));
jest.mock("../../modals/EmailThreadViewModal", () => ({ EmailThreadViewModal: () => null }));
jest.mock("../../../../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-4263", email: "agent@example.test" } }),
}));

type Row = CloudTodoHistoryResult["rows"][number];
type Mocks = Record<string, jest.Mock>;
const checklists = () => window.api.checklists as unknown as Mocks;
let cloud: Mocks;
let changed: Array<() => void> = [];

const data = fixtureChecklistsWithMyItems();
const T1 = data.checklists.find((d) => !d.checklist.isPrivate)!.items[0];
const ON: CloudTodosForDeal = { on: true, online: true, notices: [], markers: {} };
const AT = "2026-11-18T05:01:13.400Z"; // the producer suite's fixed time
const WHEN = ago(AT); // "Nov 18" or "Nov 17", by the machine's time zone

// Producer output, cloudSyncTodoScreens-4263.test.ts:320-325 (item i2: a lost desktop edit, an AI note, an add).
const NOTE_LOST: Row = { who: "You, on a computer", at: AT, what: "changed", part: "note", oldText: "from ai", newText: "from desk", kept: false };
const NOTE_AI: Row = { who: "Claude", at: AT, what: "changed", part: "note", oldText: "start", newText: "from ai", kept: true };
const ADDED: Row = { who: "You, on a computer", at: AT, what: "added", part: null, oldText: null, newText: null, kept: true };
// :332 (item i3: restored by the owner, removed by an AI app).
const RESTORED: Row = { who: "You", at: AT, what: "restored", part: null, oldText: null, newText: null, kept: true };
const REMOVED: Row = { who: "Claude", at: AT, what: "removed", part: null, oldText: null, newText: null, kept: true };
// :352-355 (item i1: a name change and a tick).
const TITLE: Row = { who: "You, on a computer", at: AT, what: "changed", part: "title", oldText: "Inspection", newText: "Inspection report", kept: true };
const DONE: Row = { who: "Claude", at: AT, what: "changed", part: "done", oldText: "not ticked", newText: "ticked", kept: true };
// DERIVED, not transcribed: partText("due", "2026-11-28") returns the string unchanged.
const DUE: Row = { who: "You, on a computer", at: AT, what: "changed", part: "due", oldText: null, newText: "2026-11-28", kept: true };

/** n rows, newest first, each told apart by its new value ("v1" is the newest). Shape of NOTE_AI. */
const rowsOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ ...NOTE_AI, oldText: `v${i + 2}`, newText: `v${i + 1}` }));

function Harness() {
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
    />
  );
}

async function show() {
  checklists().get.mockResolvedValue({ success: true, checklists: data });
  cloud.getForDeal.mockResolvedValue(ON);
  const view = render(<Harness />);
  await screen.findByTestId(`cloud-item-menu-toggle-${T1.id}`);
  await act(async () => undefined);
  return view;
}

async function openHistory(answer: CloudTodoHistoryResult) {
  cloud.history.mockResolvedValueOnce(answer);
  fireEvent.click(screen.getByTestId(`cloud-item-menu-toggle-${T1.id}`));
  fireEvent.click(screen.getByTestId(`cloud-item-history-${T1.id}`));
  const panel = await screen.findByTestId(`checklist-history-${T1.id}`);
  // the answer has landed: rows or a one-line message
  await waitFor(() => expect(panel.querySelector("ul, p")).not.toBeNull());
  return panel;
}

const rowsIn = (panel: HTMLElement) => within(panel).queryAllByTestId("checklist-history-row");
const newValues = (panel: HTMLElement) =>
  rowsIn(panel).map((r) => within(r).getByTestId("checklist-history-what").textContent!.split(" to ").at(-1));
const more = () => screen.queryByTestId(`checklist-history-more-${T1.id}`);

beforeEach(() => {
  changed = [];
  cloud = {
    getForDeal: jest.fn(),
    dismissNotice: jest.fn().mockResolvedValue({ success: true }),
    history: jest.fn().mockResolvedValue({ success: true, rows: [] }),
    listRemoved: jest.fn().mockResolvedValue({ success: true, items: [] }),
    restore: jest.fn().mockResolvedValue({ success: true }),
    onChanged: jest.fn((cb: () => void) => {
      changed.push(cb);
      return () => {
        changed = changed.filter((c) => c !== cb);
      };
    }),
  };
  (window.api as unknown as { cloudTodos: Mocks }).cloudTodos = cloud;
  const c = checklists();
  for (const f of Object.values(c)) if (typeof f?.mockClear === "function") f.mockClear();
});

describe("History: the newest 5, then Show more (C1)", () => {
  it("0 rows: the empty line, no Show more", async () => {
    await show();
    const panel = await openHistory({ success: true, rows: [] });
    expect(panel).toHaveTextContent("No changes yet.");
    expect(rowsIn(panel)).toHaveLength(0);
    expect(more()).toBeNull();
  });

  it.each([1, 5])("%i row(s): all shown, no Show more", async (n) => {
    await show();
    const panel = await openHistory({ success: true, rows: rowsOf(n) });
    expect(newValues(panel)).toEqual(rowsOf(n).map((r) => r.newText));
    expect(more()).toBeNull();
  });

  it.each([6, 12])("%i rows: the newest 5 in main's order, then Show more reveals all and goes away", async (n) => {
    await show();
    const panel = await openHistory({ success: true, rows: rowsOf(n) });
    expect(newValues(panel)).toEqual(["v1", "v2", "v3", "v4", "v5"]);
    expect(more()).toHaveTextContent("Show more");
    expect(more()!.tagName).toBe("BUTTON");
    fireEvent.click(more()!);
    expect(newValues(panel)).toEqual(rowsOf(n).map((r) => r.newText));
    expect(more()).toBeNull();
  });
});

describe("History: each row on two lines (C3)", () => {
  const line1 = (r: HTMLElement) => within(r).getByTestId("checklist-history-what");
  const line2 = (r: HTMLElement) => within(r).queryByTestId("checklist-history-who");
  /** What a sighted user reads on line 1: the screen-reader-only words left out. */
  const visible = (el: HTMLElement) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
    return copy.textContent;
  };
  /** What a screen reader reads on line 1: the visual-only arrow left out. */
  const spoken = (el: HTMLElement) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    return copy.textContent!.replace(/\s+/g, " ").trim();
  };

  it("line 1 says what changed, line 2 who and when, for every kind main sends", async () => {
    await show();
    const panel = await openHistory({ success: true, rows: [NOTE_LOST, NOTE_AI, TITLE, DONE, DUE] });
    const rows = rowsIn(panel);
    expect(rows.map((r) => visible(line1(r)))).toEqual([
      "Note from ai → from desk (not kept)",
      "Note start → from ai",
      "Name Inspection → Inspection report",
      "Tick not ticked → ticked",
      "Due date empty → 2026-11-28",
    ]);
    expect(rows.map((r) => line2(r)!.textContent)).toEqual([
      "You, on a computer · " + WHEN,
      "Claude · " + WHEN,
      "You, on a computer · " + WHEN,
      "Claude · " + WHEN,
      "You, on a computer · " + WHEN,
    ]);
    // the part name is bold; the old value is struck through and grey; the arrow stays
    const first = line1(rows[0]);
    expect(within(first).getByText("Note")).toHaveClass("font-semibold");
    const old = first.querySelector("s")!;
    expect(old).toHaveTextContent("from ai");
    expect(old).toHaveClass("text-gray-500");
    expect(line2(rows[0])).toHaveClass("text-xs", "text-gray-500");
  });

  it("added, removed and restored read as the capitalised word on line 1", async () => {
    await show();
    const panel = await openHistory({ success: true, rows: [RESTORED, REMOVED, ADDED] });
    const rows = rowsIn(panel);
    expect(rows.map((r) => line1(r).textContent)).toEqual(["Restored", "Removed", "Added"]);
    expect(within(line1(rows[0])).getByText("Restored")).toHaveClass("font-semibold");
    expect(rows.map((r) => line2(r)!.textContent)).toEqual(["You · " + WHEN, "Claude · " + WHEN, "You, on a computer · " + WHEN]);
  });

  it("a screen reader hears from … to …, not the arrow", async () => {
    await show();
    const panel = await openHistory({ success: true, rows: [NOTE_LOST] });
    expect(spoken(line1(rowsIn(panel)[0]))).toBe("Note from from ai to from desk (not kept)");
  });
});
