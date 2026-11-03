/**
 * BACKLOG-4110 (mock v9) — Dashboard panel colours.
 *
 * - Closing badge CLASSES per tone (data-tone alone is not a colour check):
 *   overdue and today red, 1-14 d amber, beyond 14 d neutral. Each badge is
 *   also checked for the absence of the other tones' classes.
 * - PanelCard: warm hairline, no shadow, warm header strip, ink title.
 * Rows transcribed from OpenRequiredChecklistItem (electron/types/checklistTodo.ts),
 * same shape as TodoPanel-3965.test.tsx.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TodoPanel } from "../TodoPanel";
import { PanelCard } from "../PanelCard";
import type { TodoState } from "../useDashboardPanels";
import type { OpenRequiredChecklistItem } from "../../../../../electron/types/checklistTodo";

const NOW = new Date(2026, 9, 31, 12, 0); // local noon, 2026-10-31

const item = (n: number, closingDeadline: string): OpenRequiredChecklistItem => ({
  itemId: `item-${n}`,
  checklistId: "cl-1",
  title: `Item ${n}`,
  transactionId: `txn-${n}`,
  propertyAddress: `${n} Test St`,
  closingDeadline,
  dealRequiredDone: 1,
  dealRequiredTotal: 4,
});

const ready = (items: OpenRequiredChecklistItem[]): TodoState => ({
  status: "ready",
  data: { totalCount: items.length, items },
});

const TONE_CLASSES = {
  danger: ["bg-danger-100", "text-danger-800"],
  warning: ["bg-warning-100", "text-warning-800"],
  neutral: ["bg-warm-divider", "text-ink-muted"],
} as const;
type Tone = keyof typeof TONE_CLASSES;

describe("BACKLOG-4110 — closing badge classes per tone", () => {
  // -1 / 0 / 9 / 21 days from 2026-10-31.
  const CASES: Array<[string, string, string, Tone]> = [
    ["2026-10-30", "-1 d", "Overdue", "danger"],
    ["2026-10-31", "0 d", "Today", "danger"],
    ["2026-11-09", "9 d", "9 d", "warning"],
    ["2026-11-21", "21 d", "21 d", "neutral"],
  ];

  it.each(CASES)("closing %s (%s) -> %s badge with the %s classes only", (deadline, _d, label, tone) => {
    render(
      <TodoPanel
        state={ready([item(1, deadline)])}
        onOpenTransaction={jest.fn()}
        onRetry={jest.fn()}
        onTick={jest.fn()}
        now={NOW}
      />,
    );
    const badge = within(screen.getByTestId("dashboard-todo-row")).getByTestId("closing-badge");
    expect(badge).toHaveTextContent(label);
    expect(badge).toHaveAttribute("data-tone", tone);
    expect(badge).toHaveClass(...TONE_CLASSES[tone]);
    (Object.keys(TONE_CLASSES) as Tone[])
      .filter((other) => other !== tone)
      .forEach((other) => {
        TONE_CLASSES[other].forEach((cls) => expect(badge).not.toHaveClass(cls));
      });
  });
});

describe("BACKLOG-4110 — PanelCard", () => {
  it("warm hairline, no shadow, warm header strip, ink title", () => {
    render(
      <PanelCard title="Recent" testId="panel">
        <p>body</p>
      </PanelCard>,
    );
    const card = screen.getByTestId("panel");
    expect(card).toHaveClass("border", "border-warm-line");
    expect(card).not.toHaveClass("shadow-sm");
    expect(card).not.toHaveClass("border-gray-200");
    const header = card.firstElementChild as HTMLElement;
    expect(header).toHaveClass("bg-warm-header", "border-b", "border-warm-line");
    expect(header).not.toHaveClass("border-gray-200");
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2).toHaveTextContent("Recent");
    expect(h2).toHaveClass("text-ink");
    expect(h2).not.toHaveClass("text-gray-900");
  });
});
