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

  it("closes on a window scroll", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="Tooltip body" />);
    await user.hover(trigger());
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes when an enclosing scroll container scrolls, not only the window", async () => {
    // `scroll` does not bubble. A container scroll reaches this component only
    // because the listener is registered on `window` with `capture: true`, and
    // the Export modal's pills sit inside exactly such a container — which is
    // the path that matters. Dropping the capture flag, or the listener
    // entirely, reds this.
    const user = userEvent.setup();
    render(
      <div data-testid="scroller" style={{ overflowY: "auto", height: 40 }}>
        <div style={{ height: 400 }}>
          <InfoTooltip text="Tooltip body" />
        </div>
      </div>,
    );
    await user.hover(trigger());
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.scroll(screen.getByTestId("scroller"));
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

/**
 * Measured in Electron 38.8.6 / Chromium 140 against the real component, driven
 * with `sendInputEvent` under CDP focus emulation (a hidden window dispatches no
 * focus events without it, which is why this join went unmeasured before):
 *
 *   tab that does NOT scroll  -> bubble stays OPEN
 *   every tab that DOES scroll -> bubble SHUT 180ms later,
 *                                 `focusin` then `scroll` 0.5ms apart
 *
 * So a tooltip on any control the browser had to scroll into view was
 * unreachable by keyboard. With `scroll-behavior: smooth` — `Settings.tsx:181`,
 * which holds five of these call sites — that one focus fires ~77 `scroll`
 * events across ~640ms, largest gap between consecutive events 17ms. Hence a
 * SLIDING 150ms window rather than a fixed short one.
 */
describe("InfoTooltip — the scroll that keyboard focus itself causes", () => {
  const renderHostInScroller = () => {
    const utils = render(
      <div data-testid="scroller">
        <button type="button">
          One PDF
          <InfoTooltip text="Tooltip body" />
        </button>
      </div>,
    );
    const host = screen.getByRole("button", { name: "One PDF" });
    act(() => host.focus());
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    return { ...utils, host, scroller: screen.getByTestId("scroller") };
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("keeps a focus-opened bubble through the scroll focus caused", () => {
    const { scroller } = renderHostInScroller();
    fireEvent.scroll(scroller);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("keeps it through a whole smooth-scroll train, then closes on a genuine scroll", () => {
    const { scroller } = renderHostInScroller();

    // ~640ms of animation events, well past a fixed 150ms window. The window
    // slides, so none of these close it.
    for (let elapsed = 0; elapsed < 640; elapsed += 16) {
      act(() => { jest.advanceTimersByTime(16); });
      fireEvent.scroll(scroller);
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    }

    // The animation stops. Once the window lapses, the user's own scroll closes
    // it exactly as it always did.
    act(() => { jest.advanceTimersByTime(151); });
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes on a genuine scroll once the window has lapsed", () => {
    const { scroller } = renderHostInScroller();
    act(() => { jest.advanceTimersByTime(151); });
    fireEvent.scroll(scroller);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("gives a POINTER-opened bubble no window at all", () => {
    render(
      <div data-testid="scroller">
        <button type="button">
          One PDF
          <InfoTooltip text="Tooltip body" />
        </button>
      </div>,
    );
    fireEvent.mouseEnter(trigger());
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("re-places the bubble on a swallowed scroll instead of letting it drift", () => {
    // jsdom returns an all-zero rect, so give the icon a moving one: the bubble
    // must follow it while a smooth container glides.
    let iconTop = 400;
    const realRect = Element.prototype.getBoundingClientRect;
    const spy = jest
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        if (this.getAttribute?.("data-testid") === "info-tooltip-trigger") {
          return { top: iconTop, left: 30, bottom: iconTop + 16, right: 46, width: 16, height: 16, x: 30, y: iconTop, toJSON: () => ({}) } as DOMRect;
        }
        return realRect.call(this);
      });
    try {
      const { scroller } = renderHostInScroller();
      expect(screen.getByRole("tooltip").style.top).toBe("392px");

      iconTop = 120;
      fireEvent.scroll(scroller);
      expect(screen.getByRole("tooltip").style.top).toBe("112px");
    } finally {
      spy.mockRestore();
    }
  });
});
