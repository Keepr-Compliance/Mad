/**
 * What a picker row absorbed — BACKLOG-2459, narrowed by BACKLOG-2370.
 *
 * ===========================================================================
 * THE COLLAPSE NOW HAPPENS IN EXACTLY ONE PLACE
 * ===========================================================================
 * A duplicate is folded away in `contacts:getAvailable`, in the main process.
 * That is where the founder's `picker: 1126 in -> dup-suppressed 21 -> shown
 * 1105` is decided. The losing record is `continue`d away and never enters
 * `availableContacts` — so it is not merely hidden from the screen, it is
 * **absent from every array the renderer receives**. It can only be shown if the
 * handler says so, which is why it arrives pre-described on
 * `ExtendedContact.absorbedRecords`.
 *
 * There used to be a SECOND source: a renderer-side residual from
 * `contactPickerList`'s own dedup pass, which compared the survivors of the
 * above against the saved `contacts` rows. BACKLOG-2370 deleted that pass — it
 * was a hiding rule that stored nothing and had never heard of an unlink
 * verdict, so it silently reversed one on the founder's data. With it gone there
 * is no residual to merge, and this module maps one shape instead of reconciling
 * two.
 *
 * That deletion cost the disclosure nothing measurable. The first attempt at
 * this feature instrumented ONLY the renderer pass, which runs over a list the
 * 21 records had already been removed from — and since `findDuplicateOwner`
 * applies the same email and phone rules, that pass found almost nothing. It was
 * a true report about a nearly empty set, presented as an answer about the
 * founder's set. What it could still contribute beyond main was the name-only
 * rule main deliberately does not implement (BACKLOG-2316: distinct people who
 * share a name), which is a collapse that should not have been happening.
 */

import type { AbsorbedContactRecord, ExtendedContact } from "../types/components";

/**
 * One folded record, ready to render, whichever process folded it.
 *
 * Note what is NOT here: anything about the SURVIVING row. The sentence may only
 * assert what the collapse established — the folded record and the agreed
 * detail — because a claim about the survivor (its source, whether it is saved)
 * is a claim the picker never checked. See `collapsedRecordSummary`.
 */
export interface FoldedRecord {
  /** Stable key for React. Unique within a row. */
  key: string;
  /** The folded record's label, or null when it had no name. */
  label: string | null;
  /** Where it came from, in words, or null when it has no address book. */
  sourceLabel: string | null;
  matchedOn: "email" | "phone" | "name";
  /** The agreed value AS SAVED on the folded record — never a normalised key. */
  matchedValue: string;
}

/** Main-process records (already described) -> the common shape. */
function fromMainProcess(records: AbsorbedContactRecord[]): FoldedRecord[] {
  return records.map((record, index) => ({
    // Main sends no id — deliberately, since a folded record's id is either a
    // regenerated shadow-table UUID or absent. Position within the row is
    // stable for a given render and is all a key needs to be.
    key: `main:${index}`,
    label: record.label,
    sourceLabel: record.sourceLabel,
    matchedOn: record.matchedOn,
    matchedValue: record.matchedValue,
  }));
}

/**
 * Every record folded into `contact`, or `undefined` when nothing was.
 *
 * `undefined` rather than `[]` so the row renders nothing without needing a
 * length check.
 *
 * BACKLOG-2370: this took two more arguments — the renderer pass's records for
 * this row, and a labelling function used only to describe them. Both are gone
 * with that pass. The parameters are removed rather than left permanently
 * `undefined`, so nothing can quietly re-wire a second collapse source into a
 * screen whose whole point is that one rule decided what it shows.
 */
export function foldedRecordsFor(contact: ExtendedContact): FoldedRecord[] | undefined {
  if (!contact.absorbedRecords?.length) return undefined;
  return fromMainProcess(contact.absorbedRecords);
}
