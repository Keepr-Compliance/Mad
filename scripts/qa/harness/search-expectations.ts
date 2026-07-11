/**
 * QA Harness — SEARCH expectation derivation (BACKLOG-1853 / QA-H6).
 *
 * Turns H1's committed canonical checklist (docs/qa/tx1-canonical-list-v2.20.0.md,
 * parsed by canonicalList.ts) into the EXACT expected result sets for the fixed
 * H6 search-query set. The checklist is the SINGLE committed source of truth;
 * the live DB measurement (search-attach-measure.js) is diffed against these
 * expectations by H1's MULTISET diff (diff.ts).
 *
 * ── SOUNDNESS of the contact-address derivation ────────────────────────────
 * The filter-OFF rule is "any From/To/Cc/Bcc address ∈ the 9-contact set". So
 * for any single contact address A among the 9, EVERY corpus email in which A
 * participates is (by definition) in the 69-row filter-OFF set. A participant
 * search for A over the full 190-email corpus therefore returns EXACTLY the
 * canonical rows whose "Matched contact(s)" column names A. This is EXACT and
 * derivable from committed data — PROVIDED that column is exhaustive w.r.t. the
 * 9 contacts (it is, by construction; the live measurement is the cross-check,
 * and any divergence is a finding to explain, per the deterministic standard).
 *
 * ── SOUNDNESS of the subject-token derivation ──────────────────────────────
 * expectedForSubjectToken is exact WITHIN the 69. For a full-corpus SUBJECT
 * search to equal it, the token must be TX1-subject-confined (no non-TX1 corpus
 * subject contains it). The fixed query set uses only such phrases; the live
 * measurement validates the confinement (a stray match is surfaced as `extra`).
 */
import type { CanonicalEmail, EmailSetMember } from './types';
import { loadCanonicalList, type ParsedCanonicalList } from './canonicalList';

export { loadCanonicalList };
export type { ParsedCanonicalList };

/** Project canonical rows down to (subject, shiftedDate) members. */
export function toMembers(emails: CanonicalEmail[]): EmailSetMember[] {
  return emails.map((e) => ({ subject: e.subject, shiftedDate: e.shiftedDate }));
}

/**
 * The canonical shorthand the checklist uses for a contact address = its local
 * part (before '@'). e.g. "amanda@cascadetitle.com" → "amanda",
 * "david.patterson@gmail.com" → "david.patterson".
 */
export function contactShorthand(address: string): string {
  return String(address).toLowerCase().trim().split('@')[0];
}

/**
 * Rows whose "Matched contact(s)" column names the given contact address. Match
 * is on the local-part shorthand bounded by the column's delimiters
 * (`:` `,` `;` whitespace) so "amanda" never matches "amandax" and
 * "mark.sullivan" is matched in full.
 */
export function expectedForContact(
  parsed: ParsedCanonicalList,
  address: string,
): CanonicalEmail[] {
  const shorthand = contactShorthand(address);
  if (!shorthand) return [];
  const escaped = shorthand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Preceded by start or a delimiter; followed by end or a delimiter.
  const re = new RegExp(`(?:^|[:,;\\s])${escaped}(?=$|[,;\\s])`, 'i');
  return parsed.filterOff.filter((e) => re.test(e.matchedContacts));
}

/** Rows whose subject contains `token` (case-insensitive substring). */
export function expectedForSubjectToken(
  parsed: ParsedCanonicalList,
  token: string,
): CanonicalEmail[] {
  const needle = String(token).toLowerCase();
  if (!needle) return [];
  return parsed.filterOff.filter((e) => e.subject.toLowerCase().includes(needle));
}

/**
 * The filter-ON (address-mention) subset — subject/body contains all of the
 * transaction's normalized tokens. Reused as the "address fragment" exact set
 * (it is the committed, DB-confirmed 37).
 */
export function expectedAddressMention(parsed: ParsedCanonicalList): CanonicalEmail[] {
  return parsed.filterOn;
}

/** A subject-family reply chain: ≥2 canonical rows sharing a Re/Fwd-stripped subject. */
export interface SubjectFamily {
  family: string;
  members: CanonicalEmail[];
}

/**
 * Group canonical rows into subject families (Re/Fwd-stripped). Families with
 * ≥2 members are the committed proxy for the real reply chains the 1721 MAPI
 * seed produces; the live measurement asserts those members actually share ONE
 * thread_id.
 */
export function expectedSubjectFamilies(parsed: ParsedCanonicalList): SubjectFamily[] {
  const byFamily = new Map<string, CanonicalEmail[]>();
  for (const e of parsed.filterOff) {
    const family = stripReplyPrefixes(e.subject);
    const bucket = byFamily.get(family);
    if (bucket) bucket.push(e);
    else byFamily.set(family, [e]);
  }
  return [...byFamily.entries()]
    .map(([family, members]) => ({ family, members }))
    .filter((f) => f.members.length >= 2);
}

/** TS mirror of search-attach-core.js normalizeSubjectFamily (kept in sync). */
export function stripReplyPrefixes(subject: string): string {
  let s = String(subject ?? '').trim();
  for (;;) {
    const stripped = s.replace(/^(re|fwd|fw)\s*:\s*/i, '');
    if (stripped === s) break;
    s = stripped;
  }
  return s.replace(/\s+/g, ' ').trim();
}
