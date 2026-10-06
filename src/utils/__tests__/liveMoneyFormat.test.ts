/**
 * liveMoneyFormat — the pure half of LiveMoneyInput (BACKLOG-3614, BACKLOG-3677).
 * Grouping is swept across every digit count from 1 to 12, not sampled.
 *
 * BACKLOG-3677 reverses SR review 3008b20f (leading zeros kept while typing):
 * a whole part with no non-zero digit is blank, never 0 (founder rule,
 * pm_comments 882e5ecc on BACKLOG-3500).
 */

import {
  deleteAcrossSeparator,
  formatMoneyEdit,
  formatMoneyLive,
  settleMoneyOnBlur,
} from "../liveMoneyFormat";
import { parseMoney } from "../../components/transactionDates/commission";

describe("formatMoneyLive — grouping", () => {
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
    "%i digits: grouped in threes and parses back to the same number",
    (n) => {
      const digits = "123456789012".slice(0, n);
      const { text, caret } = formatMoneyLive(digits, digits.length);
      expect(text).toBe(Number(digits).toLocaleString("en-US"));
      expect(caret).toBe(text.length);
      const parsed = parseMoney(text);
      expect(parsed).toEqual({ ok: true, value: Number(digits) });
    },
  );

  it.each([
    ["", ""],
    // BACKLOG-3677: leading zeros are dropped; nothing but zeros is blank.
    ["0", ""],
    ["000", ""],
    ["007", "7"],
    ["00000", ""],
    ["000123", "123"],
    [".5", "0.5"],
    ["0.5", "0.5"],
    ["00.50", "0.50"],
    [".", "0."],
    ["1234.50", "1,234.50"],
    ["1234.", "1,234."],
    ["12345678901234567890", "12,345,678,901,234,567,890"],
    ["1234.5", "1,234.5"],
    ["1234.567", "1,234.56"],
    ["1.2.3", "1.23"],
    ["$1,234", "1,234"],
    ["12 34", "1,234"],
    ["abc", ""],
  ])("%j -> %j", (raw, expected) => {
    expect(formatMoneyLive(raw, raw.length).text).toBe(expected);
  });
});

describe("formatMoneyLive — caret", () => {
  it.each([
    // [raw after the edit, caret in raw, formatted, caret in formatted]
    ["1000", 4, "1,000", 5],
    ["1000", 1, "1,000", 1],
    ["1000", 2, "1,000", 3],
    ["15,00,000", 2, "1,500,000", 3],
    ["1,23567", 4, "123,567", 3],
    ["0012", 2, "12", 0],
    ["0012", 3, "12", 1],
    ["00,000", 0, "", 0],
    [".", 1, "0.", 2],
    [".5", 0, "0.5", 0],
    ["600,000", 1, "600,000", 1],
  ])("%j @%i -> %j @%i", (raw, rawCaret, text, caret) => {
    expect(formatMoneyLive(raw, rawCaret)).toEqual({ text, caret });
  });
});

describe("deleteAcrossSeparator", () => {
  it("Backspace over a comma removes the digit before it", () => {
    // "1,234,567" with the second comma removed, caret where the comma was
    expect(deleteAcrossSeparator("1,234,567", "1,234567", 5, "Backspace")).toEqual({
      text: "123,567",
      caret: 3,
    });
  });

  it("Delete over a comma removes the digit after it", () => {
    expect(deleteAcrossSeparator("1,234,567", "1,234567", 5, "Delete")).toEqual({
      text: "123,467",
      caret: 5,
    });
  });

  it("returns null when a digit (not only a comma) was deleted", () => {
    expect(deleteAcrossSeparator("1,234", "1,24", 3, "Backspace")).toBeNull();
  });

  it("returns null at the edges", () => {
    expect(deleteAcrossSeparator(",1", "1", 0, "Backspace")).toBeNull();
    expect(deleteAcrossSeparator("1,", "1", 1, "Delete")).toBeNull();
  });

  it("Backspace over the comma in 1,|000,000 deletes the 1 and leaves the box blank", () => {
    expect(deleteAcrossSeparator("1,000,000", "1000,000", 1, "Backspace")).toEqual({
      text: "",
      caret: 0,
    });
  });
});

describe("formatMoneyEdit — never drops a character that was already there", () => {
  it.each([
    // [previous, raw after the edit, caret in raw]
    ["1,234.5", "1.,234.5", 2], // "." before existing decimals
    ["1,234.5", ".1,234.5", 1], // "." at the very start
    ["1,234", "1.,234", 2], // "." that would leave three decimals
    ["1.23", "1.253", 4], // digit inside full cents
  ])("%j -> %j is rejected", (previous, raw, caret) => {
    expect(formatMoneyEdit(previous, raw, caret)).toBeNull();
  });

  it.each([
    // [previous, raw, caret, text, caret]
    ["1,234", "1,2.34", 4, "12.34", 3], // "." leaving two decimals
    ["1,234.56", "1,234.567", 9, "1,234.56", 8], // extra typed cent: only the new digit drops
    ["", "$1,234.567", 10, "1,234.56", 8], // paste into an empty field
    ["500,000", "00,000", 0, "", 0], // BACKLOG-3677: blank, never 0
    ["1,000,000", ",000,000", 0, "", 0], // the founder's leading-1 case
    ["1,050", ",050", 0, "50", 0],
  ])("%j -> %j @%i gives %j @%i", (previous, raw, rawCaret, text, caret) => {
    expect(formatMoneyEdit(previous, raw, rawCaret)).toEqual({ text, caret });
  });
});

describe("settleMoneyOnBlur", () => {
  it.each([
    ["0.", ""],
    ["0.0", ""],
    ["0.00", ""],
    ["", ""],
    ["12.", "12"],
    ["1,234.", "1,234"],
    ["0.5", "0.5"],
    ["1,000", "1,000"],
    ["1,234.50", "1,234.50"],
  ])("%j -> %j", (text, expected) => {
    expect(settleMoneyOnBlur(text)).toBe(expected);
  });
});
