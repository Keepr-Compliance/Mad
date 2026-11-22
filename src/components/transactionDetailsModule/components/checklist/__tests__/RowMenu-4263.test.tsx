/**
 * BACKLOG-4263 — the checklist rows' ⋮ menus (My items, and the template rows' Keepr Cloud menu): closing on a
 * mouse press outside and on focus leaving, the vertical glyph, and the toggles' accessible names.
 *
 * The real tab, the real hook and the real Keepr Cloud context over the window.api mocks (the set-up of
 * TransactionChecklistTab.cloud-4263.test.tsx). Clicks go through userEvent (pointerdown, mousedown, focus, mouseup,
 * click, in that order), so the outside listener sees the same sequence a real click produces.
 *
 * Limit: this renders the tab, not the deal window. Whether a press elsewhere in the real window reaches the
 * listener is not shown here.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TransactionChecklistTab } from "../TransactionChecklistTab";
import { useTransactionChecklist } from "../../../hooks/useTransactionChecklist";
import type { CloudTodosForDeal } from "../../../../../../electron/types/ipc/window-api-cloud-todos";
import { fixtureAttachments, fixtureChecklistsWithMyItems, fixtureEmailCommunications } from "./checklistFixture";

jest.mock("../../modals/AttachmentPreviewModal", () => ({ AttachmentPreviewModal: () => null }));
jest.mock("../../modals/EmailThreadViewModal", () => ({ EmailThreadViewModal: () => null }));
jest.mock("../../../../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-4263", email: "agent@example.test" } }),
}));

type Mocks = Record<string, jest.Mock>;
const checklists = () => window.api.checklists as unknown as Mocks;
let cloud: Mocks;

const data = fixtureChecklistsWithMyItems();
const template = data.checklists.find((d) => !d.checklist.isPrivate)!;
const mine = data.checklists.find((d) => d.checklist.isPrivate)!;
const T1 = template.items[0];
const T2 = template.items[1];
const M1 = mine.items[0];
const M2 = mine.items[1];

const ON: CloudTodosForDeal = { on: true, online: true, notices: [], markers: {} };

function Harness() {
  const checklist = useTransactionChecklist("txn-1");
  return (
    <>
      <p data-testid="outside">Outside the menus</p>
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
    </>
  );
}

async function show() {
  checklists().get.mockResolvedValue({ success: true, checklists: data });
  cloud.getForDeal.mockResolvedValue(ON);
  const view = render(<Harness />);
  await screen.findByTestId(`checklist-item-${T1.id}`);
  await screen.findByTestId(`cloud-item-menu-toggle-${T1.id}`);
  await act(async () => undefined);
  return view;
}

const myToggle = (id: string) => screen.getByTestId(`my-item-menu-toggle-${id}`);
const myMenu = (id: string) => screen.queryByTestId(`my-item-menu-${id}`);
const tToggle = (id: string) => screen.getByTestId(`cloud-item-menu-toggle-${id}`);
const tMenu = (id: string) => screen.queryByTestId(`cloud-item-menu-${id}`);
const openMenus = () =>
  screen.queryAllByRole("group").filter((g) => (g.getAttribute("aria-label") ?? "").startsWith("Actions for "));

beforeEach(() => {
  cloud = {
    getForDeal: jest.fn(),
    dismissNotice: jest.fn().mockResolvedValue({ success: true }),
    history: jest.fn().mockResolvedValue({ success: true, rows: [] }),
    listRemoved: jest.fn().mockResolvedValue({ success: true, items: [] }),
    restore: jest.fn().mockResolvedValue({ success: true }),
    onChanged: jest.fn(() => () => undefined),
  };
  (window.api as unknown as { cloudTodos: Mocks }).cloudTodos = cloud;
  const c = checklists();
  for (const f of Object.values(c)) if (typeof f?.mockClear === "function") f.mockClear();
  c.setItemDueDate = jest.fn().mockResolvedValue({ success: true, changed: true });
  c.reorderMyItems.mockResolvedValue({ success: true, changed: true });
  c.renameMyItem.mockResolvedValue({ success: true, changed: true });
});

describe("row menus close on a mouse press outside (C1)", () => {
  it("My items: a press outside closes the menu", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    expect(myMenu(M1.id)).toBeInTheDocument();
    await user.click(screen.getByTestId("outside"));
    expect(myMenu(M1.id)).toBeNull();
    expect(myToggle(M1.id)).toHaveAttribute("aria-expanded", "false");
  });

  it("template row: a press outside closes the menu", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(tToggle(T1.id));
    expect(tMenu(T1.id)).toBeInTheDocument();
    await user.click(screen.getByTestId("outside"));
    expect(tMenu(T1.id)).toBeNull();
    expect(tToggle(T1.id)).toHaveAttribute("aria-expanded", "false");
  });

  it("My items: clicking an entry runs it once (Move down writes one reorder)", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    await user.click(screen.getByTestId(`my-item-down-${M1.id}`));
    await waitFor(() => expect(checklists().reorderMyItems).toHaveBeenCalledTimes(1));
    expect(checklists().reorderMyItems).toHaveBeenCalledWith({ transactionId: "txn-1", itemIds: [M2.id, M1.id] });
    expect(myMenu(M1.id)).toBeNull();
  });

  it("My items: clicking Delete opens the confirm line", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    await user.click(screen.getByTestId(`my-item-delete-${M1.id}`));
    expect(screen.getByTestId(`my-item-delete-prompt-${M1.id}`)).toBeInTheDocument();
    expect(myMenu(M1.id)).toBeNull();
  });

  it("template row: clicking History asks for the history once", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(tToggle(T1.id));
    await user.click(screen.getByTestId(`cloud-item-history-${T1.id}`));
    expect(await screen.findByTestId(`checklist-history-${T1.id}`)).toBeInTheDocument();
    expect(cloud.history).toHaveBeenCalledTimes(1);
    expect(tMenu(T1.id)).toBeNull();
  });

  it("My items: the toggle closes its open menu and it stays closed", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    expect(myMenu(M1.id)).toBeInTheDocument();
    await user.click(myToggle(M1.id));
    expect(myMenu(M1.id)).toBeNull();
    expect(myToggle(M1.id)).toHaveAttribute("aria-expanded", "false");
  });

  it("template row: the toggle closes its open menu and it stays closed", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(tToggle(T1.id));
    expect(tMenu(T1.id)).toBeInTheDocument();
    await user.click(tToggle(T1.id));
    expect(tMenu(T1.id)).toBeNull();
    expect(tToggle(T1.id)).toHaveAttribute("aria-expanded", "false");
  });
});

describe("one menu open at a time (C2)", () => {
  it("My items + My items", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    await user.click(myToggle(M2.id));
    expect(myMenu(M1.id)).toBeNull();
    expect(myMenu(M2.id)).toBeInTheDocument();
    expect(openMenus()).toHaveLength(1);
  });

  it("template row + template row", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(tToggle(T1.id));
    await user.click(tToggle(T2.id));
    expect(tMenu(T1.id)).toBeNull();
    expect(tMenu(T2.id)).toBeInTheDocument();
    expect(openMenus()).toHaveLength(1);
  });

  it("My items + template row, both ways", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    await user.click(tToggle(T1.id));
    expect(myMenu(M1.id)).toBeNull();
    expect(tMenu(T1.id)).toBeInTheDocument();
    expect(openMenus()).toHaveLength(1);
    await user.click(myToggle(M1.id));
    expect(tMenu(T1.id)).toBeNull();
    expect(myMenu(M1.id)).toBeInTheDocument();
    expect(openMenus()).toHaveLength(1);
  });
});

describe("what an entry opens stays open (C3)", () => {
  it("the delete confirm line survives a press outside", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    await user.click(screen.getByTestId(`my-item-delete-${M1.id}`));
    await user.click(screen.getByTestId("outside"));
    expect(screen.getByTestId(`my-item-delete-prompt-${M1.id}`)).toBeInTheDocument();
  });

  it("the due-date editor (template row) survives a press outside and a click into it", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(tToggle(T1.id));
    await user.click(screen.getByTestId(`cloud-item-due-${T1.id}`));
    const editor = screen.getByTestId(`checklist-due-editor-${T1.id}`);
    await user.click(within(editor).getByLabelText("Due date"));
    await user.click(screen.getByTestId("outside"));
    expect(screen.getByTestId(`checklist-due-editor-${T1.id}`)).toBeInTheDocument();
  });

  it("the due-date editor (My items) survives a press outside", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    await user.click(screen.getByTestId(`my-item-due-${M1.id}`));
    await user.click(screen.getByTestId("outside"));
    expect(screen.getByTestId(`checklist-due-editor-${M1.id}`)).toBeInTheDocument();
  });

  it("History survives a press outside", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(tToggle(T1.id));
    await user.click(screen.getByTestId(`cloud-item-history-${T1.id}`));
    await screen.findByTestId(`checklist-history-${T1.id}`);
    await user.click(screen.getByTestId("outside"));
    expect(screen.getByTestId(`checklist-history-${T1.id}`)).toBeInTheDocument();
  });
});

describe("focus (addition B)", () => {
  it("My items: Tab and Shift+Tab between the toggle and the entries keep the menu open", async () => {
    const user = userEvent.setup();
    await show();
    myToggle(M1.id).focus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(screen.getByTestId(`my-item-rename-${M1.id}`)).toHaveFocus();
    await user.tab(); // Move up is disabled on the first row
    expect(screen.getByTestId(`my-item-down-${M1.id}`)).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(myToggle(M1.id)).toHaveFocus();
    expect(myMenu(M1.id)).toBeInTheDocument();
  });

  it("template row: Tab from the toggle through the entries keeps the menu open", async () => {
    const user = userEvent.setup();
    await show();
    tToggle(T1.id).focus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(screen.getByTestId(`cloud-item-due-${T1.id}`)).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId(`cloud-item-history-${T1.id}`)).toHaveFocus();
    expect(tMenu(T1.id)).toBeInTheDocument();
  });

  it("My items: Tab out of the last entry closes the menu", async () => {
    const user = userEvent.setup();
    await show();
    myToggle(M1.id).focus();
    await user.keyboard("{Enter}");
    const del = screen.getByTestId(`my-item-delete-${M1.id}`);
    del.focus();
    expect(myMenu(M1.id)).toBeInTheDocument();
    await user.tab();
    expect(del).not.toBeInTheDocument();
    expect(myMenu(M1.id)).toBeNull();
  });

  it("template row: Tab out of the last entry closes the menu", async () => {
    const user = userEvent.setup();
    await show();
    tToggle(T1.id).focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.tab();
    expect(screen.getByTestId(`cloud-item-history-${T1.id}`)).toHaveFocus();
    await user.tab();
    expect(tMenu(T1.id)).toBeNull();
  });

  it("My items: pressing the disabled Move up on the first row keeps the menu open", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    const up = screen.getByTestId(`my-item-up-${M1.id}`);
    expect(up).toBeDisabled();
    await user.pointer({ keys: "[MouseLeft]", target: up });
    expect(myMenu(M1.id)).toBeInTheDocument();
  });

  it("My items: pressing the menu's own padding keeps the menu open", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    await user.click(myMenu(M1.id)!);
    expect(myMenu(M1.id)).toBeInTheDocument();
  });

  it("choosing Rename leaves the rename input open and focused, the draft intact, nothing saved", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(myToggle(M1.id));
    await user.click(screen.getByTestId(`my-item-rename-${M1.id}`));
    const input = screen.getByTestId(`my-item-rename-input-${M1.id}`);
    expect(input).toHaveFocus();
    expect(input).toHaveValue(M1.title);
    await user.type(input, " soon");
    expect(screen.getByTestId(`my-item-rename-input-${M1.id}`)).toHaveValue(`${M1.title} soon`);
    expect(screen.getByTestId(`my-item-rename-input-${M1.id}`)).toHaveFocus();
    expect(checklists().renameMyItem).not.toHaveBeenCalled();
  });
});

describe("the outside listener is attached only while a menu is open (C4)", () => {
  const mousedownCalls = (spy: jest.SpyInstance) =>
    spy.mock.calls.filter((c) => c[0] === "mousedown").map((c) => c[1] as EventListener);

  it.each([
    ["My items", () => myToggle(M1.id)],
    ["template row", () => tToggle(T1.id)],
  ])("%s: added on open, the same listener removed on close", async (_name, toggle) => {
    await show();
    const add = jest.spyOn(document, "addEventListener");
    const remove = jest.spyOn(document, "removeEventListener");
    try {
      fireEvent.click(toggle());
      const added = mousedownCalls(add);
      expect(added).toHaveLength(1);
      expect(mousedownCalls(remove)).toHaveLength(0);
      fireEvent.click(toggle());
      expect(mousedownCalls(remove)).toEqual(added);
      expect(mousedownCalls(add)).toHaveLength(1);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it.each([
    ["My items", () => myToggle(M1.id)],
    ["template row", () => tToggle(T1.id)],
  ])("%s: removed on unmount while open", async (_name, toggle) => {
    const view = await show();
    const add = jest.spyOn(document, "addEventListener");
    const remove = jest.spyOn(document, "removeEventListener");
    try {
      fireEvent.click(toggle());
      const added = mousedownCalls(add);
      expect(added).toHaveLength(1);
      view.unmount();
      expect(mousedownCalls(remove)).toEqual(added);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

describe("the toggle (C5, addition G)", () => {
  it.each([
    ["My items", () => myToggle(M1.id), `my-item-menu-${M1.id}`, M1.title],
    ["template row", () => tToggle(T1.id), `cloud-item-menu-${T1.id}`, T1.title],
  ])("%s: the glyph is vertical, and the name, expanded state and controls are unchanged", async (_n, toggle, menuId, title) => {
    await show();
    const t = toggle();
    expect(t).toHaveTextContent(/^⋮$/);
    expect(t).toHaveAttribute("aria-label", `More actions for ${title}`);
    expect(t).toHaveAttribute("aria-expanded", "false");
    expect(t).toHaveAttribute("aria-controls", menuId);
    fireEvent.click(t);
    expect(t).toHaveAttribute("aria-label", `More actions for ${title}`);
    expect(t).toHaveAttribute("aria-expanded", "true");
    expect(t).toHaveAttribute("aria-controls", menuId);
    expect(document.getElementById(menuId)).toBeInTheDocument();
  });
});
