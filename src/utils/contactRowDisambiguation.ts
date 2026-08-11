/**
 * SAME-NAMED ROWS SAY WHICH ONE THEY ARE (BACKLOG-2663)
 *
 * ===========================================================================
 * THE BUG THIS EXISTS TO FIX
 * ===========================================================================
 * Searching `whit` in the transaction Add Contacts picker returned three rows
 * reading `Dana Whitlock` and six rows reading one other real person's name.
 * Every row was a name and a `+ Add` button. The gate step was "import the Dana
 * with phone 555-0130" and it could not be followed from that screen — it
 * blocked the same step three separate times.
 *
 * ===========================================================================
 * THIS IS THE COST OF A CORRECT DECISION, NOT A REGRESSION
 * ===========================================================================
 * BACKLOG-2356 made picker rows name-only and BACKLOG-2591's review re-confirmed
 * it: `showDetailLine` defaults false in `ContactSearchList`, and
 * `ContactAssignmentStep.rowsUnchanged-2591.test.tsx` fences it there. That is
 * right for the common case — a broker picking a known person does not want a
 * wall of metadata — and turning the detail line on globally would reverse it
 * wholesale, putting metadata on every row for every user.
 *
 * So nothing here touches `showDetailLine`. This adds a field to a row ONLY when
 * the row's name is ambiguous inside the result set the user is looking at.
 * Quiet by default, informative exactly when the user must choose.
 *
 * ===========================================================================
 * WHY NOT CALL BACKLOG-2625'S FUNCTION, AND THE ONE RULE THAT CHANGED
 * ===========================================================================
 * 2625 solved the same shape for the review queue's candidate rows
 * (`disambiguate()` in `ReviewDuplicatesModal.tsx`). It cannot be called from
 * here: it is module-private inside a `.tsx` component and typed to
 * `ContactReviewItem` (`proposalId`, `matchedOn`, `recordEmails`, `sourceLabel`)
 * — none of which exist on a picker row. Its PRINCIPLE is reused: stay silent
 * unless ambiguous, then show the field that actually differs, organisation
 * first.
 *
 * ONE RULE IS DELIBERATELY DIFFERENT, AND IT IS THE REASON SIX ROWS WORK.
 *
 * 2625's predicate is `differsFromAColliding` — a row shows a field when that
 * field differs from AT LEAST ONE other colliding row. Take six records sharing
 * a name whose organisations are A, A, A, B, B, B: every row's organisation
 * "differs from a colliding row", so all six show an organisation and the two
 * triples are still indistinguishable from each other. The pairwise case passes
 * easily while the six-way case fails — which is exactly the failure this item
 * was filed about.
 *
 * The rule here is SEPARATION OF THE WHOLE GROUP, not difference from someone:
 *
 *   1. Walk the fields in priority order (organisation -> phone -> email).
 *   2. Keep a field only if adding it INCREASES the number of distinct composite
 *      keys in the group. A field every member shares contributes nothing and is
 *      dropped, so six records at one firm show their phone and not the firm.
 *   3. Stop as soon as every member of the group has a distinct key.
 *
 * With organisations A, A, A, B, B, B and six phones: organisation splits 1 -> 2
 * (kept, still not separated), phone splits 2 -> 6 (kept, separated) — six rows,
 * six different lines.
 *
 * ===========================================================================
 * THE HONEST LIMIT
 * ===========================================================================
 * Two records identical in name, organisation, phone AND email still render
 * identically, because there is nothing left to say about them. That is a
 * duplicate, and the review/dedup path is what answers it — inventing a
 * disambiguator here (an index, an id) would put a difference on screen that
 * does not exist in the data.
 */

import { labelForContact } from "./contactDisplayLabel";
import { formatPhoneNumber } from "./phoneNormalization";

/**
 * The fields a picker row can be told apart by, in priority order.
 *
 * Organisation first, as in 2625. Phone before email because that is the field
 * the founder was told to choose on ("the Dana with phone 555-0130") and the one
 * a broker is given in a referral; 2625's own second tier is "the identifier the
 * matched value is NOT", which has no meaning on a picker row where nothing has
 * been matched.
 */
const DISAMBIGUATION_FIELDS: ReadonlyArray<(row: DisambiguableRow) => string> = [
  (row) => (row.company ?? "").trim(),
  (row) => formatPhoneNumber((row.phone ?? row.allPhones?.[0] ?? "").trim()),
  (row) => (row.email ?? row.allEmails?.[0] ?? "").trim(),
];

/** Separator between kept fields, and between composite key parts. */
const FIELD_JOIN = " · ";
/** Unit separator — cannot occur in a company name, phone or email. */
const KEY_SEP = "";

/** Everything this module reads off a row. Structural, so tests need no full contact. */
export interface DisambiguableRow {
  id: string;
  display_name?: string | null;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  allPhones?: string[];
  allEmails?: string[];
}

/** The name as the row RENDERS it — same function `ContactRow` calls. */
function displayNameOf(row: DisambiguableRow): string {
  return labelForContact(row);
}

/**
 * Ambiguity is "looks the same to the user", so the key is the RENDERED label,
 * normalised the way BACKLOG-2618's live suppression rule normalises it
 * (trimmed, lowercased). Two rows the user cannot tell apart are two rows whose
 * visible text is the same string.
 */
function ambiguityKey(row: DisambiguableRow): string {
  return displayNameOf(row).trim().toLowerCase();
}

/** How many distinct composite keys `fields` produces across `group`. */
function distinctKeyCount(
  group: ReadonlyArray<DisambiguableRow>,
  fields: ReadonlyArray<(row: DisambiguableRow) => string>,
): number {
  return new Set(group.map((row) => fields.map((f) => f(row)).join(KEY_SEP))).size;
}

/**
 * The fields that, taken together, separate `group` as far as it can be
 * separated — dropping every field that adds no discrimination.
 *
 * Greedy in priority order. Greedy is correct here rather than merely cheap:
 * the priority order is a statement about which field a user would rather read,
 * so a smaller set found by reordering would be a worse answer, not a better one.
 */
function separatingFields(
  group: ReadonlyArray<DisambiguableRow>,
): Array<(row: DisambiguableRow) => string> {
  const kept: Array<(row: DisambiguableRow) => string> = [];
  let bestSoFar = 1; // an empty field set puts the whole group on one key

  for (const field of DISAMBIGUATION_FIELDS) {
    if (bestSoFar === group.length) break; // already fully separated
    const withField = distinctKeyCount(group, [...kept, field]);
    if (withField > bestSoFar) {
      kept.push(field);
      bestSoFar = withField;
    }
  }

  return kept;
}

/**
 * For every row whose display name collides inside `rows`, the line that tells
 * it apart. Rows with a unique name are ABSENT from the map — not present with
 * an empty string — so a caller cannot render a blank element for them.
 *
 * `rows` must be the VISIBLE result set. Ambiguity is a property of what is on
 * screen: two people called Dana Whitlock are only a problem when both are in
 * front of the user, and searching to one of them should quiet the row again.
 */
export function buildRowDisambiguators(
  rows: ReadonlyArray<DisambiguableRow>,
): Map<string, string> {
  const byName = new Map<string, DisambiguableRow[]>();
  for (const row of rows) {
    const key = ambiguityKey(row);
    const bucket = byName.get(key);
    if (bucket) bucket.push(row);
    else byName.set(key, [row]);
  }

  const result = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;

    const fields = separatingFields(group);
    if (fields.length === 0) continue; // nothing in the data separates them

    for (const row of group) {
      const line = fields
        .map((f) => f(row))
        .filter((v) => v.length > 0)
        .join(FIELD_JOIN);
      // A row holding NONE of the separating fields has nothing to say. Omitted
      // rather than rendered blank — and it is still distinguishable, because
      // every other row in the group now carries a line and it does not.
      if (line.length > 0) result.set(row.id, line);
    }
  }

  return result;
}
