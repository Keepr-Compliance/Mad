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
 *   2. FILTER    grouped Source/Role predicate (when a selection is supplied).
 *   3. SEARCH    case-insensitive substring across every identity field.
 *   4. SORT      by sortOrder, always ending in a STABLE identity tiebreaker.
 *
 * The one idea that replaces the whole SVO substitution machine: the sort's
 * tiebreaker key is derived from a STABLE identity (email/phone/name), NOT the
 * DB UUID — so importing an external contact (which swaps its id) does not move
 * the row.
 *
 * ===========================================================================
 * THERE IS NO DEDUP STAGE HERE ANY MORE — BACKLOG-2370
 * ===========================================================================
 * There used to be, and it was the SECOND piece of code answering "are these
 * the same person?". See {@link assembleContacts} for what it did, what it cost
 * the founder, and why removing it is the whole of this module's part in
 * "one matching rule, not two".
 */

import type { ExtendedContact } from "../types/components";
import { matchesContactFilters, type ContactFilters } from "./contactFilterModel";
import {
  labelForContact,
  realContactName,
  NO_NAME_PLACEHOLDER,
} from "./contactDisplayLabel";
import { looksLikePhoneQuery, normalizePhoneForSearch } from "./phoneNormalization";

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
 *
 * These keys no longer decide whether two records are one person (BACKLOG-2370
 * removed that from this layer). They remain the input to
 * {@link stableIdentityKey}, i.e. to the SORT — where a wrong answer moves a row
 * and a user can see it, rather than removing a row and nobody can.
 */
export function contactEmailKeys(contact: ExtendedContact): string[] {
  const out: string[] = [];
  for (const e of [contact.email, ...(contact.allEmails || [])]) {
    const key = normalizeEmail(e);
    if (key) out.push(key);
  }
  return out;
}

/** All non-empty, normalized phone keys for a contact (primary + allPhones). */
export function contactPhoneKeys(contact: ExtendedContact): string[] {
  const out: string[] = [];
  for (const p of [contact.phone, ...(contact.allPhones || [])]) {
    const key = normalizePhone(p);
    if (key) out.push(key);
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
 *
 * ## BACKLOG-2466 — phone fields are matched on DIGITS, not on characters
 *
 * This was a plain substring match over every field. Stored "+14155550177",
 * typed "+1 (415) 555-0177": the parentheses, spaces and dash are not in the
 * stored value, so it could not match. Unformatted digits worked and the
 * formatted form did not — for EVERY contact, not just nameless ones. It went
 * unnoticed only because people search by name.
 *
 * BACKLOG-2461 made it acute rather than causing it: the formatted number is now
 * a nameless contact's on-screen LABEL, so the list was displaying a string it
 * could not find.
 *
 * The TEXT fields are untouched — digits inside a name must still match
 * literally, so a company called "415 Realty" is still found by "415". Only the
 * phone fields gain the normalised comparison, and only for a query that looks
 * like a phone number.
 */
export function contactMatchesSearch(contact: ExtendedContact, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const textHaystacks: (string | null | undefined)[] = [
    contact.display_name,
    contact.name,
    contact.email,
    contact.company,
    ...(contact.allEmails || []),
  ];
  for (const value of textHaystacks) {
    if (value && value.toLowerCase().includes(q)) return true;
  }

  const phoneHaystacks: (string | null | undefined)[] = [
    contact.phone,
    ...(contact.allPhones || []),
  ];

  // Plain substring over the phone fields FIRST — the pre-BACKLOG-2466
  // behaviour, kept verbatim so this matcher is a strict SUPERSET of its old
  // self: no query that finds a contact today can stop finding one. It is also
  // what still matches an Apple ID or other non-numeric handle parked in a phone
  // column, which `normalizePhoneForSearch` deliberately drops.
  for (const value of phoneHaystacks) {
    if (value && value.toLowerCase().includes(q)) return true;
  }

  if (!looksLikePhoneQuery(q)) return false;
  const needle = normalizePhoneForSearch(q); // >= 3 digits, guaranteed by the gate

  for (const value of phoneHaystacks) {
    const haystack = normalizePhoneForSearch(value);
    if (!haystack) continue;
    if (haystack.includes(needle)) return true;
    // Country-code fallback: the query carries a country code the stored value
    // does not. `formatPhoneNumber` prints an 11-digit "1…" number as
    // "+1 (415) 555-0177" but the SAME number stored as a bare 10-digit
    // "4155550177" as "(415) 555-0177" — the UI teaches both forms and
    // Contacts.app supplies both storage shapes, so either display form must
    // find either shape. Last-10 is this module's own convention
    // (`normalizePhone` above) and the main process's (`toLookupKey`).
    if (needle.length > 10 && haystack.includes(needle.slice(-10))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

/**
 * ASSEMBLE the rows to render: saved contacts, then the address-book records the
 * main process handed over. No filter, no search, no sort — and, since
 * BACKLOG-2370, **no identity matching**.
 *
 * ===========================================================================
 * WHAT WAS REMOVED HERE, AND WHY
 * ===========================================================================
 * This function used to be `assembleDedupedContacts`. It compared every external
 * record against every saved contact on email, then on a shared phone with a
 * compatible name, then on name alone, and DROPPED the ones it decided were the
 * same person. That made it the second of two pieces of code answering "are
 * these the same person?", and the two did not agree:
 *
 * | | Rule | Stored? |
 * |---|---|---|
 * | `contactHandlers.findDuplicateOwner` | email regardless of name; shared phone only when names are compatible | **yes** — a crosswalk row |
 * | this function | email/phone/name keys, imported-wins, **knew nothing about verdicts** | **no** — recomputed every render |
 *
 * ## The failure it caused, on the founder's own data (2026-08-04)
 *
 * He unlinked an Outlook record from a saved contact. The main process did
 * exactly the right thing: it deleted the crosswalk row and recorded a
 * `different_people` verdict, and `contacts:get-available` consults that verdict
 * (`getRejectedSourceKeys`) specifically so a released record becomes importable
 * again. Then this function compared the released record against the saved
 * contact it had just been released FROM — same name, same phone, which is
 * precisely why it was wrongly linked in the first place — and hid it. The
 * record was unreachable on Clients & Contacts and on the transaction contact
 * picker, both of which `ContactSearchList` backs. The unlink was silently
 * reversed by a layer that had never heard of it.
 *
 * ## Why the fix is removal and not another condition
 *
 * Teaching this pass about verdicts would have made it a better second rule. The
 * founder's decision, on being shown it: *"ok sounds good we can remove it then
 * simple is better."* The reasoning is the product's, not the code's — a
 * combination worth showing a user is worth STORING, and once stored it is a
 * link. A hiding rule that stores nothing cannot be audited, undone, or
 * explained, and a contact here is a party to a transaction that can end up on
 * an exported audit. The main process's suppression at `contacts:get-available`
 * stays exactly as it is, because that decision IS stored and IS disclosed (via
 * `absorbedRecords`, BACKLOG-2459).
 *
 * ===========================================================================
 * THE ONE THING IT STILL DROPS — AND WHY THAT IS NOT A SECOND RULE
 * ===========================================================================
 * An exactly repeated `id`. That is not a judgement that two records are the
 * same person; it is noticing the SAME record twice, which is the one thing no
 * rule is needed to decide. It keeps React keys unique, and it is what
 * de-overlapped the deleted picker's union of its prop rows with
 * `searchContactsForSelection` output — both halves project real `contacts.id`,
 * so an overlap there is literally one row arriving twice.
 *
 * Returned objects are the SAME references passed in (allEmails/allPhones and
 * every other field preserved), just concatenated — never cloned.
 */
export function assembleContacts(
  contacts: ExtendedContact[],
  externalContacts: ExtendedContact[] = [],
): ExtendedContact[] {
  const seenIds = new Set<string>();
  const result: ExtendedContact[] = [];
  for (const contact of contacts) {
    if (seenIds.has(contact.id)) continue;
    seenIds.add(contact.id);
    result.push(contact);
  }
  for (const contact of externalContacts) {
    if (seenIds.has(contact.id)) continue;
    seenIds.add(contact.id);
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

/**
 * The name a row SORTS under — its REAL name, or "" when it hasn't got one.
 *
 * BACKLOG-2466. Deliberately NOT `normalizeName`, which is the DEDUP key and
 * must stay exactly as it is. Two differences matter here:
 *
 *  - This is sentinel-aware. Five live write paths persist the literal
 *    "Unknown" / "Unknown Contact" into `display_name`, and since BACKLOG-2461
 *    those rows DISPLAY their phone number instead. Sorting them under "u" put
 *    a row reading "+1 (415) 555-0177" between "Uber" and "Vex Example", with
 *    nothing on screen to explain the position — the list ordering by a string
 *    it does not show, which is the same defect as searching one it does.
 *  - Nothing else may use it. If `normalizeName` itself were made
 *    sentinel-aware, `stableIdentityKey` for a sentinel-named contact with no
 *    email and no phone would fall through to `i:${contact.id}` — the DB UUID,
 *    the one key that function exists to avoid. Every frozen `orderKeys` entry
 *    for such a row would change on import, reintroducing the import-jump
 *    BACKLOG-2352/2355 were built to kill. Pinned by test.
 */
function sortName(contact: ExtendedContact): string {
  return realContactName(contact.display_name || contact.name).toLowerCase();
}

/**
 * The key a NAMELESS row sorts by within the nameless block: the exact label
 * the row DISPLAYS (organisation -> formatted phone -> email -> "No name").
 *
 * Not a second label computed for sorting — `labelForContact` is the same
 * function the rows render, so what you read is what you sort by.
 */
function namelessSortKey(contact: ExtendedContact): string {
  return labelForContact(contact).toLowerCase();
}

const NO_NAME_KEY = NO_NAME_PLACEHOLDER.toLowerCase();

/**
 * Name A–Z (nameless rows last), then stable identity tiebreaker.
 *
 * BACKLOG-2466: the nameless rows KEEP their position at the end — moving the
 * block is a separate, visible decision — but they are no longer an
 * undifferentiated run. They order by the label they display, so a column of
 * numbers reads as an ordered column of numbers, and the rows with no
 * identifying detail at all ("No name") sort below the ones that have some
 * rather than collating under "N" among the organisations.
 */
function compareAlphabetical(a: ExtendedContact, b: ExtendedContact): number {
  const na = sortName(a);
  const nb = sortName(b);

  if (!na || !nb) {
    if (na) return -1; // b is nameless -> b goes last
    if (nb) return 1; // a is nameless -> a goes last

    const ka = namelessSortKey(a);
    const kb = namelessSortKey(b);
    const aPlaceholder = ka === NO_NAME_KEY;
    const bPlaceholder = kb === NO_NAME_KEY;
    if (aPlaceholder !== bPlaceholder) return aPlaceholder ? 1 : -1;
    if (ka !== kb) {
      const byLabel = ka.localeCompare(kb);
      if (byLabel !== 0) return byLabel;
    }
    return compareIdentity(a, b);
  }

  if (na !== nb) {
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
 * ASSEMBLE -> FILTER -> SEARCH — every stage EXCEPT the final sort.
 * Split out (BACKLOG-2355) so the picker can (a) recompute the frozen visible
 * ORDER only when the ordering inputs (search/sort/filter) change, and (b)
 * project current data through that frozen order on every render. Depends only
 * on data + search + filters — NOT on sort order.
 *
 * BACKLOG-2370 removed the DEDUP stage that used to sit between assemble and
 * filter. Every row the main process returned reaches the filter.
 */
export function assembleFilterSearch(input: BuildVisibleContactsInput): ExtendedContact[] {
  const { contacts, externalContacts = [], searchQuery = "", filters = null } = input;

  const assembled = assembleContacts(contacts, externalContacts);

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
  // `stableIdentityKey` is NOT unique — two distinct rows may share an email,
  // and since BACKLOG-2370 nothing upstream collapses them, so a plain
  // Map<key, contact> would silently drop one HERE, reintroducing the removed
  // hiding rule in the sort. Grouping guarantees every live row survives exactly
  // once. Pinned by test.
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
