/**
 * Commission figures on a submission (BACKLOG-3521, read-only display).
 *
 * The four columns come from supabase/migrations/20260925070000_backlog_3519_commission_figures.sql:
 *   commission_offered_rate      numeric(6,3)  a PERCENTAGE (2.5, not 0.025)
 *   commission_actual_rate       numeric(6,3)
 *   commission_gross_amount      numeric(12,2) stored already rounded to whole dollars
 *   commission_adjustment_reason text
 * PostgREST sends numeric as a JSON number; a string is accepted too so a
 * text-typed read ("3.000") formats the same way.
 */

export interface CommissionColumns {
  commission_offered_rate?: number | string | null;
  commission_actual_rate?: number | string | null;
  commission_gross_amount?: number | string | null;
  commission_adjustment_reason?: string | null;
}

export interface CommissionFigures {
  offeredRate: number | null;
  actualRate: number | null;
  grossAmount: number | null;
  reason: string | null;
}

/** Shown in a header cell that has no figure. */
export const NO_FIGURE = '–';

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function readCommission(row: CommissionColumns): CommissionFigures {
  const reason = typeof row.commission_adjustment_reason === 'string' ? row.commission_adjustment_reason.trim() : '';
  return {
    offeredRate: toNumber(row.commission_offered_rate),
    actualRate: toNumber(row.commission_actual_rate),
    grossAmount: toNumber(row.commission_gross_amount),
    reason: reason.length > 0 ? reason : null,
  };
}

export function hasCommissionFigures(f: CommissionFigures): boolean {
  return f.offeredRate !== null || f.actualRate !== null || f.grossAmount !== null || f.reason !== null;
}

/** 3 -> "3%", 2.5 -> "2.5%", 2.375 -> "2.375%" (trailing zeros trimmed, at most 3 decimals). */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(3)).toString()}%`;
}

/** Whole dollars, no cents: 12500 -> "$12,500". */
export function formatGross(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * offered − actual in percentage points, only when actual is LOWER than
 * offered; null otherwise. Compared in thousandths so 3.000 vs 2.500 never
 * suffers float drift.
 */
export function reductionRate(f: CommissionFigures): number | null {
  if (f.offeredRate === null || f.actualRate === null) return null;
  const diff = Math.round(f.offeredRate * 1000) - Math.round(f.actualRate * 1000);
  return diff > 0 ? diff / 1000 : null;
}

/** Header cell "Commission Offered": "3%" or "–". */
export function offeredCell(f: CommissionFigures): string {
  return f.offeredRate === null ? NO_FIGURE : formatRate(f.offeredRate);
}

/** Header cell "Final Commission": "2.5% · $12,500", either half alone, or "–". */
export function finalCell(f: CommissionFigures): string {
  const parts: string[] = [];
  if (f.actualRate !== null) parts.push(formatRate(f.actualRate));
  if (f.grossAmount !== null) parts.push(formatGross(f.grossAmount));
  return parts.length > 0 ? parts.join(' · ') : NO_FIGURE;
}
