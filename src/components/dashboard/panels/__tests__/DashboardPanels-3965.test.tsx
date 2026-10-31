/**
 * BACKLOG-3965 PR-4b: Recent | Todo wired to the real hook, the real services
 * and the real plan-gate hook; only `window.api` (tests/setup.js) is mocked.
 *
 * C5  side by side from 768 px, one column below, Recent first.
 * C6  Todo only when the gate answered "allowed"; Recent spans the row otherwise.
 * C11 a Todo row opens its deal on the Checklist tab; a Recent row on Overview.
 *     The two empty states come from main's two different answers.
 *     A tick main refuses (locked deal) leaves the row and says why.
 */
import fs from "fs";
import path from "path";
import React from "react";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DashboardPanels, PANELS_GRID_ONE, PANELS_GRID_TWO } from "../DashboardPanels";
import { CHECKLISTS_NOT_ALLOWED_MESSAGE } from "../useDashboardPanels";
import { notifyTransactionsViewClosed } from "../../../../appCore/openTransactionRequest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const api = () => (window as any).api;

const RECENT_ROW = {
  transactionId: "txn-recent",
  propertyAddress: "1 Recent St",
  status: "active",
  openedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  requiredDone: 1,
  requiredTotal: 3,
};
const TODO_ITEM = {
  itemId: "item-1",
  checklistId: "cl-1",
  title: "Signed disclosure",
  transactionId: "txn-todo",
  propertyAddress: "2 Todo Ave",
  closingDeadline: null,
  dealRequiredDone: 0,
  dealRequiredTotal: 2,
};

function setGate(state: "allowed" | "blocked" | "unknown" | "pending") {
  api().featureGate.strictState.mockImplementation(() =>
    state === "pending" ? new Promise(() => undefined) : Promise.resolve(state),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  setGate("allowed");
  api().transactions.getRecentlyOpened.mockResolvedValue({ success: true, transactions: [RECENT_ROW] });
  api().checklists.listOpenRequired.mockResolvedValue({
    success: true,
    result: { totalCount: 1, items: [TODO_ITEM] },
  });
  api().checklists.setItemChecked.mockResolvedValue({ success: true, changed: true });
});

function renderPanels() {
  const onOpenTransaction = jest.fn();
  const onViewTransactions = jest.fn();
  render(
    <DashboardPanels userId="user-1" onOpenTransaction={onOpenTransaction} onViewTransactions={onViewTransactions} />,
  );
  return { onOpenTransaction, onViewTransactions };
}

const BREAKPOINTS: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280 };
/** The grid-cols-N in effect at `width`, from classes like "grid-cols-1 md:grid-cols-2". */
const columnsAt = (className: string, width: number): number => {
  let cols = 1;
  let from = -1;
  for (const cls of className.split(/\s+/)) {
    const m = /^(?:(sm|md|lg|xl):)?grid-cols-(\d+)$/.exec(cls);
    if (!m) continue;
    const min = m[1] ? BREAKPOINTS[m[1]] : 0;
    if (width >= min && min >= from) {
      cols = Number(m[2]);
      from = min;
    }
  }
  return cols;
};

describe("DashboardPanels layout (C5, C6)", () => {
  it.each([
    [400, 1],
    [639, 1],
    [640, 1],
    [700, 1],
    [767, 1],
    [768, 2],
    [1024, 2],
    [1280, 2],
  ])("plan with checklists, %ipx wide -> %i column(s), Recent first", async (width, cols) => {
    renderPanels();
    await screen.findByTestId("dashboard-todo");
    const grid = screen.getByTestId("dashboard-panels");
    expect(columnsAt(grid.className, width)).toBe(cols);
    expect(grid.firstElementChild).toBe(screen.getByTestId("dashboard-recent"));
    expect(grid.children[1]).toBe(screen.getByTestId("dashboard-todo"));
  });

  it.each(["blocked", "unknown", "pending"] as const)(
    "gate %s -> no Todo, no rings, Recent spans the row",
    async (state) => {
      setGate(state);
      renderPanels();
      await screen.findByText("1 Recent St");
      expect(screen.queryByTestId("dashboard-todo")).not.toBeInTheDocument();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      const grid = screen.getByTestId("dashboard-panels");
      for (const width of [400, 768, 1280]) expect(columnsAt(grid.className, width)).toBe(1);
      expect(api().checklists.listOpenRequired).not.toHaveBeenCalled();
    },
  );

  it("the grid constants are the ones measured above", () => {
    expect(PANELS_GRID_TWO.split(" ")).toEqual(expect.arrayContaining(["grid-cols-1", "md:grid-cols-2"]));
    expect(PANELS_GRID_ONE.split(" ")).not.toContain("md:grid-cols-2");
  });
});

describe("DashboardPanels rows (C11, SR 5d)", () => {
  it("a Recent row opens its deal on the Overview tab", async () => {
    const { onOpenTransaction } = renderPanels();
    fireEvent.click(await screen.findByText("1 Recent St"));
    expect(onOpenTransaction).toHaveBeenCalledTimes(1);
    expect(onOpenTransaction).toHaveBeenCalledWith("txn-recent", "overview");
  });

  it("a Todo row opens its deal on the Checklist tab", async () => {
    const { onOpenTransaction } = renderPanels();
    fireEvent.click(await screen.findByText("Signed disclosure"));
    expect(onOpenTransaction).toHaveBeenCalledTimes(1);
    expect(onOpenTransaction).toHaveBeenCalledWith("txn-todo", "checklist");
  });

  it("Recent reads 5 deals for this user; Todo reads 50", async () => {
    renderPanels();
    await screen.findByText("Signed disclosure");
    expect(api().transactions.getRecentlyOpened).toHaveBeenCalledWith("user-1", 5);
    expect(api().checklists.listOpenRequired).toHaveBeenCalledWith({ userId: "user-1", limit: 50 });
  });

  it("the ring shows the deal's required numbers from the read", async () => {
    renderPanels();
    const ring = await screen.findByRole("progressbar");
    expect(ring).toHaveAttribute("aria-valuenow", "1");
    expect(ring).toHaveAttribute("aria-valuemax", "3");
    expect(screen.getByText(/^1 of 3 · 2h ago$/)).toBeInTheDocument();
  });
});

describe("Todo empty states come from main's two different answers", () => {
  it("plan refusal -> 'not on your plan'", async () => {
    api().checklists.listOpenRequired.mockResolvedValue({ success: false, error: CHECKLISTS_NOT_ALLOWED_MESSAGE });
    renderPanels();
    expect(await screen.findByText("Checklists aren't on your plan.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your checklist items.")).not.toBeInTheDocument();
  });

  it("any other failure -> 'couldn't load'", async () => {
    api().checklists.listOpenRequired.mockResolvedValue({
      success: false,
      error: "Your checklist items couldn't be loaded right now.",
    });
    renderPanels();
    expect(await screen.findByText("Couldn't load your checklist items.")).toBeInTheDocument();
    expect(screen.queryByText("Checklists aren't on your plan.")).not.toBeInTheDocument();
  });

  it("the bridge throwing -> 'couldn't load', no crash", async () => {
    api().checklists.listOpenRequired.mockRejectedValue(new Error("ipc down"));
    api().transactions.getRecentlyOpened.mockRejectedValue(new Error("ipc down"));
    renderPanels();
    expect(await screen.findByText("Couldn't load your checklist items.")).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load recent deals.")).toBeInTheDocument();
  });

  it("the renderer copy of main's plan refusal matches the handler's constant", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../../../../electron/handlers/checklistHandlers.ts"),
      "utf8",
    );
    const m = /export const CHECKLISTS_NOT_ALLOWED_ERROR =\s*"([^"]+)";/.exec(src);
    expect(m?.[1]).toBe(CHECKLISTS_NOT_ALLOWED_MESSAGE);
  });
});

describe("refresh", () => {
  it("both panels read again when the Transactions view closes", async () => {
    renderPanels();
    await screen.findByText("Signed disclosure");
    expect(api().transactions.getRecentlyOpened).toHaveBeenCalledTimes(1);
    api().transactions.getRecentlyOpened.mockResolvedValue({
      success: true,
      transactions: [{ ...RECENT_ROW, transactionId: "txn-new", propertyAddress: "9 New Rd" }],
    });
    act(() => notifyTransactionsViewClosed());
    expect(await screen.findByText("9 New Rd")).toBeInTheDocument();
    expect(api().transactions.getRecentlyOpened).toHaveBeenCalledTimes(2);
    expect(api().checklists.listOpenRequired).toHaveBeenCalledTimes(2);
  });
});

describe("the Todo checkbox", () => {
  it("ticks through checklists:set-item-checked and reads again", async () => {
    renderPanels();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Mark done: Signed disclosure" }));
    await waitFor(() => expect(api().checklists.listOpenRequired).toHaveBeenCalledTimes(2));
    expect(api().checklists.setItemChecked).toHaveBeenCalledWith({ itemId: "item-1", checked: true });
  });

  it("a locked deal: main refuses, the row stays and says why, nothing crashes", async () => {
    api().checklists.setItemChecked.mockResolvedValue({
      success: false,
      error: "This transaction is locked while it is being reviewed.",
    });
    renderPanels();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Mark done: Signed disclosure" }));
    const row = screen.getByTestId("dashboard-todo-row");
    expect(await within(row).findByRole("alert")).toHaveTextContent(
      "This transaction is locked while it is being reviewed.",
    );
    expect(within(row).getByRole("checkbox")).not.toBeChecked();
    expect(api().checklists.listOpenRequired).toHaveBeenCalledTimes(1);
  });

  it("the tick bridge throwing is reported on the row, not thrown", async () => {
    api().checklists.setItemChecked.mockRejectedValue(new Error("ipc down"));
    renderPanels();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Mark done: Signed disclosure" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Signed disclosure")).toBeInTheDocument();
  });
});
