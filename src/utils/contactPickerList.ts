/**
 * Contact Picker List — pure, deterministic assembly/dedup/filter/search/sort
 * engine for the contact search-and-select surfaces (BACKLOG-2352).
 *
 * This module is intentionally PURE: no React, no refs, no side effects, no
 * localStorage. Given the same input it returns the same output. It replaces the
 * "Stable Visible Order" ref machinery (BACKLOG-1745/1761) that wrote to refs
 * during render and corrupted under StrictMode double-invoke + async loading.
 *
 * Pipeline (in order):
 *   1. ASSEMBLE  imported DB contacts + not-yet-imported external contacts.
 *   2. DEDUP     drop externals already imported, and duplicate externals.
 *   3. FILTER    grouped Source/Role predicate (when a selection is supplied).
 *   4. SEARCH    case-insensitive substring across every identity field.
 *   5. SORT      by sortOrder, always ending in a STABLE identity tiebreaker.
 *
 * The one idea that replaces the whole SVO substitution machine: the sort's
 * tiebreaker key is derived from a STABLE identity (email/phone/name), NOT the
 * DB UUID — so importing an external contact (which swaps its id) does not move
 * the row.
 */

import type { ExtendedContact } from "../types/components";
import { matchesContactFilters, type ContactFilters } from "./contactFilterModel";

export type ContactSortOrder = "recent" | "alphabetical";

export interface BuildVisibleContactsInput {
  /** Imported/existing DB contacts (authoritative — never merged with each other). */
  contacts: ExtendedContact[];
  /** External address-book contacts not yet imported. */
  externalContacts?: ExtendedContact[];
  /** Search query. Trimmed; empty = no search filter. */
  searchQuery?: string;
  /** Sort order. Defaults to "recent". */
  sortOrder?: ContactSortOrder;
  /**
   * Grouped Source/Role selection. When provided, `matchesContactFilters` is
   * applied. When `null`/`undefined`, no filtering happens (show everything) —
   * the transaction-flow "show everyone" contract.
   */
  filters?: ContactFilters | null;
}

// ---------------------------------------------------------------------------
// Normalization helpers (pure)
// ---------------------------------------------------------------------------

/** Lowercased, trimmed email. Returns "" when empty. */
function normalizeEmail(email: string | null | undefined): string {
  return (email || "").trim().toLowerCase();
}

/**
 * Last-10-digits phone key (mirrors the backend normalizeToE164 dedup logic and
 * the pre-BACKLOG-2352 `normPhone`). Returns "" when there are no digits.
 */
function normalizePhone(phone: string | null | undefined): string {
  return (phone || "").replace(/\D/g, "").slice(-10);
}

/** Lowercased, trimmed display name (display_name -> name). Returns "" when empty. */
function normalizeName(contact: ExtendedContact): string {
  return (contact.display_name || contact.name || "").trim().toLowerCase();
}

/**
 * All non-empty, normalized email keys for a contact — primary `email` plus
 * every `allEmails` entry (BACKLOG-1270). Junk in the email field (a Zoom URL, a
 * phone number) is deliberately treated as a real identity token.
 */
export function contactEmailKeys(contact: ExtendedContact): string[] {
  const out: string[] = [];
  for (const e of [contact.email, ...(contact.allEmails || [])]) {
    const norm = normalizeEmail(e);
    if (norm) out.push(norm);
  }
  return out;
}

/** All non-empty, normalized phone keys for a contact (primary + allPhones). */
export function contactPhoneKeys(contact: ExtendedContact): string[] {
  const out: string[] = [];
  for (const p of [contact.phone, ...(contact.allPhones || [])]) {
    const norm = normalizePhone(p);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * A STABLE identity key used as the final sort tiebreaker. Derived from the
 * lexicographically smallest email, else smallest phone, else the normalized
 * name, else the id. Using the MIN (not the "primary") makes the key invariant
 * to allEmails/allPhones ordering, and using identity — not the DB UUID — keeps
 * a row in place when an external contact is imported (id changes, email stays).
 */
export function stableIdentityKey(contact: ExtendedContact): string {
  const emails = contactEmailKeys(contact);
  if (emails.length > 0) return `e:${emails.reduce((a, b) => (a < b ? a : b))}`;
  const phones = contactPhoneKeys(contact);
  if (phones.length > 0) return `p:${phones.reduce((a, b) => (a < b ? a : b))}`;
  const name = normalizeName(contact);
  if (name) return `n:${name}`;
  return `i:${contact.id}`;
}

/** Parse last_communication_at to a timestamp; invalid/missing -> 0 (sorts last). */
function lastCommTimestamp(contact: ExtendedContact): number {
  const value = contact.last_communication_at;
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring match across name, display_name, email, allEmails,
 * phone, allPhones AND company. Empty/whitespace query matches everything.
 */
export function contactMatchesSearch(contact: ExtendedContact, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const haystacks: (string | null | undefined)[] = [
    contact.display_name,
    contact.name,
    contact.email,
    contact.phone,
    contact.company,
    ...(contact.allEmails || []),
    ...(contact.allPhones || []),
  ];

  for (const value of haystacks) {
    if (value && value.toLowerCase().includes(q)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Assemble + dedup
// ---------------------------------------------------------------------------

/** Mutable accumulator of identity tokens already claimed by kept contacts. */
interface SeenIdentities {
  ids: Set<string>;
  emails: Set<string>;
  phones: Set<string>;
  /** Normalized names of kept contacts that have NO email and NO phone. */
  nameOnly: Set<string>;
}

function newSeen(): SeenIdentities {
  return { ids: new Set(), emails: new Set(), phones: new Set(), nameOnly: new Set() };
}

/** Record a kept contact's identity tokens so later contacts can dedup against it. */
function claim(seen: SeenIdentities, contact: ExtendedContact): void {
  seen.ids.add(contact.id);
  const emails = contactEmailKeys(contact);
  const phones = contactPhoneKeys(contact);
  emails.forEach((e) => seen.emails.add(e));
  phones.forEach((p) => seen.phones.add(p));
  // Name is a last-resort identity ONLY for contacts with no stronger token,
  // so we never over-merge two distinct people who happen to share a name.
  if (emails.length === 0 && phones.length === 0) {
    const name = normalizeName(contact);
    if (name) seen.nameOnly.add(name);
  }
}

/** True when `contact` shares identity with an already-kept contact. */
function matchesSeen(seen: SeenIdentities, contact: ExtendedContact): boolean {
  const emails = contactEmailKeys(contact);
  if (emails.some((e) => seen.emails.has(e))) return true;
  const phones = contactPhoneKeys(contact);
  if (phones.some((p) => seen.phones.has(p))) return true;
  if (emails.length === 0 && phones.length === 0) {
    const name = normalizeName(contact);
    if (name && seen.nameOnly.has(name)) return true;
  }
  return false;
}

/**
 * ASSEMBLE + DEDUP (no filter, no search, no sort).
 *
 * - Imported DB contacts are authoritative: every distinct row is kept (only an
 *   exact repeated id is dropped). We never merge two DB rows even if they share
 *   an email — silently hiding a real contact is a worse failure than a rare
 *   duplicate, and merging is a separate Contacts-screen concern.
 * - External contacts are dropped when they match ANY kept contact (imported or
 *   an earlier external) by email -> phone -> name-only. This subsumes the old
 *   `isContactImported` (all emails + last-10-digit phone) and additionally
 *   collapses duplicate externals, including name-only / junk-in-email entries.
 *
 * Returned objects are the SAME references passed in (allEmails/allPhones and
 * every other field preserved), just filtered — never cloned.
 */
export function assembleDedupedContacts(
  contacts: ExtendedContact[],
  externalContacts: ExtendedContact[] = [],
): ExtendedContact[] {
  const seen = newSeen();
  const result: ExtendedContact[] = [];

  // Pass 1: imported (authoritative). Keep all distinct-id rows.
  for (const contact of contacts) {
    if (seen.ids.has(contact.id)) continue;
    claim(seen, contact);
    result.push(contact);
  }

  // Pass 2: external. Drop if already imported or a duplicate external.
  for (const contact of externalContacts) {
    if (seen.ids.has(contact.id)) continue;
    if (matchesSeen(seen, contact)) continue;
    claim(seen, contact);
    result.push(contact);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sort comparators (total orders — always fully deterministic)
// ---------------------------------------------------------------------------

/** Final identity tiebreaker: stable identity key, then id. Total order. */
function compareIdentity(a: ExtendedContact, b: ExtendedContact): number {
  const ka = stableIdentityKey(a);
  const kb = stableIdentityKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Recency DESC, nulls last, then stable identity tiebreaker. */
function compareRecent(a: ExtendedContact, b: ExtendedContact): number {
  const ta = lastCommTimestamp(a);
  const tb = lastCommTimestamp(b);
  if (ta !== tb) return tb - ta;
  return compareIdentity(a, b);
}

/** Name A–Z (empty names last), then stable identity tiebreaker. */
function compareAlphabetical(a: ExtendedContact, b: ExtendedContact): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na !== nb) {
    if (!na) return 1;
    if (!nb) return -1;
    const byName = na.localeCompare(nb);
    if (byName !== 0) return byName;
  }
  return compareIdentity(a, b);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the fully-processed, deterministic list of contacts to render.
 * ASSEMBLE -> DEDUP -> FILTER -> SEARCH -> SORT. The rendered row count is
 * simply `result.length` — there is no separate count channel.
 */
export function buildVisibleContacts(input: BuildVisibleContactsInput): ExtendedContact[] {
  const {
    contacts,
    externalContacts = [],
    searchQuery = "",
    sortOrder = "recent",
    filters = null,
  } = input;

  const assembled = assembleDedupedContacts(contacts, externalContacts);

  const filtered = filters
    ? assembled.filter((contact) => matchesContactFilters(contact, filters))
    : assembled;

  const query = searchQuery.trim();
  const searched = query
    ? filtered.filter((contact) => contactMatchesSearch(contact, query))
    : filtered;

  const comparator = sortOrder === "alphabetical" ? compareAlphabetical : compareRecent;
  return searched.slice().sort(comparator);
}
