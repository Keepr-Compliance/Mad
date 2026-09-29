/**
 * LiveMoneyInput — commas added while typing, caret kept in place (BACKLOG-3614).
 *
 * The input is controlled and its value round-trips through the parent, so the
 * tests drive it through a small stateful wrapper (not a jest.fn) and read
 * `selectionStart` after each edit — that is the only way a caret jump shows up.
 */

import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import LiveMoneyInput from "../LiveMoneyInput";

function Harness({ initial = "", onText }: { initial?: string; onText?: (t: string) => void }) {
  const [text, setText] = useState(initial);
  return (
    <LiveMoneyInput
      data-testid="money"
      value={text}
      onValueChange={(t) => {
        setText(t);
        onText?.(t);
      }}
    />
  );
}

const setup = (initial = "") => {
  const onText = jest.fn();
  render(<Harness initial={initial} onText={onText} />);
  return { input: screen.getByTestId("money") as HTMLInputElement, onText, user: userEvent.setup() };
};

/** Type `keys` with the caret placed at `at` first. */
const typeAt = (
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLInputElement,
  keys: string,
  at: number,
) => user.type(input, keys, { initialSelectionStart: at, initialSelectionEnd: at });

describe("LiveMoneyInput — formatting while typing", () => {
  it("adds commas as each digit arrives: 100 -> 1,000 -> 1,000,000", async () => {
    const { input, user } = setup();
    const seen: string[] = [];
    for (const d of "1000000") {
      await user.type(input, d);
      seen.push(input.value);
    }
    expect(seen).toEqual([
      "1",
      "10",
      "100",
      "1,000",
      "10,000",
      "100,000",
      "1,000,000",
    ]);
    // Appending keeps the caret at the end.
    expect(input.selectionStart).toBe("1,000,000".length);
  });

  it("drops a $, spaces and letters; keeps one dot and two decimals", async () => {
    const { input, user } = setup();
    await user.type(input, "$1 2a3b4.567.8");
    expect(input.value).toBe("1,234.56");
  });

  it("formats a pasted amount", async () => {
    const { input, user } = setup();
    await user.click(input);
    await user.paste("$1,200,000");
    expect(input.value).toBe("1,200,000");
    expect(input.selectionStart).toBe("1,200,000".length);
  });

  it("leaves the field blank when only letters are typed", async () => {
    const { input, user, onText } = setup();
    await user.type(input, "abc");
    expect(input.value).toBe("");
    expect(onText).not.toHaveBeenCalled();
  });
});

describe("LiveMoneyInput — caret position", () => {
  it("insert in the middle: caret stays after the typed digit", async () => {
    const { input, user } = setup("100,000");
    // caret between "1" and "0" -> type 5 -> 1,500,000 with caret after the 5
    await typeAt(user, input, "5", 1);
    expect(input.value).toBe("1,500,000");
    expect(input.selectionStart).toBe(3);
  });

  it("insert just before a comma: caret stays before the comma", async () => {
    const { input, user } = setup("12,345");
    await typeAt(user, input, "9", 2);
    expect(input.value).toBe("129,345");
    expect(input.selectionStart).toBe(3);
  });

  it("backspace a digit in the middle: caret stays where the digit was", async () => {
    const { input, user } = setup("1,234,567");
    // caret after the "4" (index 5) -> backspace -> 123,567 with caret after "3"
    await typeAt(user, input, "{Backspace}", 5);
    expect(input.value).toBe("123,567");
    expect(input.selectionStart).toBe(3);
  });

  it("backspace over a comma deletes the digit before it", async () => {
    const { input, user } = setup("1,234,567");
    // caret right after the second comma (index 6)
    await typeAt(user, input, "{Backspace}", 6);
    expect(input.value).toBe("123,567");
    expect(input.selectionStart).toBe(3);
  });

  it("delete over a comma deletes the digit after it", async () => {
    const { input, user } = setup("1,234,567");
    // caret right before the second comma (index 5)
    await typeAt(user, input, "{Delete}", 5);
    expect(input.value).toBe("123,467");
    // caret stays after the "4" it was after
    expect(input.selectionStart).toBe(5);
  });

  it("a dropped letter mid-number leaves the value and the caret alone", async () => {
    const { input, user } = setup("1,000");
    await typeAt(user, input, "x", 2);
    expect(input.value).toBe("1,000");
    expect(input.selectionStart).toBe(2);
  });

  it("backspacing the whole number empties it one digit at a time", async () => {
    const { input, user } = setup("1,000,000");
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      await typeAt(user, input, "{Backspace}", input.value.length);
      seen.push(input.value);
    }
    expect(seen).toEqual(["100,000", "10,000", "1,000", "100", "10", "1", ""]);
  });
});

// SR review (pm_comments 3008b20f on BACKLOG-3614): three defects in the first cut.
describe("LiveMoneyInput — SR fixes", () => {
  it("R1: 500,000 -> Backspace the 5 -> type 6 -> 600,000 (leading zeros kept while typing)", async () => {
    const { input, user } = setup("500,000");
    await typeAt(user, input, "{Backspace}", 1);
    expect(input.value).toBe("00,000");
    expect(input.selectionStart).toBe(0);
    await typeAt(user, input, "6", 0);
    expect(input.value).toBe("600,000");
    expect(input.selectionStart).toBe(1);
  });

  it("R1b: Backspace over the comma in 1,|000,000 keeps the zeros", async () => {
    const { input, user } = setup("1,000,000");
    await typeAt(user, input, "{Backspace}", 2);
    expect(input.value).toBe("000,000");
    await typeAt(user, input, "2", 0);
    expect(input.value).toBe("2,000,000");
  });

  it("R1c: leading zeros are trimmed when the field loses focus", async () => {
    const { input, user, onText } = setup("500,000");
    await typeAt(user, input, "{Backspace}", 1);
    fireEvent.blur(input);
    expect(input.value).toBe("0");
    expect(onText).toHaveBeenLastCalledWith("0");
  });

  it("R2: a second . typed mid-number is ignored; no digits are lost", async () => {
    const { input, user } = setup("1,234.5");
    await typeAt(user, input, ".", 1);
    expect(input.value).toBe("1,234.5");
    expect(input.selectionStart).toBe(1);
  });

  it("R2b: a . typed where it would push digits past two decimals is ignored", async () => {
    const { input, user } = setup("1,234");
    await typeAt(user, input, ".", 1);
    expect(input.value).toBe("1,234");
  });

  it("R2c: a digit typed inside full cents is ignored; the existing cent is kept", async () => {
    const { input, user } = setup("1.23");
    await typeAt(user, input, "5", 3);
    expect(input.value).toBe("1.23");
  });

  it("R2d: a . typed where it leaves at most two decimals is accepted", async () => {
    const { input, user } = setup("1,234");
    await typeAt(user, input, ".", 3);
    expect(input.value).toBe("12.34");
  });

  it("R3: a Backspace that deletes nothing does not make a later cut delete a digit", async () => {
    const { input, user } = setup("1,234");
    // Backspace at the very start: nothing to delete, no change event.
    await typeAt(user, input, "{Backspace}", 0);
    expect(input.value).toBe("1,234");
    // Cut only the comma (no key press involved).
    input.setSelectionRange(1, 2);
    await user.cut();
    expect(input.value).toBe("1,234");
  });
});
