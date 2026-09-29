/**
 * BACKLOG-3520 — the commission figures the "Verify Transaction Details" step
 * captures, as pure functions: parsing what was typed, computing the gross
 * amount, and building the update the shared writer sends.
 *
 * Units. Rates are PERCENTAGES as an agent types them (2.5 means 2.5%, never
 * 0.025), 0..100, at most 3 decimals — the cloud column is numeric(6,3) and the
 * IPC validator rounds to the same. Money is dollars, stored to cents.
 *
 * Money rounds BEFORE it is formatted or stored. `formatCurrency`
 * (src/utils/formatUtils.ts) uses minimumFractionDigits 0, so an unrounded
 * 10312.5 renders as "$10,312.5"; `formatCommissionAmount` here always shows
 * cents. The gross is computed in integer cents and thousandths of a percent:
 * `412500 * 2.5 / 100` and similar are exact only by luck in floating point.
 */

/** Every value the form holds, exactly as typed. */
export interface CommissionInputs {
  /** Sale price field text. Prefilled from the transaction. */
  saleText: string;
  /** Commission Offered field text (percent). */
  offeredText: string;
  /** Commission Actual field text (percent). */
  actualText: string;
  /** Optional one-line reason. Only kept while actual differs from offered. */
  reasonText: string;
}

export type ParsedNumber =
  | { ok: true; value: number | null }
  | { ok: false };

const RATE_DECIMALS = 3;

/** Round half up to `places` decimals via the decimal string, not binary float. */
export function roundHalfUp(value: number, places: number): number {
  const shifted = Number(`${value}e${places}`);
  if (!Number.isFinite(shifted)) return Math.round(value * 10 ** places) / 10 ** places;
  return Number(`${Math.round(shifted)}e-${places}`);
}

/** A percentage 0..100; blank is "not entered" (`value: null`), anything else unparseable is `ok: false`. */
export function parseRate(text: string): ParsedNumber {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return { ok: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false };
  return { ok: true, value: roundHalfUp(n, RATE_DECIMALS) };
}

/** Dollars typed with optional `$`, commas and spaces; blank is "not entered". */
export function parseMoney(text: string): ParsedNumber {
  const cleaned = text.replace(/[\s$,]/g, "");
  if (cleaned === "") return { ok: true, value: null };
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === ".") return { ok: false };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: n };
}

/**
 * Gross commission in dollars, rounded to cents once (half up), or `null` when
 * either input is missing. Integer arithmetic: sale in cents times the rate in
 * thousandths of a percent, then a single divide-and-round.
 */
export function computeGross(sale: number | null, actualRate: number | null): number | null {
  if (sale === null || actualRate === null) return null;
  const saleCents = Math.round(sale * 100);
  const rateMilli = Math.round(actualRate * 1000);
  // cents = saleCents * (rateMilli / 1000) / 100
  const cents = Math.floor((saleCents * rateMilli + 50_000) / 100_000);
  return cents / 100;
}

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$10,312.50", or an em dash when there is no amount yet. */
export function formatCommissionAmount(gross: number | null): string {
  return gross === null ? "—" : MONEY.format(gross);
}

/** The sale price as prefilled into its field: grouped digits, cents only when present. */
export function formatSaleInput(price: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return "";
  return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Rates as prefilled into their fields: no trailing zeros ("2.5", not "2.500"). */
export function formatRateInput(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "";
  return String(rate);
}

export interface ParsedCommission {
  sale: number | null;
  offered: number | null;
  actual: number | null;
  gross: number | null;
  /** Actual differs from offered — the only time a reason is asked for. */
  rateDiffers: boolean;
  /** The reason to store: trimmed, `null` when blank or when the rates match. */
  reason: string | null;
}

/** What the form means, or the first thing wrong with it. */
export function parseCommission(
  inputs: CommissionInputs,
): { ok: true; value: ParsedCommission } | { ok: false; error: string } {
  const sale = parseMoney(inputs.saleText);
  if (!sale.ok) return { ok: false, error: "Sale Price must be a valid amount" };
  const offered = parseRate(inputs.offeredText);
  if (!offered.ok) return { ok: false, error: "Commission Offered must be a percentage between 0 and 100" };
  const actual = parseRate(inputs.actualText);
  if (!actual.ok) return { ok: false, error: "Commission Actual must be a percentage between 0 and 100" };
  const rateDiffers =
    offered.value !== null && actual.value !== null && actual.value !== offered.value;
  const trimmed = inputs.reasonText.trim();
  return {
    ok: true,
    value: {
      sale: sale.value,
      offered: offered.value,
      actual: actual.value,
      gross: computeGross(sale.value, actual.value),
      rateDiffers,
      reason: rateDiffers && trimmed !== "" ? trimmed : null,
    },
  };
}

/** An empty commission warns; it never blocks. Complete = both rates entered. */
export function isCommissionComplete(value: ParsedCommission): boolean {
  return value.offered !== null && value.actual !== null;
}

/**
 * The keys the shared writer adds to the confirmed-dates update. Every figure
 * is always named (`null` clears), so blanking a field reaches the row; the
 * sale price is named only when one was entered, so an empty field never
 * erases the transaction's price.
 */
export interface CommissionUpdate {
  sale_price?: number;
  commission_offered_rate: number | null;
  commission_actual_rate: number | null;
  commission_gross_amount: number | null;
  commission_adjustment_reason: string | null;
}

export function buildCommissionUpdate(value: ParsedCommission): CommissionUpdate {
  const update: CommissionUpdate = {
    commission_offered_rate: value.offered,
    commission_actual_rate: value.actual,
    commission_gross_amount: value.gross,
    commission_adjustment_reason: value.reason,
  };
  if (value.sale !== null) update.sale_price = value.sale;
  return update;
}
