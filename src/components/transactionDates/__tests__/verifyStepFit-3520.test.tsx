/**
 * BACKLOG-3520 follow-up — the Verify Transaction Details step of the Submit
 * dialog fits without scrolling where it can, and where it cannot the
 * scrollbar sits INSIDE the rounded frame.
 *
 * jsdom has no layout, so these controls read the structure that produces the
 * behaviour: which element clips, which element scrolls, and what sits outside
 * the scroller. The measured heights are recorded on the backlog item.
 *
 * RUNNER: npx jest src/components/transactionDates/__tests__/verifyStepFit-3520.test.tsx
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Transaction } from "@/types";
import { SubmitForReviewModal } from "../../transactionDetailsModule/components/modals/SubmitForReviewModal";

const base = {
  id: "txn-3520-fit",
  user_id: "user-3520",
  status: "active",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase",
  started_at: "2026-01-05",
  closed_at: "2026-03-14",
  sale_price: 412500,
  listing_price: 415000,
} as unknown as Transaction;

function renderSubmit() {
  render(
    <SubmitForReviewModal
      transaction={base}
      emailCount={4}
      textThreadCount={2}
      attachmentCount={3}
      emailAttachmentCount={1}
      totalSizeBytes={2048}
      isSubmitting={false}
      progress={null}
      error={null}
      onCancel={jest.fn()}
      onSubmit={jest.fn()}
      onExport={jest.fn()}
    />,
  );
}

const panel = () => screen.getByTestId("submit-review-modal").firstElementChild as HTMLElement;
const scrollers = (root: HTMLElement) =>
  [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].filter((e) =>
    /(^|\s)(sm:)?overflow-y-auto(\s|$)/.test(e.className.toString()),
  );

describe("Submit dialog, Verify Transaction Details step: where it scrolls", () => {
  it("the panel clips and is not the scroll container; the inner body is", () => {
    renderSubmit();
    expect(panel().className).toMatch(/(^|\s)overflow-hidden(\s|$)/);
    expect(panel().className).toMatch(/sm:overflow-hidden/);
    expect(panel().className).not.toMatch(/overflow-y-auto/);
    // The height cap: without it a short window pushes header and buttons off-screen and nothing scrolls.
    expect(panel().className).toMatch(/(^|\s)sm:max-h-\[/);
    expect(scrollers(panel())).toEqual([screen.getByTestId("submit-review-body")]);
  });

  it("header and action buttons sit outside the scrolling body", () => {
    renderSubmit();
    const body = screen.getByTestId("submit-review-body");
    const footer = screen.getByTestId("submit-review-footer");
    const header = screen.getByTestId("submit-review-header");
    for (const el of [footer, header]) {
      expect(body.contains(el)).toBe(false);
      expect(panel().contains(el)).toBe(true);
    }
    expect(footer).toContainElement(screen.getByRole("button", { name: "Next" }));
    expect(footer).toContainElement(screen.getByRole("button", { name: "Export PDF" }));
    expect(body.contains(screen.getByRole("button", { name: "Next" }))).toBe(false);
    expect(body).toContainElement(screen.getByTestId("submit-review-dates"));
  });
});

describe("the commission rates row", () => {
  it("Offered, Actual and Amount share one row container", () => {
    renderSubmit();
    const row = screen.getByTestId("commission-rates-row");
    for (const id of ["commission-offered", "commission-actual", "commission-amount"]) {
      expect(row).toContainElement(screen.getByTestId(id));
    }
    expect(row.children).toHaveLength(3);
  });

  it("the reason stays outside that row and appears only when the rates differ", () => {
    renderSubmit();
    expect(screen.queryByTestId("commission-reason")).toBeNull();
    fireEvent.change(screen.getByTestId("commission-offered"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("commission-actual"), { target: { value: "2.5" } });
    const reason = screen.getByTestId("commission-reason");
    expect(screen.getByTestId("commission-rates-row").contains(reason)).toBe(false);
  });
});
