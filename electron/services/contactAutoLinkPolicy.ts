/**
 * WHAT THE APP IS ALLOWED TO DECIDE ABOUT IDENTITY — BACKLOG-2668
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
 * Three states, and this module's whole job is to name which one applies:
 *
 *   | AI add-on | toggle | mode      | the rule ...                          |
 *   |-----------|--------|-----------|---------------------------------------|
 *   | off       | n/a    | `off`     | does not run at all                   |
 *   | on        | off    | `suggest` | asks, and never links by itself       |
 *   | on        | on     | `auto`    | links, exactly as it did before       |
 *
 * ===========================================================================
 * "AI TIER" IS AN ADD-ON, NOT A PLAN. THE PLAN IS READ BY NOTHING HERE.
 * ===========================================================================
 * The first cut of this file read `subscription_tier` and treated anything that
 * was not `free` as the AI tier. THE FOUNDER CORRECTED THAT ON PR #2367:
 *
 *   "AI features can be on any plan — individual, team or pro."
 *
 * The codebase already said so, in `types/models.ts` above `UserLicense`:
 *
 *   license_type: 'individual' | 'team' | 'enterprise'   (base license)
 *   ai_detection_enabled: boolean   (add-on, works with ANY base license)
 *
 * A plan-derived reading is wrong in BOTH directions, and the expensive
 * direction is the second: a paying individual WITHOUT the add-on would have
 * been auto-linked silently, and a free-plan user WITH it would have been
 * denied the suggestions he is entitled to.
 *
 * So the input is the add-on flag and nothing else. `license_type` is
 * deliberately not read, and a control asserts that an `enterprise` plan with
 * the add-on OFF still resolves to `off`.
 *
 * ===========================================================================
 * WHY `users_local`, AND NOT THE LICENSE SERVICE OR THE FEATURE GATE
 * ===========================================================================
 * `contactLinkingScheduler.ts` documents that the linking pass is synchronous
 * up to its first await, and that the hold protecting provisional iPhone rows
 * silently stops protecting anything if an await is introduced ahead of it —
 * "NOTHING WOULD GO RED: every existing test would still pass, because the
 * hazard is a scheduling interleaving no test can create while the pass is
 * synchronous."
 *
 * That rules out every async source, and each is independently disqualified:
 *
 *   - `featureGateService.checkFeature` is async AND FAIL-OPEN — with no cache
 *     it returns "allowed". A user who is merely offline would auto-link, which
 *     is the precise outcome this file exists to prevent. Its `ai_detection`
 *     key is also team-only, which the founder's correction rules out.
 *   - `licenseService` is async on every export (network plus a disk cache) and
 *     its cache format is private to that module.
 *
 * `users_local.ai_detection_enabled` is local, synchronous, and `INTEGER
 * DEFAULT 0` — fail-closed in the schema itself. `licenseHandlers`'
 * `getLicenseData()` reads it too, including in the team-membership branch,
 * where it is commented "AI addon status from local database (local setting)".
 *
 * ===========================================================================
 * THIS IS A THIRD OPINION ABOUT AI, NOT AN ECHO OF THE RENDERER'S — SR, 23 AUG
 * ===========================================================================
 * An earlier draft of this comment claimed the gate "agrees with what the user
 * is already being shown". THAT WAS FALSE, and the correction matters more than
 * the mistake, because the next reader will otherwise assume one source exists.
 *
 * `LicenseContext` writes `state.hasAIAddon` from this column (`:143`) and from
 * `validationResult.aiEnabled` (`:198`) — and then SHADOWS both:
 *
 *     const hasAIAddon = featureIsAllowed("ai_detection");   // :302
 *
 * That const is what the provider exports (`:326`, `:345`). Nothing outside the
 * file reads `state.hasAIAddon` at all, so the column-derived writes are dead.
 * The header says so outright (SPRINT-127 / TASK-2160): "hasAIAddon now read
 * from plan features via useFeatureGate ... Plan features are the sole source
 * of truth; no license column fallback."
 *
 * So there are three answers to "does this user have AI?":
 *   1. `isAllowed("ai_detection")` — the plan feature gate, behind 10+ live
 *      surfaces and the renderer's `hasAIAddon`;
 *   2. `isAutoDetectAllowed` — entitlement AND the `enable_auto_detect` toggle;
 *   3. this column — which had NO live consumer before this file.
 *
 * They are not guaranteed to agree, and the disagreement is not symmetric:
 * `useFeatureGate.isAllowed` FAIL-OPENS (`useFeatureGate.ts:10,29` — "Defaults
 * to allowed for unknown features"), so the renderer can already show AI as
 * available while this gate reads `off`. That is the safe direction and the
 * reason the fail-open source was rejected above, but it is a divergence, not
 * an agreement. It is invisible today only because nobody is entitled: all 15
 * Supabase `licenses` rows are `false` (measured 23 Aug).
 *
 * Reconciling the three is deliberately NOT this item's work — the founder has
 * de-prioritised feature-gate rework until the features themselves work, and
 * `featureGateHandlers.ts:22-27` additionally lists `ai_detection` in
 * `TEAM_ONLY_FEATURES`, which contradicts his "AI can be on any plan" ruling.
 * Both are pre-existing. What this file owes the reader is an accurate map, and
 * the map is: THREE sources, this one the newest consumer, chosen because it is
 * the only one that is local, synchronous and fail-closed.
 *
 * ===========================================================================
 * KNOWN AND REPORTED: THAT COLUMN IS A MIRROR NOBODY REFILLS
 * ===========================================================================
 * The cloud truth is `licenses.ai_detection_enabled` in Supabase. NOTHING
 * copies it into `users_local` in a packaged build — traced on 23 Aug: no auth
 * handler writes the column, `supabaseService` never mentions it, and the only
 * writers are the DEV-ONLY `license:dev:toggle-ai-addon` IPC (registered solely
 * when `!app.isPackaged`) and the user-id migration column-for-column copy.
 *
 * That is a PRE-EXISTING, APP-WIDE defect — the renderer `hasAIAddon` is
 * equally stale — and it is filed rather than fixed here: building an
 * entitlement mirror is not this item scope. Its consequence is stated so
 * nobody rediscovers it as a bug in this gate: until that sync exists, a
 * packaged build resolves to `off` for everyone, which is the safe direction
 * and the same answer the rest of the app already gives.
 *
 * ===========================================================================
 * FAIL-CLOSED. EVERY UNKNOWN IS `off`.
 * ===========================================================================
 * A missing user row, an unreadable database, a NULL, a value the app does not
 * write — all resolve to `off`. The asymmetry is the argument: a link this rule
 * should have made is offered again on the next sync, and a link it should not
 * have made has already copied values onto a saved contact by the time anyone
 * notices. Failing towards "do nothing" costs a pass; failing towards "link"
 * costs a correction the user has to find first.
 *
 * ===========================================================================
 * THE TOGGLE DOES NOT EXIST YET, AND IS DELIBERATELY NOT BUILT HERE
 * ===========================================================================
 * BACKLOG-2616, 13 Aug: "Today there is NO setting at all ... The toggle is new
 * surface." It belongs to the 2616 / BACKLOG-2630 build line, which owns the
 * settings surface and the migration that would store it.
 *
 * A toggle that does not exist has never been turned ON, and the 13 Aug ruling
 * permits automatic linking only behind a toggle the user turned on. So a user
 * WITH the add-on resolves to `suggest` today. That is the ruling applied, not
 * a gap filled: `auto` is fully implemented and is reached the moment
 * `readAutoLinkToggle` has something real to read.
 */

import { dbGet } from "./db/core/dbConnection";
import { LOCAL_USER_AI_DETECTION_SQL } from "./db/localUserSql";
import logService from "./logService";

/**
 * What the app may do with a guess about identity for this user.
 *
 * Deliberately three values rather than a boolean. A boolean would have to mean
 * either "may link" or "may run", and the middle state — runs, asks, never
 * links — is the one the founder toggle exists to select.
 */
export type ContactAutoLinkMode = "off" | "suggest" | "auto";

/**
 * Does this user have the AI detection add-on?
 *
 * ===========================================================================
 * THE TABLE IS `users_local`. THERE IS NO `users` TABLE.
 * ===========================================================================
 * The first cut of this file queried `FROM users`, which does not exist — the
 * local table has been `users_local` since the schema was written, and every
 * reader in `userDbService` says so. It threw in production, was swallowed by
 * the `catch` below, and returned `off` for everyone: the right answer for
 * entirely the wrong reason, with a warning on every sync pass.
 *
 * It survived a full green suite because the TEST FIXTURE INVENTED A `users`
 * TABLE. The suite now extracts this table DDL from
 * `electron/database/schema.sql` itself, so a name that does not exist in
 * production cannot pass here again.
 *
 * `=== 1` is exact rather than truthy. SQLite has no boolean: the dev toggle
 * writes `enabled ? 1 : 0`, so 1 is the only value that means "on". A NULL, a 0
 * or anything else is not a state the app writes, and an unrecognised state is
 * an unknown — which is `off`.
 */
function hasAiAddon(userId: string): boolean {
  const row = dbGet<{ ai_detection_enabled: number | null }>(
    LOCAL_USER_AI_DETECTION_SQL,
    [userId],
  );
  // No row is not "no add-on" — it is "we do not know", and unknown is `off`.
  // Same answer, different reason, and the reason is what survives a refactor.
  if (!row) return false;
  return row.ai_detection_enabled === 1;
}

/**
 * Has the user turned automatic linking ON?
 *
 * There is nowhere to store that answer yet (BACKLOG-2616 owns the setting), so
 * it is `false` for everyone. Written as its own named function rather than a
 * `false` literal inside `resolveContactAutoLinkMode` so that the day the
 * setting lands there is ONE body to fill in and the ladder above it does not
 * have to be re-reasoned.
 */
function readAutoLinkToggle(_userId: string): boolean {
  return false;
}

/**
 * The one predicate. Everything that could automatically decide two records are
 * the same person asks THIS, and asks it in one place rather than at each call
 * site — the per-caller shape that BACKLOG-2562 single-predicate fix exists
 * to replace.
 *
 * Never throws. A database error is an unknown, and an unknown is `off`.
 */
export function resolveContactAutoLinkMode(userId: string): ContactAutoLinkMode {
  try {
    if (!hasAiAddon(userId)) return "off";
    return readAutoLinkToggle(userId) ? "auto" : "suggest";
  } catch (error) {
    // Fail-closed, and say so out loud: a pass that quietly stopped linking
    // because a query threw looks identical to a pass that correctly found
    // nothing to link.
    logService.warn(
      `[Contacts] could not read the AI add-on flag; automatic linking stays off: ${error}`,
      "Contacts",
    );
    return "off";
  }
}
