/**
 * Keepr Cloud deal projection — BACKLOG-4243 PR-2.
 *
 * One local `transactions` row → the deal DTO the server stores
 * (`cloud_upsert_deal`, migration 20261112190000) and its content hash.
 * Shape: supabase/contracts/cloud-deal-shape-v1.json and the frozen deal field
 * list (plan §3, §4). `DEAL_SOURCE_COLUMNS` is the single list of columns the
 * projection reads; the dirty-mark trigger watches exactly these (plus
 * user_id), so the two cannot drift.
 */
import { parseDbTimestamp } from "../../utils/dbTimestamp";
import { dealLockReason } from "../transactionEligibility";
import { contentHash, type JsonValue } from "./jcs";

/** Bumped when a normalisation rule changes (stored per state row). */
export const HASH_VERSION = 1;

/** Every `transactions` column the projection reads. */
export const DEAL_SOURCE_COLUMNS = [
  "id",
  "property_address",
  "property_street",
  "property_city",
  "property_state",
  "property_zip",
  "transaction_type",
  "status",
  "started_at",
  "closed_at",
  "detection_status",
  "detection_source",
  "detection_confidence",
  "detection_method",
  "reviewed_at",
  "created_at",
  "submission_status",
  "listing_price",
  "sale_price",
  "earnest_money_amount",
  "commission_offered_rate",
  "commission_actual_rate",
  "commission_gross_amount",
  "mutual_acceptance_date",
  "inspection_deadline",
  "financing_deadline",
  "closing_deadline",
  "representation_start_date",
  "stage",
  "export_status",
] as const;

export type DealSourceColumn = (typeof DEAL_SOURCE_COLUMNS)[number];
export type DealRow = { [K in DealSourceColumn]?: unknown } & { id: string; updated_at?: unknown };

/** The frozen hashed field list for a deal (prebuild.md §(b)). */
export const DEAL_HASHED_FIELDS = [
  "organization_id",
  "property_address",
  "property_street",
  "property_city",
  "property_state",
  "property_zip",
  "transaction_type",
  "status",
  "started_at",
  "closed_at",
  "detection_status",
  "detection_source",
  "detection_confidence",
  "detection_method",
  "reviewed_at",
  "local_created_at",
  "lock_reason",
  "texts_outside_window_count",
  "details",
] as const;

/** `details` v1 keys (contract `deal.details.keys`). */
export const DETAILS_NUMBER_KEYS = [
  "listing_price",
  "sale_price",
  "earnest_money_amount",
  "commission_offered_rate",
  "commission_actual_rate",
  "commission_gross_amount",
] as const;
export const DETAILS_DATE_KEYS = [
  "mutual_acceptance_date",
  "inspection_deadline",
  "financing_deadline",
  "closing_deadline",
  "representation_start_date",
] as const;
export const DETAILS_STRING_KEYS = ["stage", "submission_status", "export_status"] as const;

// ---------------------------------------------------------------- normalisers

/** Removes U+0000 and lone surrogate code units (plan §3.4). */
export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value : String(value);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += s[i];
  }
  return out;
}

/** REAL / INTEGER / numeric text → finite number, else null. */
export function cleanNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

/** Calendar date: first 10 characters when they are YYYY-MM-DD, else null. */
export function calendarDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = DATE_PREFIX.exec(value.trim());
  return m ? m[1] : null;
}

/** Top-level calendar date (started_at, closed_at): YYYY-MM-DDT00:00:00.000Z. */
export function calendarDateInstant(value: unknown): string | null {
  const d = calendarDate(value);
  return d ? `${d}T00:00:00.000Z` : null;
}

/** Instant: zone-less SQLite text is UTC; date-only is midnight UTC; else null. */
export function instant(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const d = parseDbTimestamp(value as string | Date);
  return d ? d.toISOString() : null;
}

// ---------------------------------------------------------------- the DTO

export interface DealDto {
  [field: string]: JsonValue;
}

export function buildDealDetails(row: DealRow): { [key: string]: JsonValue } {
  const details: { [key: string]: JsonValue } = { v: 1 };
  for (const k of DETAILS_NUMBER_KEYS) details[k] = cleanNumber(row[k]);
  for (const k of DETAILS_DATE_KEYS) details[k] = calendarDate(row[k]);
  for (const k of DETAILS_STRING_KEYS) details[k] = cleanText(row[k]);
  return details;
}

/** The hashed deal DTO: exactly DEAL_HASHED_FIELDS, every key present. */
export function buildDealDto(row: DealRow): DealDto {
  const lockReason = dealLockReason(typeof row.submission_status === "string" ? row.submission_status : null);
  return {
    organization_id: null,
    property_address: cleanText(row.property_address),
    property_street: cleanText(row.property_street),
    property_city: cleanText(row.property_city),
    property_state: cleanText(row.property_state),
    property_zip: cleanText(row.property_zip),
    transaction_type: cleanText(row.transaction_type),
    status: cleanText(row.status),
    started_at: calendarDateInstant(row.started_at),
    closed_at: calendarDateInstant(row.closed_at),
    detection_status: cleanText(row.detection_status),
    detection_source: cleanText(row.detection_source),
    detection_confidence: cleanNumber(row.detection_confidence),
    detection_method: cleanText(row.detection_method),
    reviewed_at: instant(row.reviewed_at),
    local_created_at: instant(row.created_at),
    lock_reason: lockReason,
    texts_outside_window_count: null,
    details: buildDealDetails(row),
  };
}

export interface ProjectedDeal {
  localId: string;
  dto: DealDto;
  hash: string;
  /** The `p_deal` argument: the DTO plus identity and provenance keys (not hashed). */
  payload: { [key: string]: JsonValue };
}

export function projectDeal(row: DealRow, installId: string): ProjectedDeal {
  const dto = buildDealDto(row);
  const hash = contentHash(dto);
  return {
    localId: row.id,
    dto,
    hash,
    payload: {
      ...dto,
      local_id: row.id,
      source_install_id: installId,
      content_hash: hash,
      source_updated_at: instant(row.updated_at),
    },
  };
}
