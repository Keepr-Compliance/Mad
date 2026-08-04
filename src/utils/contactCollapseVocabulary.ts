/**
 * The words the picker uses for a record it folded away — RENDERER COPY
 * (BACKLOG-2459).
 *
 * ===========================================================================
 * WHY THIS IS A MIRROR AND NOT AN IMPORT
 * ===========================================================================
 * The masking and identifier wording were written for the review queue
 * (BACKLOG-2410) and live in `electron/services/contactLinkEvidence.ts`. The
 * picker's disclosure needs the same words, so the obvious move is to import
 * them. **This repository has no location from which both processes can import
 * a TypeScript module**, which was established by building, not by reading
 * config:
 *
 *  - **The renderer cannot import from `electron/`.** Vite only applies its
 *    TypeScript transform to files under `src/`; anything else reaches rollup as
 *    raw text and fails on the first type annotation. A first attempt at this
 *    feature put a shared module at `electron/services/contactLinkEvidenceVocabulary.ts`
 *    and imported it here. `tsc --noEmit`, eslint, the whole jest suite and a
 *    full SR review all passed — and `vite build` failed on
 *    `import type { LinkProposalReason }`, on both macOS and Windows.
 *  - **`shared/` at the repo root is no better.** Probed directly: a value
 *    import of `shared/probe/probeShared.ts` fails the build with the same
 *    parse error. (This is why `shared/types/license.js` sits next to its `.ts`
 *    as a hand-compiled artifact.)
 *  - **`electron/` cannot import from `src/` either.** `tsconfig.electron.json`
 *    sets `rootDir: ./electron`. Every existing cross-boundary import in that
 *    direction is in a TEST, which that config excludes.
 *
 * Neither direction works, so a module both sides need has to be duplicated.
 * The duplication is made safe the way PR #2201 made it safe when it hit this
 * same wall: a PARITY TEST
 * (`src/utils/__tests__/contactCollapseVocabulary.parity.test.ts`) imports both
 * copies — jest resolves across the boundary freely, unlike Vite and tsc — and
 * asserts identical output over a shared corpus. If either side is edited alone,
 * that test goes red.
 *
 * **Only the mirrored functions below may be edited in lockstep.**
 * `collapsedRecordSummary` is NOT mirrored: it is the picker's own sentence and
 * the main process has no use for it, so it lives here alone.
 */

// ---------------------------------------------------------------------------
// MIRRORED — byte-for-byte with `electron/services/contactLinkEvidence.ts`.
// Pinned by the parity test. Do not edit one side alone.
// ---------------------------------------------------------------------------

/** `jane.smith@example.com` -> `ja…@example.com`. Recognisable, not harvestable. */
export function maskEmail(email: string): string {
  const trimmed = (email ?? "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed ? "an email address" : "an email address";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  if (local.length <= 2) return `${local}${domain}`;
  return `${local.slice(0, 2)}…${domain}`;
}

/** `+1 (415) 555-0134` -> `…0134`. The last four is what people recognise. */
export function maskPhone(phone: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 0) return "a phone number";
  if (digits.length <= 4) return `…${digits}`;
  return `…${digits.slice(-4)}`;
}

/**
 * The identifier, named and masked, as a noun phrase.
 *
 * Mirrors `describeIdentifier` in `contactLinkEvidence.ts`. It answers for all
 * three kinds of identifier — including a name, which is the one
 * `matchMethodDescription` has no truthful sentence for.
 */
export function describeIdentifier(
  matchedOn: "email" | "phone" | "name" | null | undefined,
  values: string[],
): string | null {
  const first = values.find((v) => typeof v === "string" && v.trim().length > 0);
  if (!first) return null;
  if (matchedOn === "email") return `the email address ${maskEmail(first)}`;
  if (matchedOn === "phone") return `the phone number ${maskPhone(first)}`;
  if (matchedOn === "name") return `the name "${first.trim()}"`;
  return null;
}

// ---------------------------------------------------------------------------
// RENDERER-ONLY — no counterpart in the main process, nothing to keep in step.
// ---------------------------------------------------------------------------

/**
 * What the picker says about a record it folded into a row (BACKLOG-2459).
 *
 * ===========================================================================
 * WHY THIS IS NOT `summaryForReason("duplicate_source_record")`
 * ===========================================================================
 * That sentence was tried first, on the reasoning that reusing existing words
 * beats inventing new ones. It reads:
 *
 *     Two entries in your {source} both list {identifier}, and you already have
 *     {who} saved from one of them.
 *
 * It makes TWO factual claims the picker never checks, and SR review found both
 * false in the founder's own data shape:
 *
 *  - **"you already have {who} saved"** — the surviving row is very often an
 *    address-book record that has NOT been imported. The screen would call the
 *    contact already saved while still showing the button that saves it.
 *  - **"Two entries in your {source}"** — the two records routinely come from
 *    DIFFERENT places (an Outlook contact folded into a Mac address-book one).
 *    Naming one address book for both is simply wrong.
 *
 * That sentence is true only when the survivor is a saved row AND both records
 * share a source. The judgement that a near-miss sentence is worse than an
 * accurate one — on a surface where a contact is a party to an audit — is the
 * same judgement that rejected `matchMethodDescription("unique_name")` earlier.
 * It applies here too, and this time it points AWAY from reuse.
 *
 * So this states only what the collapse actually establishes: which record was
 * folded in, where THAT record came from, and which detail the two agreed on.
 * It makes no claim about the survivor's source and none about whether anything
 * is saved, because the picker determines neither. Both optional clauses degrade
 * independently, so a record with no name and no known source still produces a
 * true sentence rather than one with a hole in it.
 */
export function collapsedRecordSummary(ctx: {
  /** The folded record's own label, or null when it had no name. */
  foldedLabel: string | null;
  /** Where the folded record came from, in words, or null when unknown. */
  foldedSourceLabel: string | null;
  /** From `describeIdentifier` — the detail the two records agreed on. */
  identifierPhrase: string | null;
}): string {
  const who = ctx.foldedLabel?.trim() ? ctx.foldedLabel.trim() : "A record with no name";
  const from = ctx.foldedSourceLabel ? ` from your ${ctx.foldedSourceLabel}` : "";
  const because = ctx.identifierPhrase
    ? `both list ${ctx.identifierPhrase}`
    : "they carry the same details";
  return `${who}${from} is shown on this row, because ${because}.`;
}
