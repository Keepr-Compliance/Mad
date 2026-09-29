/**
 * BACKLOG-3614: FloatingActionBar is generic — any ordered set of 1-4 actions.
 * These tests use a two-button set (the shape Submit will pass: "Export PDF" +
 * "Next") so the component is proven independently of New Transaction.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import {
  FloatingActionBar,
  FLOATING_ACTION_BAR_CONTENT_PADDING,
} from "../FloatingActionBar";

describe("FloatingActionBar (BACKLOG-3614)", () => {
  it("renders a two-button set in order, floating at the bottom-right", async () => {
    const exportPdf = jest.fn();
    const next = jest.fn();
    render(
      <FloatingActionBar
        testId="bar"
        actions={[
          { label: "Export PDF", onClick: exportPdf, variant: "secondary", testId: "a" },
          { label: "Next", onClick: next, variant: "primary", testId: "b" },
        ]}
      />,
    );
    const bar = screen.getByTestId("bar");
    expect(bar.className).toEqual(expect.stringContaining("absolute"));
    expect(bar.className).toEqual(expect.stringContaining("bottom-4"));
    const buttons = Array.from(bar.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Export PDF", "Next"]);
    expect(buttons.map((b) => b.getAttribute("data-variant"))).toEqual([
      "secondary",
      "primary",
    ]);
    expect(buttons[1].className).toEqual(expect.stringContaining("from-indigo-500"));

    await userEvent.click(screen.getByTestId("a"));
    await userEvent.click(screen.getByTestId("b"));
    expect(exportPdf).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("skips falsy entries, honours disabled, loading, aria-label and icon", async () => {
    const onDisabled = jest.fn();
    render(
      <FloatingActionBar
        testId="bar"
        actions={[
          false,
          { label: "Skip", onClick: onDisabled, variant: "ghost", disabled: true, testId: "d" },
          {
            label: "Save",
            onClick: jest.fn(),
            variant: "primary",
            loading: true,
            loadingLabel: "Saving...",
            testId: "l",
          },
          null,
          {
            label: "",
            ariaLabel: "Help",
            icon: <svg data-testid="icon" />,
            onClick: jest.fn(),
            testId: "i",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("bar").querySelectorAll("button")).toHaveLength(3);

    const disabled = screen.getByTestId("d");
    expect(disabled).toBeDisabled();
    await userEvent.click(disabled);
    expect(onDisabled).not.toHaveBeenCalled();

    const loading = screen.getByTestId("l");
    expect(loading).toBeDisabled();
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Saving...");
    expect(loading.className).toEqual(expect.stringContaining("bg-gray-300"));

    expect(screen.getByRole("button", { name: "Help" })).toBe(screen.getByTestId("i"));
    expect(screen.getByTestId("i")).toContainElement(screen.getByTestId("icon"));
    // Defaults to secondary when no variant is given.
    expect(screen.getByTestId("i")).toHaveAttribute("data-variant", "secondary");
  });

  it("exports the content padding a consumer applies to its own scroll area", () => {
    expect(FLOATING_ACTION_BAR_CONTENT_PADDING).toMatch(/^pb-\d+$/);
  });
});
