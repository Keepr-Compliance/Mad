/**
 * Contact Link Evidence — the PURE half (BACKLOG-2410, split out by BACKLOG-2459)
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM `contactLinkEvidence.ts`
 * ===========================================================================
 * `contactLinkEvidence.ts` imports `db/core/dbConnection` at module scope, which
 * makes it main-process-only: importing it from the renderer would drag
 * better-sqlite3 into the Vite bundle. But the sentences below are needed on BOTH
 * sides. BACKLOG-2459 has to explain a collapse the RENDERER makes — the picker's
 * dedup pass in `src/utils/contactPickerList.ts` folds duplicate records together
 * before anything is rendered — and the founder's requirement there is the same
 * one this vocabulary was written for: say what happened in words the user can
 * check.
 *
 * So the pure, database-free functions live here and `contactLinkEvidence.ts`
 * re-exports them. Nothing about their behaviour changed in the move; there is
 * exactly ONE copy of every sentence, and it is this one.
 *
 * The two doctrines the original file established still govern everything below:
 *
 * WORDS, NEVER A SCORE. "0.82 confidence" tells a user nothing they can act on.
 * A full sentence naming the actual identifier and the actual reason does. The
 * only number that may appear is a COUNT of things the user owns, written out
 * alongside what it counts.
 *
 * IDENTIFIERS ARE PARTIALLY MASKED. The sentence has to name the identifier or
 * the user cannot check it. It does not have to reproduce it in full — enough to
 * recognise, not enough to harvest.
 */

import type { LinkProposalReason } from "./db/contactLinkReviewDbService";

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
 * The sentence a user reads first. One per reason, and each one names what
 * actually happened rather than describing a category.
 */
export function summaryForReason(
  reason: LinkProposalReason,
  ctx: {
    contactLabel: string;
    sourceLabel: string;
    identifierPhrase: string | null;
    nameHolderCount?: number;
    nameText?: string | null;
  },
): string {
  const who = ctx.contactLabel;
  const ident = ctx.identifierPhrase;
  switch (reason) {
    case "identifier_reassigned":
      return (
        `A record in your ${ctx.sourceLabel} carries ${ident ?? "an identifier"}, which you also have ` +
        `saved against ${who} — but ${who}'s own entry in that ${ctx.sourceLabel} no longer lists it. ` +
        `That usually means the ${ident ?? "identifier"} moved to a different person.`
      );
    case "duplicate_source_record":
      return (
        `Two entries in your ${ctx.sourceLabel} both list ${ident ?? "the same details"}, and you already ` +
        `have ${who} saved from one of them. This is usually one person saved twice.`
      );
    case "ambiguous_identifier":
      return (
        `${ident ?? "This identifier"} appears on more than one of your saved contacts, so there is no way ` +
        `to tell which of them this ${ctx.sourceLabel} entry belongs to. ${who} is one of the candidates.`
      );
    case "frozen_audit_contact":
      return (
        `${who} appears on an audit you have already exported. Nothing is linked to an exported audit ` +
        `automatically, so this one is being left to you.`
      );
    case "name_not_unique":
      return (
        `${ctx.nameHolderCount ?? "Several"} separate records carry the name ` +
        `${ctx.nameText ?? who}. A name shared by that many people cannot say which is which.`
      );
    case "name_same_source_family":
      return (
        `Two entries named ${ctx.nameText ?? who} both come from your ${ctx.sourceLabel}. A name repeated ` +
        `inside one address book is a duplicate to clean up, not a link between two lists.`
      );
    case "name_generational_suffix":
      return (
        `One of these is written with a generational suffix (Jr, Sr, II, III) and the other is not. ` +
        `That is most often a parent and a child, who share a surname and often an address and a phone.`
      );
    case "name_two_saved_contacts":
      return (
        `${ctx.nameText ?? who} appears once in your address book and once in your email contacts, but ` +
        `each is already saved as its own contact. Joining them would merge two saved people, which is ` +
        `more than a link.`
      );
    default:
      return `This match was not applied automatically.`;
  }
}

/**
 * The identifier, named and masked, as a noun phrase that drops into the
 * sentences above.
 *
 * Exported as of BACKLOG-2459 (it was file-private). The picker's collapse has to
 * say WHICH detail two records agreed on, and this is the function that already
 * answers that for all three kinds of identifier — including a name, which is the
 * one `matchMethodDescription` has no truthful sentence for.
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
