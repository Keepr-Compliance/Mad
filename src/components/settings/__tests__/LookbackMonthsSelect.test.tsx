/**
 * The shared months dropdown (macOS, Android Companion, Google Messages, email).
 *
 * Founder (2026-10-02): the options are 1, 1.5, 2, 3, 4, 5, 6 months and 1
 * year; 1.5 is marked "(default)". A stored value outside the list (9, 18, 24)
 * shows as "Custom: N months" and a stored All time as "All time" — never
 * blank — but neither is offered as a new choice.
 *
 * Mutations that turn this red:
 *   - no option for a stored value outside the list → the select reads blank;
 *   - "(default)" on the wrong option, or not a parameter;
 *   - All time still offered for a bounded value.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  LOOKBACK_MONTH_OPTIONS,
  LookbackMonthsSelect,
  forceWindowLine,
  lastMonthsPhrase,
  lookbackOptionLabel,
  parseLookbackOption,
} from "../LookbackMonthsSelect";

const labels = (select: HTMLSelectElement) => Array.from(select.options).map((o) => o.textContent);

describe("LookbackMonthsSelect", () => {
  it("offers exactly the founder's list, the default marked", () => {
    render(<LookbackMonthsSelect value={6} onChange={jest.fn()} aria-label="months" />);
    const select = screen.getByRole("combobox", { name: "months" }) as HTMLSelectElement;
    expect(select.value).toBe("6");
    expect(labels(select)).toEqual([
      "Last 1 month", "Last 1.5 months (default)", "Last 2 months", "Last 3 months",
      "Last 4 months", "Last 5 months", "Last 6 months", "Last 1 year",
    ]);
    expect(LOOKBACK_MONTH_OPTIONS).toEqual([1, 1.5, 2, 3, 4, 5, 6, 12]);
  });

  it.each([9, 18, 24])("a stored %i (outside the list) shows as Custom, not blank", (months) => {
    render(<LookbackMonthsSelect value={months} onChange={jest.fn()} aria-label="months" />);
    const select = screen.getByRole("combobox", { name: "months" }) as HTMLSelectElement;
    expect(select.value).toBe(String(months));
    expect(select.selectedOptions[0].textContent).toBe(`Custom: ${months} months`);
  });

  it("a stored All time (null) shows as All time; a change reports the option value", () => {
    const onChange = jest.fn();
    render(<LookbackMonthsSelect value={null} onChange={onChange} aria-label="months" />);
    const select = screen.getByRole("combobox", { name: "months" }) as HTMLSelectElement;
    expect(select.value).toBe("all");
    expect(select.selectedOptions[0].textContent).toBe("All time");
    fireEvent.change(select, { target: { value: "1.5" } });
    expect(onChange).toHaveBeenCalledWith("1.5");
    expect(parseLookbackOption("all")).toBeNull();
    expect(parseLookbackOption("1.5")).toBe(1.5);
  });

  it("All time is not offered for a bounded value", () => {
    render(<LookbackMonthsSelect value={3} onChange={jest.fn()} aria-label="months" />);
    expect(labels(screen.getByRole("combobox", { name: "months" }) as HTMLSelectElement)).not.toContain("All time");
  });

  it("the option list and the default are parameters", () => {
    render(<LookbackMonthsSelect value={3} onChange={jest.fn()} options={[1, 3, 6]} defaultMonths={3} aria-label="months" />);
    expect(labels(screen.getByRole("combobox", { name: "months" }) as HTMLSelectElement)).toEqual([
      "Last 1 month", "Last 3 months (default)", "Last 6 months",
    ]);
  });

  it("forceWindowLine: what a Force run keeps", () => {
    expect(forceWindowLine(1.5, "texts")).toBe("Keeps texts from the last 1.5 months; older texts not in an audit period are removed.");
    expect(forceWindowLine(12, "emails")).toBe("Keeps emails from the last year; older emails are removed from this computer.");
    expect(forceWindowLine(null, "texts")).toBe("Keeps all your texts.");
  });

  it("labels and phrases", () => {
    expect(lookbackOptionLabel(1.5)).toBe("Last 1.5 months (default)");
    expect(lookbackOptionLabel(1.5, null)).toBe("Last 1.5 months");
    expect(lookbackOptionLabel(12, null)).toBe("Last 1 year");
    expect(lastMonthsPhrase(1)).toBe("the last month");
    expect(lastMonthsPhrase(1.5)).toBe("the last 1.5 months");
    expect(lastMonthsPhrase(12)).toBe("the last year");
  });
});
