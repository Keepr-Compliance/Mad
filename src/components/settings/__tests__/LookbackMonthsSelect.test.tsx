/**
 * The shared months dropdown (macOS, Android Companion, Google Messages).
 * Mutation: no option for a stored value outside the list → the select reads
 * blank → red.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LookbackMonthsSelect, parseLookbackOption } from "../LookbackMonthsSelect";

describe("LookbackMonthsSelect", () => {
  it("shows the listed options and All time", () => {
    render(<LookbackMonthsSelect value={6} onChange={jest.fn()} aria-label="months" />);
    const select = screen.getByRole("combobox", { name: "months" }) as HTMLSelectElement;
    expect(select.value).toBe("6");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Last 3 months", "Last 6 months", "Last 9 months", "Last 12 months", "Last 18 months", "Last 24 months", "All time",
    ]);
  });

  it("a stored value outside the list shows as Custom, not blank", () => {
    render(<LookbackMonthsSelect value={2} onChange={jest.fn()} aria-label="months" />);
    const select = screen.getByRole("combobox", { name: "months" }) as HTMLSelectElement;
    expect(select.value).toBe("2");
    expect(select.selectedOptions[0].textContent).toBe("Custom: 2 months");
  });

  it("null is All time; a change reports the option value", () => {
    const onChange = jest.fn();
    render(<LookbackMonthsSelect value={null} onChange={onChange} aria-label="months" />);
    const select = screen.getByRole("combobox", { name: "months" }) as HTMLSelectElement;
    expect(select.value).toBe("all");
    fireEvent.change(select, { target: { value: "12" } });
    expect(onChange).toHaveBeenCalledWith("12");
    expect(parseLookbackOption("all")).toBeNull();
    expect(parseLookbackOption("18")).toBe(18);
  });
});
