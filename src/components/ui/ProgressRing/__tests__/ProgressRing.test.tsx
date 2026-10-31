/**
 * BACKLOG-3965 PR-4a (plan C9): ProgressRing renders the counts it is given.
 *
 * Asserts on the arc's own dash length, not only aria-valuenow, so a ring that
 * draws 100 % as an empty arc is caught; sweeps every attribute for NaN /
 * Infinity at 0 of 0; and pins the colour to kit token classes with no
 * gradient or inline colour.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ProgressRing } from "../ProgressRing";

function ring() {
  return screen.getByRole("progressbar");
}
function arc(container: HTMLElement) {
  const el = container.querySelector('[data-part="arc"]');
  if (!el) throw new Error("arc not rendered");
  return el;
}
function rail(container: HTMLElement) {
  const el = container.querySelector('[data-part="rail"]');
  if (!el) throw new Error("rail not rendered");
  return el;
}
function allAttributeValues(container: HTMLElement): string[] {
  const values: string[] = [];
  container.querySelectorAll("*").forEach((el) => {
    Array.from(el.attributes).forEach((a) => values.push(`${a.name}=${a.value}`));
  });
  return values;
}

describe("ProgressRing (BACKLOG-3965)", () => {
  it.each([
    // done, total, dasharray, valuenow, valuemax, label
    [0, 5, "0.0 100", "0", "5", "0 of 5 required done"],
    [1, 4, "25.0 100", "1", "4", "1 of 4 required done"],
    [3, 5, "60.0 100", "3", "5", "3 of 5 required done"],
    [7, 12, "58.3 100", "7", "12", "7 of 12 required done"],
    [5, 5, "100.0 100", "5", "5", "5 of 5 required done"],
    [7, 5, "100.0 100", "5", "5", "7 of 5 required done"],
  ])("%i of %i: arc %s, aria-valuenow %s", (done, total, dash, now, max, label) => {
    const { container } = render(<ProgressRing done={done} total={total} />);
    expect(arc(container)).toHaveAttribute("stroke-dasharray", dash);
    expect(ring()).toHaveAttribute("aria-valuenow", now);
    expect(ring()).toHaveAttribute("aria-valuemin", "0");
    expect(ring()).toHaveAttribute("aria-valuemax", max);
    expect(ring()).toHaveAccessibleName(label);
  });

  it("0 of 0 renders an empty ring with no NaN or Infinity anywhere", () => {
    const { container } = render(<ProgressRing done={0} total={0} />);
    expect(arc(container)).toHaveAttribute("stroke-dasharray", "0.0 100");
    expect(ring()).toHaveAttribute("aria-valuenow", "0");
    expect(ring()).toHaveAttribute("aria-valuemax", "0");
    expect(ring()).toHaveAccessibleName("No required items");
    const values = allAttributeValues(container);
    expect(values.length).toBeGreaterThan(10);
    expect(values.filter((v) => /NaN|Infinity/.test(v))).toEqual([]);
  });

  it("a zero arc uses a butt cap (a round cap would draw a dot); a partial arc is round", () => {
    const { container, rerender } = render(<ProgressRing done={0} total={5} />);
    expect(arc(container)).toHaveAttribute("stroke-linecap", "butt");
    rerender(<ProgressRing done={2} total={5} />);
    expect(arc(container)).toHaveAttribute("stroke-linecap", "round");
  });

  it("takes an accessible name from the caller (e.g. a deal with no checklist)", () => {
    render(<ProgressRing done={0} total={0} label="No checklist" />);
    expect(ring()).toHaveAccessibleName("No checklist");
  });

  it("is exposed as a progressbar; the svg itself is hidden from assistive tech", () => {
    const { container } = render(<ProgressRing done={2} total={4} />);
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("uses kit token classes only: gray-200 rail, primary-600 arc, no gradient or inline colour", () => {
    const { container } = render(<ProgressRing done={3} total={5} />);
    expect(rail(container).getAttribute("class")?.split(/\s+/)).toContain("stroke-gray-200");
    expect(arc(container).getAttribute("class")?.split(/\s+/)).toContain("stroke-primary-600");
    expect(container.querySelector("linearGradient, radialGradient, defs")).toBeNull();
    container.querySelectorAll("*").forEach((el) => {
      expect(el.hasAttribute("stroke")).toBe(false);
      expect(el.getAttribute("style") ?? "").not.toMatch(/stroke|gradient|url\(|#[0-9a-f]{3}/i);
      expect(el.getAttribute("class") ?? "").not.toMatch(/gradient|from-|via-|to-|blue-|indigo-|purple-/);
    });
  });

  it("renders at the size it is given (default 34 px)", () => {
    const { container, rerender } = render(<ProgressRing done={1} total={2} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "34");
    rerender(<ProgressRing done={1} total={2} size={24} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "24");
  });
});
