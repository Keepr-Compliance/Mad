/**
 * THE CONTACTS HEADER NAMES EVERY SOURCE IT COUNTS (BACKLOG-2662)
 *
 * ===========================================================================
 * THE BUG THIS EXISTS TO FIX
 * ===========================================================================
 * The Clients & Contacts header read:
 *
 *     1173 contacts (1171 from Contacts App)
 *
 * while the database held 1,166 `macos` records and 5 `outlook` records. All
 * five Outlook records were being credited to the Contacts App, because the
 * words were typed into the JSX:
 *
 *     {externalContacts.length > 0 && ` (${externalContacts.length} from Contacts App)`}
 *
 * `contacts:get-available` returns rows of EVERY source — its SQL
 * (`contactRecencySql.ts`) has no source predicate, and the per-source gates in
 * `contactHandlers.ts` are user preferences that all default on. So Outlook,
 * Gmail, iPhone and Android records were all counted under one provider's name.
 *
 * This is the same defect BACKLOG-2483 fixed one layer down, where the import
 * picker badged nine sources with a two-way ternary. The renderer went on doing
 * the visual equivalent in the header. The fix is the same fix: ask
 * `contactSourceLabel`, never write a provider's name down.
 *
 * ===========================================================================
 * WHY THIS TAKES THE ROWS AND NOT TWO ARRAY LENGTHS
 * ===========================================================================
 * The header's two numbers were not the same units, which is the second half of
 * the bug and the source of the founder's unexplained two-record gap.
 *
 *   total          = `visibleCount`, the RENDERED row count reported up from
 *                    `ContactSearchList` — post filter, post search.
 *   parenthetical  = `externalContacts.length`, the RAW `get-available` array.
 *
 * Nothing made those reconcile. `assembleContacts` is a concat that drops only
 * exactly-repeated ids (BACKLOG-2370 deleted the dedup stage), so the total also
 * counts the SAVED half — rows from `contacts:get-all`, which is
 * `[...importedRows, ...messageDerivedAsContacts(userId)]`. Those saved rows
 * were in the total and in no part of the breakdown. That is the 1173-vs-1171
 * gap, and typing one letter into the search box widened it arbitrarily
 * (`3 contacts (1171 from Contacts App)`).
 *
 * So this function is handed THE ROWS THE HEADER IS COUNTING and partitions
 * them. The parts sum to the total by construction; a gap is not something the
 * assertion has to tolerate, it is something the shape cannot express.
 *
 * ===========================================================================
 * GROUPING KEYS ON `source` AND NOTHING ELSE
 * ===========================================================================
 * Specifically NOT on `is_message_derived`. `useContactDirectory`'s
 * `fetchExternalContacts` stamps `is_message_derived: true` onto every row it
 * receives from `contacts:get-available` — a display flag for the source pill —
 * so that field cannot tell an address-book record from a text-derived one and
 * a partition built on it would be wrong for the whole external half.
 */

import { contactSourceLabel } from "./contactFilterModel";

/** One named source and how many of the counted rows came from it. */
export interface ContactSourceSegment {
  /** The display name, from `contactSourceLabel` — never written down here. */
  readonly label: string;
  readonly count: number;
}

/** The only field this partition reads. Structural so tests need no full row. */
export interface SourceBearingRow {
  readonly source?: string | null;
}

/**
 * Partition rows by the name their source is called by.
 *
 * Grouping is BY LABEL, not by raw source value, and that is deliberate:
 * `contactSourceLabel` folds `email`+`inferred` into "From Email" and
 * `sms`+`messages` into "From Texts" (asserted in `contactSourceLabel.test.ts`).
 * A user does not want "2 from From Texts, 1 from From Texts" because one row
 * came through a synthetic projection and the other through a column.
 *
 * A row whose source is unknown, NULL or absent lands on
 * `UNKNOWN_CONTACT_SOURCE_LABEL` ("Other") rather than being dropped or
 * attributed to a provider it did not come from. Dropping is what would let the
 * counts stop summing to the total.
 *
 * ORDER IS TOTAL AND DETERMINISTIC: count DESC, then label A-Z. The dominant
 * source reads first, which is what the header said before this change, and the
 * A-Z tiebreak means a re-render can never reorder equal segments.
 */
export function summariseContactSources(
  rows: ReadonlyArray<SourceBearingRow>,
): ContactSourceSegment[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = contactSourceLabel(row.source);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
}

/**
 * The header's parenthetical, or `null` when there is nothing to say.
 *
 * ONE SEGMENT PRODUCES EXACTLY THE STRING THE HEADER SHOWED BEFORE THIS CHANGE
 * — ` (1166 from Contacts App)`. That is not a coincidence to be preserved by
 * hand; the single-source case is the state that HID the bug (the founder's
 * reading minutes before the Outlook sync), so it is the regression guard, and
 * it is asserted byte-for-byte in `contactSourceBreakdown.test.ts`.
 *
 * Two or more segments enumerate every one of them. The grammar does not change
 * between the two cases — the list simply grows — so there is one sentence shape
 * to read rather than two.
 */
export function formatContactSourceSummary(
  segments: ReadonlyArray<ContactSourceSegment>,
): string | null {
  if (segments.length === 0) return null;
  return ` (${segments.map((s) => `${s.count} from ${s.label}`).join(", ")})`;
}
