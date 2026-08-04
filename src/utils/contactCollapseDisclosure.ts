/**
 * What a picker row absorbed, from BOTH places that decide it (BACKLOG-2459).
 *
 * ===========================================================================
 * THE COLLAPSE HAPPENS TWICE, IN TWO PROCESSES
 * ===========================================================================
 * A duplicate can be folded away at either of two points, and only one of them
 * is visible from the renderer:
 *
 *  1. **The main process**, in `contacts:getAvailable`. This is where the
 *     founder's `picker: 1126 in -> dup-suppressed 21 -> shown 1105` is decided.
 *     The losing record is `continue`d away and never enters `availableContacts`
 *     — so it is not merely hidden from the screen, it is **absent from every
 *     array the renderer receives**. It can only be shown if the handler says
 *     so, which is why it now arrives pre-described on
 *     `ExtendedContact.absorbedRecords`.
 *
 *  2. **The renderer**, in `contactPickerList.assembleDedupedContactsWithEvidence`.
 *     This pass runs over the survivors of (1) plus the saved `contacts` rows,
 *     which main never compared against each other. Its residual is small but
 *     real — mostly the name-only rule, which main does not implement at all.
 *
 * The first attempt at this feature instrumented ONLY (2), which is a pass over
 * a list the 21 records had already been removed from — and since main's
 * `findDuplicateOwner` applies the same email and phone rules, that pass finds
 * almost nothing. It was a true report about a nearly empty set, presented as an
 * answer about the founder's set.
 *
 * This module is the single place the two are brought together, so a row
 * discloses every record folded into it regardless of which process decided it,
 * and one sentence renders both.
 */

import type { AbsorbedContactRecord, ExtendedContact } from "../types/components";
import type { CollapsedContactRecord } from "./contactPickerList";

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
 * Renderer-side records -> the common shape.
 *
 * `sourceLabel` is null rather than derived from `contact.source`: the
 * renderer's `ContactSource` union names a contact's ORIGIN (`contacts_app`,
 * `manual`, `email`), which is not the same vocabulary as the address book the
 * main process names (`macos`, `outlook`). Mapping between them is the crosswalk
 * BACKLOG-2472/2473 own, and inventing a third mapping here to fill a clause
 * that is allowed to be absent would be the worse trade — the sentence degrades
 * cleanly without it.
 */
function fromRenderer(
  records: CollapsedContactRecord[],
  labelFor: (contact: ExtendedContact) => string,
): FoldedRecord[] {
  return records.map((record) => ({
    key: `renderer:${record.contact.id}`,
    label: labelFor(record.contact),
    sourceLabel: null,
    matchedOn: record.matchedOn,
    matchedValue: record.matchedValue,
  }));
}

/**
 * Every record folded into `contact`, main-process first.
 *
 * Main first because those are the collapses the user actually lost rows to;
 * the renderer residual is a second-order effect over what main already
 * returned. Returns `undefined` — not `[]` — when nothing was folded, so the row
 * renders nothing without needing a length check.
 */
export function foldedRecordsFor(
  contact: ExtendedContact,
  rendererRecords: CollapsedContactRecord[] | undefined,
  labelFor: (contact: ExtendedContact) => string,
): FoldedRecord[] | undefined {
  const fromMain = contact.absorbedRecords?.length
    ? fromMainProcess(contact.absorbedRecords)
    : [];
  const fromRend = rendererRecords?.length ? fromRenderer(rendererRecords, labelFor) : [];
  if (fromMain.length === 0 && fromRend.length === 0) return undefined;
  return [...fromMain, ...fromRend];
}
