/**
 * WHAT THE APP IS ALLOWED TO DECIDE ABOUT IDENTITY, BY TIER — BACKLOG-2668
 *
 * ===========================================================================
 * THE RULING THIS FILE IMPLEMENTS
 * ===========================================================================
 * Founder, 11 Aug, on BACKLOG-2668, choosing option 1 of three:
 *
 *   "`runUniqueNameAutoLink` does not run on the basic tier. The basic tier
 *    decides nothing about whether two records are the same person, and a
 *    frequency-gated unique-name match is still a guess."
 *
 * and, in the same decision, what that costs and why it is intended:
 *
 *   "Records that share NO email and NO phone, whose only evidence is a unique
 *    name, stay unlinked and UNPROPOSED on the basic tier."
 *
 * Founder, 13 Aug, on BACKLOG-2616, adding the second dimension:
 *
 *   "I would like to add a setting toggle to allow for automatic contact and
 *    record linking for AI tier so it will be gated, and we already profiled
 *    when this will suggest vs automatically link."
 *
 * So there are THREE states, not two, and this module's whole job is to name
 * which one a given user is in:
 *
 *   | tier  | toggle | mode      | the rule ...                          |
 *   |-------|--------|-----------|---------------------------------------|
 *   | basic | n/a    | `off`     | does not run at all                   |
 *   | AI    | off    | `suggest` | asks, and never links by itself       |
 *   | AI    | on     | `auto`    | links, exactly as it did before       |
 *
 * ===========================================================================
 * IT IS SYNCHRONOUS, AND THAT IS A HARD CONSTRAINT, NOT A PREFERENCE
 * ===========================================================================
 * `contactLinkingScheduler.ts` documents that the linking pass is synchronous
 * up to its first await, and that the hold protecting provisional iPhone rows
 * silently stops protecting anything if an await is introduced ahead of it —
 * "NOTHING WOULD GO RED: every existing test would still pass, because the
 * hazard is a scheduling interleaving no test can create while the pass is
 * synchronous."
 *
 * That rules out both async sources of tier truth, and each is independently
 * disqualified anyway:
 *
 *   - `featureGateService.checkFeature` is async AND FAIL-OPEN — with no cache
 *     it returns "allowed". A user who is merely offline would auto-link on the
 *     basic tier, which is the precise outcome this file exists to prevent. Its
 *     `ai_detection` key is also a different, team-only feature.
 *   - `licenseService` is async on every export (network plus a disk cache).
 *
 * `users.subscription_tier` is local, synchronous, and CHECK-constrained by the
 * schema. It is written at every auth path (`sessionHandlers`,
 * `googleAuthHandlers`, `microsoftAuthHandlers`, `sharedAuthHandlers`) from the
 * cloud user record, so it is the same fact those services would have fetched.
 *
 * ===========================================================================
 * FAIL-CLOSED. EVERY UNKNOWN IS `off`.
 * ===========================================================================
 * A missing user row, an unreadable database, a tier string nobody has seen
 * before — all resolve to `off`. The asymmetry is the argument: a link this
 * rule should have made is offered again on the next sync, and a link it should
 * not have made has already copied values onto a saved contact by the time
 * anyone notices. Failing towards "do nothing" costs a pass; failing towards
 * "link" costs a correction the user has to find first.
 *
 * ===========================================================================
 * THE TOGGLE DOES NOT EXIST YET, AND IS DELIBERATELY NOT BUILT HERE
 * ===========================================================================
 * BACKLOG-2616, 13 Aug: "Today there is NO setting at all ... The toggle is new
 * surface." It belongs to the 2616 / BACKLOG-2630 build line, which owns the
 * settings surface and the migration that would store it.
 *
 * A toggle that does not exist has never been turned ON, and the 13 Aug ruling
 * permits automatic linking only behind a toggle the user turned on. So the AI
 * tier resolves to `suggest` today. That is the ruling applied, not a gap
 * filled: `auto` is fully implemented and is reached the moment
 * `readAutoLinkToggle` has something real to read.
 *
 * CONSEQUENCE, STATED RATHER THAN DISCOVERED: on this tree no production path
 * reaches `auto`. An AI-tier user who was silently auto-linked yesterday is
 * asked today. Anyone reading that as a regression should read the 13 Aug
 * ruling first.
 */

import { dbGet } from "./db/core/dbConnection";
import logService from "./logService";

/**
 * What the app may do with a guess about identity for this user.
 *
 * Deliberately three values rather than a boolean. A boolean would have to mean
 * either "may link" or "may run", and the middle state — runs, asks, never
 * links — is the one the founder's toggle exists to select.
 */
export type ContactAutoLinkMode = "off" | "suggest" | "auto";

/**
 * Tier values that carry the AI capability.
 *
 * ===========================================================================
 * FLAGGED FOR THE FOUNDER — THIS MAPPING IS NOT IN THE RECORD
 * ===========================================================================
 * The decisions say "basic tier" and "AI tier". The database says `free`,
 * `pro`, `enterprise` (`schema.sql`, `users.subscription_tier`). No comment
 * anywhere states which of the three is "the AI tier", so "AI tier = anything
 * that is not `free`" is READ, not quoted.
 *
 * It is safe to ship unconfirmed for one reason and one only: a user this
 * mapping misclassifies lands in `suggest`, which asks and never links. The
 * blast radius of getting it wrong is a question the user did not need to be
 * asked — not a silent merge. Correcting it is this one Set.
 */
const AI_TIER_SUBSCRIPTIONS: ReadonlySet<string> = new Set(["pro", "enterprise"]);

/**
 * Does this user's subscription carry the AI tier?
 *
 * Reads the local `users` row directly rather than through `userDbService`,
 * whose every export is `async` — see the synchronous constraint above. This is
 * a leaf: `dbGet` and the log service, nothing else, so it can be imported by
 * the linking services without re-creating the `contactSourceLinker` ->
 * `contactSourceValues` require cycle that `frozenContactDbService` was split
 * out to avoid.
 */
function isAiTier(userId: string): boolean {
  const row = dbGet<{ subscription_tier: string | null }>(
    `SELECT subscription_tier FROM users WHERE id = ?`,
    [userId],
  );
  // No row is not "free" — it is "we do not know", and unknown is `off`. Same
  // answer here, different reason, and the reason is what survives a refactor.
  if (!row) return false;
  return AI_TIER_SUBSCRIPTIONS.has((row.subscription_tier ?? "").trim().toLowerCase());
}

/**
 * Has the user turned automatic linking ON?
 *
 * There is nowhere to store that answer yet (BACKLOG-2616 owns the setting), so
 * it is `false` for everyone. Written as its own named function rather than a
 * `false` literal inside `resolveContactAutoLinkMode` so that the day the
 * setting lands there is ONE body to fill in and the mode ladder above it does
 * not have to be re-reasoned.
 */
function readAutoLinkToggle(_userId: string): boolean {
  return false;
}

/**
 * The one predicate. Everything that could automatically decide two records are
 * the same person asks THIS, and asks it in one place rather than at each call
 * site — the per-caller shape that BACKLOG-2562's single-predicate fix exists
 * to replace.
 *
 * Never throws. A database error is an unknown, and an unknown is `off`.
 */
export function resolveContactAutoLinkMode(userId: string): ContactAutoLinkMode {
  try {
    if (!isAiTier(userId)) return "off";
    return readAutoLinkToggle(userId) ? "auto" : "suggest";
  } catch (error) {
    // Fail-closed, and say so out loud: a pass that quietly stopped linking
    // because a query threw looks identical to a pass that correctly found
    // nothing to link.
    logService.warn(
      `[Contacts] could not read the auto-link tier; treating this user as basic tier: ${error}`,
      "Contacts",
    );
    return "off";
  }
}
