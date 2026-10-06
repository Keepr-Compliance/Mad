/**
 * The ONE months→days rule (founder, 2026-10-02): round(months × 30.4375).
 * Mutations that turn this red: setMonth back (1.5 truncates to 1 month), a
 * different factor (30), no rounding.
 */
import { LOOKBACK_DAYS_PER_MONTH, lookbackDays, lookbackStartMs } from "../lookbackWindow";
import { computeEffectiveImportWindow, computeImportCutoffNano, DEFAULT_LOOKBACK_MONTHS } from "../../services/macOSMessagesImportService/importHelpers";

const DAY = 24 * 60 * 60 * 1000;

describe("lookbackWindow", () => {
  it.each([[1, 30], [1.5, 46], [2, 61], [3, 91], [4, 122], [5, 152], [6, 183], [12, 365], [18, 548], [24, 731]])(
    "%s months = %s days", (months, days) => {
      expect(lookbackDays(months)).toBe(days);
      expect(lookbackStartMs(months, 1_000 * DAY)).toBe((1_000 - days) * DAY);
    });

  it("one factor; the shared default is 1.5 months", () => {
    expect(LOOKBACK_DAYS_PER_MONTH).toBe(30.4375);
    expect(DEFAULT_LOOKBACK_MONTHS).toBe(1.5);
  });

  it("the import cutoff and the effective window use it (1.5 months is 46 days, not 1 month)", () => {
    const now = new Date("2026-10-02T12:00:00.000Z");
    const MAC_EPOCH = Date.UTC(2001, 0, 1);
    const nano = computeImportCutoffNano({ lookbackMonths: 1.5 }, now) as number;
    expect(MAC_EPOCH + nano / 1e6).toBe(now.getTime() - 46 * DAY);
    const w = computeEffectiveImportWindow({ lookbackMonths: 1.5, auditStartISO: null }, now);
    expect(Date.parse(w.effectiveCutoffISO as string)).toBe(now.getTime() - 46 * DAY);
  });
});
