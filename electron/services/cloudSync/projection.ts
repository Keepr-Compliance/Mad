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
import { isPrivateChecklist } from "../db/checklistPrivacy";
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

// ================================================================ children (PR-3)
//
// Frozen hashed field lists (scratchpad/4236/prebuild.md §(b)), plus the party
// `details_withheld` flag (cloud-deal-shape-v1.json party.details_withheld,
// in_content_hash: true). Each projection reads only the columns named in its
// *_SOURCE_COLUMNS lists; the dirty-mark triggers watch exactly those.

/** transaction_contacts columns the party projection reads. */
export const PARTY_ROW_COLUMNS = [
  "id",
  "transaction_id",
  "contact_id",
  "role",
  "role_category",
  "specific_role",
  "is_primary",
  "notes",
  "removed_at",
] as const;
/** contacts columns the party projection reads. */
export const PARTY_CONTACT_COLUMNS = ["display_name", "company", "source", "removed_at", "removed_reason"] as const;
export const PARTY_EMAIL_COLUMNS = ["contact_id", "email", "is_primary", "label"] as const;
export const PARTY_PHONE_COLUMNS = ["contact_id", "phone_e164", "phone_display", "is_primary", "label"] as const;
export const PARTY_SOURCE_LINK_COLUMNS = ["contact_id", "source_type"] as const;

export const PARTY_HASHED_FIELDS = [
  "local_contact_id",
  "role",
  "role_category",
  "specific_role",
  "is_primary",
  "notes",
  "display_name",
  "company",
  "emails",
  "phones",
  "contact_source",
  "contact_deleted",
  "removed_reason",
  "details_withheld",
] as const;

/** transaction_checklists columns the checklist projection reads. */
export const CHECKLIST_SOURCE_COLUMNS = ["id", "transaction_id", "template_id", "template_name", "sort_order", "selected_at"] as const;
export const CHECKLIST_HASHED_FIELDS = ["template_id", "template_name", "sort_order", "selected_at", "is_private"] as const;

/** transaction_checklist_items columns the item projection reads. */
export const ITEM_SOURCE_COLUMNS = [
  "id",
  "checklist_id",
  "title",
  "description",
  "is_required",
  "expected_document_type",
  "is_checked",
  "checked_at",
  "note",
  "sort_order",
  "created_at",
] as const;
export const ITEM_HASHED_FIELDS = [
  "local_checklist_id",
  "title",
  "description",
  "is_required",
  "expected_document_type",
  "is_checked",
  "checked_at",
  "note",
  "sort_order",
  "local_created_at",
  "links",
] as const;

export const GOOGLE_CONTACTS_SOURCE = "google_contacts";

function cleanBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n !== 0 : null;
}

function cleanInt(value: unknown): number | null {
  const n = cleanNumber(value);
  return n === null ? null : Math.trunc(n);
}

export interface PartySource {
  row: Record<string, unknown>;
  /** The contacts row, or null when the contact no longer exists. */
  contact: Record<string, unknown> | null;
  emails: Array<Record<string, unknown>>;
  phones: Array<Record<string, unknown>>;
  /** source_type values of the contact's contact_source_links rows. */
  sourceTypes: string[];
}

/** The Google predicate (P3-4): contact source google_contacts OR any google_contacts link. */
export function isWithheld(source: PartySource): boolean {
  return (
    source.contact?.source === GOOGLE_CONTACTS_SOURCE ||
    source.sourceTypes.includes(GOOGLE_CONTACTS_SOURCE)
  );
}

function byPrimaryThen<T>(rows: T[], key: (r: T) => string, id: (r: T) => string, primary: (r: T) => boolean): T[] {
  return [...rows].sort((a, b) => {
    const p = Number(primary(b)) - Number(primary(a));
    if (p !== 0) return p;
    const k = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    if (k !== 0) return k;
    return id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0;
  });
}

/** §3.2 order: is_primary DESC, lower(email) ASC, id ASC. */
export function partyEmails(rows: Array<Record<string, unknown>>): JsonValue[] {
  return byPrimaryThen(
    rows,
    (r) => String(r.email ?? "").toLowerCase(),
    (r) => String(r.id ?? ""),
    (r) => cleanBool(r.is_primary) === true,
  ).map((r) => ({ email: cleanText(r.email) ?? "", is_primary: cleanBool(r.is_primary) === true, label: cleanText(r.label) }));
}

/** §3.2 order: is_primary DESC, phone_e164 ASC, id ASC. */
export function partyPhones(rows: Array<Record<string, unknown>>): JsonValue[] {
  return byPrimaryThen(
    rows,
    (r) => String(r.phone_e164 ?? ""),
    (r) => String(r.id ?? ""),
    (r) => cleanBool(r.is_primary) === true,
  ).map((r) => ({
    e164: cleanText(r.phone_e164) ?? "",
    display: cleanText(r.phone_display),
    is_primary: cleanBool(r.is_primary) === true,
    label: cleanText(r.label),
  }));
}

/**
 * The hashed party DTO. When withheld, name, company, emails and phones are
 * blanked BEFORE hashing, so the hash covers exactly what is sent (P3-2).
 */
export function buildPartyDto(source: PartySource): { [key: string]: JsonValue } {
  const c = source.contact;
  const withheld = isWithheld(source);
  const contactDeleted = c === null || (c.removed_at !== null && c.removed_at !== undefined);
  return {
    local_contact_id: cleanText(source.row.contact_id),
    role: cleanText(source.row.role),
    role_category: cleanText(source.row.role_category),
    specific_role: cleanText(source.row.specific_role),
    is_primary: cleanBool(source.row.is_primary),
    notes: cleanText(source.row.notes),
    display_name: withheld ? null : cleanText(c?.display_name),
    company: withheld ? null : cleanText(c?.company),
    emails: withheld ? [] : partyEmails(source.emails),
    phones: withheld ? [] : partyPhones(source.phones),
    contact_source: cleanText(c?.source),
    contact_deleted: contactDeleted,
    removed_reason: contactDeleted ? cleanText(c?.removed_reason) : null,
    details_withheld: withheld,
  };
}

export function buildChecklistDto(row: Record<string, unknown>): { [key: string]: JsonValue } {
  return {
    template_id: cleanText(row.template_id),
    template_name: cleanText(row.template_name),
    sort_order: cleanInt(row.sort_order),
    selected_at: instant(row.selected_at),
    is_private: isPrivateChecklist(typeof row.template_id === "string" ? row.template_id : null),
  };
}

/** `links` is null in Checkpoint 1 (plan §2.3). */
export function buildItemDto(row: Record<string, unknown>): { [key: string]: JsonValue } {
  return {
    local_checklist_id: cleanText(row.checklist_id),
    title: cleanText(row.title),
    description: cleanText(row.description),
    is_required: cleanBool(row.is_required),
    expected_document_type: cleanText(row.expected_document_type),
    is_checked: cleanBool(row.is_checked),
    checked_at: instant(row.checked_at),
    note: cleanText(row.note),
    sort_order: cleanInt(row.sort_order),
    local_created_at: instant(row.created_at),
    links: null,
  };
}

export type ChildKind = "party" | "checklist" | "checklist_item";

export interface ProjectedChild {
  kind: ChildKind;
  localId: string;
  hash: string;
  /** The row sent: the hashed DTO plus local_id and content_hash (not hashed). */
  payload: { [key: string]: JsonValue };
}

export function projectChild(kind: ChildKind, localId: string, dto: { [key: string]: JsonValue }): ProjectedChild {
  const hash = contentHash(dto);
  return { kind, localId, hash, payload: { ...dto, local_id: localId, content_hash: hash } };
}
