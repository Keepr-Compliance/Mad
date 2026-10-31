/**
 * BACKLOG-3965 PR-4b: the Recent panel.
 * Rows transcribed from GET_RECENTLY_OPENED_TRANSACTIONS_SQL's aliases
 * (electron/services/db/transactionOpenSql.ts) / RecentlyOpenedTransaction.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RecentPanel } from "../RecentPanel";
import type { RecentlyOpenedTransaction } from "../../../../../electron/types/transactionOpen";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const row = (over: Partial<RecentlyOpenedTransaction>): RecentlyOpenedTransaction => ({
  transactionId: "txn-a",
  propertyAddress: "1 Test St",
  status: "active",
  openedAt: "2026-10-31T10:00:00.000Z",
  requiredDone: 3,
  requiredTotal: 5,
  ...over,
});

function renderRecent(rows: RecentlyOpenedTransaction[], showProgress = true, onOpen = jest.fn()) {
  render(
    <RecentPanel
      state={{ status: "ready", rows }}
      showProgress={showProgress}
      onOpenTransaction={onOpen}
      onViewAll={jest.fn()}
      now={NOW}
    />,
  );
  return onOpen;
}

describe("RecentPanel", () => {
  it("a row shows address, 'N of M' and when it was opened, with a ring", () => {
    renderRecent([row({})]);
    expect(screen.getByText("1 Test St")).toBeInTheDocument();
    expect(screen.getByText("3 of 5 · 2h ago")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
  });

  it("a row click opens that deal", () => {
    const onOpen = renderRecent([row({ transactionId: "txn-b" })]);
    fireEvent.click(screen.getByTestId("dashboard-recent-row"));
    expect(onOpen).toHaveBeenCalledWith("txn-b");
  });

  it("a 0-total ring has no NaN or Infinity in any attribute", () => {
    renderRecent([row({ requiredDone: 0, requiredTotal: 0 })]);
    const ring = screen.getByRole("progressbar");
    const attrs = [ring, ...Array.from(ring.querySelectorAll("*"))].flatMap((el) =>
      Array.from(el.attributes).map((a) => a.value),
    );
    expect(attrs.length).toBeGreaterThan(0);
    for (const value of attrs) expect(value).not.toMatch(/NaN|Infinity/);
    expect(ring.querySelector('[data-part="arc"]')).toHaveAttribute("stroke-dasharray", "0.0 100");
    expect(screen.getByText("No required items · 2h ago")).toBeInTheDocument();
  });

  it("without checklists on the plan: no ring, no counts", () => {
    renderRecent([row({})], false);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("2h ago")).toBeInTheDocument();
  });

  it("empty and failed reads say different things", () => {
    const { unmount } = render(
      <RecentPanel state={{ status: "ready", rows: [] }} showProgress onOpenTransaction={jest.fn()} onViewAll={jest.fn()} />,
    );
    expect(screen.getByText("Deals you open show here.")).toBeInTheDocument();
    unmount();
    render(<RecentPanel state={{ status: "error" }} showProgress onOpenTransaction={jest.fn()} onViewAll={jest.fn()} />);
    expect(screen.getByText("Couldn't load recent deals.")).toBeInTheDocument();
    expect(screen.queryByText("Deals you open show here.")).not.toBeInTheDocument();
  });

  it("rows are disabled while a sync runs", () => {
    render(
      <RecentPanel
        state={{ status: "ready", rows: [row({})] }}
        showProgress
        disabled
        onOpenTransaction={jest.fn()}
        onViewAll={jest.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("dashboard-recent-row")).toBeDisabled();
  });
});
