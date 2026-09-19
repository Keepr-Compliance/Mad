/**
 * Shared SQL for resolving a saved contact to its LINKED external source records
 * (BACKLOG-2401; narrowed to links only by BACKLOG-2669).
 *
 * Lives in its own module because there are TWO backfill implementations that
 * must not drift apart: the main-thread path in
 * `electron/handlers/contactHandlers.ts` and its twin in
 * `electron/workers/contactQueryWorker.ts`, which wins whenever the worker pool
 * is warm. The worker holds its own `better-sqlite3` handle and cannot import
 * the db service, so the one thing they can genuinely share is the SQL text.
 * Changing the rule in only one of them is how a fix becomes invisible in the
 * field, so it is expressed exactly once, here.
 *
 * BACKLOG-3044 PR 3 added the ONE import this module has: the `sql` tag. That is
 * compatible with the sentence above, and the difference matters — the constraint
 * is that the worker cannot import the db SERVICE, which owns a native handle and
 * the main process's connection. `core/sqlText.ts` is a dependency-free type brand
 * with no runtime imports of its own, and the worker already imports the
 * tag-using `contactRecencySql.ts` (`contactQueryWorker.ts:24`). Both facts were
 * checked by execution before the import was added, not reasoned from the comment.
 *
 * The text is unchanged by the branding: `sql` returns the cooked template, so
 * `.prepare(CONTACT_SOURCE_RECORDS_SQL)` in the worker and in six test files still
 * receives exactly the bytes it did before — `SafeSql` is `string & {…}`, which is
 * assignable to every `string` position.
 *
 * ---------------------------------------------------------------------------
 * THE RULE: A RECORD CONTRIBUTES VALUES ONLY WHEN IT IS LINKED (BACKLOG-2669)
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE ADDING A BRANCH THAT SELECTS `external_contacts` BY CONTENT.
 *
 * This query is not a reader. Its two consumers COPY every row it returns onto
 * the contact's `contact_emails` / `contact_phones`. So it resolves through the
 * crosswalk and through nothing else. A link is made by the source-id path, by
 * the user linking a source by hand, or by a human answering a question. There
 * is no fourth way, and none of the three runs through this query.
 *
 * WHAT USED TO BE HERE. Two further branches selected `external_contacts` by
 * CONTENT ALONE — priority 2 on a shared email, priority 3 on a shared phone —
 * gated only on the contact holding no record-backed crosswalk row. No link, no
 * name check, no verdict, and no answer.
 *
 * Founder's machine, 12 Aug (full trail on BACKLOG-2669). A contact created by
 * hand, holding ONE phone number the founder typed, whose only crosswalk row was
 * `origin` — linked to no source record at all — acquired four values belonging
 * to other people inside thirty minutes:
 *
 *     +15035550181             manual   23:34:51   the founder typed it
 *     bianca@example.com       import   23:50:33   from a record sharing that phone
 *     +15035550180             import   23:54:26
 *     bea.okafor@example.net   import   00:03:08   from a record sharing THAT email
 *     bianca.reyes@example.org import   00:03:08
 *
 * (His two numbers ended `0301` and `0300`. They are shown here — and spelled in
 * the tests — shifted into the `555-0100..555-0199` block that
 * `scripts/ci/check-fixture-pii.mjs` reserves for fictional use, which rejected
 * the originals. Nothing else about the trail is altered.)
 *
 * AND IT CASCADED, which is what made it urgent rather than untidy. The copied
 * email widened the contact's match surface, so the next sweep matched further
 * records through a value the previous sweep had taken. Each stolen value steals
 * more. A single-hop test cannot see that, which is why the control in
 * `__tests__/contactSourceLinkSql.unlinkedCopy-2669.test.ts` runs two sweeps.
 *
 * THE OBJECTION, ANSWERED: "then a new record's values never reach the contact."
 * They do. An unlinked content match ALREADY files a proposal
 * (`contactSourceLinker.resolveSourceRecord`); the user answers, the link is
 * created, `applyLinkedSourceValues` copies, and priority 1 below carries it on
 * every sweep after. Measured on the founder's own fixture: with these branches
 * gone he is still ASKED about the record that matched his phone — and is no
 * longer asked about the second record, which became a candidate only because
 * the defect had already put a stranger's email on him. The branches were
 * redundant with the ask, not complementary to it.
 *
 * Every proposal in the founder's trail was still `pending`. The branches did
 * not merely ignore a verdict; they did not wait for one to exist.
 *
 * DELETING BRANCHES FROM A `UNION ALL` IS MONOTONICALLY RESTRICTIVE. For every
 * input the result set is a subset of what it was, so no contact — frozen or
 * not, linked or not — can gain a value it could not gain before.
 *
 * ---------------------------------------------------------------------------
 * THE TWO LESSONS THOSE BRANCHES COST, KEPT BECAUSE THEY ARE WHY NOBODY SHOULD
 * RE-ADD THEM
 * ---------------------------------------------------------------------------
 * BACKLOG-2473 — the gate that switched them on had to read
 * `NOT EXISTS (... AND x.match_method <> 'origin')`, never a bare `NOT EXISTS`.
 * v61 gives EVERY contact an origin row recording where it came from, and an
 * origin row points at a synthetic `source_record_id` that JOINs nothing. The
 * bare gate would have been false for every contact in the database, both
 * fallbacks would have been silently dead, and nothing would have failed — the
 * addresses would simply have stopped arriving. Any future content branch
 * inherits that trap: a row in `contact_source_links` is NOT the same thing as a
 * link to a source record.
 *
 * BACKLOG-2664 — they were made to stop at the freeze, because a copy with no
 * link behind it must never reach a contact an exported audit depends on. A
 * frozen contact can never earn a record-backed link by content matching
 * (`contactSourceLinker.resolveSourceRecord` refuses at its
 * `frozen_audit_contact` branch), so the gate never closed for her and every
 * sweep re-copied every content-matching record, forever. That freeze gate is
 * now UNNECESSARY RATHER THAN ABSENT: no contact gains anything from an unlinked
 * content match, so the frozen subset is covered by the stronger rule. Measured,
 * not argued — the 2664 suite's three founder cases and its parity block pass
 * unmodified against this query.
 *
 * ---------------------------------------------------------------------------
 * DISPLAY NAME IS ABSENT ON PURPOSE (BACKLOG-2401)
 * ---------------------------------------------------------------------------
 * `... WHERE name = ?` against `contacts.display_name` was the entire previous
 * mechanism and the defect that work removed: rename yourself in Contacts.app
 * and the next sync refreshes the shadow row under the new name, so the lookup
 * finds nothing and the saved record is orphaned in silence. The crosswalk is
 * keyed on the source record, which a rename does not change.
 *
 * ---------------------------------------------------------------------------
 * EVERY LINKED RECORD IS RETURNED, IN AN EXPLICIT ORDER — not one arbitrary row
 * ---------------------------------------------------------------------------
 * A contact can legitimately map to several source records at once (the same
 * person in macOS, Outlook and an iPhone). Backfill is ADDITIVE — it inserts
 * missing emails/phones and dedupes — so reading every linked record is both
 * more complete and immune to the "which source wins?" question for everything
 * except which value is written first.
 *
 * Where order is still observable it is DECLARED rather than left to whichever
 * row the query planner happened to emit last (catalogue C12):
 *
 *   `source_rank`: macos(1) < iphone(2) < outlook(3) < google_contacts(4) <
 *                  android_sync(5)
 *
 * Rationale, recorded so it can be argued with rather than rediscovered: the
 * two address books the user curates by hand on their own devices (macos,
 * iphone) outrank the two server directories (outlook, google_contacts), which
 * in turn outrank the companion-derived feed (android_sync) — the most derived
 * and the least directly edited by the person whose contacts these are.
 *
 * Final tiebreak is `external_record_id`, so the order is TOTAL and the same on
 * every machine and every run.
 *
 * ---------------------------------------------------------------------------
 * ONE ASYMMETRY, RECORDED RATHER THAN CLAIMED (BACKLOG-2669)
 * ---------------------------------------------------------------------------
 * The linker's email probe compares against an UNTRIMMED stored address
 * (`contactMatchIndex.ts:159` — deliberate, and documented there); the deleted
 * priority-2 branch trimmed both sides. Neither the engineer nor the SR review
 * could reach a writer that stores an untrimmed address
 * (`backfillContactEmailsSync` stores `email.toLowerCase().trim()`), so this is
 * recorded, not asserted. Its consequence has flipped sign under this change: it
 * used to mean "the fallback copies where the linker refuses", and now means
 * "nothing happens and nobody is asked".
 */

import { sql } from "./core/sqlText";

/**
 * Params: @userId = user_id, @contactId = contact_id.
 * Columns: emails_json, phones_json, matched_by, pri, source_rank, external_record_id.
 *
 * The wrapper subquery and the constant `pri` survive the removal of priorities
 * 2 and 3 (BACKLOG-2669): the row shape and the declared ordering are unchanged
 * for both consumers, and a future priority — if one is ever justified — is
 * added to a query that already sorts.
 */
export const CONTACT_SOURCE_RECORDS_SQL = sql`
  SELECT emails_json, phones_json, matched_by, pri, source_rank, external_record_id FROM (
    SELECT
      ec.emails_json                AS emails_json,
      ec.phones_json                AS phones_json,
      'source_id'                   AS matched_by,
      1                             AS pri,
      CASE ec.source
        WHEN 'macos' THEN 1 WHEN 'iphone' THEN 2 WHEN 'outlook' THEN 3
        WHEN 'google_contacts' THEN 4 WHEN 'android_sync' THEN 5 ELSE 6
      END                           AS source_rank,
      ec.external_record_id         AS external_record_id
    FROM contact_source_links csl
    JOIN external_contacts ec
      ON ec.user_id = csl.user_id
     AND ec.source = csl.source_type
     AND ec.external_record_id = csl.source_record_id
    WHERE csl.user_id = @userId AND csl.contact_id = @contactId
  )
  ORDER BY pri, source_rank, external_record_id
`;

export interface ContactSourceRecordRow {
  emails_json: string | null;
  phones_json: string | null;
  /**
   * Always `"source_id"` since BACKLOG-2669 removed the content branches.
   * `"email"` and `"phone"` are KEPT in the union deliberately: they are the
   * vocabulary of `contact_source_links.match_method`, a link the linker made by
   * content matching still carries one of them, and narrowing this type would
   * ripple through consumers of a row whose shape has not changed.
   */
  matched_by: "source_id" | "email" | "phone";
  pri: number;
  source_rank: number;
  external_record_id: string;
}
