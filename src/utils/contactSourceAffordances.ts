/**
 * Which source rows a contact card may offer an ACTION on (BACKLOG-2471/2510).
 *
 * ===========================================================================
 * THE FOUNDER'S OBJECTION, AND ITS EXACT SCOPE
 * ===========================================================================
 *   > *"i'm still not sure what unlink button you are referring to... why would
 *   > we have unlink on a singular contact. we have a remove contact button
 *   > already"*
 *
 * He was looking at a contact he had just imported from ONE address-book card.
 * Its only source was the card it was made from, so `Unlink` would have detached
 * the contact from the only thing it came from — which is not unlinking, it is
 * deleting, and `Remove` already does that. The button was redundant at best and
 * misleading at worst.
 *
 * The scope of that objection is the SINGULAR case, and this module keeps to it.
 *
 * ===========================================================================
 * WHY THIS ONLY STARTED MATTERING WITH BACKLOG-2510
 * ===========================================================================
 * Before BACKLOG-2510 the Clients & Contacts import wrote no crosswalk row at
 * all, so a freshly imported contact had an empty source list and the panel
 * stayed hidden by accident. Routing that import through `contacts:import` is
 * what gives it a real row — `match_method: 'source_id'`, written by
 * `linkImportedContact` — and at a bare `sourceList.length > 0` the panel would
 * have opened on every imported contact with `Unlink` on the record it came
 * from. The fix creates the case; this is the gate that handles it.
 *
 * Note that `matchMethod !== "origin"` does NOT handle it, which is the
 * intuitive answer and the wrong one. `origin` rows point at the synthetic
 * `origin:<contactId>` and `getContactProvenance` already drops them in SQL;
 * they never reach here. The row for a record a contact was imported FROM is
 * `source_id`, and it is a real row about a real card.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY *NOT* CHANGED
 * ===========================================================================
 * A contact can hold more than one `source_id` row from a single import: the
 * picker collapses a person present in both the Mac address book and Outlook
 * into one row and writes a link for each record it stood for (BACKLOG-2458,
 * the founder's Casey Lane). Unlinking one of those is meaningful — the
 * contact survives on the other — and it is exactly the wrong-merge undo the
 * Sources panel exists to provide. So multi-source contacts keep the behaviour
 * they ship with today, unchanged.
 *
 * The rule below is therefore: **an action is offered when detaching would
 * leave the contact still sourced, or when the record was attached after the
 * fact.** The only case it takes away is the one the founder pointed at.
 *
 * OPEN, AND NOT DECIDED HERE: when a contact has its own imported record PLUS a
 * record attached later, this offers `Unlink` on both. The affordance rule as
 * written on BACKLOG-2471 would offer it only on the attached one. That
 * distinction was settled before `source_id` was part of the discussion, it
 * changes shipped behaviour, and it belongs with the `Compare sources` build
 * where the "which columns" question already lives.
 */

/** `contact_source_links.match_method`, as the renderer receives it. */
type MatchMethod = string;

/** The minimum a caller must supply: everything here keys off the method. */
interface SourceLike {
  matchMethod: MatchMethod;
}

/**
 * Methods meaning "this record is one the contact was CREATED FROM", as opposed
 * to one a linking pass or a human attached to a contact that already existed.
 *
 * Every writer was checked by reading it, not by grepping for the token:
 *   - `contactHandlers.ts` `linkImportedContact` — at import, for the records
 *     the user picked. This is the case.
 *   - `contactSourceLinker.ts` `resolveSourceRecord` step 1 — writes `source_id`
 *     ONLY for a pair that is already linked, to backfill a missing
 *     `externalUuid`. It creates no new link.
 *   - `contacts:import`'s existing-DB-contact branch cannot reach it: those rows
 *     carry no `externalRecordId`, so `toSourceIdentities` returns
 *     `no-external-record` and nothing is written.
 *
 * `origin` is listed for completeness. `getContactProvenance` filters it in SQL,
 * but this predicate must be correct on its own terms rather than because a
 * caller upstream happens to filter first.
 */
const CREATED_FROM_METHODS: ReadonlySet<MatchMethod> = new Set([
  "origin",
  "source_id",
]);

/** True when the record was ATTACHED to a contact that already existed. */
export function isAttachedSource(matchMethod: MatchMethod): boolean {
  return !CREATED_FROM_METHODS.has(matchMethod);
}

/**
 * True when the card may offer `Unlink` on this row.
 *
 * Detaching is offered when the contact would still have a source afterwards,
 * or when this record was attached after the fact. It is withheld only when the
 * row is the single record the contact was created from — where `Remove` is the
 * control the founder correctly pointed at.
 */
export function canUnlinkSource(
  sources: ReadonlyArray<SourceLike>,
  source: SourceLike,
): boolean {
  return sources.length > 1 || isAttachedSource(source.matchMethod);
}

/**
 * True when the Sources panel should render at all.
 *
 * A panel whose every row is actionless has nothing to offer: the contact card
 * already names where the contact came from in its header, which is what the
 * founder was pointing out — *"but after i imported tad it still had the
 * 'Contacts App'"*. The label was already the right amount of information;
 * repeating it inside a panel adds a button, not an answer.
 */
export function showSourcesPanel(sources: ReadonlyArray<SourceLike>): boolean {
  return sources.some((s) => canUnlinkSource(sources, s));
}
