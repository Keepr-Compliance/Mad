/**
 * liveMoneyFormat — the pure half of LiveMoneyInput (BACKLOG-3614).
 * Grouping is swept across every digit count from 1 to 12, not sampled.
 */

import { deleteAcrossSeparator, formatMoneyLive } from "../liveMoneyFormat";
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
    ["0", "0"],
    ["000", "0"],
    ["007", "7"],
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
    ["0012", 2, "12", 0],
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
});
