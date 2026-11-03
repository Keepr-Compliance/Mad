/**
 * BACKLOG-3964 slice 3a: useEscapeToClose and useFocusTrap read their callbacks
 * through a ref, so a callback rebuilt on every render (SupportTicketDialog
 * passes one) is the one that runs, not the first render's.
 */
import React from "react";
import { render, fireEvent } from "@testing-library/react";
import { useEscapeToClose } from "../useEscapeToClose";
import { useFocusTrap } from "../useFocusTrap";

function EscapeHost(props: { onEscape: () => void; deferTo?: () => boolean }) {
  useEscapeToClose(true, props.onEscape, props.deferTo);
  return null;
}

function TrapHost(props: { deferTo?: () => boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, props.deferTo);
  return (
    <div ref={ref}>
      <button data-testid="a">a</button>
      <button data-testid="b">b</button>
    </div>
  );
}

describe("useEscapeToClose follows a changed callback", () => {
  it("calls the NEW onEscape after a rerender, never the old one", () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(<EscapeHost onEscape={first} />);
    rerender(<EscapeHost onEscape={second} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("uses the NEW deferTo after a rerender", () => {
    const onEscape = jest.fn();
    const { rerender } = render(<EscapeHost onEscape={onEscape} deferTo={() => false} />);
    rerender(<EscapeHost onEscape={onEscape} deferTo={() => true} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEscape).not.toHaveBeenCalled();
    rerender(<EscapeHost onEscape={onEscape} deferTo={() => false} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe("useFocusTrap follows a changed deferTo", () => {
  it("Tab is wrapped while deferTo is false and left alone once a rerender makes it true", () => {
    const { rerender, getByTestId } = render(<TrapHost deferTo={() => false} />);
    const b = getByTestId("b");
    b.focus();
    // Last element + Tab: trap wraps to first (event default prevented).
    expect(fireEvent.keyDown(b, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(getByTestId("a"));

    rerender(<TrapHost deferTo={() => true} />);
    b.focus();
    // Deferred: the trap leaves Tab alone.
    expect(fireEvent.keyDown(b, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(b);
  });
});
