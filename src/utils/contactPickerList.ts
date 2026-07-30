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

/**
 * Recency DESC, nulls last. On a timestamp tie, fall back to NAME (A–Z) FIRST,
 * then the stable identity key as the final determinism/import-stability
 * tiebreaker — this is exactly `compareAlphabetical`'s contract (name compare,
 * empty names last, then `compareIdentity`), so we delegate to it.
 *
 * BACKLOG-2354: previously ties went straight to `compareIdentity` (smallest
 * email). That is a correct *invisible* tiebreaker, but when the whole list
 * ties (e.g. the Clients & Contacts screen before it had recency data) it
 * became the entire *visible* order — an alphabetical-by-EMAIL list with
 * never-contacted people at the top. Falling back to name first makes a
 * no-recency list read alphabetically by NAME, never by email, while keeping
 * `stableIdentityKey` as the final tiebreaker for import stability.
 */
function compareRecent(a: ExtendedContact, b: ExtendedContact): number {
  const ta = lastCommTimestamp(a);
  const tb = lastCommTimestamp(b);
  if (ta !== tb) return tb - ta;
  return compareAlphabetical(a, b);
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

/** The total-order comparator for a given sort order. */
function comparatorFor(sortOrder: ContactSortOrder): (a: ExtendedContact, b: ExtendedContact) => number {
  return sortOrder === "alphabetical" ? compareAlphabetical : compareRecent;
}

// ---------------------------------------------------------------------------
// Pipeline stages (pure, composable)
// ---------------------------------------------------------------------------

/**
 * ASSEMBLE -> DEDUP -> FILTER -> SEARCH — every stage EXCEPT the final sort.
 * Split out (BACKLOG-2355) so the picker can (a) recompute the frozen visible
 * ORDER only when the ordering inputs (search/sort/filter) change, and (b)
 * project current data through that frozen order on every render. Depends only
 * on data + search + filters — NOT on sort order.
 */
export function assembleFilterSearch(input: BuildVisibleContactsInput): ExtendedContact[] {
  const { contacts, externalContacts = [], searchQuery = "", filters = null } = input;

  const assembled = assembleDedupedContacts(contacts, externalContacts);

  const filtered = filters
    ? assembled.filter((contact) => matchesContactFilters(contact, filters))
    : assembled;

  const query = searchQuery.trim();
  return query
    ? filtered.filter((contact) => contactMatchesSearch(contact, query))
    : filtered;
}

/**
 * SORT a pre-assembled list by `sortOrder`. Pure, total order, never mutates the
 * input (sorts a copy). This is the deterministic order used both directly
 * (`buildVisibleContacts`) and to seed the frozen `orderKeys` in the picker.
 */
export function sortContacts(
  list: ExtendedContact[],
  sortOrder: ContactSortOrder = "recent",
): ExtendedContact[] {
  return list.slice().sort(comparatorFor(sortOrder));
}

/**
 * BACKLOG-2355 — project LIVE data onto a FROZEN visible order.
 *
 * `orderKeys` is a snapshot of `stableIdentityKey`s captured when the ordering
 * inputs (search / sort / filter) last changed. Re-emitting `list` in that
 * frozen order is what stops background data refreshes and select/import — which
 * swap a row's DB UUID and can flip its recency from null to a real date — from
 * reshuffling the list mid-interaction:
 *
 *   - a key in `orderKeys` that still exists in `list` -> emitted at its FROZEN
 *     slot, carrying the CURRENT (live) contact object for that identity (so the
 *     row's data updates in place without moving);
 *   - a key in `orderKeys` absent from `list` (removed / filtered / searched
 *     out) -> dropped;
 *   - a `list` item whose identity is NOT in `orderKeys` (brand-new) -> merged in
 *     at the position the `sortOrder` comparator would place it, so genuinely
 *     new contacts still appear in a sensible spot.
 *
 * With an EMPTY `orderKeys`, every item is "new" -> the result is a full sort,
 * i.e. `projectOntoOrder(list, [], o)` === `sortContacts(list, o)`.
 */
export function projectOntoOrder(
  list: ExtendedContact[],
  orderKeys: string[],
  sortOrder: ContactSortOrder = "recent",
): ExtendedContact[] {
  const comparator = comparatorFor(sortOrder);

  // Group live rows by stable identity, preserving list order WITHIN each group.
  // `stableIdentityKey` is NOT unique — the dedup stage deliberately keeps two
  // distinct imported rows that share an email (see assembleDedupedContacts), so
  // a plain Map<key, contact> would silently collapse them. Grouping guarantees
  // every live row survives exactly once.
  const groups = new Map<string, ExtendedContact[]>();
  for (const contact of list) {
    const key = stableIdentityKey(contact);
    const bucket = groups.get(key);
    if (bucket) bucket.push(contact);
    else groups.set(key, [contact]);
  }

  // Frozen backbone: each orderKey consumes ONE live row of that identity (in
  // list order). A key with no live row left contributes nothing — this is how
  // removed / filtered / searched-out rows drop out.
  const frozen: ExtendedContact[] = [];
  for (const key of orderKeys) {
    const bucket = groups.get(key);
    if (bucket && bucket.length > 0) frozen.push(bucket.shift() as ExtendedContact);
  }

  // Leftovers: live rows no frozen slot claimed — brand-new identities, or extra
  // same-identity rows beyond what the frozen order accounted for. Sorted, then
  // merged into the backbone at their comparator position. (Map preserves
  // insertion = list order, so the pre-sort input is deterministic.)
  const leftovers: ExtendedContact[] = [];
  for (const bucket of groups.values()) {
    for (const contact of bucket) leftovers.push(contact);
  }

  if (leftovers.length === 0) return frozen; // common anti-jump case (no new rows)
  leftovers.sort(comparator);
  if (frozen.length === 0) return leftovers; // empty frozen order -> full sort

  // Merge: each leftover is inserted before the first not-yet-emitted frozen row
  // it sorts strictly before. Frozen rows keep their relative order; `fi`
  // advances monotonically.
  const result: ExtendedContact[] = [];
  let fi = 0;
  for (const item of leftovers) {
    while (fi < frozen.length && comparator(frozen[fi], item) <= 0) {
      result.push(frozen[fi]);
      fi += 1;
    }
    result.push(item);
  }
  while (fi < frozen.length) {
    result.push(frozen[fi]);
    fi += 1;
  }
  return result;
}

/**
 * BACKLOG-2357 — ADDITIVELY merge newly-arrived identity keys into a frozen
 * `orderKeys` snapshot, WITHOUT re-sorting the existing order.
 *
 * ## Why this exists
 * The freeze (BACKLOG-2355) seeds `orderKeys` once on first data. But external
 * (address-book) contacts load a beat AFTER imported ones (getAvailable resolves
 * later), so their identities never made it into that first snapshot — leaving
 * them positioned LIVE by `projectOntoOrder`'s leftover-merge, which re-sorts
 * them every render. When such a row is selected it auto-imports (BACKLOG-2357
 * Fix A now keeps its recency stable, but as defense-in-depth) and any recency
 * change would still move a NON-frozen row = the founder's select-jump.
 *
 * This gives late-arriving identities a FROZEN slot the moment they appear:
 *   - every existing key is preserved in its EXACT current order (this is NOT a
 *     re-freeze / re-sort — the whole point of the freeze is destroyed if the
 *     established order is disturbed);
 *   - each genuinely-new key (a key in `sortedKeys` beyond what `existingKeys`
 *     already accounts for, MULTISET-aware so two distinct rows sharing an email
 *     each keep a slot) is inserted at the position `sortedKeys` implies —
 *     mirroring `projectOntoOrder`'s "insert unknown keys before the first frozen
 *     row they sort before" placement, using each key's index in `sortedKeys` as
 *     the ordering authority (keys absent from the current sort sort to the end).
 *
 * When nothing is new the SAME `existingKeys` reference is returned so a
 * `setState(prev => mergeNewOrderKeys(prev, ...))` bails out with no re-render.
 *
 * @param existingKeys the frozen order (may contain duplicate keys by design).
 * @param sortedKeys   `stableIdentityKey`s of the CURRENT list already in sort order.
 */
export function mergeNewOrderKeys(existingKeys: string[], sortedKeys: string[]): string[] {
  // Multiset of frozen slots already held per identity. A key in `sortedKeys`
  // is "already frozen" only up to how many times it appears in `existingKeys`.
  const existingRemaining = new Map<string, number>();
  for (const key of existingKeys) {
    existingRemaining.set(key, (existingRemaining.get(key) ?? 0) + 1);
  }

  // New occurrences, in sortedKeys order (the deterministic placement order).
  const newKeys: string[] = [];
  for (const key of sortedKeys) {
    const left = existingRemaining.get(key) ?? 0;
    if (left > 0) existingRemaining.set(key, left - 1); // consumed by a frozen slot
    else newKeys.push(key); // genuinely new -> needs a slot
  }

  if (newKeys.length === 0) return existingKeys; // nothing new -> same ref -> React bails

  // Sorted-position authority (first occurrence wins). A frozen key that is NOT
  // in the current sort (removed / filtered / searched-out) is `undefined` here:
  // it is PRESERVED in the output but must NOT act as a placement barrier for new
  // keys (projectOntoOrder drops it at render, so its slot is irrelevant, and
  // treating it as +Infinity would wrongly pull later-sorting new keys in front
  // of real keys). Only keys present in the current sort order a new key.
  const sortedIndex = new Map<string, number>();
  sortedKeys.forEach((key, i) => {
    if (!sortedIndex.has(key)) sortedIndex.set(key, i);
  });

  // Walk the frozen backbone in its EXACT order, flushing each new key just
  // before the first PRESENT existing key it sorts before. `newKeys` is already
  // in sorted order so the pointer advances monotonically — this is
  // projectOntoOrder's leftover-merge, lifted to key space.
  const result: string[] = [];
  let ni = 0;
  for (const existingKey of existingKeys) {
    const eIdx = sortedIndex.get(existingKey);
    if (eIdx !== undefined) {
      while (ni < newKeys.length && (sortedIndex.get(newKeys[ni]) as number) < eIdx) {
        result.push(newKeys[ni]);
        ni += 1;
      }
    }
    result.push(existingKey);
  }
  while (ni < newKeys.length) {
    result.push(newKeys[ni]);
    ni += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the fully-processed, deterministic list of contacts to render.
 * ASSEMBLE -> DEDUP -> FILTER -> SEARCH -> SORT. The rendered row count is
 * simply `result.length` — there is no separate count channel.
 *
 * Composes the pipeline stages above. The picker uses the stages directly (to
 * freeze order across refreshes, BACKLOG-2355); everything else uses this.
 */
export function buildVisibleContacts(input: BuildVisibleContactsInput): ExtendedContact[] {
  return sortContacts(assembleFilterSearch(input), input.sortOrder ?? "recent");
}
