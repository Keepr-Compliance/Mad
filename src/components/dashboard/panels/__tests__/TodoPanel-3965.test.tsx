/**
 * BACKLOG-3965 PR-4b: the Todo panel.
 * Rows transcribed from OpenRequiredChecklistItem (electron/types/checklistTodo.ts,
 * the aliases of PR-3's openRequiredItems SQL).
 */
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TodoPanel, TODO_VISIBLE_ROWS } from "../TodoPanel";
import type { TodoState } from "../useDashboardPanels";
import type { OpenRequiredChecklistItem } from "../../../../../electron/types/checklistTodo";

const NOW = new Date(2026, 9, 31, 12, 0); // local noon, 2026-10-31

const item = (n: number, over: Partial<OpenRequiredChecklistItem> = {}): OpenRequiredChecklistItem => ({
  itemId: `item-${n}`,
  checklistId: "cl-1",
  title: `Item ${n}`,
  transactionId: `txn-${n}`,
  propertyAddress: `${n} Test St`,
  closingDeadline: "2026-11-10",
  dealRequiredDone: 1,
  dealRequiredTotal: 4,
  ...over,
});

function renderTodo(state: TodoState, extra: Partial<React.ComponentProps<typeof TodoPanel>> = {}) {
  const props = {
    state,
    onOpenTransaction: jest.fn(),
    onRetry: jest.fn(),
    onTick: jest.fn(),
    now: NOW,
    ...extra,
  };
  render(<TodoPanel {...props} />);
  return props;
}

const ready = (items: OpenRequiredChecklistItem[], totalCount = items.length): TodoState => ({
  status: "ready",
  data: { totalCount, items },
});

describe("TodoPanel", () => {
  it("the header count is the uncapped totalCount, not the rows read", () => {
    const items = Array.from({ length: 50 }, (_, i) => item(i));
    renderTodo(ready(items, 120));
    expect(screen.getByTestId("dashboard-todo-count")).toHaveTextContent("120 required");
  });

  it(`shows ${TODO_VISIBLE_ROWS} rows, then Show more expands without promising every row`, () => {
    const items = Array.from({ length: 50 }, (_, i) => item(i));
    renderTodo(ready(items, 120));
    expect(screen.getAllByTestId("dashboard-todo-row")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByTestId("dashboard-todo-row")).toHaveLength(50);
    expect(screen.getByTestId("dashboard-todo-partial")).toHaveTextContent("Showing 50 of 120.");
  });

  it("no Show more and no partial note when every row fits", () => {
    renderTodo(ready([item(1), item(2)]));
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-todo-partial")).not.toBeInTheDocument();
  });

  it("a row click opens its deal", () => {
    const props = renderTodo(ready([item(7)]));
    fireEvent.click(within(screen.getByTestId("dashboard-todo-row")).getByText("Item 7"));
    expect(props.onOpenTransaction).toHaveBeenCalledWith("txn-7");
    expect(props.onTick).not.toHaveBeenCalled();
  });

  it("the badge reads the deal's closing date against the local day", () => {
    renderTodo(
      ready([
        item(1, { closingDeadline: "2026-10-31" }),
        item(2, { closingDeadline: "2026-11-01" }),
        item(3, { closingDeadline: "2026-11-20" }),
        item(4, { closingDeadline: null }),
      ]),
    );
    const rows = screen.getAllByTestId("dashboard-todo-row");
    expect(within(rows[0]).getByTestId("closing-badge")).toHaveTextContent("Today");
    expect(within(rows[1]).getByTestId("closing-badge")).toHaveTextContent("1 d");
    expect(within(rows[2]).getByTestId("closing-badge")).toHaveAttribute("data-tone", "warning");
    expect(within(rows[3]).queryByTestId("closing-badge")).not.toBeInTheDocument();
  });

  // BACKLOG-3966 PR-3: main no longer refuses the read on the plan, so the
  // "not on your plan" state is gone; a plan without checklists shows the
  // template hint instead (below).
  describe("empty states — two different messages", () => {
    const MESSAGES = ["Nothing required left.", "Couldn't load your checklist items."];
    it.each([
      ["nothing left", ready([]), MESSAGES[0]],
      ["read failed", { status: "error" } as TodoState, MESSAGES[1]],
    ])("%s", (_name, state, message) => {
      renderTodo(state);
      expect(screen.getByText(message)).toBeInTheDocument();
      for (const other of MESSAGES.filter((m) => m !== message)) {
        expect(screen.queryByText(other)).not.toBeInTheDocument();
      }
    });

    it("a failed read offers a retry", () => {
      const props = renderTodo({ status: "error" });
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(props.onRetry).toHaveBeenCalled();
    });
  });

  it("an empty group renders no group, no header", () => {
    renderTodo(ready([], 0));
    expect(screen.queryByTestId("dashboard-todo-group")).not.toBeInTheDocument();
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
  });

  it("no 'Suggested' group or text renders in any state", () => {
    const states: TodoState[] = [
      ready([item(1)]),
      ready([]),
      { status: "loading" },
      { status: "error" },
    ];
    for (const state of states) {
      const { unmount } = render(
        <TodoPanel state={state} onOpenTransaction={jest.fn()} onRetry={jest.fn()} onTick={jest.fn()} now={NOW} />,
      );
      expect(screen.queryByText(/suggested/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  describe("the checkbox", () => {
    it("ticks the item, not the row click", () => {
      const props = renderTodo(ready([item(3)]));
      fireEvent.click(screen.getByRole("checkbox", { name: "Mark done: Item 3" }));
      expect(props.onTick).toHaveBeenCalledWith("item-3");
      expect(props.onOpenTransaction).not.toHaveBeenCalled();
    });

    it("a refused tick keeps the row, unticked, with main's reason", () => {
      renderTodo(ready([item(3)]), {
        tickError: { itemId: "item-3", message: "This deal is locked." },
      });
      expect(screen.getByRole("checkbox", { name: "Mark done: Item 3" })).not.toBeChecked();
      expect(screen.getByRole("alert")).toHaveTextContent("This deal is locked.");
    });

    it("is disabled while its tick is in flight", () => {
      renderTodo(ready([item(3)]), { tickingItemId: "item-3" });
      expect(screen.getByRole("checkbox", { name: "Mark done: Item 3" })).toBeDisabled();
    });
  });
});

describe("the template-checklists hint (BACKLOG-3966 PR-3)", () => {
  const HINT = "Template checklists aren't on your plan.";
  it.each([
    ["rows", ready([item(1)])],
    ["nothing left", ready([])],
    ["read failed", { status: "error" } as TodoState],
    ["loading", { status: "loading" } as TodoState],
  ])("templateHint + %s -> the hint shows", (_name, state) => {
    render(
      <TodoPanel state={state} templateHint onOpenTransaction={jest.fn()} onRetry={jest.fn()} onTick={jest.fn()} now={NOW} />,
    );
    expect(screen.getByTestId("dashboard-todo-template-hint")).toHaveTextContent(HINT);
  });

  it("no templateHint -> no hint", () => {
    render(<TodoPanel state={ready([item(1)])} onOpenTransaction={jest.fn()} onRetry={jest.fn()} onTick={jest.fn()} now={NOW} />);
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it("signed out ('off') -> no hint", () => {
    render(
      <TodoPanel state={{ status: "off" }} templateHint onOpenTransaction={jest.fn()} onRetry={jest.fn()} onTick={jest.fn()} now={NOW} />,
    );
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
