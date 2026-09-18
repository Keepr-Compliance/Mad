/**
 * What a contact is CALLED on screen and in the audit PDF — CANONICAL COPY.
 *
 * ===========================================================================
 * THIS IS THE CANONICAL COPY. THE MIRROR IS `src/utils/contactDisplayLabel.ts`
 * ===========================================================================
 *
 * BACKLOG-2461: a contact with no name rendered as "Unknown Contact" in the
 * picker and exported into the compliance PDF as the literal word "Unknown" —
 * beside their role, while the record held a phone number we could have
 * printed. On a verified store, 18 of 1,124 macOS contacts have no name; all 18
 * rendered identically and could not be told apart.
 *
 * Two surfaces used two different literals for one condition, which is the tell
 * that it was never decided as a single behaviour. It is decided here, once.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RULE IS STATED TWICE
 * ---------------------------------------------------------------------------
 * `tsconfig.electron.json` sets `rootDir: "./electron"`, so nothing under
 * `electron/` may import from `src/` or `shared/` — the same constraint that
 * makes `electron/utils/contactNameCompat.ts` a hand-duplicate. Importing the
 * other way is worse: the export path pulls in main-process modules that cannot
 * exist in the renderer bundle.
 *
 * What keeps the copies honest is not this comment.
 * `src/utils/__tests__/contactDisplayLabel.parity.test.ts` loads BOTH and asserts an
 * identical string for every case in a shared table. Edit one without the other
 * and that test goes red.
 *
 * ---------------------------------------------------------------------------
 * DISPLAY ONLY — NEVER PERSIST THE RESULT
 * ---------------------------------------------------------------------------
 * The output of this function must never be written to `contacts.display_name`.
 * A stored fallback freezes a phone number as somebody's name: a later rename
 * cannot dislodge it, and the crosswalk and dedup rules begin matching on it.
 * `electron/utils/__tests__/contactDisplayLabel.persistence.test.ts` asserts the
 * column is untouched.
 *
 * NOTE (BACKLOG-2461, honest limit): that constraint is STILL violated in
 * shipped data by a different path. `contactsService.buildContactLabel` bakes an
 * email/phone fallback into the macOS record's `name` before it ever reaches an
 * import, so the founder's nameless-but-phoned address-book contacts arrive
 * already carrying a phone number as their name and are stored that way. That
 * producer is untouched, and BACKLOG-2464 still owns it.
 *
 * WHAT CHANGED (BACKLOG-2707): this note used to add that the situation "cannot
 * be undone here", because an empty `display_name` is compatible with EVERY
 * name under `namesAreCompatible` and clearing it would let one nameless record
 * claim a shared office line against every real person on it — gated on
 * BACKLOG-2416. **Both halves of that are now stale, and the write paths this
 * module governs no longer store a label.** Re-measured before relying on it:
 *
 *   - `phoneClaimedByImported` / `emailClaimedByImported` — DELETED
 *     (BACKLOG-2608). Only the tombstone in `contactHandlers.ts` remains.
 *   - the renderer dedup pass — gone (BACKLOG-2370). `contactsShareIdentity`
 *     survives in `src/utils/contactListAnchor.ts` as a SCROLL rule that, as
 *     its own header says, removes nothing.
 *   - auto-link — guarded (BACKLOG-2624). `autoLinkNameGuard.ts` returns
 *     `name_unknown` for a missing name BEFORE calling `namesAreCompatible`,
 *     precisely because that function would answer `true`.
 *   - BACKLOG-2416, the stated blocking dependency — completed.
 *
 * `namesAreCompatible("", x)` is still `true`. What is gone is every live
 * consumer that would ACT on that answer to hide or fold a record.
 *
 * So `contacts:import` and `contacts:create` now store `""` for a nameless
 * contact, and the label is computed here at read time. Two producers outside
 * this PR still write the `"Unknown"` literal — `iPhoneSyncStorageService` and
 * the Android promote path in `localSyncService` — which is why the sentinel
 * set below stays.
 */

import { formatPhoneNumber } from "./phoneNormalization";

/** Shown only when there is no name, no organisation, no phone and no email. */
export const NO_NAME_PLACEHOLDER = "No name";

/**
 * Labels a machine wrote to mean "this record had no name" — not names a person
 * chose. Matched EXACTLY (trimmed, case-insensitive), so a real contact called
 * "Unknown Records LLC" keeps its name.
 *
 * NOT legacy, despite the name, and THIS SET STAYS.
 *
 * BACKLOG-2707 removed four of the paths this note used to list — the two
 * substitutions in `contactDbService` (`createContact`, `createContactsBatch`)
 * and the two in `contactHandlers` (`contacts:import`, `contacts:create`). They
 * now write `""`. Two live producers of the literal remain, both outside that
 * item's scope and both filed:
 *
 *   - `iPhoneSyncStorageService` defaults a null iPhone display name to
 *     "Unknown" on the way INTO `external_contacts`, so the string arrives at
 *     the import already looking like a name.
 *   - `localSyncService`'s Android promote path substitutes it caller-side,
 *     building rows for `createContactsBatch` — so removing the writer's
 *     fallback does not reach it.
 *
 * And every row already on disk. The set is therefore permanent machinery for
 * as long as either producer or any shipped row exists, not a migration shim.
 *
 * Why "write nothing" was never the alternative: `contacts.display_name` is
 * declared `TEXT NOT NULL`. `""` is the empty spelling the column allows, and
 * it is strictly safer than the literal for the one rule that still reads this
 * column to suppress a row — `namesThatAreTheirOwnIdentity` builds its Set with
 * `.filter(Boolean)`, so `""` drops out while `"unknown"` becomes a live key
 * that hides every message-derived person of that name.
 */
const LEGACY_NO_NAME_SENTINELS = new Set(["unknown", "unknown contact"]);

export interface ContactLabelParts {
  /** `display_name`, or the legacy `name` — may hold a legacy sentinel. */
  name?: string | null;
  /** `company` / organisation. */
  organization?: string | null;
  /** Primary phone. E.164 (`+14155550134`) or raw; formatted for display here. */
  phone?: string | null;
  /** Primary email. */
  email?: string | null;
}

/**
 * The contact's actual name, or "" when there isn't one.
 *
 * "" is returned both for a blank field and for a legacy placeholder, because
 * "Unknown" was never a name — it was this function's job, done badly, earlier.
 */
export function realContactName(name?: string | null): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "";
  if (LEGACY_NO_NAME_SENTINELS.has(trimmed.toLowerCase())) return "";
  return trimmed;
}

/**
 * The label to show for a contact, falling back through what we actually hold.
 *
 * Order: name -> organisation -> formatted phone -> email -> "No name".
 *
 * The placeholder is "No name" rather than "Unknown" deliberately: "Unknown"
 * claims we know nothing about the person, when the truth is that exactly one
 * field is empty and we may well hold their number.
 */
export function contactDisplayLabel(parts: ContactLabelParts): string {
  const name = realContactName(parts.name);
  if (name) return name;

  const organization = (parts.organization || "").trim();
  if (organization) return organization;

  const phone = formatPhoneNumber(parts.phone).trim();
  if (phone) return phone;

  const email = (parts.email || "").trim();
  if (email) return email;

  return NO_NAME_PLACEHOLDER;
}

/**
 * The label for a transaction-contact row, mapped from its `contact_*` columns.
 *
 * This exists because every field of `ContactLabelParts` is optional, so an
 * unmapped row (`{ contact_name, contact_phone, ... }`) is structurally
 * assignable to it: TypeScript accepts it, every tier reads `undefined`, and the
 * caller silently gets "No name" for a contact whose number we hold. That
 * mistake was made while writing the tests for this very function, which is
 * reason enough to make the mapping something callers cannot get wrong.
 */
export function labelForTransactionContact(row: {
  contact_name?: string | null;
  contact_company?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
}): string {
  return contactDisplayLabel({
    name: row.contact_name,
    organization: row.contact_company,
    phone: row.contact_phone,
    email: row.contact_email,
  });
}
