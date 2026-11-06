/**
 * Sender filter — BACKLOG-4175.
 *
 * Pure and worker-safe: the only import is the address-list parser. Decides
 * from the FROM address of a message only — never Reply-To, never another
 * participant, never the recipients, never the body.
 *
 * Implemented so far: exact addresses (`suppress.exactAddresses`). An entry
 * matches only the whole parsed address: no host, substring, suffix or
 * local-part widening.
 */
import { parseEmailAddressList } from "../emailAddress";
import type { SenderRuleModes, SenderRuleSet, SenderRuleSignal } from "./bundledRules";

export type SenderFilterSurface = keyof SenderRuleModes;

/**
 * The first parsed address of a stored `emails.sender` value, lowercased and
 * trimmed by the parser; null when nothing parses. Covers the raw Gmail
 * `From` header (`"Name" <addr>`) and the Outlook `Name <addr>` / bare form.
 */
export function fromAddress(sender: string | null | undefined): string | null {
  const first = parseEmailAddressList(sender).addresses[0];
  return first ? first.email_address : null;
}

/** True when the From address is exactly one of `suppress.exactAddresses`. */
export function matchesExactAddress(sender: string | null | undefined, rules: SenderRuleSet): boolean {
  const from = fromAddress(sender);
  return from !== null && rules.suppress.exactAddresses.includes(from);
}

/** Is a signal live (changes behaviour) on a surface? */
export function isSignalLive(rules: SenderRuleSet, signal: SenderRuleSignal, surface: SenderFilterSurface): boolean {
  return rules.modes[signal][surface] === "live";
}
