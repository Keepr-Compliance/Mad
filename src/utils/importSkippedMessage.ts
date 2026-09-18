/**
 * =============================================================================
 * BACKLOG-3376 — WHAT THE IMPORT SAVED THAT NO EMAIL CAN BE ADDRESSED FROM
 * =============================================================================
 * BACKLOG-3358 stopped an address the app cannot validate from blocking an
 * import: the contact now saves with the value as the address book has it. A
 * real user hit that on 2026-09-15 with `name@ Domain.com` from an iPhone sync.
 * Nothing told them, so their emails would never link to the deal and nothing
 * would explain why.
 *
 * This builds the sentence that tells them, for both surfaces that import a
 * contact: the Clients & Contacts card and the deal wizard's contact step.
 *
 * -----------------------------------------------------------------------------
 * WHY ONE MODULE AND NOT TWO COPIES
 * -----------------------------------------------------------------------------
 * The two surfaces differ in exactly ONE word — the card "imported" a contact,
 * the wizard "added" one — and share the join, the quoting, the singular/plural
 * split and every clause the founder confirmed. Two copies would drift on the
 * next wording change, and the join is the part most worth having in one place.
 * The verb stays a required parameter rather than a default so the difference
 * is made at each call site and is visible in a diff.
 *
 * -----------------------------------------------------------------------------
 * WHAT EACH CLAUSE IS BACKED BY
 * -----------------------------------------------------------------------------
 *   - *"isn't a valid email address"* — the app's own `validateEmail` refuses
 *     it. NOT "isn't an address Keepr can read": Keepr read it, normalized it
 *     and stored it, so that phrase is the one claim the code would not back.
 *   - *"won't be linked to your transactions"* — definite, because the caller
 *     only ever passes addresses that satisfy `isUnmatchableImportEmail`
 *     (whitespace, or no `@`). That predicate's docblock carries the trace and
 *     names which arm is enforced and which is a premise. An address the app
 *     merely refuses to validate — `pat@intranet` — is NOT in that set and
 *     produces no message at all, because its mail links normally.
 *   - *"Open {name} in your contacts and correct the address"* — the saved
 *     contact is editable through `ContactFormModal`. An address-book record
 *     cannot be edited before import, which is why this is an after-the-fact
 *     message rather than a block.
 *
 * Wording is FOUNDER-CONFIRMED on both surfaces (2026-09-16).
 *
 * -----------------------------------------------------------------------------
 * HOW LONG IT STAYS: UNTIL THE USER DISMISSES IT
 * -----------------------------------------------------------------------------
 * Both call sites raise this with `{ persistent: true }`. There is deliberately
 * NO duration constant in this module any more, and adding one back would be a
 * regression: the founder tested the 12-second version on both surfaces on
 * 2026-09-16 and asked for a message the user has to dismiss, because a timed
 * one can be missed.
 *
 * Still `info` and still the ordinary notification rather than a modal dialog —
 * the contact did import — and `NotificationToast` always renders a dismiss
 * button (`notification-dismiss`), so the user is never stuck with it.
 */

/** "imported" on the Clients & Contacts card, "added" in the deal wizard. */
export type ImportVerb = "imported" | "added";

/**
 * Join addresses the way a sentence does: commas between all but the last, and
 * "and" before the last. No cap — a card with three unreadable addresses is
 * already the extreme case, and truncating would hide the very one the user
 * has to go and fix.
 */
function joinQuoted(addresses: string[]): string {
  const quoted = addresses.map((a) => `"${a}"`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * The message, or `null` when there is nothing to say.
 *
 * `null` rather than an empty string so a caller cannot raise a blank toast by
 * forgetting to check the length.
 */
export function unmatchableEmailMessage({
  name,
  verb,
  addresses,
}: {
  name: string;
  verb: ImportVerb;
  addresses: string[];
}): string | null {
  if (addresses.length === 0) return null;

  if (addresses.length === 1) {
    return (
      `${name} was ${verb}, but ${joinQuoted(addresses)} isn't a valid email address. ` +
      `Emails from it won't be linked to your transactions. ` +
      `Open ${name} in your contacts and correct the address.`
    );
  }

  // Not "N of their email addresses aren't valid email addresses" — the noun is
  // said once, in the clause that carries the judgement.
  return (
    `${name} was ${verb}, but ${addresses.length} of their addresses aren't valid ` +
    `email addresses: ${joinQuoted(addresses)}. ` +
    `Emails from them won't be linked to your transactions. ` +
    `Open ${name} in your contacts and correct them.`
  );
}
