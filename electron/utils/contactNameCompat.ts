/**
 * Are these two display names plausibly the SAME person? (BACKLOG-2316 /
 * BACKLOG-2399 / BACKLOG-2416)
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN MODULE
 * ===========================================================================
 * BACKLOG-2416: two layers were answering this question differently. The main
 * process gated phone-based dedup on name compatibility
 * (`contactHandlers.isDuplicate`); the renderer's picker dedup
 * (`src/utils/contactPickerList.matchesSeen`) matched on phone UNCONDITIONALLY.
 * So two people on one office line survived the backend rule and were then
 * collapsed to one row by the renderer — the backend still held both, and the
 * screen could not reach one of them.
 *
 * The rule is extracted here so there is ONE statement of it rather than two
 * that drift.
 *
 * ===========================================================================
 * WHY IT IS MIRRORED IN `src/utils/contactNameCompat.ts` RATHER THAN IMPORTED
 * ===========================================================================
 * `tsconfig.electron.json` sets `rootDir: "./electron"`. Nothing under
 * `electron/` can import from `shared/` or `src/` — that constraint is why
 * `electron/types/license.ts` duplicates `shared/types/license.ts` instead of
 * importing it, and it applies here too.
 *
 * So the renderer copy is a MIRROR, and the thing that keeps the mirror honest
 * is not this comment: `src/utils/__tests__/contactNameCompat.parity.test.ts` imports BOTH
 * implementations and asserts they return the same verdict for every case in a
 * shared table. Change one without the other and that test goes red.
 */

/**
 * BACKLOG-2316: Normalize a display name for comparison — lowercase, drop the
 * punctuation that distinguishes an abbreviated surname ("Jane S." vs
 * "Jane Smith"), and collapse whitespace. Returns "" for a missing name.
 */
export function normalizeContactName(name: string | null | undefined): string {
  return (name || "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * BACKLOG-2316: Decide whether two display names could plausibly belong to the
 * SAME person. Used to gate phone-based dedup so that two DISTINCT people who
 * merely share a normalized number (a household / office line) are BOTH kept,
 * while the same person recorded across sources ("Jane Smith" / "Jane S.") is
 * still collapsed.
 *
 * Rule: an empty name can't contradict (compatible). Otherwise compare token by
 * token up to the shorter name's length; every aligned token pair must be
 * prefix-compatible (one a prefix of the other). So "Jane Smith" ~ "Jane S." is
 * compatible, but "Margaret …" / "John …" and "… Smith" / "… Jones" are not.
 * Nickname forms (Bob/Robert) are intentionally treated as distinct — the app
 * cannot safely assume they are one person, and keeping both is the safe error.
 *
 * ---------------------------------------------------------------------------
 * BACKLOG-2399 — A LONE TOKEN IS NEVER ENOUGH TO CLAIM TWO PEOPLE ARE ONE
 * ---------------------------------------------------------------------------
 * Because the loop only ran to the SHORTER name's length, a single-token name
 * was prefix-compatible with EVERY longer name starting with that token:
 *
 *     "Margaret"  vs  "Margaret Chen"   -> compatible  -> second one dropped
 *
 * On a shared office line that silently removed a DISTINCT person from the
 * import picker — she could not be imported at all, and nothing said so.
 *
 * The shape was mostly unreachable before: an org-labelled card compared as
 * "miller - seller", which collides with nothing. BACKLOG-2399 relabels that
 * whole population to bare first names, which is exactly this shape, so the
 * latent case became a common one. The predicate is pre-existing; the relabel
 * is what made it bite, so it is fixed here rather than left as a side effect.
 *
 * A single token that is not an exact match is therefore treated as NOT
 * compatible. That follows the rule this function already states — "keeping
 * both is the safe error" — and the harms are not symmetric: a duplicate row in
 * the picker is visible and the user can ignore it, whereas a person who never
 * appears cannot be imported and leaves no trace. Exact matches ("Margaret" /
 * "Margaret") still collapse via the equality check above.
 */
export function namesAreCompatible(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeContactName(a);
  const nb = normalizeContactName(b);
  if (!na || !nb) return true;
  if (na === nb) return true;

  const ta = na.split(" ");
  const tb = nb.split(" ");

  // BACKLOG-2399: one bare token carries too little to overrule a shared line.
  if (ta.length === 1 || tb.length === 1) return false;

  const len = Math.min(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = ta[i];
    const y = tb[i];
    if (!x.startsWith(y) && !y.startsWith(x)) return false;
  }
  return true;
}
