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
  // BACKLOG-3677 reverses R1 (leading zeros kept while typing): it was the
  // cause of the founder's "backspacing the leading 1 of 1,000,000 saves 0".
  // A whole part with no non-zero digit is now blank (pm_comments 882e5ecc).
  it("R1 (3677): 500,000 -> Backspace the 5 -> blank; replacing a leading digit is select-and-type", async () => {
    const { input, user } = setup("500,000");
    await typeAt(user, input, "{Backspace}", 1);
    expect(input.value).toBe("");
  });

  it("R1 (3677): select the 5 of 500,000 and type 6 -> 600,000", async () => {
    const { input, user } = setup("500,000");
    await user.type(input, "6", { initialSelectionStart: 0, initialSelectionEnd: 1 });
    expect(input.value).toBe("600,000");
    expect(input.selectionStart).toBe(1);
  });

  it("R1b (3677): Backspace over the comma in 1,|000,000 deletes the 1 and leaves the box blank", async () => {
    const { input, user, onText } = setup("1,000,000");
    await typeAt(user, input, "{Backspace}", 2);
    expect(input.value).toBe("");
    expect(onText).toHaveBeenLastCalledWith("");
  });

  it("R1c (3677): a zero amount left in the field is blank after blur, never 0", async () => {
    const { input, user, onText } = setup();
    await user.type(input, ".");
    expect(input.value).toBe("0.");
    fireEvent.blur(input);
    expect(input.value).toBe("");
    expect(onText).toHaveBeenLastCalledWith("");
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

// BACKLOG-3677 — the founder's bug, and a table sweep of typing, deleting and
// pasting. Each row starts from `initial` with the caret (or selection) at
// [start, end], sends `keys`, and checks the text and the caret.
describe("LiveMoneyInput — BACKLOG-3677 leading-digit fix", () => {
  it("backspacing the leading 1 of 1,000,000 leaves the box BLANK (not 0), before and after blur", async () => {
    const { input, user, onText } = setup("1,000,000");
    await typeAt(user, input, "{Backspace}", 1);
    expect(input.value).toBe("");
    expect(onText).toHaveBeenLastCalledWith("");
    fireEvent.blur(input);
    expect(input.value).toBe("");
  });

  it("Delete on the leading 1 of 1,000,000 also leaves the box blank", async () => {
    const { input, user } = setup("1,000,000");
    await typeAt(user, input, "{Delete}", 0);
    expect(input.value).toBe("");
  });
});

type Row = [label: string, initial: string, start: number, end: number, keys: string, text: string, caret: number];

const SWEEP: Row[] = [
  // typing: caret at the start, middle and end
  ["type at start", "234", 0, 0, "1", "1,234", 1],
  ["type in middle", "1,034", 2, 2, "2", "12,034", 2],
  ["type at end", "1,23", 4, 4, "4", "1,234", 5],
  // comma boundaries
  ["999 -> 1,000 (type at end)", "999", 3, 3, "9", "9,999", 5],
  ["999 -> 1,000 (type at start)", "999", 0, 0, "1", "1,999", 1],
  ["999,999 -> 1,000,000 boundary (type at end)", "99,999", 6, 6, "9", "999,999", 7],
  ["999,999 + 9 at end -> 9,999,999", "999,999", 7, 7, "9", "9,999,999", 9],
  ["999,999 + 1 at start -> 1,999,999", "999,999", 0, 0, "1", "1,999,999", 1],
  ["1,000 -> backspace last -> 100", "1,000", 5, 5, "{Backspace}", "100", 3],
  ["1,000,000 -> backspace last -> 100,000", "1,000,000", 9, 9, "{Backspace}", "100,000", 7],
  // deleting: start, middle, end, across a comma
  ["backspace at start does nothing", "1,234", 0, 0, "{Backspace}", "1,234", 0],
  ["delete at start", "1,234", 0, 0, "{Delete}", "234", 0],
  ["backspace in middle", "12,345", 4, 4, "{Backspace}", "1,245", 3],
  ["backspace at end", "12,345", 6, 6, "{Backspace}", "1,234", 5],
  ["delete at end does nothing", "12,345", 6, 6, "{Delete}", "12,345", 6],
  ["backspace across a comma", "12,345", 3, 3, "{Backspace}", "1,345", 1],
  ["delete across a comma", "12,345", 2, 2, "{Delete}", "1,245", 3],
  ["backspace the leading digit, zeros follow", "1,000,000", 1, 1, "{Backspace}", "", 0],
  ["backspace the leading digit, a non-zero follows", "1,050", 1, 1, "{Backspace}", "50", 0],
  // selections
  ["select-all + Backspace -> blank", "1,234,567", 0, 9, "{Backspace}", "", 0],
  ["select-all + Delete -> blank", "1,234,567", 0, 9, "{Delete}", "", 0],
  ["select-all + type -> replaces", "1,234,567", 0, 9, "8", "8", 1],
  ["select a middle run + type", "1,234,567", 2, 5, "9", "19,567", 2],
  // decimals
  ["type a dot at end", "1,234", 5, 5, ".", "1,234.", 6],
  ["type cents", "1,234.", 6, 6, "50", "1,234.50", 8],
  ["third decimal is ignored", "1,234.50", 8, 8, "1", "1,234.50", 8],
  ["a dot into an empty box gives 0.", "", 0, 0, ".", "0.", 2],
  ["backspace the dot rejoins the digits", "1,234.5", 6, 6, "{Backspace}", "12,345", 5],
  // leading zeros
  ["a lone 0 is blank", "", 0, 0, "0", "", 0],
  ["leading zeros are dropped as typed", "", 0, 0, "007", "7", 1],
  ["a zero typed before the number is dropped", "123", 0, 0, "0", "123", 0],
  ["0 then .5 gives 0.5", "", 0, 0, "0.5", "0.5", 3],
];

describe("LiveMoneyInput — BACKLOG-3677 table sweep (typing and deleting)", () => {
  it.each(SWEEP)("%s: %j [%i,%i] + %s -> %j @%i", async (_label, initial, start, end, keys, text, caret) => {
    const { input, user } = setup(initial);
    await user.type(input, keys, { initialSelectionStart: start, initialSelectionEnd: end });
    expect(input.value).toBe(text);
    expect(input.selectionStart).toBe(caret);
  });
});

describe("LiveMoneyInput — BACKLOG-3677 table sweep (pasting)", () => {
  it.each([
    // [paste, initial, start, end, text, caret]
    ["$1,234.50", "", 0, 0, "1,234.50", 8],
    ["$1,234.567", "", 0, 0, "1,234.56", 8],
    ["1000000", "", 0, 0, "1,000,000", 9],
    ["000123", "", 0, 0, "123", 3],
    ["$0.00", "", 0, 0, "0.00", 4],
    ["99", "1,000", 1, 1, "199,000", 3],
    ["$2,500", "1,234,567", 0, 9, "2,500", 5],
  ])("paste %j into %j [%i,%i] -> %j @%i", async (paste, initial, start, end, text, caret) => {
    const { input, user } = setup(initial);
    input.focus();
    input.setSelectionRange(start, end);
    await user.paste(paste);
    expect(input.value).toBe(text);
    expect(input.selectionStart).toBe(caret);
  });

  it("a pasted $0.00 is blank once the field loses focus", async () => {
    const { input, user } = setup();
    input.focus();
    await user.paste("$0.00");
    fireEvent.blur(input);
    expect(input.value).toBe("");
  });
});
