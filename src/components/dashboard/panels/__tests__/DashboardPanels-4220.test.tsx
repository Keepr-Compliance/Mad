/**
 * BACKLOG-4220: Settings > General "Show to-do list on the dashboard".
 *
 * Real hook, real services, real Settings component; only `window.api`
 * (tests/setup.js) is mocked. The `preferences:get` answer is the shape
 * electron/handlers/preferenceHandlers.ts returns:
 * `{ success: true, preferences: <bag>, source: "cloud" }`.
 *
 * C1 off -> no Todo panel.
 * C2 off -> one column at every width (Recent spans the row).
 * C3 off -> the Todo read never runs.
 * C4 no stored value -> Todo shown and read (default unchanged).
 * C5 the Settings switch writes `dashboard.showTodo` and the mounted panels follow.
 * C6 off -> on in the same mount reads Todo again.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("@/hooks/useNotification", () => ({ useNotification: () => ({ notify: jest.fn() }) }));
jest.mock("../../../../contexts/NetworkContext", () => ({ useNetwork: () => ({ isOnline: true }) }));

import { DashboardPanels } from "../DashboardPanels";
import { showTodoFromPreferences } from "../todoPanelPreference";
import { GeneralSettings } from "../../../settings/GeneralSettings";

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

/** A stored bag as preferences:get returns it. */
function storedPreferences(bag: Record<string, unknown>) {
  api().preferences.get.mockResolvedValue({ success: true, preferences: bag, source: "cloud" });
}

beforeEach(() => {
  jest.clearAllMocks();
  api().featureGate.strictState.mockResolvedValue("allowed");
  api().transactions.getRecentlyOpened.mockResolvedValue({ success: true, transactions: [RECENT_ROW] });
  api().checklists.listOpenRequired.mockResolvedValue({
    success: true,
    result: { totalCount: 1, items: [TODO_ITEM] },
  });
  api().preferences.update.mockResolvedValue({ success: true });
});

function renderPanels() {
  return render(<DashboardPanels userId="user-1" onOpenTransaction={jest.fn()} onViewTransactions={jest.fn()} />);
}

const BREAKPOINTS: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280 };
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

/** Let the preferences read, the Recent read and any Todo read settle. */
async function settle() {
  await screen.findByText("1 Recent St");
  await waitFor(() => expect(api().preferences.get).toHaveBeenCalledWith("user-1"));
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Todo hidden (dashboard.showTodo = false)", () => {
  beforeEach(() => storedPreferences({ sync: { autoSyncOnLogin: true }, dashboard: { showTodo: false } }));

  it("C1: no Todo panel; Recent is the only panel", async () => {
    renderPanels();
    await settle();
    expect(screen.queryByTestId("dashboard-todo")).not.toBeInTheDocument();
    const grid = screen.getByTestId("dashboard-panels");
    expect(grid.children).toHaveLength(1);
    expect(grid.firstElementChild).toBe(screen.getByTestId("dashboard-recent"));
  });

  it.each([400, 767, 768, 1024, 1280])("C2: %ipx wide -> one column (no half-width class)", async (width) => {
    renderPanels();
    await settle();
    await waitFor(() => expect(screen.queryByTestId("dashboard-todo")).not.toBeInTheDocument());
    const grid = screen.getByTestId("dashboard-panels");
    expect(columnsAt(grid.className, width)).toBe(1);
    expect(grid.className.split(/\s+/)).not.toContain("md:grid-cols-2");
  });

  it("C3: the Todo read never runs", async () => {
    renderPanels();
    await settle();
    expect(api().transactions.getRecentlyOpened).toHaveBeenCalled();
    expect(api().checklists.listOpenRequired).not.toHaveBeenCalled();
  });
});

describe("Todo shown by default (C4)", () => {
  it.each([
    ["no dashboard key", { sync: { autoSyncOnLogin: true } }],
    ["empty bag", {}],
    ["non-boolean value", { dashboard: { showTodo: "no" } }],
  ])("%s -> Todo shown, read once, two columns from 768 px", async (_label, bag) => {
    storedPreferences(bag);
    renderPanels();
    expect(await screen.findByText("Signed disclosure")).toBeInTheDocument();
    const grid = screen.getByTestId("dashboard-panels");
    expect([400, 768, 1280].map((w) => columnsAt(grid.className, w))).toEqual([1, 2, 2]);
    expect(api().checklists.listOpenRequired).toHaveBeenCalledTimes(1);
  });

  it("a failed preferences read -> Todo shown and read", async () => {
    api().preferences.get.mockResolvedValue({ success: false, error: "offline" });
    renderPanels();
    expect(await screen.findByText("Signed disclosure")).toBeInTheDocument();
    expect(api().checklists.listOpenRequired).toHaveBeenCalledTimes(1);
  });

  it("showTodoFromPreferences: absent = shown, only false hides", () => {
    expect(showTodoFromPreferences({})).toBe(true);
    expect(showTodoFromPreferences(undefined)).toBe(true);
    expect(showTodoFromPreferences({ dashboard: {} })).toBe(true);
    expect(showTodoFromPreferences({ dashboard: { showTodo: true } })).toBe(true);
    expect(showTodoFromPreferences({ dashboard: { showTodo: false } })).toBe(false);
  });

  it("Settings switch is on when nothing is stored", () => {
    render(<GeneralSettings userId="user-1" initialPreferences={{}} />);
    expect(screen.getByRole("switch", { name: "Show to-do list on the dashboard" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

describe("the Settings switch drives the mounted dashboard (C5, C6)", () => {
  function renderBoth(initial: Record<string, unknown>) {
    storedPreferences(initial);
    render(
      <>
        <DashboardPanels userId="user-1" onOpenTransaction={jest.fn()} onViewTransactions={jest.fn()} />
        <GeneralSettings userId="user-1" initialPreferences={initial} />
      </>,
    );
  }

  it("C5: turning it off writes dashboard.showTodo=false and removes Todo without a remount", async () => {
    renderBoth({});
    expect(await screen.findByText("Signed disclosure")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Show to-do list on the dashboard" }));
    await waitFor(() => expect(screen.queryByTestId("dashboard-todo")).not.toBeInTheDocument());
    expect(api().preferences.update).toHaveBeenCalledWith("user-1", { dashboard: { showTodo: false } });
    expect(columnsAt(screen.getByTestId("dashboard-panels").className, 1024)).toBe(1);
    expect(screen.getByRole("switch", { name: "Show to-do list on the dashboard" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("C6: turning it back on reads Todo again and shows it", async () => {
    renderBoth({ dashboard: { showTodo: false } });
    await settle();
    expect(api().checklists.listOpenRequired).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Show to-do list on the dashboard" }));
    expect(await screen.findByText("Signed disclosure")).toBeInTheDocument();
    expect(api().checklists.listOpenRequired).toHaveBeenCalledTimes(1);
    expect(api().preferences.update).toHaveBeenCalledWith("user-1", { dashboard: { showTodo: true } });
  });

  it("a failed save puts the switch and the dashboard back", async () => {
    renderBoth({});
    expect(await screen.findByText("Signed disclosure")).toBeInTheDocument();
    api().preferences.update.mockResolvedValue({ success: false, error: "offline" });
    fireEvent.click(screen.getByRole("switch", { name: "Show to-do list on the dashboard" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Show to-do list on the dashboard" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(screen.getByTestId("dashboard-todo")).toBeInTheDocument();
  });
});
