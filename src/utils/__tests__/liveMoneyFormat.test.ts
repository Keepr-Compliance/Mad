/**
 * liveMoneyFormat — the pure half of LiveMoneyInput (BACKLOG-3614).
 * Grouping is swept across every digit count from 1 to 12, not sampled.
 */

import {
  deleteAcrossSeparator,
  formatMoneyEdit,
  formatMoneyLive,
  trimLeadingZeros,
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
    // SR review 3008b20f: leading zeros are kept while typing (deleting the 5
    // in 500,000 must leave 00,000); trimLeadingZeros removes them on blur.
    ["0", "0"],
    ["000", "000"],
    ["007", "007"],
    ["00000", "00,000"],
    [".5", ".5"],
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
    ["0012", 2, "0,012", 3],
    ["00,000", 0, "00,000", 0],
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

  it("Backspace over the comma in 1,|000,000 keeps the zeros (SR 3008b20f)", () => {
    expect(deleteAcrossSeparator("1,000,000", "1000,000", 1, "Backspace")).toEqual({
      text: "000,000",
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
    ["500,000", "00,000", 0, "00,000", 0],
    ["00,000", "600,000", 1, "600,000", 1],
  ])("%j -> %j @%i gives %j @%i", (previous, raw, rawCaret, text, caret) => {
    expect(formatMoneyEdit(previous, raw, rawCaret)).toEqual({ text, caret });
  });
});

describe("trimLeadingZeros (on blur)", () => {
  it.each([
    ["00,000", "0"],
    ["000,000", "0"],
    ["007", "7"],
    ["0,012", "12"],
    ["00.5", "0.5"],
    ["0", "0"],
    [".5", ".5"],
    ["", ""],
    ["1,000", "1,000"],
  ])("%j -> %j", (text, expected) => {
    expect(trimLeadingZeros(text)).toBe(expected);
  });
});
