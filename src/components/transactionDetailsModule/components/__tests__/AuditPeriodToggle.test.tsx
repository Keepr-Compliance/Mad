/**
 * AuditPeriodToggle Tests (BACKLOG-2291)
 *
 * The shared audit-period control extracted from the Texts tab so the
 * ConversationViewModal renders an identical toggle. Verifies the pill markup,
 * the switch state/behaviour, and the "(i)" popover carrying the date range.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuditPeriodToggle } from "../AuditPeriodToggle";

describe("AuditPeriodToggle", () => {
  it("renders the pill, label and switch reflecting the checked state", () => {
    render(
      <AuditPeriodToggle
        checked
        onChange={jest.fn()}
        auditRangeLabel="Jan 1, 2026 - Jan 31, 2026"
      />
    );

    expect(screen.getByTestId("audit-period-filter")).toBeInTheDocument();
    expect(screen.getByTestId("audit-period-info")).toHaveTextContent(
      /Remove texts outside audit range/
    );
    expect(screen.getByTestId("audit-period-filter-checkbox")).toBeChecked();
  });

  it("calls onChange with the toggled value when the switch is clicked", () => {
    const onChange = jest.fn();
    render(
      <AuditPeriodToggle
        checked={false}
        onChange={onChange}
        auditRangeLabel="Jan 1, 2026 - Jan 31, 2026"
      />
    );

    const toggle = screen.getByTestId("audit-period-filter-checkbox");
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("carries the exact date range in the (i) title and click-to-open popover", () => {
    render(
      <AuditPeriodToggle
        checked
        onChange={jest.fn()}
        auditRangeLabel="Jan 1, 2026 - Jan 31, 2026"
      />
    );

    const infoButton = screen.getByTestId("audit-period-info-button");
    expect(infoButton).toHaveAttribute(
      "title",
      expect.stringContaining("Jan 1, 2026 - Jan 31, 2026")
    );

    // Popover is closed until the "(i)" is clicked.
    expect(
      screen.queryByTestId("audit-period-info-popover")
    ).not.toBeInTheDocument();
    fireEvent.click(infoButton);
    expect(screen.getByTestId("audit-period-info-popover")).toHaveTextContent(
      "Jan 1, 2026 - Jan 31, 2026"
    );
  });

  it("omits the parenthetical range when no label is provided", () => {
    render(<AuditPeriodToggle checked onChange={jest.fn()} auditRangeLabel="" />);

    fireEvent.click(screen.getByTestId("audit-period-info-button"));
    const popover = screen.getByTestId("audit-period-info-popover");
    expect(popover).toHaveTextContent(
      "When ON, only texts within the audit period are shown. When OFF, every linked text is shown."
    );
    expect(popover).not.toHaveTextContent("()");
  });
});
