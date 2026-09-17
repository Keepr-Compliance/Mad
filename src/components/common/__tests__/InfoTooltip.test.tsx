/**
 * InfoTooltip — hover and keyboard-focus behaviour (BACKLOG-3415).
 *
 * The founder asked for every (i) to open on hover instead of click. Before
 * this change the icon was a click toggle with a 3-second auto-dismiss and no
 * keyboard path at all. There was no test for the component.
 *
 * Two trigger shapes, because 12 of 16 call sites sit inside a <button>:
 *   - standalone (inside a <label> or plain markup): the icon is the tab stop
 *   - nested in an interactive host (<button>, role="button" card): the host is
 *     the tab stop, and keyboard focus on it opens the bubble
 */

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { InfoTooltip } from "../InfoTooltip";

const trigger = () => screen.getByTestId("info-tooltip-trigger");

describe("InfoTooltip — standalone trigger", () => {
  it("shows the bubble on hover and hides it when the pointer leaves", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="Tooltip body" />);
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.hover(trigger());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Tooltip body");

    await user.unhover(trigger());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("is a tab stop: shows on keyboard focus, hides on blur, and describes itself while shown", async () => {
    const user = userEvent.setup();
    render(
      <>
        <InfoTooltip text="Tooltip body" />
        <button type="button">next</button>
      </>,
    );
    expect(trigger()).toHaveAttribute("tabindex", "0");

    await user.tab();
    expect(trigger()).toHaveFocus();
    const bubble = screen.getByRole("tooltip");
    expect(bubble).toHaveTextContent("Tooltip body");
    expect(trigger()).toHaveAttribute("aria-describedby", bubble.id);

    await user.tab();
    expect(screen.getByRole("button", { name: "next" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger()).not.toHaveAttribute("aria-describedby");
  });

  it("does not auto-dismiss while hovered (the old click version closed itself after 3s)", () => {
    jest.useFakeTimers();
    try {
      render(<InfoTooltip text="Tooltip body" />);
      fireEvent.mouseEnter(trigger());
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(10_000);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="Tooltip body" />);
    await user.hover(trigger());
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps only one bubble open at a time", async () => {
    const user = userEvent.setup();
    render(
      <>
        <InfoTooltip text="First" />
        <InfoTooltip text="Second" />
      </>,
    );
    const [first, second] = screen.getAllByTestId("info-tooltip-trigger");

    await user.tab();
    expect(first).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("First");

    await user.hover(second);
    const bubbles = screen.getAllByRole("tooltip");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toHaveTextContent("Second");
  });

  it("uses the wide, left-aligned bubble only when asked", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<InfoTooltip text="Narrow" />);
    await user.hover(trigger());
    expect(screen.getByRole("tooltip").className).toContain("w-52");
    unmount();

    render(<InfoTooltip wide text={"Line one\nLine two"} />);
    await user.hover(trigger());
    const bubble = screen.getByRole("tooltip");
    expect(bubble.className).toContain("w-72");
    expect(bubble.className).toContain("whitespace-pre-line");
    expect(bubble.className).not.toContain("w-52");
  });

  it("renders a plain string exactly as before, and markup when given a node (BACKLOG-3415)", async () => {
    const user = userEvent.setup();

    // `text` was widened from string to ReactNode so the Transaction Dates
    // tooltip can bold each date's name. 15 of the 16 call sites still pass a
    // plain string: the bubble must hold that string and nothing else — no
    // wrapper element introduced by the widening.
    const { unmount } = render(<InfoTooltip text="Plain string body" />);
    await user.hover(trigger());
    const plain = screen.getByRole("tooltip");
    expect(plain).toHaveTextContent("Plain string body");
    expect(plain.childElementCount).toBe(0);
    expect(plain.innerHTML).toBe("Plain string body");
    unmount();

    render(<InfoTooltip wide text={<strong className="font-semibold">Bold body</strong>} />);
    await user.hover(trigger());
    const rich = screen.getByRole("tooltip");
    expect(rich.querySelector("strong")).not.toBeNull();
    expect(rich.querySelector("strong")!.textContent).toBe("Bold body");
  });
});

describe("InfoTooltip — clicking or pressing keys on the icon is inert", () => {
  it("does not fire a parent's click or key handlers", async () => {
    const user = userEvent.setup();
    const onClick = jest.fn();
    const onKeyDown = jest.fn();
    render(
      // Mirrors a clickable card. Deliberately no role, so the icon stays a tab
      // stop and the Enter/Space path is exercised.
      <div onClick={onClick} onKeyDown={onKeyDown}>
        <InfoTooltip text="Tooltip body" />
      </div>,
    );

    await user.click(trigger());
    expect(onClick).not.toHaveBeenCalled();

    trigger().focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not toggle a checkbox in the surrounding <label>", async () => {
    const user = userEvent.setup();
    render(
      <label>
        <input type="checkbox" data-testid="box" />
        Include attachments
        <InfoTooltip text="Tooltip body" />
      </label>,
    );

    await user.click(trigger());
    expect(screen.getByTestId("box")).not.toBeChecked();
  });

  it("does not submit a form or fire the button's onClick when the icon sits inside a submit button", async () => {
    const user = userEvent.setup();
    const onSubmit = jest.fn((e: React.FormEvent) => e.preventDefault());
    const onClick = jest.fn();
    render(
      <form onSubmit={onSubmit}>
        <button type="submit" onClick={onClick}>
          One PDF
          <InfoTooltip text="Tooltip body" />
        </button>
      </form>,
    );

    await user.click(trigger());
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("InfoTooltip — nested inside an interactive host", () => {
  it("inside a <button>: the icon is not a tab stop and does not change the button's name", () => {
    render(
      <button type="button">
        One PDF
        <InfoTooltip text="Tooltip body" />
      </button>,
    );
    expect(trigger()).not.toHaveAttribute("tabindex");
    expect(trigger()).not.toHaveAttribute("aria-label");
    expect(screen.getByRole("button", { name: "One PDF" })).toBeInTheDocument();
  });

  it("inside a <button>: hover still opens it", async () => {
    const user = userEvent.setup();
    render(
      <button type="button">
        One PDF
        <InfoTooltip text="Tooltip body" />
      </button>,
    );
    await user.hover(trigger());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Tooltip body");
    await user.unhover(trigger());
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("inside a <button>: keyboard focus on the button opens it and the button is described by it; blur closes it", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">
          One PDF
          <InfoTooltip text="Tooltip body" />
        </button>
        <button type="button">next</button>
      </>,
    );
    const host = screen.getByRole("button", { name: "One PDF" });

    await user.tab();
    expect(host).toHaveFocus();
    const bubble = screen.getByRole("tooltip");
    expect(bubble).toHaveTextContent("Tooltip body");
    expect(host).toHaveAttribute("aria-describedby", bubble.id);

    await user.tab();
    expect(screen.getByRole("button", { name: "next" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(host).not.toHaveAttribute("aria-describedby");
  });

  it("inside a role=\"button\" card: the card is the tab stop, not the icon", async () => {
    const user = userEvent.setup();
    render(
      <div role="button" tabIndex={0} onKeyDown={jest.fn()}>
        Pete
        <span>
          Deleted contact
          <InfoTooltip text="Tooltip body" />
        </span>
      </div>,
    );
    expect(trigger()).not.toHaveAttribute("tabindex");

    await user.tab();
    expect(screen.getByRole("button")).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Tooltip body");
  });

  it("does not open when the host is focused by a mouse click (not :focus-visible)", () => {
    const realMatches = Element.prototype.matches;
    const spy = jest
      .spyOn(Element.prototype, "matches")
      .mockImplementation(function (this: Element, selector: string) {
        if (selector === ":focus-visible") return false;
        return realMatches.call(this, selector);
      });
    try {
      render(
        <button type="button">
          One PDF
          <InfoTooltip text="Tooltip body" />
        </button>,
      );
      act(() => {
        screen.getByRole("button", { name: "One PDF" }).focus();
      });
      expect(screen.getByRole("button", { name: "One PDF" })).toHaveFocus();
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
