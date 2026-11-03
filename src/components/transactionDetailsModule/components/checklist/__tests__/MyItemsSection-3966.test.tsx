/**
 * BACKLOG-3966 U1 — the private "My items" section on the Checklist tab.
 *
 * The tab with the REAL hook (`useTransactionChecklist`) and the REAL service
 * (`checklistService`) over the `window.api.checklists` mocks, so every write
 * is asserted at the bridge: which channel, with which deal id. Fixtures come
 * from the producer suite (`checklistRendererFixtures-3476.test.ts`,
 * `checklistsWithMyItems`): main's private checklist, its sums, its links.
 *
 * Controls: see the IMPL 3966 U1 row on BACKLOG-3966 (each mutation was run
 * against the code these tests sit beside, before and after commit).
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { TransactionChecklistTab, type TransactionChecklistTabProps } from "../TransactionChecklistTab";
import { useTransactionChecklist } from "../../../hooks/useTransactionChecklist";
import type { StrictFeatureStateOrPending } from "../../../../../hooks/useStrictFeatureState";
import type { ChecklistDetail } from "../../../../../../electron/types/checklist";
import type { ChecklistWriteResult } from "../../../../../../electron/types/ipc/window-api-checklists";
import { templateChecklistHint } from "../../../../../utils/checklistPlanHint";
import { MY_ITEMS_EMPTY_LINE, MY_ITEMS_LOCKED_LINE } from "../MyItemsSection";
import {
  envelopeOf,
  fixtureAttachments,
  fixtureChecklist,
  fixtureChecklistsWithMyItems,
  fixtureEmailCommunications,
  fixtureMyItems,
} from "./checklistFixture";

jest.mock("../../modals/AttachmentPreviewModal", () => ({
  AttachmentPreviewModal: () => <div data-testid="preview-modal" />,
}));
jest.mock("../../modals/EmailThreadViewModal", () => ({
  EmailThreadViewModal: () => <div data-testid="thread-modal" />,
}));
jest.mock("../../../../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-3966", email: "agent@example.test" } }),
}));

const api = () => window.api.checklists as unknown as Record<string, jest.Mock>;
const onShowError = jest.fn();

/** Every write channel the section could reach. Exactly one is expected per action. */
const WRITE_CHANNELS = [
  "addMyItem",
  "renameMyItem",
  "reorderMyItems",
  "removeMyItem",
  "setItemChecked",
  "setItemNote",
  "addLink",
  "removeLink",
  "selectTemplate",
  "remove",
] as const;
const calledWrites = () => WRITE_CHANNELS.filter((c) => api()[c].mock.calls.length > 0);

/**
 * BACKLOG-3966 (B): main's lock refusal, typed as the bridge declares it. If
 * `dealLocked` / `refusedEdit` leave `ChecklistWriteResult`, this literal is an
 * excess-property error and `npm run type-check:tests` goes red.
 */
const LOCK_REFUSAL: ChecklistWriteResult = {
  success: false,
  error: "This deal is with your broker for review. It can't be changed until the review is done.",
  dealLocked: "submitted",
  refusedEdit: "rename-my-item",
};

function Harness({
  gate,
  overrides = {},
}: {
  gate: StrictFeatureStateOrPending;
  overrides?: Partial<TransactionChecklistTabProps>;
}) {
  const checklist = useTransactionChecklist("txn-1");
  return (
    <TransactionChecklistTab
      checklist={checklist}
      gate={gate}
      attachments={fixtureAttachments()}
      attachmentsLoading={false}
      emailCommunications={fixtureEmailCommunications()}
      ensureEmailsLoaded={() => Promise.resolve()}
      onRefreshLinkTargets={jest.fn()}
      onShowSuccess={jest.fn()}
      onShowError={onShowError}
      {...overrides}
    />
  );
}

const answer = (checklists: ChecklistDetail[]) => ({ success: true, checklists: envelopeOf(checklists) });
const mine = fixtureMyItems();
const [callLender, sendHoa] = [...mine.items].sort((a, b) => a.sortOrder - b.sortOrder);
const section = () => screen.getByTestId("my-items-section");
const rowTitles = () =>
  within(section())
    .getAllByTestId(/^checklist-item-/)
    .map((row) => row.querySelector("h5")?.textContent);
const openMenu = (id: string) => fireEvent.click(screen.getByTestId(`my-item-menu-toggle-${id}`));

beforeEach(() => {
  jest.clearAllMocks();
  api().get.mockResolvedValue(answer([fixtureChecklist(0), mine]));
  api().addMyItem.mockResolvedValue({
    success: true,
    result: { status: "added", checklistId: mine.checklist.id, itemId: "new-item" },
  });
  api().renameMyItem.mockResolvedValue({ success: true, changed: true });
  api().reorderMyItems.mockResolvedValue({ success: true, result: { status: "reordered" } });
  api().removeMyItem.mockResolvedValue({ success: true, changed: true });
  api().setItemChecked.mockResolvedValue({ success: true, changed: true });
});

describe("the section, its place and its numbers", () => {
  it("draws first, private, with main's count and no Required/Optional pill on its rows", async () => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    const panel = screen.getByTestId("checklist-panel");
    const sections = within(panel).getAllByRole("region");
    expect(sections[0]).toBe(section());
    expect(within(section()).getByTestId("my-items-private-pill")).toHaveTextContent("Private");
    expect(within(section()).getByTestId("my-items-count")).toHaveTextContent("1 of 2 done");
    expect(rowTitles()).toEqual([callLender.title, sendHoa.title]);
    for (const item of mine.items) {
      expect(screen.queryByTestId(`checklist-required-${item.id}`)).not.toBeInTheDocument();
    }
    // Template rows keep theirs.
    const templateItem = fixtureChecklist(0).items[0];
    expect(screen.getByTestId(`checklist-required-${templateItem.id}`)).toHaveTextContent("Required");
  });

  it("the tab total is main's sum, My items included (4 of 8 = 3 of 6 + 1 of 2)", async () => {
    api().get.mockResolvedValue({ success: true, checklists: fixtureChecklistsWithMyItems() });
    render(<Harness gate="allowed" />);
    const total = await screen.findByTestId("checklist-total-progress");
    expect(within(total).getByTestId("checklist-progress-text")).toHaveTextContent(/^4 of 8 required done$/);
    expect(within(total).getByTestId("checklist-total-my-items")).toHaveTextContent(
      "includes 1 of 2 of your items",
    );
  });

  it("get returns no private checklist -> the empty section, ready for the first item", async () => {
    api().get.mockResolvedValue(answer([fixtureChecklist(0)]));
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("my-items-empty")).toHaveTextContent(MY_ITEMS_EMPTY_LINE);
    expect(screen.getByTestId("my-items-add-input")).toBeInTheDocument();
    expect(screen.queryByTestId("my-items-count")).not.toBeInTheDocument();
    expect(screen.queryByTestId("checklist-total-my-items")).not.toBeInTheDocument();
  });
});

describe("one primary button per view, and the section collapses", () => {
  const isPrimary = (el: HTMLElement) => el.className.includes("bg-primary");

  it("the template chooser is showing -> My items Add is the kit secondary button", async () => {
    api().get.mockResolvedValue(answer([mine]));
    render(<Harness gate="allowed" />);
    await screen.findByTestId("checklist-chooser");
    const add = screen.getByTestId("my-items-add");
    expect(isPrimary(add)).toBe(false);
    expect(add.className).toContain("border-input");
  });

  it("no chooser -> My items Add stays primary", async () => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    expect(screen.queryByTestId("checklist-chooser")).not.toBeInTheDocument();
    expect(isPrimary(screen.getByTestId("my-items-add"))).toBe(true);
  });

  it("collapse: open by default, the header toggles rows and the add input, Tab reaches it, Enter operates it", async () => {
    const user = userEvent.setup();
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    const toggle = screen.getByTestId("my-items-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(rowTitles()).toEqual([callLender.title, sendHoa.title]);
    toggle.focus();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(section()).queryAllByTestId(/^checklist-item-/)).toHaveLength(0);
    expect(screen.queryByTestId("my-items-add-input")).not.toBeInTheDocument();
    // Header, Private pill and count stay.
    expect(within(section()).getByTestId("my-items-private-pill")).toBeInTheDocument();
    expect(within(section()).getByTestId("my-items-count")).toHaveTextContent("1 of 2 done");
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(rowTitles()).toEqual([callLender.title, sendHoa.title]);
  });

  it("collapse: a real Tab from the page start lands on the header toggle", async () => {
    const user = userEvent.setup();
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    for (let i = 0; i < 20 && document.activeElement !== screen.getByTestId("my-items-toggle"); i++) {
      await user.tab();
    }
    expect(screen.getByTestId("my-items-toggle")).toHaveFocus();
  });
});

describe("every write goes through its own channel, for this deal", () => {
  it("add: add-my-item with the deal id and the trimmed title, then one re-read", async () => {
    api().get.mockResolvedValue(answer([fixtureChecklist(0)]));
    render(<Harness gate="allowed" />);
    const input = await screen.findByTestId("my-items-add-input");
    await waitFor(() => expect(api().get).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "  Book final walkthrough  " } });
    fireEvent.click(screen.getByTestId("my-items-add"));
    await waitFor(() => expect(api().get).toHaveBeenCalledTimes(2));
    expect(api().addMyItem).toHaveBeenCalledTimes(1);
    expect(api().addMyItem).toHaveBeenCalledWith({ transactionId: "txn-1", title: "Book final walkthrough" });
    expect(calledWrites()).toEqual(["addMyItem"]);
    expect(input).toHaveValue("");
  });

  it("add: Enter in the input adds", async () => {
    render(<Harness gate="allowed" />);
    const input = await screen.findByTestId("my-items-add-input");
    fireEvent.change(input, { target: { value: "Order keys" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api().addMyItem).toHaveBeenCalledWith({ transactionId: "txn-1", title: "Order keys" }));
  });

  it("rename: rename-my-item with the item id; Enter saves", async () => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    openMenu(callLender.id);
    fireEvent.click(screen.getByTestId(`my-item-rename-${callLender.id}`));
    const input = screen.getByTestId(`my-item-rename-input-${callLender.id}`);
    fireEvent.change(input, { target: { value: "Call lender today" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api().renameMyItem).toHaveBeenCalledTimes(1));
    expect(api().renameMyItem).toHaveBeenCalledWith({
      transactionId: "txn-1",
      itemId: callLender.id,
      title: "Call lender today",
    });
    expect(calledWrites()).toEqual(["renameMyItem"]);
  });

  it.each([
    ["an empty title", ""],
    ["a whitespace-only title", "   \t  "],
  ])("rename to %s writes nothing and keeps the old title", async (_name, value) => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    openMenu(callLender.id);
    fireEvent.click(screen.getByTestId(`my-item-rename-${callLender.id}`));
    const input = screen.getByTestId(`my-item-rename-input-${callLender.id}`);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByTestId(`my-item-rename-input-${callLender.id}`)).not.toBeInTheDocument();
    expect(api().renameMyItem).not.toHaveBeenCalled();
    expect(calledWrites()).toEqual([]);
    expect(rowTitles()).toEqual([callLender.title, sendHoa.title]);
  });

  it("rename: Escape cancels and writes nothing", async () => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    openMenu(callLender.id);
    fireEvent.click(screen.getByTestId(`my-item-rename-${callLender.id}`));
    const input = screen.getByTestId(`my-item-rename-input-${callLender.id}`);
    fireEvent.change(input, { target: { value: "Something else" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId(`my-item-rename-input-${callLender.id}`)).not.toBeInTheDocument();
    expect(calledWrites()).toEqual([]);
  });

  it("reorder: Move down sends the whole new order through reorder-my-items", async () => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    openMenu(callLender.id);
    fireEvent.click(screen.getByTestId(`my-item-down-${callLender.id}`));
    expect(rowTitles()).toEqual([sendHoa.title, callLender.title]); // shown at once
    await waitFor(() => expect(api().reorderMyItems).toHaveBeenCalledTimes(1));
    expect(api().reorderMyItems).toHaveBeenCalledWith({
      transactionId: "txn-1",
      itemIds: [sendHoa.id, callLender.id],
    });
    expect(calledWrites()).toEqual(["reorderMyItems"]);
  });

  it("reorder: the first row cannot move up, the last cannot move down", async () => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    openMenu(callLender.id);
    expect(screen.getByTestId(`my-item-up-${callLender.id}`)).toBeDisabled();
    openMenu(sendHoa.id);
    expect(screen.getByTestId(`my-item-down-${sendHoa.id}`)).toBeDisabled();
  });

  it("reorder: dragging the handle onto another row sends that order", async () => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    fireEvent.dragStart(screen.getByTestId(`my-item-drag-${sendHoa.id}`));
    const target = screen.getByTestId(`checklist-item-${callLender.id}`);
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    await waitFor(() =>
      expect(api().reorderMyItems).toHaveBeenCalledWith({
        transactionId: "txn-1",
        itemIds: [sendHoa.id, callLender.id],
      }),
    );
  });

  it("tick: set-item-checked with the item id and the new value", async () => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    fireEvent.click(screen.getByTestId(`checklist-check-${callLender.id}`));
    await waitFor(() => expect(api().setItemChecked).toHaveBeenCalledTimes(1));
    expect(api().setItemChecked).toHaveBeenCalledWith({ itemId: callLender.id, checked: true });
    expect(calledWrites()).toEqual(["setItemChecked"]);
  });

  it("delete: asks first; Cancel writes nothing; Delete sends remove-my-item", async () => {
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    openMenu(sendHoa.id);
    fireEvent.click(screen.getByTestId(`my-item-delete-${sendHoa.id}`));
    expect(screen.getByTestId(`my-item-delete-prompt-${sendHoa.id}`)).toHaveTextContent(
      `Delete “${sendHoa.title}”?`,
    );
    fireEvent.click(screen.getByTestId(`my-item-delete-cancel-${sendHoa.id}`));
    expect(calledWrites()).toEqual([]);
    openMenu(sendHoa.id);
    fireEvent.click(screen.getByTestId(`my-item-delete-${sendHoa.id}`));
    fireEvent.click(screen.getByTestId(`my-item-delete-confirm-${sendHoa.id}`));
    await waitFor(() => expect(api().removeMyItem).toHaveBeenCalledTimes(1));
    expect(api().removeMyItem).toHaveBeenCalledWith({ transactionId: "txn-1", itemId: sendHoa.id });
    expect(calledWrites()).toEqual(["removeMyItem"]);
  });
});

describe("keyboard", () => {
  it("Tab reaches a row's actions; Enter opens them, renames and saves", async () => {
    const user = userEvent.setup();
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    const toggle = screen.getByRole("button", { name: `More actions for ${callLender.title}` });
    // From the row's Link… button, Tab lands on its ⋯ (this row has a note, so no Add note).
    screen.getByTestId(`checklist-open-picker-${callLender.id}`).focus();
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(screen.getByRole("button", { name: "Rename" })).toHaveFocus();
    await user.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: `Rename ${callLender.title}` });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "Call lender now{Enter}");
    await waitFor(() =>
      expect(api().renameMyItem).toHaveBeenCalledWith({
        transactionId: "txn-1",
        itemId: callLender.id,
        title: "Call lender now",
      }),
    );
  });

  it("Move down is reachable and works from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    screen.getByRole("button", { name: `More actions for ${callLender.title}` }).focus();
    await user.keyboard("{Enter}");
    await user.tab(); // Rename
    await user.tab(); // Move up (disabled: skipped)
    expect(screen.getByRole("button", { name: "Move down" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(api().reorderMyItems).toHaveBeenCalledWith({
        transactionId: "txn-1",
        itemIds: [sendHoa.id, callLender.id],
      }),
    );
  });
});

describe("a plan without checklists (carry-forward A)", () => {
  it.each(["blocked", "unknown"] as const)(
    "%s + only My items -> the section is editable; the tab says the plan sentence",
    async (gate) => {
      api().get.mockResolvedValue(answer([mine]));
      render(<Harness gate={gate} />);
      await screen.findByTestId("my-items-section");
      expect(screen.getByTestId("my-items-add-input")).toBeInTheDocument();
      expect(screen.getByTestId(`checklist-check-${callLender.id}`)).not.toBeDisabled();
      expect(screen.getByTestId(`checklist-open-picker-${callLender.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`my-item-menu-toggle-${callLender.id}`)).toBeInTheDocument();
      expect(screen.queryByTestId("my-items-locked")).not.toBeInTheDocument();
      // (C) one sentence for the tab and the Dashboard.
      expect(screen.getByTestId("checklist-template-hint").textContent).toBe(templateChecklistHint(gate));
      expect(screen.queryByTestId("checklist-readonly-notice")).not.toBeInTheDocument();
      // No template-checklist actions, and no Remove on My items.
      expect(screen.queryByTestId("checklist-add")).not.toBeInTheDocument();
      expect(screen.queryByTestId("checklist-chooser")).not.toBeInTheDocument();
      expect(screen.queryByTestId(`checklist-remove-${mine.checklist.id}`)).not.toBeInTheDocument();
      expect(api().listTemplates).not.toHaveBeenCalled();
    },
  );

  it("blocked + My items: a tick and an add still reach main", async () => {
    api().get.mockResolvedValue(answer([mine]));
    render(<Harness gate="blocked" />);
    await screen.findByTestId("my-items-section");
    fireEvent.click(screen.getByTestId(`checklist-check-${callLender.id}`));
    await waitFor(() => expect(api().setItemChecked).toHaveBeenCalledWith({ itemId: callLender.id, checked: true }));
    fireEvent.change(screen.getByTestId("my-items-add-input"), { target: { value: "Order keys" } });
    fireEvent.click(screen.getByTestId("my-items-add"));
    await waitFor(() => expect(api().addMyItem).toHaveBeenCalledWith({ transactionId: "txn-1", title: "Order keys" }));
  });

  it("blocked + My items: Link… on a My item opens the picker", async () => {
    api().get.mockResolvedValue(answer([mine]));
    render(<Harness gate="blocked" />);
    await screen.findByTestId("my-items-section");
    fireEvent.click(screen.getByTestId(`checklist-open-picker-${callLender.id}`));
    expect(await screen.findByTestId("checklist-link-picker")).toBeInTheDocument();
  });

  it("blocked + a template checklist and My items: template actions stay withheld", async () => {
    render(<Harness gate="blocked" />);
    await screen.findByTestId("my-items-section");
    const templateItem = fixtureChecklist(0).items[1];
    expect(screen.getByTestId(`checklist-check-${templateItem.id}`)).toBeDisabled();
    expect(screen.queryByTestId(`checklist-open-picker-${templateItem.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId("checklist-add")).not.toBeInTheDocument();
    expect(screen.getByTestId("checklist-readonly-notice")).toBeInTheDocument();
    // My items in the same tab stay editable.
    expect(screen.getByTestId(`checklist-check-${callLender.id}`)).not.toBeDisabled();
  });

  it("allowed + only My items -> the template chooser shows under My items", async () => {
    api().get.mockResolvedValue(answer([mine]));
    render(<Harness gate="allowed" />);
    await screen.findByTestId("checklist-chooser");
    const panel = screen.getByTestId("checklist-panel");
    expect(within(panel).getByTestId("my-items-section")).toBeInTheDocument();
    expect(
      section().compareDocumentPosition(screen.getByTestId("checklist-chooser")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("a locked deal (SR ruling 4: every My-items write refused)", () => {
  it("locked from the start: rows read-only, the tab notice is the one lock line, no add", async () => {
    render(<Harness gate="allowed" overrides={{ lockedTooltip: "With your broker for review." }} />);
    await screen.findByTestId("my-items-section");
    // One lock line: the tab's notice says it; the section adds no second one.
    expect(screen.getByTestId("checklist-locked-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("my-items-locked")).not.toBeInTheDocument();
    expect(screen.queryByTestId("my-items-add-input")).not.toBeInTheDocument();
    expect(screen.getByTestId(`checklist-check-${callLender.id}`)).toBeDisabled();
    expect(screen.queryByTestId(`my-item-menu-toggle-${callLender.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`checklist-open-picker-${callLender.id}`)).not.toBeInTheDocument();
  });

  it("a rename refused by the lock: the old title comes back, main's sentence shows, rows lock", async () => {
    let settle!: (v: ChecklistWriteResult) => void;
    api().renameMyItem.mockReturnValue(new Promise<ChecklistWriteResult>((r) => (settle = r)));
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    openMenu(callLender.id);
    fireEvent.click(screen.getByTestId(`my-item-rename-${callLender.id}`));
    const input = screen.getByTestId(`my-item-rename-input-${callLender.id}`);
    fireEvent.change(input, { target: { value: "Renamed while locked" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Optimistic: the new title shows while main answers.
    expect(rowTitles()[0]).toBe("Renamed while locked");
    await act(async () => settle(LOCK_REFUSAL));
    await waitFor(() => expect(rowTitles()[0]).toBe(callLender.title));
    expect(screen.getByTestId("my-items-error")).toHaveTextContent(LOCK_REFUSAL.error!);
    expect(screen.getByRole("alert")).toBe(screen.getByTestId("my-items-error"));
    expect(screen.queryByTestId("my-items-add-input")).not.toBeInTheDocument();
    expect(screen.getByTestId(`checklist-check-${callLender.id}`)).toBeDisabled();
  });

  it("a delete refused by the lock: the row comes back", async () => {
    api().removeMyItem.mockResolvedValue({ ...LOCK_REFUSAL, refusedEdit: "remove-my-item" });
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    openMenu(sendHoa.id);
    fireEvent.click(screen.getByTestId(`my-item-delete-${sendHoa.id}`));
    fireEvent.click(screen.getByTestId(`my-item-delete-confirm-${sendHoa.id}`));
    expect(await screen.findByTestId("my-items-error")).toHaveTextContent(LOCK_REFUSAL.error!);
    expect(rowTitles()).toEqual([callLender.title, sendHoa.title]);
  });

  it("a reorder refused: the old order comes back", async () => {
    api().reorderMyItems.mockResolvedValue({ ...LOCK_REFUSAL, refusedEdit: "reorder-my-items" });
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    openMenu(callLender.id);
    fireEvent.click(screen.getByTestId(`my-item-down-${callLender.id}`));
    expect(await screen.findByTestId("my-items-error")).toBeInTheDocument();
    expect(rowTitles()).toEqual([callLender.title, sendHoa.title]);
  });

  it("an add refused: nothing added, the typed title stays in the input", async () => {
    api().addMyItem.mockResolvedValue({ ...LOCK_REFUSAL, refusedEdit: "add-my-item" });
    render(<Harness gate="allowed" />);
    const input = await screen.findByTestId("my-items-add-input");
    fireEvent.change(input, { target: { value: "Order keys" } });
    fireEvent.click(screen.getByTestId("my-items-add"));
    expect(await screen.findByTestId("my-items-error")).toHaveTextContent(LOCK_REFUSAL.error!);
    expect(screen.queryByTestId("my-item-adding")).not.toBeInTheDocument();
  });

  it("a tick refused: the box goes back", async () => {
    api().setItemChecked.mockResolvedValue({ ...LOCK_REFUSAL, refusedEdit: "set-item-checked" });
    render(<Harness gate="allowed" />);
    await screen.findByTestId("my-items-section");
    const box = screen.getByTestId(`checklist-check-${callLender.id}`);
    fireEvent.click(box);
    expect(await screen.findByTestId("my-items-error")).toHaveTextContent(LOCK_REFUSAL.error!);
    expect(box).toHaveAttribute("aria-checked", "false");
  });
});
