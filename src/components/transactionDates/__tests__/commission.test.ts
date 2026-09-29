/**
 * BACKLOG-3520 — the pure commission arithmetic and parsing.
 * RUNNER: npx jest src/components/transactionDates/__tests__/commission.test.ts
 */
import {
  buildCommissionUpdate,
  computeGross,
  formatCommissionAmount,
  formatRateInput,
  formatSaleInput,
  parseCommission,
  parseMoney,
  parseRate,
  roundHalfUp,
} from "../commission";

describe("computeGross — whole dollars, half up: Math.round(sale x rate%)", () => {
  it.each([
    [412500, 2.5, 10313], // the mock's worked example: 10312.5 -> 10313, NOT 10312.50
    [412500, 3, 12375],
    [100000, 10, 10000], // the founder's worked example
    [412500, 2.375, 9797], // 9796.875
    [333.33, 1.005, 3], // 3.3499665
    [200, 0.25, 1], // exactly 0.5 -> 1
    [10000, 1.005, 101], // exactly 100.5; float sale*rate/100 gives 100.49999999999999
    [11000, 0.35, 39], // exactly 38.5; float gives 38
    [199, 0.25, 0], // 0.4975
    [1000001, 0.5, 5000], // 5000.005
    [999999.99, 100, 1000000], // 999999.99
    [412500, 0, 0],
    [0, 3, 0],
  ])("sale %p at %p%% -> %p", (sale, rate, expected) => {
    expect(computeGross(sale, rate)).toBe(expected);
  });

  it("is null when either input is missing (never 0)", () => {
    expect(computeGross(null, 3)).toBeNull();
    expect(computeGross(412500, null)).toBeNull();
  });

  it("is always a whole number of dollars", () => {
    for (const sale of [0.01, 1, 99.99, 250000.5, 412500, 987654.32]) {
      for (let milli = 0; milli <= 100000; milli += 137) {
        expect(Number.isInteger(computeGross(sale, milli / 1000))).toBe(true);
      }
    }
  });

  it("BOUNDARY SWEEP: at sale 200 every exact .5 rounds UP, one milli-percent below rounds down, one above rounds up", () => {
    // 200 x rate% = rate x 2 dollars, so rate = 0.25 x (2k+1) lands exactly on k + 0.5.
    for (let k = 0; k < 200; k++) {
      const half = 0.25 * (2 * k + 1);
      expect(computeGross(200, half)).toBe(k + 1);
      expect(computeGross(200, Math.round((half - 0.001) * 1000) / 1000)).toBe(k);
      expect(computeGross(200, Math.round((half + 0.001) * 1000) / 1000)).toBe(k + 1);
    }
  });
});

describe("formatCommissionAmount", () => {
  it("shows whole dollars, matching what is stored", () => {
    expect(formatCommissionAmount(10313)).toBe("$10,313");
    expect(formatCommissionAmount(12375)).toBe("$12,375");
    expect(formatCommissionAmount(0)).toBe("$0");
  });
  it("is an em dash with no amount", () => {
    expect(formatCommissionAmount(null)).toBe("—");
  });
});

describe("parseRate", () => {
  it.each([
    ["", { ok: true, value: null }],
    ["  ", { ok: true, value: null }],
    ["0", { ok: true, value: 0 }],
    ["100", { ok: true, value: 100 }],
    ["2.5", { ok: true, value: 2.5 }],
    ["2.3754", { ok: true, value: 2.375 }],
    [".5", { ok: true, value: 0.5 }],
    ["100.001", { ok: false }],
    ["-1", { ok: false }],
    ["abc", { ok: false }],
    ["1e2", { ok: false }],
    ["1.2.3", { ok: false }],
    [".", { ok: false }],
  ])("%p", (text, expected) => {
    expect(parseRate(text)).toEqual(expected);
  });
});

describe("parseMoney", () => {
  it.each([
    ["", { ok: true, value: null }],
    ["$412,500", { ok: true, value: 412500 }],
    [" 412 500.50 ", { ok: true, value: 412500.5 }],
    ["-5", { ok: false }],
    ["12abc", { ok: false }],
  ])("%p", (text, expected) => {
    expect(parseMoney(text)).toEqual(expected);
  });
});

describe("roundHalfUp / prefill formatting", () => {
  it("does not drift on binary-float half cents", () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(10312.505, 2)).toBe(10312.51);
    expect(roundHalfUp(2.3754, 3)).toBe(2.375);
  });
  it("prefills without trailing zeros and with grouping", () => {
    expect(formatRateInput(2.5)).toBe("2.5");
    expect(formatRateInput(null)).toBe("");
    expect(formatSaleInput(412500)).toBe("412,500");
    expect(formatSaleInput(412500.5)).toBe("412,500.5");
    expect(formatSaleInput(undefined)).toBe("");
  });
});

describe("parseCommission / buildCommissionUpdate", () => {
  const inputs = (o: Partial<Record<"saleText" | "offeredText" | "actualText" | "reasonText", string>>) => ({
    saleText: "412,500",
    offeredText: "",
    actualText: "",
    reasonText: "",
    ...o,
  });
  const value = (o: Parameters<typeof inputs>[0]) => {
    const r = parseCommission(inputs(o));
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it("names the first invalid field", () => {
    expect(parseCommission(inputs({ saleText: "x" }))).toEqual({ ok: false, error: "Sale Price must be a valid amount" });
    expect(parseCommission(inputs({ offeredText: "101" })).ok).toBe(false);
    expect(parseCommission(inputs({ actualText: "-1" })).ok).toBe(false);
  });

  it("a reason survives only while the rates differ", () => {
    expect(value({ offeredText: "3", actualText: "2", reasonText: " why " }).reason).toBe("why");
    expect(value({ offeredText: "3", actualText: "3", reasonText: "why" }).reason).toBeNull();
    expect(value({ offeredText: "3", actualText: "2", reasonText: "  " }).reason).toBeNull();
  });

  it("rateDiffers compares the ROUNDED rates (2.3754 vs 2.375 is not a difference)", () => {
    expect(value({ offeredText: "2.375", actualText: "2.3754" }).rateDiffers).toBe(false);
    expect(value({ offeredText: "2.375", actualText: "2.376" }).rateDiffers).toBe(true);
  });

  it("the update always names all four figures, and the sale price only when there is one", () => {
    const withSale = buildCommissionUpdate(value({ offeredText: "3", actualText: "3" }));
    expect(withSale).toEqual({
      sale_price: 412500,
      commission_offered_rate: 3,
      commission_actual_rate: 3,
      commission_gross_amount: 12375,
      commission_adjustment_reason: null,
    });
    const noSale = buildCommissionUpdate(value({ saleText: "", offeredText: "3", actualText: "3" }));
    expect("sale_price" in noSale).toBe(false);
    expect(noSale.commission_gross_amount).toBeNull(); // no sale price -> no amount
  });
});
