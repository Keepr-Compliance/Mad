/**
 * @jest-environment node
 *
 * BACKLOG-2530 STEP 4 — A MULTI-STATEMENT WRITE MAY NOT SHIP WITHOUT A
 * TRANSACTION.
 *
 * ===========================================================================
 * WHY A GUARD AND NOT A CONVENTION
 * ===========================================================================
 * Steps 1-3 of BACKLOG-2530 wrapped every write the audit found. That fixes
 * today and relies on every future author remembering tomorrow.
 *
 * **Conventions failed twice on 2026-08-05.** BACKLOG-2510 (an import path that
 * wrote no crosswalk row) and BACKLOG-2525 (a path with no duplicate guard)
 * were both a NEW path not doing what its siblings did. Neither was caught by
 * review, because nothing about the new code looked wrong — it looked like the
 * other paths, minus one line nobody was looking for.
 *
 * This guard makes the omission red instead of invisible. Same shape as the
 * fixture-PII check: **you cannot forget it, because forgetting is what turns
 * the build red.**
 *
 * ===========================================================================
 * THE RULE
 * ===========================================================================
 * An exported function in the db layer that issues TWO OR MORE write statements
 * must either:
 *
 *   (a) call `dbTransaction` itself, or
 *   (b) be called BY NAME inside some other function's `dbTransaction` callback
 *       — the sync-core pattern (`updateContactSync`, `createTransactionSync`,
 *       `assignContactToTransactionSync`), which exists precisely so the
 *       composition can be atomic.
 *
 * ===========================================================================
 * WHY THE ENUMERATION IS DERIVED FROM SOURCE, NOT LISTED
 * ===========================================================================
 * BACKLOG-2530: *"A registry someone must remember to update is not
 * enforcement; prefer something derived from the code itself."*
 *
 * The function set, the write count and the wrapping are all read out of the
 * files. **Adding a new multi-write function turns this red without anyone
 * touching this file.** The only hand-maintained part is EXEMPT below, which
 * requires a written reason per entry and is asserted to stay small.
 *
 * ===========================================================================
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * ===========================================================================
 * It does not verify that a rollback TEST exists — that cannot be derived from
 * source without pattern-matching test bodies, and a check that guesses is a
 * check that gets ignored. The forced-crash tests are asserted per operation in
 * the suites named in EXEMPT and in `atomicCreate-2496` / `atomicDealCreate-2538`.
 *
 * It counts statements textually. A write built by string concatenation at
 * runtime is invisible to it. That is a known floor, not a claim of completeness.
 */

import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DB_DIR = path.join(REPO_ROOT, "electron", "services", "db");

/**
 * ===========================================================================
 * BACKLOG-2584 — THE SCAN ROOT, AND WHY WIDENING IT ALONE WOULD PROVE NOTHING
 * ===========================================================================
 * This used to be `DB_DIR`. Orchestration services in `electron/services/` and
 * IPC handlers in `electron/handlers/` were never enumerated, so a multi-write
 * ADDED LATER to any of them shipped with no standing red.
 *
 * Widening the ROOT alone does not fix that, and the measurement says so.
 * At `0dca6beb1`, with the enumerator unchanged:
 *
 *   root electron/services/db   96 files   439 fns   13 multi-write   0 new offenders
 *   root electron/services     269 files   820 fns   13 multi-write   0 new offenders
 *   root electron/services+handlers 317    890 fns   13 multi-write   0 new offenders
 *   root electron/             498 files  1131 fns   13 multi-write   0 new offenders
 *
 * Thirteen to thirteen. The 402 added files contain no exported function with
 * two SQL write STATEMENTS, because these files hold no SQL: epic 9 moved the
 * SQL into `db/` and left them composing db-layer CALLS. A textual write rule
 * cannot see a composition, so a root-only widening ships a green test that
 * proves nothing — the exact failure this guard exists to prevent.
 *
 * What makes the widening real is the composition rule below: a call to a
 * db-layer function that writes COUNTS AS A WRITE. That is what turns the
 * orchestration layer red, and it re-derives BACKLOG-2549, 2550, 2845 and part
 * of 2546 from source without being told about them.
 *
 * `__typefixtures__` is excluded deliberately: it holds `mustNotCompile-*.ts`
 * fixtures for `dbTransaction` itself, which are not shipped code. The exclusion
 * is pinned by a PRECONDITION below, because an exclusion held only by a string
 * literal is silently undone by a directory rename.
 *
 * ===========================================================================
 * STRUCTURAL FLOOR — WRITES SPREAD ACROSS NON-EXPORTED MODULE-LOCAL HELPERS
 * ===========================================================================
 * A unit is an exported function or an `ipcMain.handle` registration. Writes
 * split across TWO non-exported module-local helpers belong to no unit and are
 * invisible at any root. The depth-1 closure in `unitsInFile` only helps when
 * an enumerated unit calls both.
 *
 * This is not hypothetical and it hides part of an open critical.
 * BACKLOG-2546's own named sites `systemHandlers.ts:156` and `:198` sit inside
 * `createLocalUserFromCloud` (declared `:135`) and `persistSessionForUser`
 * (declared `:192`) — both `async function`, neither exported. The guard reads
 * green over them.
 *
 * SO: GUARD-GREEN IS NOT ITEM-COMPLETE, and the disposition must say which
 * sites each item has covered. BACKLOG-2546 names five entry points; this guard
 * sees three of them (`googleAuthHandlers.ts:116` and `:423`,
 * `microsoftAuthHandlers.ts:94`) and does not see the `systemHandlers` pair.
 * Closing 2546 requires reading the item, not re-running this file.
 */
const SCAN_ROOT = path.join(REPO_ROOT, "electron");
const EXCLUDED_DIR_NAMES = ["__tests__", "__typefixtures__"];

/**
 * Functions allowed to issue multiple writes unwrapped. EVERY entry needs a
 * reason. An entry whose reason is "it's fine" is a bug report.
 */
/**
 * An exemption is keyed `file::function`, never a bare name — BACKLOG-2990 chunk 5.
 *
 * A bare name is matched REPO-WIDE, so exempting one function silently exempts
 * every same-named function in `db/`. That is not hypothetical here: chunk 5
 * exempted `deleteLiveForceSet` in `macosForceSetSql.ts`, and
 * `emailForceSetSql.ts` has a namesake. The email one is inert today at a single
 * write — below this guard's threshold of two — but it would have been covered
 * silently the moment it grew.
 *
 * Third name-collision in this epic: BACKLOG-3061's method shadowed by an
 * identically-named live one, this guard's own known-list, and a reviewer pass
 * that matched `REPO_ROOT` and missed a guard using `ROOT`. A stated collision
 * is not hypothetical.
 */
const exemptKey = (f: { file: string; name: string }): string => `${f.file}::${f.name}`;

const EXEMPT: Record<string, string> = {
  // REMOVED by BACKLOG-2990 chunk 5: `runMigrations` and `applyMigration` were
  // exempted here, and both are METHODS on `electron/services/databaseService.ts`
  // — outside `DB_DIR`, which is `electron/services/db`. This guard has never
  // enumerated them, so those two exemptions were inert for their whole life.
  //
  // A bare-name key hid that: nothing distinguishes "exempted and needed" from
  // "exempted and never seen". Re-keying to `file::function` made me write the
  // path down, and there was no path to write. Deleting them shrinks the
  // exemption surface, which is the safe direction.
  // BACKLOG-2990 chunk 5. Three DELETEs, and they ARE atomic — this guard cannot
  // see it, because the transaction is one module away in `services/` and
  // `namesCalledInsideATransaction` scans only `db/` for `dbTransaction(`.
  //
  // Its ONE caller is `forceStaging.forceSwapSteps.deleteLiveForceSet`, itself
  // called only from inside the `db.transaction()` callback in
  // `swapStagingIntoLive` (forceStaging.ts:453). Verified by enumerating every
  // reference to the symbol, not by reading the nearest one.
  //
  // WRAPPING IT WOULD BE REDUNDANT, not merely stylistically wrong. better-sqlite3
  // implements a nested `db.transaction()` as a SAVEPOINT, so the failure semantics
  // of THIS path are unchanged — measured on the real driver, an uncaught throw
  // inside the inner transaction rolls back to the savepoint, rethrows, and aborts
  // the outer swap, leaving the user's corpus untouched exactly as it does today.
  // What nesting WOULD change is what a FUTURE caller could do: it makes a
  // partial-swap-survives-an-error state reachable by catching, on the one path
  // whose job is not to lose the user's messages. Transaction shape belongs to
  // item 6, not to a text move.
  //
  // These three writes lived in `services/` before this chunk and were invisible
  // to a guard that enumerates `db/`. The move did not create the exposure; it
  // made it visible.
  //
  // BACKLOG-2960 RE-KEYED, not re-argued: the three DELETEs now live in the
  // SYNCHRONOUS TWIN `deleteLiveForceSetSync`, because the seam export
  // `deleteLiveForceSet` became a promise-returning wrapper and a
  // `db.transaction()` body cannot await. The exemption follows the writes. The
  // reasoning above is unchanged — same three DELETEs, same single call path,
  // same reason nesting would be wrong — and this map still holds two entries.
  "electron/services/db/macosForceSetSql.ts::deleteLiveForceSetSync":
    "atomic via swapStagingIntoLive's db.transaction() body in macOSMessagesImportService/forceStaging.ts, its only call path (body -> forceSwapSteps.deleteLiveForceSet -> this twin); nesting would convert a swap-aborting failure into a savepoint rollback",
  // ==========================================================================
  // BACKLOG-3232 — THREE ASYNC ORCHESTRATORS, SURFACED BY THE CLASS WIDENING
  // ==========================================================================
  // These three are FALSE POSITIVES OF THE RULE, not of the enumerator: the
  // enumerator found them correctly and an `export async function` of the same
  // shape would read identically. They are EXEMPT and not `KNOWN_UNWRAPPED`
  // because that list admits CONFIRMED REAL VIOLATIONS only — quieting a false
  // positive there would mean filing a bogus item to cite, which is the
  // BACKLOG-3053 silencing this epic exists to end.
  //
  // WHAT THEY SHARE, and it is structural rather than stylistic: every counted
  // write is a separate awaited fetch-then-store round trip against a remote
  // provider, and `dbTransaction` takes a SYNCHRONOUS callback, so no
  // transaction can span them. This guard's own `localWriters` note already
  // says so — "an async orchestrator cannot be fixed with a `dbTransaction`
  // anyway" — which is why the local-helper closure is depth-1 and does not
  // propagate. The class widening is the first time that shape reached the
  // OFFENDER list, because these three are methods.
  //
  // NOT A BLANKET PASS FOR ASYNC. Each was opened and read, and each is a
  // resumable checkpoint loop whose partial state is its normal resting state,
  // not a corrupt one. A method that awaits between two writes belonging to ONE
  // logical action does not belong here — `_saveCommunications` in
  // `transactionService.ts` is exactly that and is listed as a real violation.
  "electron/services/emailSyncService.ts::precacheEmails":
    "eight awaited fetchStoreAndDedup round trips (inbox/all-folder/gmail/all-label, each with a backfill pass), every one a provider fetch followed by its own store; a crash between batches leaves fewer emails cached, which is the ordinary resumable state of an incremental cache and is healed by the next run's dedup on external_id",
  "electron/services/emailSyncService.ts::fetchOutlookEmails":
    "three awaited fetchStoreAndDedup round trips (inbox, sent, all-folder) against Microsoft Graph; same resumable-batch shape as precacheEmails above, and no dbTransaction can span an awaited network call because its callback is synchronous",
  // BACKLOG-3314: this reason used to call the terminal recordSyncSuccess /
  // recordSyncFailure pair "try/catch-exclusive". Measured, it is not. The
  // exemption stands; only that stated reason was wrong, and it is corrected here.
  "electron/services/shadowDeltaSyncService.ts::runOnce":
    "a per-folder delta loop that persists each folder's cursor only AFTER that folder is fully stored, which its own comment calls crash-safe per folder; the writes belong to different logical units by design and are separated by awaited Graph calls. NOT try/catch-exclusive (BACKLOG-3314 @0285e214c): four unseparated pairs, two of them plain sequences, so no try/catch rule would recover this slot; ensureSyncStateRow at :112 commits before the :115 throw that lands in the catch writing recordSyncFailure, and recordSyncSuccess is itself two statements (emailSyncStateService.ts:163-164). Harmless — an idempotent INSERT OR IGNORE and a failure counter — so the exemption stands",
  "electron/services/db/contactValueProvenanceBackfill.ts::relabelTypedContactValues":
    "called only from a migration — inside migration v60's migrate() at databaseService.ts:3276 — and EVERY migration is run by `const runInTransaction = currentDb.transaction(...)` at databaseService.ts:3513, verified by reading the caller, not inferred (BACKLOG-2569 re-checked these; they had drifted from :3231/:3468)",
};

/**
 * ===========================================================================
 * WHAT THE FIRST VERSION OF THIS GUARD GOT WRONG
 * ===========================================================================
 * It reported NINE unwrapped multi-write functions. **Six were false
 * positives.** The claim was made, filed and reported before any of the nine
 * was opened and read — the exact failure this whole feature exists to prevent,
 * committed by the guard meant to prevent it.
 *
 * (This paragraph said SEVEN until BACKLOG-2569. The seventh, `updateContactRole`,
 * was never a false positive — it was a REAL unwrapped multi-write that blind
 * spot 3 below hid. Reclassifying it corrected the headline to six.)
 *
 * Three blind spots produced them, all now fixed above:
 *
 *   1. **`db.transaction(...)` was not recognised as wrapping** — only the
 *      shared `dbTransaction(...)` helper was. `batchUpdateContactAssignments`
 *      was reported as the worst offender in the codebase (six writes) while
 *      having been transactional all along.
 *
 *   2. **Branch-exclusive writes were counted as sequential.** The upsert shape
 *      —  `if (existing) { UPDATE …; return; } INSERT …;`  — is two write
 *      STATEMENTS and never two WRITES. That accounted for
 *      `upsertEmailAttachmentMetadata`, `createLink`, `markContactAsImported`
 *      and `createEmail`.
 *
 *   3. **BACKLOG-2569 — one write regex, two different views of the body.**
 *      `writeCount` tested the JOINED body; `writesAreBranchExclusive` tested
 *      the SAME pattern line by line. A multi-line `UPDATE …\n SET …` matches
 *      the first and no single line of the second, so any function whose second
 *      write was multi-line was counted as multi-write and then silently
 *      cleared as branch-exclusive. It hid `updateContactRole` — two sequential
 *      unwrapped writes, listed under blind spot 2 above as though it were an
 *      upsert. Fixed by deriving both from one `WRITE_PATTERN` over one
 *      `stripComments()` view and ordering by character offset. The function
 *      itself was deleted (unreachable: no IPC handler, preload bridge or
 *      renderer caller); its shape survives as a transcribed fixture, because
 *      after the deletion that fixture is the only thing still proving this
 *      guard can catch the shape at all.
 *
 * A fourth was a reachability error no static rule would catch:
 * `relabelTypedContactValues` runs from a migration, and EVERY migration is
 * already wrapped by the runner at `databaseService.ts:3513`
 * (`currentDb.transaction(...)`). Established by reading the caller.
 *
 * **Two were real.** `deleteBySessionId` (fixed by BACKLOG-2480) and
 * `linkContactToTransaction` (fixed by BACKLOG-2543). `updateContactRole` was a
 * third, found only once blind spot 3 was closed.
 *
 * THE STANDING LESSON, since this guard exists to enforce it: **a tool that
 * reports a violation has not established one.** The list below is what a human
 * confirmed by opening the function, not what the scan emitted.
 */
/**
 * ===========================================================================
 * BACKLOG-2584 — KEYED `file::function`, AND WHAT MAY GO IN IT
 * ===========================================================================
 * This map was keyed by BARE NAME while `EXEMPT` above was re-keyed to
 * `file::function` by BACKLOG-2990 chunk 5. Both filters that read it — the
 * offender test's `exemptKey(f) in KNOWN_UNWRAPPED` and the shrink test's
 * `unwrapped().map(exemptKey)` — now use the same key, and they must be changed
 * together or the re-key is half-applied and the shrink test compares
 * `file::function` strings against bare names.
 *
 * The reason is the same one chunk 5 gave for `EXEMPT`, and it got stronger when
 * this guard's scan root widened to `electron/`. Measured at `0dca6beb1`:
 *
 *   electron/services/db  —  439 exported functions,  6 duplicate bare names
 *   electron/             — 1131 exported functions, 15 duplicate bare names
 *
 * `deleteLiveForceSet` — the exact name that motivated chunk 5 — is one of the
 * fifteen. A bare-name key across 1131 functions silences every namesake, and
 * this list went from 0 entries to a populated one in the same change.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY BE LISTED HERE — this is the rule, not a preference
 * ---------------------------------------------------------------------------
 * **An entry is a CONFIRMED REAL VIOLATION with a filed BACKLOG item, and it is
 * DELETED as that item ships.** A FALSE POSITIVE is never listed: it is fixed in
 * the heuristic, or exempted in `EXEMPT` above with a written reason under the
 * cap of 6.
 *
 * Stated because the widened root and the cite-an-item rule together create a
 * pressure that runs the wrong way — quieting a false positive by filing a bogus
 * item to cite. That is silencing by another route, and it is the failure
 * BACKLOG-3053 recorded: a known-list entry that made a refactor tidy while
 * preserving a live data-integrity defect.
 *
 * Every entry cites the SHA it was measured at, because a `file::function` key
 * survives line drift but the LINE NUMBERS inside these reason strings do not.
 * Re-derive them; do not hand-copy them forward.
 *
 * ---------------------------------------------------------------------------
 * THIS LIST IS A LOWER BOUND, NOT A COMPLETE SET
 * ---------------------------------------------------------------------------
 * A populated list invites the reading "these are the unwrapped multi-writes."
 * It is not. Two measured floors sit under it, and while either is open the
 * thirteen is a FLOOR:
 *
 *   - `captureBody` truncates on an inline object type in a parameter list, so
 *     some multi-write functions are counted as ZERO-write and can never appear
 *     here. 56 functions have the shape, 4 are multi-write, at `0dca6beb1`.
 *     Tracked by BACKLOG-3225.
 *   - Call-token counting is scoped OUT of `db/`. That is a floor with a
 *     measured size, not a proof of absence: turning it on surfaces EIGHT more,
 *     all real (a raw write plus a non-exported local helper that writes), of
 *     which six had no filed item until BACKLOG-3226. Tracked there.
 *
 *   - A write inside a NESTED PROMISE-RETURNING LITERAL is attributed to the
 *     unit that encloses it, so the headline can name a function that issues no
 *     writes. Two of this round's entries — `gmailFetchService::initialize` and
 *     `googleContactProvider::fetchContacts` — are exactly that: both only
 *     REGISTER the `oauth2Client.on("tokens", ...)` callback holding the writes.
 *     Pre-existing (`captureBody` does the same for an `export function`); the
 *     class widening only put it on more units. Population unmeasured. Tracked
 *     by BACKLOG-3311, which also names the in-tree fix shape.
 *
 *   - ~~A unit can ENUMERATE AND STILL COUNT ZERO~~ — **CLOSED by BACKLOG-3312**,
 *     and the sentence is corrected rather than deleted so a reader can see what
 *     changed. It read "`WRITE_PATTERN` reads literal SQL text only". The
 *     pattern was never at fault: `writeCount` takes a body string and nothing
 *     else, so there was no file to resolve a constant AGAINST. Hoisted SQL
 *     constants are now resolved through their declaration — see
 *     `readBindings` / `writeConstsIn` below. Measured at `8f17c1e16`: 21 units
 *     count more, 5 cross the threshold, TWO are real new offenders and are the
 *     last two entries in this list.
 *
 * Add a floor here when one is found; do not let the list's completeness be
 * assumed from its length.
 */
const KNOWN_UNWRAPPED: Record<string, string> = {
  // ==========================================================================
  // POPULATED BY BACKLOG-2584, from THIS GUARD'S OWN OUTPUT at `0dca6beb1`.
  // ==========================================================================
  // Not from a scratch harness: the list was emptied, the suite run, and these
  // thirteen are the offender test's own failure output. Each was then opened
  // and read before being classified — a tool that reports a violation has not
  // established one.
  //
  // Each damage string is TRANSCRIBED from its item's "Crash leaves" section,
  // not paraphrased. Line numbers here are as measured at `0dca6beb1` and drift;
  // the `file::function` keys do not.

  // --- BACKLOG-2546: DISCHARGED by the login-provisioning transaction -------
  // The three entries that were here (googleAuthHandlers::handleGoogleLogin,
  // ::handleGoogleCompleteLogin, microsoftAuthHandlers::handleMicrosoftLogin)
  // are deleted because their bug is fixed: all four login paths now commit the
  // user, token and session rows in one transaction owned by
  // `services/loginProvisioningService.ts`.
  //
  // READ THIS BEFORE TRUSTING THE DELETION. It is evidenced by the DIFF and by
  // the forced-crash suite `loginProvisioningAtomicity-2546.test.ts`, NOT by
  // this guard. This guard cannot tell "fixed" from "made invisible" here: the
  // fix turns five db/ exports into delegates, which drops them from
  // `dbLayerWriters()`, so the same three entries would also have to be deleted
  // if the handlers had been left completely untouched (measured). That is
  // BACKLOG-3238.

  // --- BACKLOG-2550 (critical, open): message link pointer vs junction ----
  "electron/services/messageMatchingService.ts::autoLinkTextsToTransaction":
    "BACKLOG-2550 @0dca6beb1 (:386, junction INSERT loop then one bulk messages UPDATE): junction rows with messages.transaction_id still NULL, so the message is re-offered as unlinked and the re-link is blocked only by the unique index",
  "electron/services/messageMatchingService.ts::autoLinkEmailsToTransaction":
    "BACKLOG-2550 @0dca6beb1 (:645, same shape on the email path): the pointer set with no junction row leaves the message invisible to every reader that joins through communications, while the messages table claims it is linked",
  "electron/services/autoLinkService.ts::expandAttachedThreadsForUser":
    "BACKLOG-2550 @0dca6beb1 (:1501, linkMessageToTransaction + createCommunicationReference): a thread expansion that half-ran leaves some messages of one attached conversation linked and the rest not, which reads to the user as a conversation that imported incompletely",

  // --- BACKLOG-2845 (open): review queue approve/reject -------------------
  "electron/services/reviewStateService.ts::approveReviewItems":
    "BACKLOG-2845 @0dca6beb1 (:1018, confirmEmailLinksByEmailIds + resolveLegacyTwins + createThreadCommunicationReference, in a for loop over itemIds): a crash part-way through approving a selection leaves some emails promoted and the rest still queued, with the pending_review row deleted for only some of them",
  "electron/services/reviewStateService.ts::rejectReviewItems":
    "BACKLOG-2845 @0dca6beb1 (:1071, addIgnoredCommunication + resolveLegacyTwins): a failure after the suppression row is written leaves the legacy address_missing link alive — the email is hidden from future discovery but still counted by getReviewState(), so the Complete gate never clears",

  // --- Filed by BACKLOG-2584 itself, before being listed here -------------
  "electron/handlers/contactHandlers.ts::ipc:contacts:import":
    "BACKLOG-3220 @1cd39acd0 (:1954, markContactAsImported + linkImportedContact across three for loops, PLUS backfillContactEmails + backfillContactPhones on the same path — 4 counted writes became 6 when BACKLOG-3235 restored the two twin facades to the writer set; zero dbTransaction anywhere in the handler): some contacts marked imported with their crosswalk link written and others marked imported with no link, so those source rows are never suppressed and re-offer on the next pass — and now also a contact whose emails were backfilled while its phones were not",

  // --- BACKLOG-3259 (open): surfaced BY BACKLOG-3235's own fix ------------
  // Listed, never fixed: the widening PR must list what it surfaces or CI is
  // red and it cannot land; fixing a surfaced defect belongs to its own item.
  "electron/handlers/contactHandlers.ts::ipc:contacts:create":
    "BACKLOG-3259 @1cd39acd0 (:2547, createContact :2717 + backfillContactEmails :2774 + backfillContactPhones :2778, zero dbTransaction in the handler): reachable WITHOUT a crash — the catch arm at :2801-2815 returns { success: false } with no compensating delete, so an ordinary throw from either backfill (a malformed email or phone is enough) leaves the contact row committed and visible in Clients & Contacts holding the name and only some of the addresses the user typed, while the UI tells them it was not created; the user retries and gets a SECOND contact",
  "electron/handlers/emailLinkingHandlers.ts::ipc:transactions:link-emails":
    "BACKLOG-3221 @0dca6beb1 (:169, createCommunication + createEmail unwrapped): a communications junction row whose email_id points at an emails row that was never written, so the email is invisible to every reader that joins through it — or the inverse, an email row with no link, absent from the transaction it was just attached to",
  "electron/handlers/messageImportHandlers.ts::ipc:messages:import-macos":
    "BACKLOG-3222 @0dca6beb1 (:148, backfillContactCommunicationDates :278 + backfillPhoneLastMessageTable :302): contacts showing a refreshed last-communication date while phone_last_message still holds the pre-import value, so the contact list and the phone-keyed views disagree until the next successful import",

  // ORIGINAL NOTE, kept because it records why this list was empty and why the
  // nine-entry version of it was discarded rather than merged:
  // EMPTY — and that is the honest result. Six of the nine this list started
  // with were false positives (see the correction above); `deleteBySessionId`
  // was fixed by BACKLOG-2480, `linkContactToTransaction` by BACKLOG-2543, and
  // `updateContactRole` — mislabelled a false positive, actually real — was
  // deleted as unreachable by BACKLOG-2569.
  //
  // ==========================================================================
  // BACKLOG-3232 — SURFACED BY THE CLASS WIDENING, NEWLY FILED
  // ==========================================================================
  // Six units that no guard had ever enumerated, each opened and read before
  // being classified, each filed as its own item, none fixed here. Damage
  // strings are TRANSCRIBED from the filed items' "Crash leaves" sections, not
  // paraphrased from the code — a reader following the citation must find the
  // same sentence. Measured at `abaa1ff20`; line numbers drift, the keys do not.
  //
  // TWO SITES SHARE ONE ITEM. BACKLOG-3306 is one duplicated defect at two
  // call sites, so it takes two entries. Deleting only one of them when 3306
  // ships leaves the other as `fixedButStillListed` and reddens the shrink
  // test — which is the intended behaviour, not a trap.
  //
  // NEITHER OF THESE TWO UNITS ACTUALLY WRITES. BACKLOG-3311: the reported
  // function only REGISTERS the callback that holds the writes. The entries are
  // keyed on what this guard reports, so they will need re-keying when 3311
  // lands. Written down because an entry pointing at the wrong unit survives
  // the fix and then blocks the "may only SHRINK" assertion.
  "electron/services/gmailFetchService.ts::initialize":
    "BACKLOG-3306 — one token column updated and the other stale: a stored new refresh_token beside an expired access_token. Self-healing, which is why it is low: the next API call 401s, the refresh fires again and both are written.",
  "electron/services/providers/googleContactProvider.ts::fetchContacts":
    "BACKLOG-3306 — the same duplicated token-refresh callback as gmailFetchService above, writing the two UPDATEs in the opposite order; a crash leaves one token column updated and the other stale.",
  "electron/services/localSyncService.ts::storeContacts":
    "BACKLOG-3307 — every unchanged contact row keeps an older synced_at and reads as 'not present in the latest sync', so the identity crosswalk's reassignment guard is silently disabled for android_sync and a phone number that has moved between two people binds to the WRONG contact and is never flagged. Persists until the next full snapshot.",
  "electron/services/transactionService/transactionService.ts::_saveCommunications":
    "BACKLOG-3308 — an emails row with no communications row: the email is stored but not attached to the transaction, so it does not appear on it. Partially self-healing, but only if a scan re-runs and nothing schedules one on this condition.",
  "electron/services/transactionService/transactionService.ts::unlinkCommunication":
    "BACKLOG-3309 — the email is simultaneously still linked (the communications row survives) and suppressed (the ignored_communications row exists); the next auto-link scan keeps it linked while it also sits in the ignore set. The email twin of BACKLOG-2547, at a site 2547 does not name.",
  "electron/services/transactionService/transactionService.ts::restoreRemovedEmailThread":
    "BACKLOG-3310 — the email is neither ignored nor linked: it disappears from 'Show removed emails' AND does not reappear on the transaction, so the user's route back to it is gone and nothing re-derives it.",

  // ==========================================================================
  // BACKLOG-3232 — SURFACED BY THE CLASS WIDENING, ALREADY-FILED SITES
  // ==========================================================================
  // These three were named in an open item BEFORE this widening and had no
  // standing red, because the guard enumerated nothing from their files. They
  // are the item's whole point: the control existed on paper and not in the
  // build. Each cites the item that already owns the fix; none is fixed here.
  // Damage strings transcribed from those items, not restated from the code.
  //
  // Measured at `abaa1ff20`. The items' own line numbers have drifted (2552
  // says `:326`, 2550 says `:2069-2107`, 2547 says `:2150-2256`); the
  // `file::function` key survives that drift, which is why it is the key.
  "electron/services/iPhoneSyncStorageService.ts::rollbackSession":
    "BACKLOG-2552 — a half-rolled-back sync session: attachment rows deleted while their parent message rows remain, or messages gone while contacts survive. The rollback that exists to guarantee an atomic cancel is itself non-atomic.",
  "electron/services/transactionService/transactionService.ts::linkMessages":
    "BACKLOG-2550 — junction rows written with messages.transaction_id still NULL, so the message is re-offered as unlinked; or the inverse, the pointer set with no junction row, so the message is invisible to every junction reader. Transient, not permanent: INSERT OR IGNORE plus the unique indexes make a re-run idempotent.",
  "electron/services/transactionService/transactionService.ts::unlinkMessages":
    "BACKLOG-2547 — the suppression row written but the link DELETE never ran, so the message is simultaneously linked (junction row survives) and suppressed (ignore row exists); the next auto-link scan keeps it linked while it also sits in the ignore set.",


  // ==========================================================================
  // BACKLOG-3312 — SURFACED BY CONSTANT RESOLUTION
  // ==========================================================================
  // Both ran HOISTED SQL CONSTANTS, so every previous version of this guard
  // counted them as ZERO-write and reported them clean. Neither is new code and
  // neither is fixed here; what is new is that the guard can see them.
  //
  // Measured at `8f17c1e16`: these two are the ENTIRE pipeline-surviving
  // population of the widening — 21 units count more, 5 cross the threshold,
  // and the other three were each opened and read (two are genuinely atomic,
  // one was a false positive of a naive resolver). The unwrapped set goes
  // 18 -> 20 and loses nothing.
  //
  // Damage strings TRANSCRIBED from each item's "Crash leaves" section. Note
  // that `pruneOldEntries` cites 3319 and NOT its parent BACKLOG-2554, which
  // names the same site: an entry citing a nine-bullet batch survives until the
  // batch closes, so if 2554 shipped with this bullet unfixed the entry would
  // cite a completed item while preserving a live defect — the BACKLOG-3053
  // shape. The bullet was split out of 2554's scope for exactly that reason.
  "electron/services/failureLogService.ts::pruneOldEntries":
    "BACKLOG-3319 — the age DELETE commits and the cap DELETE does not, so the failure log keeps rows above the 500-row cap until the next startup prunes again. Diagnostics only — no user-visible record is lost. That is why this is low despite inheriting from a critical batch.",
  "electron/services/reviewStateService.ts::restoreRejectedToQueue":
    "BACKLOG-3320 — a crash after the INSERT and before the DELETE leaves the item queued for review AND still listed as rejected: it appears twice, in two places that contradict each other. It loops per sibling, so a multi-email thread can end up part-restored. The MIRROR of BACKLOG-3310, not the same failure — that one writes in the opposite order and leaves NEITHER.",

  // ==========================================================================
  // BACKLOG-3239 — SURFACED BY THE BRANCH-EXCLUSIVITY FIX
  // ==========================================================================
  // The branch rule cleared a pair whenever a `} else` closed the arm holding
  // the EARLIER write, without ever checking where the LATER write was. This
  // handler is the one live site that rode on it, and it is the deep-link login
  // the founder actually uses.
  //
  // Measured at `73d3e3fbe`: of the nine units cleared only by this predicate,
  // four were cleared by a `} else` and five by a `return` (BACKLOG-3224's arm,
  // untouched). Of those four, THREE are genuinely exclusive and stay cleared —
  // each was opened and read, not inferred: `contactHandlers::ipc:contacts:get-available`
  // (a `} else if` arm), `contactDbService::markContactAsImported` and
  // `emailAttachmentService::processAttachment` (both one write per arm). This
  // entry is the ENTIRE surfaced population, and it is not empty, which is the
  // bar BACKLOG-3248 sets for a widening.
  //
  // NOT FIXED HERE. Damage transcribed from BACKLOG-3322, which owns the path.
  "electron/handlers/systemHandlers.ts::ipc:system:initialize-secure-storage":
    "BACKLOG-3322 — the macOS deep-link login provisions the user, token and session as separate writes, so a crash between them leaves a local users row with no durable session: no session.json on disk, and the relaunch that grants Full Disk Access lands the founder back on a failed-login screen while `ensureUserInLocalDb` reports 'already exists -> success' over it. The counted pair is `createUser` at systemHandlers.ts:562 and `createLocalUserFromCloud` at :651. BACKLOG-3253 removes the DB-init deferral this catch-up path exists to compensate for, and BACKLOG-3322 carries the open Fork D question of what this path should do when tokens are absent.",

  // MERGE NOTE: the incoming side of this conflict was the original nine-entry
  // list. It is deliberately discarded, not merged — every entry in it was
  // either fixed or never a violation, and re-adding one would fail the
  // "may only shrink" test below.
};

interface Fn {
  file: string;
  name: string;
  line: number;
  body: string;
  /**
   * Predicate for "this identifier is a db-layer write", or `null` INSIDE the
   * db layer. See `dbLayerWriters` for why `db/` keeps the raw-SQL rule.
   */
  isDbWriterCall: ((name: string) => boolean) | null;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.includes(entry.name)) continue;
      out.push(...sourceFiles(p));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Brace-matched body of the function starting at `startLine`.
 *
 * ===========================================================================
 * STATED FLOOR — BACKLOG-3225, FOUND BY A CONTROL THAT DID NOT GO RED
 * ===========================================================================
 * This matches braces from the DECLARATION line, so a parameter list holding an
 * INLINE OBJECT TYPE closes the capture before the body opens:
 *
 *     export function f(row: { a: string; b: string }): void {   // capture ends
 *       dbRun(`INSERT INTO x ...`);                              // never seen
 *
 * The function then reads as having NO BODY: zero writes, zero transaction.
 *
 * Measured at `0dca6beb1` across scan root `electron/`: 56 exported functions
 * have a truncated capture, and FOUR have >= 2 SQL writes in their true body
 * while this guard counts 0 — `contactDbService.ts:520 createContactsBatch`,
 * `:2729 syncContactEmails`, `:2825 syncContactPhones`, and
 * `emailSyncStateService.ts:104 updateCachedBounds`. All four are in `db/`, so
 * this floor predates the widened root; it is not a cost of BACKLOG-2584.
 *
 * Severity today is ONE defect: the first three are self-wrapped and would not
 * be offenders if visible, and `updateCachedBounds` is already filed in
 * BACKLOG-2554. Severity tomorrow is not bounded — any new multi-write written
 * with an inline-typed parameter is invisible, and 56 functions already have the
 * shape.
 *
 * Filed as BACKLOG-3225 with the fix (capture from the matching `)` of the
 * parameter list). Not fixed here: this PR is capped at two heuristic changes
 * and already carries both.
 *
 * HOW IT WAS FOUND, because the method matters more than the bug: control 5 of
 * BACKLOG-2584 planted a deliberately unwrapped multi-write and the guard stayed
 * GREEN. The rule is to suspect the fixture before the control — the planted
 * function had an inline object type in its parameters. The plant was wrong AND
 * the guard was wrong, and only chasing the silent control found the second one.
 */
function captureBody(lines: string[], startLine: number): string {
  let depth = 0;
  let started = false;
  const buf: string[] = [];
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    buf.push(line);
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth <= 0) break;
  }
  return buf.join("\n");
}

/**
 * An `ipcMain.handle(...)` registration as its own unit, captured by PARENTHESIS
 * span rather than by brace matching.
 *
 * BACKLOG-2584: brace matching is wrong here in both directions. A registrar
 * function's body brace-matches every handler it registers, so
 * `registerContactHandlers` reads as one function issuing eight writes — the
 * headline is then a function that does not exist. And a ONE-LINE registration
 * (`ipcMain.handle("x", handlerFn);`) contains no brace at all, so a
 * brace-matched capture runs on into the FOLLOWING handlers and reports several
 * registrations with identical write sets. Both were live in an earlier
 * measurement of this task; three `sharedAuthHandlers` rows were the same body.
 *
 * Reading the channel from the `handle(` line alone is also wrong: at
 * `0dca6beb1` only 80 of 323 registrations put the channel on that line, so 243
 * would go unenumerated — 75% of the IPC surface, silently.
 *
 * So: track paren depth from `handle(`. If a `{` opens first, the unit is that
 * block. If the paren closes with no block, the handler was registered BY NAME
 * and the identifier is resolved to its declaration in the same file.
 */
function captureHandlerUnit(
  lines: string[],
  startLine: number
): { body: string | null; channel: string | null; refName: string | null } {
  let paren = 0;
  let sawParen = false;
  let brace = 0;
  let sawBrace = false;
  const buf: string[] = [];
  let flat = "";
  const startCol = lines[startLine].indexOf("ipcMain.handle(");
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    buf.push(line);
    flat += line + " ";
    for (let j = i === startLine ? startCol : 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === "(") {
        paren++;
        sawParen = true;
      } else if (ch === ")") {
        paren--;
        if (sawParen && paren <= 0 && !sawBrace) {
          const m = /ipcMain\.handle\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z0-9_.]+)\s*\)/.exec(flat);
          return { body: null, channel: m ? m[1] : null, refName: m ? m[2] : null };
        }
      } else if (ch === "{") {
        brace++;
        sawBrace = true;
      } else if (ch === "}") {
        brace--;
        if (sawBrace && brace <= 0) {
          const m = /ipcMain\.handle\(\s*["'`]([^"'`]+)/.exec(flat);
          return { body: buf.join("\n"), channel: m ? m[1] : null, refName: null };
        }
      }
    }
  }
  return { body: null, channel: null, refName: null };
}

/**
 * Every function exported from `electron/services/db` that issues at least one
 * SQL write in its own body — the ground truth the composition rule stands on.
 * 114 of 439 at `0dca6beb1`.
 *
 * ~~STATED FLOOR: this is derived from body TEXT, so a db-layer function that
 * writes through a hoisted SQL constant is missing from it.~~ **CLOSED by
 * BACKLOG-3312** — kept and struck through, because the floor being written
 * down with a name is what made it closeable. It named ONE function at
 * `0dca6beb1`, `emailSyncSql.ts:263 clearSyncCursor`. Re-measured at
 * `8f17c1e16` there were TWO, `clearSyncCursor` and
 * `externalContactDbService.ts:978 updateLastMessageAtFromLookupTable`, and the
 * writer set goes 127 -> 129 with both admitted. `dbLayerWriters` resolves the
 * constants; `writersFrom` stays a pure function over declarations and reads the
 * count off the `constWrites` field, so the BACKLOG-3235 fixtures are untouched.
 * Pinned by `a db/ writer that hoists its statement is in the writer set`.
 *
 * A builder that RETURNS SQL rather than executing it is also in this set —
 * `claimMessagesForTransactionSql09` builds a `SafeSql`. A builder call is not
 * itself a write, and a builder-plus-executor pair for one logical write counts
 * as two. That is why every reported offender is dispositioned by reading the
 * function, never by trusting this set.
 */
/**
 * The exported `db/` function declarations of ONE file, as name + captured body.
 *
 * Split out of `dbLayerWriters` by BACKLOG-3235 so `writersFrom` below is a PURE
 * function over declarations and a fixture can run the real derivation over a
 * transcribed source string. Before the split there was no way to test the
 * writer-set rule at all: `dbLayerWriters` read the disk, so every fixture in
 * this file could only ever exercise what happens AFTER the set is built.
 */
function dbWriterDeclsIn(lines: string[]): { name: string; body: string }[] {
  const decls: { name: string; body: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(lines[i]);
    if (!m) continue;
    decls.push({ name: m[1], body: captureBody(lines, i) });
  }
  return decls;
}

/**
 * ===========================================================================
 * BACKLOG-3235 — A WRITER THAT MOVED INTO A SYNCTWIN IS STILL A WRITER
 * ===========================================================================
 * Pass 1 is the raw-SQL rule, unchanged. Pass 2 is the one heuristic change
 * this PR carries.
 *
 * THE DEFECT. The syncTwin recipe (`electron/__tests__/syncTwin.guard.test.ts`)
 * moves a writer's body into `<name>Sync` and leaves `<name>` a one-line
 * delegate holding NO SQL. Under pass 1 alone the promise-returning name drops
 * out of this set, and because call sites are resolved by BARE NAME, every
 * caller outside `db/` silently stops counting that write. The guard's coverage
 * shrank as the epic that depends on it advanced.
 *
 * THE RULE. A `db/` export whose own body holds no SQL, whose `<name>Sync`
 * sibling IS a pass-1 writer, and whose body REFERENCES that sibling, is a
 * writer. Two passes over the pass-1 set — no fixpoint, so the result does not
 * depend on declaration order.
 *
 * This is a RESTORATION, not a wider predicate. Measured at `1cd39acd0`:
 * `writersFrom(decls) minus pass-1-only` is set-equal, element for element, to
 * the seven names BACKLOG-3238 enumerates. It makes writer-set membership
 * INVARIANT under the syncTwin refactor and changes nothing else.
 *
 * POPULATION, measured at `1cd39acd0`: EIGHT `db/` wrappers hold no SQL and
 * delegate to a writing twin; SEVEN of them are de-detected. The eighth,
 * `macosForceSetSql.ts:284 deleteLiveForceSet`, is masked — the UNRELATED
 * `emailForceSetSql.ts:201 deleteLiveForceSet` runs a `DELETE FROM emails` and
 * keeps the bare name in the pass-1 set, so pass 2 skips it at the first
 * `continue`. Its callers count a write for the wrong reason. The seven is
 * therefore conditional on that function: give IT a twin and the eighth name
 * de-detects too, and pass 2 restores it. Stated with its condition so a later
 * count of eight reads as the condition being met, not as drift.
 *
 * WHY THE BODY CHECK IS HERE THOUGH IT CHANGES NOTHING TODAY. Measured: with
 * and without it the writer set is 122 and the offender set identical, at this
 * SHA. It is not decoration. `base` is a set of BARE NAMES over 434 unique
 * names with SIX measured duplicates (`columnList`, `createStagingTable`,
 * `deleteLiveForceSet`, `dropStagingTable`, `mirrorStagingIndexes`,
 * `selectExistingExternalIds`). Without the body check, a `foo` in one file
 * pairs with a writing `fooSync` in ANOTHER by naming coincidence alone, with no
 * evidence that `foo` delegates to anything. This guard has been burned by
 * bare-name matching twice already — EXEMPT's re-key to `file::function`, and
 * `deleteLiveForceSet` again in the measurement above. The check is pinned by
 * `a db/ export that does not reference its twin is not admitted`; delete the
 * check and that test goes red.
 *
 * IT MUST NOT BE KEYED ON `Promise.resolve`. Measured: only THREE of the seven
 * use `return Promise.resolve(xSync(...))`. The other four are
 * `export async function x(...) { return xSync(...); }` with no `Promise.resolve`
 * at all. A shape check on the ruled wrapper text would miss four of seven.
 *
 * IT PROTECTS A FIXTURE. BACKLOG-3238 records that 2546's `updateUser` twin
 * flips the `THREE_HANDLERS_ONE_WRITE_EACH` fixture below from [1,1,1] to
 * [0,1,1]. Pass 2 keeps `updateUser` in the set once that twin lands, so the
 * fixture stays green rather than needing an edit.
 *
 * Cited by NAME, deliberately. This line carried a line number through three
 * hands — BACKLOG-3238 measured it at `bea54238f`, the plan review repeated it,
 * and it landed here as `:1324` — while the fixture is at `:1253` at
 * `1cd39acd0` and moves again with every edit to this file. A number that names
 * a location INSIDE the file citing it stales itself; a name does not.
 *
 * STATED FLOORS — measured sizes, not absences. None of these is fixed here.
 *
 *   1. NON-TWIN DELEGATION, seven names at `1cd39acd0`:
 *      `createTransactionWithContactsSync`, `fullSync`,
 *      `getContactsSortedByActivity`, `getOrCreateLLMSettings`,
 *      `syncContactsBySource`, `syncGoogleContacts`, `upsertFromOutlook`.
 *      A `db/` export holding no SQL that reaches a writer through a call which
 *      is NOT its `<name>Sync` twin stays out of this set. These are REAL
 *      exposures under this guard's own rule — a caller invoking one of them
 *      plus one more write can half-happen — not artefacts. Admitting them is a
 *      WIDER PREDICATE with its own unfiled population, which is why it is not
 *      done here. BACKLOG-3238 is narrowed to exactly these seven and stays
 *      OPEN. Measured consequence today: one unit,
 *      `contactHandlers.ts ipc:contacts:get-available`.
 *
 *   2. BARE-NAME MASKING: `macosForceSetSql.ts:284 deleteLiveForceSet`, above.
 *      Sibling of BACKLOG-3223's clearing-set floor.
 *
 *   3. BACKLOG-3225 TRUNCATION hides FIVE `db/` writers from pass 1, so pass 2
 *      cannot pair with them either: `batchInsertMessages`,
 *      `createContactsBatch`, `syncContactEmails`, `syncContactPhones`,
 *      `updateCachedBounds`. (3225's body names four on a ">= 2 writes" test;
 *      writer-set membership needs only one, so the number here is five.)
 *      Measured at `1cd39acd0`: 12 `db/` exports truncate, and ZERO of the ten
 *      same-file twin pairs do — on either side — so 3225 does not blind pass 2
 *      at this SHA.
 *
 * `followTwins` exists ONLY so a fixture can derive both sets from one
 * declaration list and assert the DIFFERENCE. No production caller passes it;
 * `dbLayerWriters()` takes the default.
 */
function writersFrom(
  decls: { name: string; body: string; constWrites?: number }[],
  followTwins = true
): Set<string> {
  const base = new Set<string>();
  // BACKLOG-3312: `constWrites` is supplied by `dbLayerWriters`, which has the
  // file in hand. This function still touches no disk, so the BACKLOG-3235
  // fixtures keep running the REAL derivation over a transcribed source string.
  for (const d of decls) if (writeCount(d.body) + (d.constWrites ?? 0) >= 1) base.add(d.name);
  if (!followTwins) return base;

  const writers = new Set(base);
  for (const d of decls) {
    if (base.has(d.name)) continue;
    if (!base.has(d.name + "Sync")) continue;
    if (!new RegExp("\\b" + d.name + "Sync\\s*\\(").test(stripComments(d.body))) continue;
    writers.add(d.name);
  }
  return writers;
}

function dbLayerWriters(): Set<string> {
  const decls: { name: string; body: string; constWrites?: number }[] = [];
  for (const file of sourceFiles(DB_DIR)) {
    for (const d of dbWriterDeclsIn(fs.readFileSync(file, "utf8").split("\n"))) {
      decls.push({ ...d, constWrites: constWriteOffsets(stripComments(d.body), file).length });
    }
  }
  return writersFrom(decls);
}

/**
 * The units of one file: exported functions, plus each `ipcMain.handle`
 * registration. A registrar function is dropped once its handlers are units in
 * their own right — otherwise the same writes are counted twice, at a
 * granularity that names no real function.
 *
 * Exported as its own function so a fixture can run the real enumeration over a
 * transcribed source string. That is what makes the "we do NOT see a
 * non-violation" control possible at all.
 */
/**
 * ===========================================================================
 * BACKLOG-3232 — A CLASS-SHAPED SERVICE ENUMERATED NOTHING AT ALL
 * ===========================================================================
 * Until this function existed, a unit was recognised from exactly two shapes:
 * `/^export\s+(?:async\s+)?function\s+.../` and an `ipcMain.handle(`
 * registration. A service written as a CLASS matches neither, so the guard
 * enumerated ZERO units from the entire file and every method in it was
 * invisible at any scan root. Not "checked and passed" — never looked at.
 *
 * Measured at `abaa1ff20` (`electron/`, the guard's own exclusions):
 * 467 production `.ts` files, 102 declare a class, and 80 of those yielded
 * ZERO guard-enumerable units. `databaseService.ts` (171 members) and
 * `transactionService/transactionService.ts` (35) were two of them.
 *
 * THE SYMPTOM WAS ALREADY WRITTEN DOWN HERE, UNGENERALISED. The `EXEMPT` block
 * above says `runMigrations` and `applyMigration` "are METHODS on
 * electron/services/databaseService.ts ... This guard has never enumerated
 * them, so those two exemptions were inert for their whole life." That was read
 * as a keying problem. It was this.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MIRROR AND NOT A LIFT — deliberate duplication, with a reason
 * ---------------------------------------------------------------------------
 * `electron/__tests__/syncTwin.guard.test.ts` scans the same root with a real
 * `ts.SourceFile` and already sees class methods. The shape below is copied
 * from it: its `productionSources` walk, its `ts.createSourceFile(..., true)`
 * call, and the `isFnLike` / `hasModifier` member test.
 *
 * It is COPIED, not shared, and that is a choice:
 *
 *   - syncTwin's `FnNode` union EXCLUDES `ConstructorDeclaration`. This guard
 *     needs constructors — a constructor issuing two writes is a real defect.
 *   - syncTwin's `declaredName` resolves `VariableDeclaration` and
 *     `PropertyAssignment` parents, not `PropertyDeclaration`, so a class
 *     property holding an arrow function gets no name there.
 *
 * Widening either one to serve THIS guard changes syncTwin's candidate set,
 * its `calleeNames` boundary walk and its owner resolution. The two guards
 * protect DIFFERENT invariants, and coupling them means a regression in one
 * is indistinguishable from a regression in the other. The duplication is
 * cheaper than that. Unifying them later is a separate item with its own
 * justification — do not do it as a drive-by.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS A UNIT HERE, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * Every method, constructor and function-valued property of every class in the
 * file — INCLUDING `private` ones. Measured at `abaa1ff20`: 751 methods,
 * 333 private methods, 57 constructors, 2 private constructors, and ZERO
 * function-valued properties.
 *
 * PRIVATE IS DELIBERATE. For a module-level `function`, a non-exported helper
 * that writes is attributed to its caller by the depth-1 `localWriters` closure
 * below. That closure is built from the module-level `function` regex and has
 * NEVER seen a method, so a private method gets NO attribution anywhere.
 * Excluding it would leave its writes invisible at every root — the exact
 * defect this change exists to fix. Four of the twelve units this widening
 * surfaced are private, including `iPhoneSyncStorageService.rollbackSession`,
 * which is BACKLOG-2552's own named site.
 *
 * STATED FLOOR, WITH A MEASURED SIZE — `localWriters` IS NOT WIDENED HERE.
 * A public method that calls a private writing METHOD counts that call as ZERO
 * writes. Measured at `abaa1ff20`: 18 private members carry at least one
 * counted write. SIX carry two or more and are therefore checked as units in
 * their own right — four are reported offenders, two clear (`emailSyncService.ts`
 * `fetchGmailEmails` and `emailAttachmentService.ts` `processAttachment`). The
 * remaining TWELVE carry exactly one write, which is below this guard's
 * threshold and is contributed to no caller — so those twelve writes are
 * counted nowhere.
 * Widening `localWriters` to methods is a wider predicate with its own
 * unmeasured population; this change already carries one heuristic change, and
 * BACKLOG-2584 / 3235 set the convention of at most one per PR.
 *
 * ---------------------------------------------------------------------------
 * KEYS: A CONSTRUCTOR IS NAMED `<ClassName>.constructor`
 * ---------------------------------------------------------------------------
 * `EXEMPT` and `KNOWN_UNWRAPPED` are keyed `file::name`. Measured across all
 * 2,546 units with a BARE `constructor` name, that key collided exactly THREE
 * times — `supportAccessService.ts`, `tokenEncryptionService.ts`, and
 * `types/database.ts` (five classes) — every one of them a file holding two or
 * more classes. ONE entry would have silently covered all of them, which is the
 * bare-name failure this guard has already been burned by three times.
 *
 * Methods keep their BARE name on purpose: `name` is matched against the
 * `namesCalledInsideATransaction` clearing set and is passed as `selfName` to
 * strip self-recursion, and both of those are bare-name comparisons. A
 * constructor is never a call token — `new Foo()` does not match
 * `\bconstructor\s*\(` — so the dotted form is safe there and nowhere else.
 * Pinned by the unit-key PRECONDITION below, which asserts the collision COUNT
 * as well as its absence.
 *
 * NO DOUBLE COUNTING. Measured at `abaa1ff20`: 113 classes under `electron/`,
 * ZERO declared inside a function and ZERO anonymous. A class nested in an
 * enumerated function would have its writes counted twice, once in the method
 * and once in the enclosing function; none exists, and the unit-key
 * PRECONDITION would catch the name collision if one appeared.
 */
function classMemberUnits(
  rel: string,
  lines: string[],
  isDbWriterCall: ((name: string) => boolean) | null
): Fn[] {
  const sf = ts.createSourceFile(rel, lines.join("\n"), ts.ScriptTarget.ES2020, true);
  const out: Fn[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      const className = n.name?.text ?? "<anonymous>";
      for (const member of n.members) {
        let name: string | null = null;
        if (ts.isMethodDeclaration(member) && member.body) {
          name = ts.isIdentifier(member.name) ? member.name.text : null;
        } else if (ts.isConstructorDeclaration(member) && member.body) {
          name = `${className}.constructor`;
        } else if (
          ts.isPropertyDeclaration(member) &&
          member.initializer &&
          (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))
        ) {
          name = ts.isIdentifier(member.name) ? member.name.text : null;
        }
        if (!name) continue;
        out.push({
          file: rel,
          name,
          line: sf.getLineAndCharacterOfPosition(member.getStart(sf)).line + 1,
          body: member.getText(sf),
          isDbWriterCall,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function unitsInFile(rel: string, lines: string[], dbWriters: Set<string>): Fn[] {
  const inDbLayer = rel.startsWith("electron/services/db/");

  // Declarations in this file, for identifier-registered handlers and for the
  // local-helper closure below.
  const declared = new Map<string, { line: number; body: string; exported: boolean }>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(lines[i]);
    if (m) {
      declared.set(m[2], { line: i + 1, body: captureBody(lines, i), exported: Boolean(m[1]) });
    }
  }

  // A NON-EXPORTED helper in the same file that reaches a db-layer write counts
  // as a write at its call site. Depth 1, no propagation into exported units:
  // full closure makes every caller-of-two-callers an offender, and an async
  // orchestrator cannot be fixed with a `dbTransaction` anyway.
  //
  // This is what sees BACKLOG-2549: `markFirstExport` in
  // `transactionExportHandlers.ts` is exactly this shape, wrapping
  // `stampFirstExportedAt`.
  const localWriters = new Set<string>();
  for (const [name, decl] of declared) {
    if (decl.exported) continue;
    let reaches = writeCount(decl.body) >= 1;
    if (!reaches) {
      for (const call of stripComments(decl.body).matchAll(/\b([A-Za-z0-9_]+)\s*\(/g)) {
        if (call[1] !== name && dbWriters.has(call[1])) {
          reaches = true;
          break;
        }
      }
    }
    if (reaches) localWriters.add(name);
  }

  // Inside `db/` the raw-SQL rule stands and call tokens are OFF. `db/` is the
  // leaf layer: its functions hold the SQL, so a uniform rule would have them
  // counting each other, and a writer's own declaration line matches its own
  // call pattern.
  //
  // MEASURED, not assumed. With call tokens ON inside `db/` and own-name
  // stripping applied, the offender set goes 13 -> 21 at `0dca6beb1`. The eight
  // additions are all in `db/`: communicationDbService.ts createCommunication
  // (:80), deleteCommunication (:333), deleteCommunicationByMessageId (:367),
  // createCommunicationReference (:732), createThreadCommunicationReference
  // (:1017), deleteCommunicationByThread (:1061), and emailSyncStateService.ts
  // recordSyncSuccess (:158) / recordSyncFailure (:173).
  //
  // The delta is NOT noise: the last two are named in BACKLOG-2554 as "two
  // unwrapped statements" already.
  //
  // CORRECTED BY BACKLOG-3312 — this used to say they are invisible to the
  // raw-SQL rule "because one of each pair goes through a hoisted SQL
  // constant". That was not true when it was written. Measured at `8f17c1e16`:
  // `recordSyncSuccess` and `recordSyncFailure` each hold ONE INLINE `sql` tag
  // and ZERO constant references, and `git show 0dca6beb1` shows the SQL was
  // already inline at the SHA the paragraph cites. Their second write is the
  // `ensureSyncStateRow(...)` CALL, invisible for the reason this paragraph is
  // actually about — call tokens are OFF inside `db/`. So resolving constants
  // does NOT close these two; BACKLOG-3226 still owns them. The sentence is
  // corrected rather than deleted because a known-false comment left in place
  // is worse than the defect it describes.
  //
  // So the scoped-out decision is a FLOOR, not a proof of absence, and the floor
  // has a measured size. Not adopted here — eight new dispositions inside the
  // write-densest directory in the repo is its own task, and SR ruled it comes
  // back for review rather than being absorbed.
  //
  // SO THIS IS A FLOOR WITH A MEASURED SIZE, NOT A PROOF OF ABSENCE. SR
  // decomposed the eight and they are real, not artifacts of the uniform rule:
  // the six in communicationDbService.ts are a raw write plus a call to
  // `updateTransactionThreadCountInternal` (:1236), a non-exported local helper
  // holding its own UPDATE. Two are filed in BACKLOG-2554; the six are filed as
  // BACKLOG-3226, which also carries the rule change. Do not read the scoped-out
  // decision as "nothing is there".
  const isDbWriterCall = inDbLayer
    ? null
    : (name: string) => dbWriters.has(name) || localWriters.has(name);

  const found: Fn[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/ipcMain\.handle\s*\(/.test(lines[i])) {
      const handler = captureHandlerUnit(lines, i);
      if (handler.body) {
        found.push({
          file: rel,
          name: `ipc:${handler.channel ?? "<unnamed>"}`,
          line: i + 1,
          body: handler.body,
          isDbWriterCall,
        });
      } else if (handler.refName) {
        const base = handler.refName.split(".").pop() as string;
        const decl = declared.get(base);
        if (decl) {
          found.push({ file: rel, name: base, line: decl.line, body: decl.body, isDbWriterCall });
        }
      }
      continue;
    }
    const m = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(lines[i]);
    if (m) {
      found.push({ file: rel, name: m[1], line: i + 1, body: captureBody(lines, i), isDbWriterCall });
    }
  }

  // BACKLOG-3232. Pushed BEFORE the registrar filter below, so a class method
  // that registers `ipcMain.handle(...)` is dropped in favour of the handlers
  // it registers — the same rule a registrar FUNCTION already gets.
  found.push(...classMemberUnits(rel, lines, isDbWriterCall));

  const registrars = new Set(
    found
      .filter((u) => !u.name.startsWith("ipc:") && /ipcMain\.handle\s*\(/.test(u.body))
      .map((u) => `${u.file}:${u.line}`)
  );
  const seen = new Set<string>();
  return found.filter((u) => {
    const key = `${u.file}:${u.line}`;
    if (registrars.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanUnits(): Fn[] {
  const dbWriters = dbLayerWriters();
  const units: Fn[] = [];
  for (const file of sourceFiles(SCAN_ROOT)) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    units.push(...unitsInFile(rel, fs.readFileSync(file, "utf8").split("\n"), dbWriters));
  }
  return units;
}

/**
 * Write statements in a body, counted on SQL keywords at the start of a
 * statement. `strip` removes line comments first so a commented-out INSERT in
 * an explanation does not count — several of these files carry long comments
 * quoting the SQL they replaced.
 */
/**
 * ONE pattern, used by EVERY heuristic below.
 *
 * BACKLOG-2569: it used to be written out twice — and the two copies were
 * applied to two different VIEWS of the function body (`writeCount` to the
 * joined body, `writesAreBranchExclusive` line by line). A multi-line
 * `UPDATE …\n SET …` matches the first and not the second, so a function whose
 * second write was multi-line was silently cleared. Sharing the source string
 * is not cosmetic: it is what makes that divergence impossible to re-introduce
 * without deleting this constant.
 */
const WRITE_PATTERN = String.raw`\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM)\b`;

/**
 * ONE view of the body, used by EVERY heuristic below — the other half of the
 * BACKLOG-2569 fix. Drops lines that OPEN with a comment marker so a
 * commented-out INSERT in an explanation does not count; several of these files
 * carry long comments quoting the SQL they replaced.
 */
function stripComments(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
}

function writeCount(body: string): number {
  const matches = stripComments(body).match(new RegExp(WRITE_PATTERN, "gi"));
  return matches ? matches.length : 0;
}

/**
 * ===========================================================================
 * BACKLOG-3312 — A UNIT THAT ENUMERATES AND STILL COUNTS ZERO
 * ===========================================================================
 * `failureLogService.ts::pruneOldEntries` became a unit under BACKLOG-3232 and
 * then counted ZERO writes, because both its DELETEs execute HOISTED SQL
 * CONSTANTS — `dbRun(PRUNE_BY_AGE_SQL, ...)`, with the text in
 * `db/failureLogSql.ts`. BACKLOG-2554 already named that site as two unwrapped
 * DELETEs, so the guard read GREEN over a site an open item called unsafe.
 *
 * **Before the class widening the guard did not look. After it, the guard
 * looked and reported clean.** The second is the worse state: a unit that
 * enumerates but cannot count is indistinguishable from a verified-safe one in
 * every count above, and in the "may only SHRINK" assertion.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY AT FAULT — the item blamed the wrong thing
 * ---------------------------------------------------------------------------
 * BACKLOG-3312 was filed saying `WRITE_PATTERN` "cannot see" a constant. The
 * pattern is fine. `writeCount` takes a BODY STRING AND NOTHING ELSE, so there
 * was no file to resolve a constant AGAINST — at any breadth, the SQL is not in
 * the body. That is why the fix is a resolver and not a wider regex.
 *
 * AND IT IS DELIBERATELY NOT A WIDER REGEX. Matching identifiers that LOOK like
 * SQL constant names is the line-matcher failure this guard has already hit
 * five times (BACKLOG-3223, 3224, 3225, 3232, 3239). `the pattern is NOT
 * widened` pins the distinction: after this change `writeCount` ALONE still
 * counts 0 for `pruneOldEntries`; its two writes come from resolution.
 *
 * ---------------------------------------------------------------------------
 * POPULATION, measured at `8f17c1e16` BEFORE any of this was written
 * ---------------------------------------------------------------------------
 * Across 2,546 units: **21** count more with resolution, **5** cross 0/1 -> >=2,
 * and **TWO** survive the whole pipeline as new offenders — the last two
 * entries in KNOWN_UNWRAPPED, each citing its own filed item. 23 distinct
 * write-SQL constants are referenced inside units; 66 write-resolving constant
 * bindings exist across the scanned tree. The unwrapped set goes 18 -> 20 and
 * LOSES nothing.
 *
 * The other three crossers were each opened and read, never classified from a
 * name: `contactSourceValues.ts::removeUnlinkedSourceValues` (0->2) really does
 * run inside `dbTransaction<UnlinkOutcome>(` at `contactProvenance.ts:246`;
 * `importHelpers.ts::syncMacChatThreadNames` (1->3) opens its own
 * `db.transaction(...)`; and `db/transactionDbService.ts::updateTransaction`
 * (1->2) is a FALSE POSITIVE of a naive resolver — the next paragraph.
 *
 * ---------------------------------------------------------------------------
 * ONLY SQL TEXT RESOLVES, AND A MEASURED FALSE POSITIVE IS WHY
 * ---------------------------------------------------------------------------
 * A first cut resolved ANY module-level const, and reported
 * `db/transactionDbService.ts:979 updateTransaction` as a new offender by
 * resolving `TRANSACTION_COLUMN_POLICY` — an OBJECT LITERAL whose `why:` prose
 * at `:310` QUOTES `UPDATE transactions SET text_thread_count = ?`. Prose about
 * a statement, not a statement. Under this guard's rule that every
 * KNOWN_UNWRAPPED entry cites a filed item, that false positive could only have
 * been quieted by filing a bogus item against a function that is not defective.
 *
 * So an initializer resolves only when it IS SQL TEXT: a string literal, a
 * template, or a tagged template (`sql` / `unsafeSql`, per `core/sqlText`).
 * Pinned by `prose inside an object literal is not a write`, whose fixture is
 * transcribed from that constant.
 *
 * ---------------------------------------------------------------------------
 * TWO PHASES, BECAUSE ONE PHASE GAVE TWO DIFFERENT ANSWERS
 * ---------------------------------------------------------------------------
 * The first resolver cached a module's resolved map keyed by FILE while
 * computing it under a recursion DEPTH CAP. A module first reached AT the cap
 * had its own imports left unresolved, and that partial map was then cached as
 * final. `reviewStateService.ts` imports every one of its SQL constants, so
 * reached deep it resolved to the EMPTY set and `restoreRejectedToQueue`
 * counted 0. Measured: **19 offenders on one run and 20 on three others, from
 * the same code** — the answer depended on which file was visited first.
 *
 * A guard whose result depends on visit order is worse than no guard, so the
 * shape below has neither a depth cap nor a partial cache. `readBindings`
 * parses ONE file and follows NO edge. `resolveBinding` walks the binding graph
 * one name at a time with its own cycle set. Only COMPLETE maps are cached.
 * Pinned by `the resolved set does not depend on visit order`, which derives one
 * module's set twice with the cache warmed in opposite directions.
 *
 * ---------------------------------------------------------------------------
 * STATED FLOORS — measured sizes, none fixed here
 * ---------------------------------------------------------------------------
 *   1. `localWriters` is NOT resolved. Two non-exported helpers hold a
 *      const-only write: `emailSyncService.ts:533 fetchStoreAndDedup` and
 *      `reviewStateService.ts:996 resolveLegacyTwins`. Measured BOTH ways:
 *      resolving there too changes the offender set by ZERO. Left out to keep
 *      this change to one mechanism, and recorded with its size rather than
 *      omitted.
 *   2. NAMESPACE imports (`import * as x` -> `x.CONST`) do not resolve. Eight
 *      exist, all of `db/externalContactDbService`, and ZERO namespace-qualified
 *      references to a write constant appear in any unit body.
 *   3. A REFERENCE counts, executed or not — the same treatment an inline SQL
 *      literal already gets. All 23 referenced constants are passed to `dbRun`
 *      or `prepare`. A constant NAME appearing inside a string literal would
 *      also count; none does.
 *   4. Only RELATIVE specifiers are followed. A constant re-exported through a
 *      package entry point would not resolve; none is.
 *   5. MODULE LEVEL only. A constant declared inside a function is already in
 *      the body and needs no resolution. Measured: ZERO units shadow a resolved
 *      name with a local `const` / `let` / `var`.
 */
interface ModuleBindings {
  /** `const NAME = <sql text>` declared HERE -> writes in that text. 0 is kept. */
  own: Map<string, number>;
  /** `import { A as B }` / `export { A } from` -> where B's value comes from. */
  from: Map<string, { file: string; name: string }>;
}

/** Is this initializer SQL TEXT? See the false-positive paragraph above. */
function isSqlTextInitializer(node: ts.Expression): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  );
}

const bindingCache = new Map<string, ModuleBindings>();
const writeConstCache = new Map<string, Map<string, number>>();

/** Test-only: clear both caches so visit order can be varied deliberately. */
function clearConstCaches(): void {
  bindingCache.clear();
  writeConstCache.clear();
}

/** PHASE ONE. One file's own SQL-text constants and its import edges. Follows nothing. */
function readBindings(abs: string): ModuleBindings {
  const cached = bindingCache.get(abs);
  if (cached) return cached;
  const out: ModuleBindings = { own: new Map(), from: new Map() };
  bindingCache.set(abs, out);
  if (!fs.existsSync(abs)) return out;

  const sf = ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.ES2020, true);
  const resolveSpec = (spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const base = path.resolve(path.dirname(abs), spec);
    for (const cand of [base + ".ts", path.join(base, "index.ts")]) {
      if (fs.existsSync(cand)) return cand;
    }
    return null;
  };

  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (!isSqlTextInitializer(d.initializer)) continue;
        out.own.set(d.name.text, writeCount(d.initializer.getText(sf)));
      }
    } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const from = resolveSpec(st.moduleSpecifier.text);
      const nb = st.importClause?.namedBindings;
      if (!from || !nb || !ts.isNamedImports(nb)) continue;
      for (const e of nb.elements) {
        out.from.set(e.name.text, { file: from, name: (e.propertyName ?? e.name).text });
      }
    } else if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      const from = resolveSpec(st.moduleSpecifier.text);
      if (!from) continue;
      for (const e of st.exportClause.elements) {
        out.from.set(e.name.text, { file: from, name: (e.propertyName ?? e.name).text });
      }
    }
  }
  return out;
}

/**
 * PHASE TWO. Follow ONE name through the binding graph to the text it names.
 * `seen` is per NAME and per query — never shared, never cached — so a cycle
 * terminates without making the answer depend on who asked first.
 */
function resolveBinding(file: string, name: string, seen: Set<string>): number {
  const key = `${file}::${name}`;
  if (seen.has(key)) return 0;
  seen.add(key);
  const b = readBindings(file);
  const own = b.own.get(name);
  if (own !== undefined) return own;
  const edge = b.from.get(name);
  if (!edge) return 0;
  return resolveBinding(edge.file, edge.name, seen);
}

/** Names visible in `abs` that resolve to SQL text issuing at least one write. */
function writeConstsIn(abs: string): Map<string, number> {
  const cached = writeConstCache.get(abs);
  if (cached) return cached;
  const b = readBindings(abs);
  const out = new Map<string, number>();
  for (const [name, n] of b.own) if (n >= 1) out.set(name, n);
  for (const name of b.from.keys()) {
    const n = resolveBinding(abs, name, new Set<string>());
    if (n >= 1) out.set(name, n);
  }
  // Cached only once COMPLETE. A partial map cached as final is the defect the
  // header describes, and it cost a measurement that could not be reproduced.
  writeConstCache.set(abs, out);
  return out;
}

/**
 * Offsets at which a body REFERENCES a constant holding write SQL — the same
 * stream shape `writeOffsets` produces, labelled with the constant's name so a
 * reported offender says WHICH statement it ran.
 *
 * Identifiers are tokenised rather than matched with `\b`, so `A_PRUNE_BY_AGE_SQL`
 * cannot match `PRUNE_BY_AGE_SQL`.
 */
function constWriteOffsets(src: string, absFile: string): { at: number; label: string }[] {
  const names = writeConstsIn(absFile);
  if (names.size === 0) return [];
  const out: { at: number; label: string }[] = [];
  for (const m of src.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const n = names.get(m[0]);
    if (n === undefined) continue;
    for (let k = 0; k < n; k++) out.push({ at: m.index ?? 0, label: m[0] });
  }
  return out;
}

/**
 * THE ONE VIEW every heuristic reads — raw SQL, db-layer calls, and resolved
 * constants, in offset order.
 *
 * BACKLOG-2569 made `writeCount` and `writesAreBranchExclusive` share one
 * pattern because two views of one body silently cleared `updateContactRole`.
 * BACKLOG-3312 adds a third source of writes, so it shares the VIEW as well:
 * `file` is what enables constant resolution, and both callers pass the same
 * one. `file` stays optional so every heuristic fixture below keeps the exact
 * behaviour it was written against.
 */
function writeStream(
  src: string,
  isDbWriterCall: ((name: string) => boolean) | null,
  selfName: string | null,
  file: string | null
): { at: number; label: string }[] {
  const raw = writeOffsets(src, isDbWriterCall, selfName);
  if (file === null) return raw;
  return [...raw, ...constWriteOffsets(src, path.join(REPO_ROOT, file))].sort((a, b) => a.at - b.at);
}

/**
 * ONE pattern for "this text opens a `dbTransaction`", used by BOTH
 * `wrapsItself` and `namesCalledInsideATransaction` — the same
 * one-source-string discipline BACKLOG-2569 imposed on `WRITE_PATTERN`, and for
 * the same reason: these two were written out separately and drifted together.
 *
 * ===========================================================================
 * BACKLOG-2584 — THE GENERIC FORM WAS NEVER MATCHED
 * ===========================================================================
 * Both sites used to test `/\bdbTransaction\s*\(/`, which does NOT match
 * `dbTransaction<UnlinkOutcome>(` — the type argument sits between the name and
 * the paren. Executed both forms: plain -> true, generic -> FALSE.
 *
 * Inside `db/` that was inert, because the only `dbTransaction<` occurrence
 * there is the DECLARATION at `core/dbConnection.ts:287`. It became
 * load-bearing the moment this guard's scan root widened past `db/`: six call
 * sites live in five production files outside it, and five of the six use the
 * generic form (measured at `0dca6beb1`) —
 *
 *   electron/handlers/contactHandlers.ts:2884        dbTransaction(() => {
 *   electron/services/contactProvenance.ts:246       dbTransaction<UnlinkOutcome>(
 *   electron/services/contactCompare.ts:1166         dbTransaction<ConfirmSourcesOutcome>(
 *   electron/services/contactLinkReview.ts:322,:410  dbTransaction<ReviewDecisionOutcome>(
 *   electron/services/contactManualLink.ts:294       dbTransaction<LinkSourceOutcome>(
 *
 * — so the widened scan would have reported four CORRECTLY ATOMIC wrappers as
 * unwrapped. Under this guard's rule that every `KNOWN_UNWRAPPED` entry cites a
 * filed item, those four false positives could only have been quieted by filing
 * four bogus items. Fixing the regex is a PRECONDITION of widening, not an
 * improvement shipped alongside it.
 *
 * STATED FLOOR, not fixed: `(?:<[^>]*>)?` cannot match a NESTED generic —
 * `dbTransaction<Map<string, number>>(` reads as unwrapped, measured. There are
 * ZERO nested-generic call sites at `0dca6beb1`, so this is latent. Closing it
 * needs a bracket-matching parse, which is a different task.
 */
const TRANSACTION_CALL = String.raw`\bdbTransaction\s*(?:<[^>]*>)?\s*\(`;

function wrapsItself(body: string): boolean {
  // `dbTransaction(...)` is the shared helper. `db.transaction(...)` is
  // better-sqlite3's own API, used directly where a function already holds a
  // handle — MISSING IT WAS A BUG IN THE FIRST VERSION OF THIS GUARD, and it
  // reported `batchUpdateContactAssignments` as the worst offender in the
  // codebase when that function has been transactional all along.
  //
  // BACKLOG-2569: read the STRIPPED body, so a comment merely mentioning
  // `.transaction(` cannot clear a function that never opens one — the same
  // defect class as the multi-line blind spot this task fixes. Measured at 0
  // classification changes across all 316 exported functions when introduced.
  // KNOWN LIMITATION, stated here rather than only in the PR: stripComments
  // drops lines that OPEN with a comment marker, so a TRAILING
  // `// … .transaction( …` comment still evades this. Closing that needs a real
  // comment/string-literal-aware parse, which is a different task.
  const src = stripComments(body);
  return new RegExp(TRANSACTION_CALL).test(src) || /\b\w+\.transaction\s*\(/.test(src);
}

/**
 * A write that can only run when an earlier one did NOT — the upsert shape:
 *
 *     if (existing) { UPDATE …; return existing.id; }
 *     INSERT …;
 *
 * Two write statements, never two writes. Counting them textually is what made
 * the first version of this guard report four functions that cannot leave a
 * partial state.
 *
 * ===========================================================================
 * BACKLOG-2584 — THE RULE AS IMPLEMENTED, BECAUSE IT USED TO BE STATED WRONG
 * ===========================================================================
 * This paragraph used to read "a `return` sits between the writes at the same
 * or shallower brace depth" while the implementation COMPUTED NO DEPTH AT ALL.
 * One function, two accounts — the BACKLOG-2569 class, inside the very function
 * 2569 fixed. Two real false clears followed, both read in source, not inferred:
 *
 *   - `messageMatchingService.ts:386 autoLinkTextsToTransaction` —
 *     `createCommunicationReference` at :483 runs inside a `for` loop, then
 *     `dbRun(claimMessagesForTransactionSql09(...))` at :516 runs after it.
 *     Strictly sequential. Cleared by a `} else {` at :493 closing an unrelated
 *     inner `if (refId)` — a SIBLING of the first write, not its branch.
 *   - `autoLinkEmailsToTransaction` (:645), the same shape at :776/:809.
 *
 * THE RULE, exactly as the code below implements it. An exit clears two writes
 * when, between them, there is either:
 *
 *   (a) a `return` — at ANY depth, because it leaves the function; or
 *   (b) a `} else` whose depth is STRICTLY LESS than the preceding write's,
 *       i.e. the write was inside the branch that the `else` closes.
 *
 * Strictly less, not "at or below". The upsert's `return` sits at the SAME
 * depth as the write above it, and an `} else` at the same depth as a write is
 * the sibling case that produced both false clears. Two rules because a
 * `return` and an `} else` mean different things, and one condition covering
 * both is what let the sibling case through.
 *
 * MEASURED, not assumed: 0 classification changes across all 439 exported
 * functions in `electron/services/db` at `0dca6beb1` — the bar BACKLOG-2569 set
 * for its own change to this function. The upsert shape and the
 * one-write-per-branch shape both still clear; the fixtures below pin that.
 *
 * STATED FLOOR, not fixed (BACKLOG-2584, cut from that task's scope by SR): a
 * `return` INSIDE A CLOSURE still clears at any depth. Two writes separated by
 * a `.filter((x) => { return x.ok; })` read as branch-exclusive. Pre-existing —
 * the old depth-blind rule cleared it too, so this is not a regression — but it
 * is a floor, not a guarantee. Closing it needs the exits to be attributed to
 * the function they actually leave.
 *
 * STATED FLOOR, measured and NOT fixed by decision (BACKLOG-3314): `try`/`catch`
 * is not an exit. A write in a `try` and a write in its `catch` count as a
 * pair. That is a false POSITIVE only when the two genuinely cannot both run —
 * and a try/catch is NOT exclusive by construction: `try { W1; mayThrow(); }
 * catch { W2 }` runs W1 and then W2.
 *
 * Measured at `0285e214c` by two independent methods (this predicate's own
 * offsets, and the TypeScript AST): 26 multi-write units not otherwise cleared,
 * 53 `try` blocks among them, and ONE unit with a write in a try and in its
 * catch — `shadowDeltaSyncService.ts::runOnce`, already EXEMPT and not
 * recoverable by any try/catch rule (see its entry). A rule clearing EVERY
 * try/catch pair would reclassify zero units. Not added, on the measured-need
 * bar BACKLOG-3312 was held to.
 *
 * THE RULE, if a unit ever needs it. A `} catch` separates W1 -> W2 only when
 * ALL four hold:
 *   1. W2 is inside that catch arm, and W1 inside the try block it follows.
 *   2. W1 is at the try block's TOP LEVEL (`lastWriteDepth === catch depth + 1`).
 *      `try { for (…) { W1 } } catch { W2 }` commits W1 on one pass and throws
 *      on the next.
 *   3. W1 is the try block's LAST statement — only whitespace between the end
 *      of its statement and the try's `}`. Otherwise
 *      `try { W1; mayThrow(); } catch { W2 }` clears.
 *   4. W1 is the ONLY write in the try block. The pairwise walk below never
 *      compares W0 with W2, so `try { if (a) { W0; mayThrow(); return; } W1; }
 *      catch { W2 }` would clear with W0 and W2 both run. `runOnce`'s outer try
 *      is this shape: `ensureSyncStateRow` commits, then a throw reaches the
 *      catch.
 * `} finally` never separates anything; it always runs.
 *
 * THREE GAPS THAT RULE STILL HAS. Each of these passes all four conditions,
 * and each lets W1 commit and W2 run. Verified two ways at `1463e12d4`: the
 * four conditions were sketched on this file's own `braceDepths` / `writeStream`
 * / `elseArmRange`, and each shape was run in node to watch both writes happen.
 * The same sketch still rejected condition 2's braced loop, condition 3's
 * trailing `mayThrow()` and condition 4's `W0 … return` shape, so it
 * discriminates.
 *   (i)  A LOOP WITHOUT BRACES. `try { for (…) W1(…); } catch { W2 }`, and
 *        `xs.forEach((x) => W1(x));`. A braceless body opens no brace, so
 *        condition 2's depth test reads W1 as top level. It commits on one pass
 *        and throws on the next.
 *   (ii) A THROW LATER IN W1'S OWN STATEMENT. `await W1(…).then((r) => f(r));`,
 *        or `W1(…).id.toString()`. Condition 3 ends at the statement's `;`, but
 *        the rest of that statement runs after W1 has committed. W1's OWN
 *        ARGUMENTS are not this gap: they are evaluated before the call, so a
 *        throw there means W1 never ran (run in node, W2 alone).
 *   (iii) A WRITER CALL COUNTS AS ONE WRITE. A two-statement writer that commits
 *        its first statement and throws on its second still sends control to
 *        the catch, so W2 runs beside a half-done W1. `recordSyncSuccess`
 *        (`emailSyncStateService.ts:163-164`) is exactly that.
 * (i) and (ii) need a statement-level parse this offset machinery does not
 * have. (iii) cannot be seen from the caller at all. Any rule built from the
 * four conditions opens holes in the CLEARING direction. Leaving it out costs a
 * false positive, which this guard reports rather than hides.
 *
 * ===========================================================================
 * BACKLOG-2569 — WHY THIS READS THE JOINED BODY AND NOT LINES
 * ===========================================================================
 * This used to `split("\n")` and test each line. `writeCount` above tested the
 * SAME pattern against the JOINED body. A multi-line statement —
 *
 *     UPDATE transaction_contacts
 *     SET role = ?
 *
 * — matches the joined view (`\s+` spans the newline) and matches NO SINGLE
 * LINE. So `writeCount` saw 2 writes while this function saw 1, concluded
 * "one write is trivially exclusive", and cleared the function. That is
 * exactly how `updateContactRole` (two sequential unwrapped writes) passed
 * this guard. Both heuristics now derive from `WRITE_PATTERN` over
 * `stripComments(body)`, and ordering is by CHARACTER OFFSET rather than line
 * index — which is what makes a multi-line write positionable at all.
 */
/**
 * Brace depth at every character offset. A `{` reports the depth it OPENS; a
 * `}` reports the depth it CLOSES, so the character AFTER a `}` is already at
 * the outer depth. That is what lets `} else` be read at the depth of the `if`
 * it belongs to rather than the depth of the block it just closed.
 */
function braceDepths(src: string): number[] {
  const depths = new Array<number>(src.length).fill(0);
  let cur = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      cur++;
      depths[i] = cur;
    } else if (ch === "}") {
      depths[i] = cur;
      cur--;
    } else {
      depths[i] = cur;
    }
  }
  return depths;
}

/**
 * Every write in a body as an offset-ordered stream — the ONE view both
 * `unitWriteCount` and `writesAreBranchExclusive` read, for the reason
 * BACKLOG-2569 gave: two heuristics over two different views of one body is how
 * `updateContactRole` was silently cleared.
 *
 * A write is a raw SQL statement, or — outside `db/` — a CALL to a db-layer
 * writer. `selfName` is stripped so a function never counts its own declaration
 * line or its own recursion: `export function createLink(` matches
 * `\bcreateLink\s*\(`.
 */
function writeOffsets(
  src: string,
  isDbWriterCall: ((name: string) => boolean) | null,
  selfName: string | null
): { at: number; label: string }[] {
  const out: { at: number; label: string }[] = [];
  for (const m of src.matchAll(new RegExp(WRITE_PATTERN, "gi"))) {
    out.push({ at: m.index ?? 0, label: "<sql>" });
  }
  if (isDbWriterCall) {
    for (const m of src.matchAll(/\b([A-Za-z0-9_]+)\s*\(/g)) {
      if (selfName !== null && m[1] === selfName) continue;
      if (isDbWriterCall(m[1])) out.push({ at: m.index ?? 0, label: m[1] });
    }
  }
  return out;
}

/** Writes a unit issues, under the rule that applies to the layer it lives in. */
function unitWrites(unit: Fn): { at: number; label: string }[] {
  return writeStream(stripComments(unit.body), unit.isDbWriterCall, unit.name, unit.file);
}

/**
 * The offset span of the block an `else` opens — `{` exclusive to matching `}`
 * exclusive — or `null` when that `else` governs no block.
 *
 * ===========================================================================
 * BACKLOG-3239 — THE RULE NEVER CHECKED THE LATER WRITE
 * ===========================================================================
 * `writesAreBranchExclusive` verified that the EARLIER write sat inside the
 * branch a `} else` closes, and then cleared the pair without ever asking where
 * the LATER write was. Its own comment claimed an intent the code did not
 * enforce, so a write in the `if` arm and a write DOWNSTREAM OF THE WHOLE
 * if/else — in neither arm, able to run in the same pass — read as exclusive.
 *
 * A LIVE OFFENDER rode on it, which is what makes this a defect rather than a
 * floor. `systemHandlers.ts::ipc:system:initialize-secure-storage` (declared
 * `:469`) counts two writes, opens no transaction, and was cleared here:
 *
 *   :560  if (!localUser) {
 *   :562    await databaseService.createUser({ … })   <- write 1, depth 5
 *   :580  } else {                                    <- exit, depth 4 < 5
 *   :586  }                                           <- the arm ENDS here
 *   :630  try {
 *   :651        await createLocalUserFromCloud(…)     <- write 2, 65 lines past
 *
 * Measured at `73d3e3fbe`: `writes=2 wraps=false branchExcl=TRUE inTx=false`.
 * Of the NINE units cleared only by this predicate at that SHA, four were
 * cleared by a `} else` and five by a `return` — the `return` arm is
 * BACKLOG-3224 and is deliberately untouched here.
 *
 * STATED FLOOR 1 — a braceless `else` governs no block, so this returns `null`
 * and such an `else` never clears anything:
 *
 *   if (a) { W1 } else doSomething();
 *
 * That is a false POSITIVE — red where the code may be exclusive — which is the
 * safe direction for this guard, and it surfaces as a listed offender someone
 * reads rather than as silence. ZERO live sites have the shape at `73d3e3fbe`,
 * swept rather than sampled:
 *
 *   git grep -nE '^[[:space:]]*\}[[:space:]]*else[[:space:]]*$|^[[:space:]]*\}[[:space:]]*else[[:space:]]+[^{]' \
 *     -- electron | grep -vE 'else[[:space:]]+if'
 *
 * returns ONE line, and it is the fixture in this file that pins the floor.
 * Adding a second arm-finding path for it is a change with no measured need.
 *
 * STATED FLOOR 2 — the EARLIER write is still checked by DEPTH ALONE, the rule
 * BACKLOG-2584 set (`e.depth < lastWriteDepth`). It is not checked by offset,
 * so this shape is still cleared although both writes run:
 *
 *   for (…) { W1 }            // W1 one deeper than the `else` below
 *   if (b) { } else { W2 }    // `else` shallower than W1; W2 inside its arm
 *
 * The machinery below could verify the earlier write by offset too. ZERO live
 * offenders have the shape at `73d3e3fbe` — the fix's whole surfaced population
 * is the ONE unit listed in `KNOWN_UNWRAPPED` above, and it is not this shape.
 * Widening it here was ruled out of scope for that reason, the same
 * measured-need bar BACKLOG-3312 was held to.
 *
 * FILED AS BACKLOG-3323, which carries the shape above and the measurement
 * behind it: of the nine units cleared only by this predicate at `73d3e3fbe`,
 * none has it. It was sequenced after BACKLOG-3314, which made NO change to
 * this predicate — try/catch is recorded as a stated floor on
 * `writesAreBranchExclusive` instead — so nothing is ahead of it here.
 */
function elseArmRange(
  src: string,
  depths: number[],
  afterElse: number
): { start: number; end: number } | null {
  let i = afterElse;
  const skipSpace = (): void => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  skipSpace();
  // `else if (cond) {` — the arm IS the nested `if`, so step over its head and
  // take the block that follows. Chained arms each register their own `} else`.
  if (src.startsWith("if", i) && !/[A-Za-z0-9_$]/.test(src[i + 2] ?? "")) {
    i += 2;
    skipSpace();
    if (src[i] !== "(") return null;
    let parens = 0;
    for (; i < src.length; i++) {
      if (src[i] === "(") parens++;
      else if (src[i] === ")") {
        parens--;
        if (parens === 0) {
          i++;
          break;
        }
      }
    }
    skipSpace();
  }
  if (src[i] !== "{") return null; // STATED FLOOR 1 — braceless else
  const opened = depths[i] ?? 0; // the depth this `{` OPENS
  for (let j = i + 1; j < src.length; j++) {
    // `braceDepths` reports, for a `}`, the depth it CLOSES. The first `}`
    // closing `opened` is this block's own — anything nested closes deeper.
    if (src[j] === "}" && depths[j] === opened) return { start: i, end: j };
  }
  return { start: i, end: src.length }; // unbalanced source; arm runs to the end
}

function writesAreBranchExclusive(
  body: string,
  isDbWriterCall: ((name: string) => boolean) | null = null,
  selfName: string | null = null,
  // BACKLOG-3312: the repo-relative file, so this heuristic sees the SAME
  // resolved constants `unitWrites` does. `null` keeps the fixtures below
  // reading exactly the stream they were written against.
  file: string | null = null
): boolean {
  const src = stripComments(body);
  const depths = braceDepths(src);

  // Writes and exits as one offset-ordered stream. A write at the same offset
  // as an exit sorts first, preserving the old `else if` precedence where a
  // line containing a write was never also read as an exit.
  const tokens: {
    at: number;
    isWrite: boolean;
    depth: number;
    isReturn: boolean;
    // BACKLOG-3239: the span of the arm a `} else` opens. `null` for a `return`
    // and for an `else` that governs no block.
    arm: { start: number; end: number } | null;
  }[] = [];
  for (const w of writeStream(src, isDbWriterCall, selfName, file)) {
    tokens.push({ at: w.at, isWrite: true, depth: depths[w.at] ?? 0, isReturn: false, arm: null });
  }
  // Anchored per line via /m. `[ \t]*` NOT `\s*`, and `\}[ \t]*else` NOT
  // `\}\s*else`: under /m, `\s` spans newlines, which would let a `}` and an
  // `else` on separate lines register as an exit the original never accepted.
  // A LOOSENED exit anchor creates new masking — the opposite of this fix.
  for (const m of src.matchAll(/^[ \t]*(return\b|\}[ \t]*else\b)/gm)) {
    const at = m.index ?? 0;
    // Depth is read at the LAST character of the match, so for `} else` it is
    // the depth AFTER the `}` closed — the depth of the `if` this `else` pairs
    // with. For `return` the depth is where it stands.
    const depthAt = at + m[0].length - 1;
    const isReturn = /return/.test(m[1]);
    tokens.push({
      at,
      isWrite: false,
      depth: depths[depthAt] ?? 0,
      isReturn,
      // BACKLOG-3239: `depthAt + 1` is the first character after `else`.
      arm: isReturn ? null : elseArmRange(src, depths, depthAt + 1),
    });
  }
  tokens.sort((a, b) => a.at - b.at || (a.isWrite ? -1 : 1));

  let seenWrite = false;
  let lastWriteDepth = 0;
  let exitsSinceWrite: {
    depth: number;
    isReturn: boolean;
    arm: { start: number; end: number } | null;
  }[] = [];
  for (const t of tokens) {
    if (t.isWrite) {
      if (seenWrite) {
        // (a) a `return` leaves the function from any depth — BACKLOG-3224 owns
        // that arm and it is unchanged here.
        //
        // (b) a `} else` separates the two writes only when BOTH ends hold:
        // the EARLIER write was inside the branch the `else` closes (strictly
        // deeper than the `else` itself — BACKLOG-2584), AND the LATER write is
        // inside the `else` arm. BACKLOG-3239: the second half did not exist,
        // so a write downstream of the whole if/else — in neither arm, reached
        // on the same pass — was cleared as exclusive.
        const separated = exitsSinceWrite.some(
          (e) =>
            e.isReturn ||
            (e.depth < lastWriteDepth &&
              e.arm !== null &&
              t.at > e.arm.start &&
              t.at < e.arm.end)
        );
        if (!separated) return false; // two writes, nothing exclusive between
      }
      seenWrite = true;
      lastWriteDepth = t.depth;
      exitsSinceWrite = [];
    } else if (seenWrite) {
      exitsSinceWrite.push({ depth: t.depth, isReturn: t.isReturn, arm: t.arm });
    }
  }
  return seenWrite;
}

/**
 * Every identifier called inside some `dbTransaction(() => { ... })` anywhere in
 * the scanned tree — rule (b), the sync-core pattern.
 *
 * BACKLOG-2584: this scans `SCAN_ROOT`, not `DB_DIR`, or a db-layer function
 * composed inside a HANDLER's transaction reads as unwrapped
 * (`contactHandlers.ts:2884` is such a transaction). The set goes 54 -> 81 bare
 * names at `0dca6beb1`.
 *
 * STATED FLOOR, and the sharp edge of this widening: this is a CLEARING set,
 * matched by BARE NAME against 1131 functions with 15 duplicate names. A
 * function wrapped by one caller and unwrapped by another is cleared by the
 * wrapped one.
 *
 * AUDITED, not assumed. Exactly TWO multi-write units are cleared ONLY by this
 * set at `0dca6beb1`, and both FAIL the reachability check that
 * `relabelTypedContactValues` gets in EXEMPT:
 *
 *   - `contactSourceValues.ts:233 applyLinkedSourceValues` — 5 call sites, and
 *     3 are NOT inside any transaction (`contactHandlers.ts:466`,
 *     `contactNameAutoLink.ts:621`, `contactSourceLinker.ts:823`). Two are
 *     (`contactLinkReview.ts:383`, `contactManualLink.ts:362`), and those two
 *     clear it everywhere.
 *   - `transactionContactDbService.ts:292 assignContactToTransactionSync` —
 *     reachable unwrapped through its own async seam at `:274`. Pre-existing:
 *     this was cleared under the `db/`-only scan too.
 *
 * Filed as BACKLOG-3223, which also carries the fix to this rule: clear a name
 * only when NO call path reaches it outside a transaction. Not fixed here — it
 * is a heuristic change beyond this task's budget, and neither function is
 * REPORTED today, which is precisely the point. A clearing set nobody audits is
 * how a real violation goes quiet.
 */
function namesCalledInsideATransaction(): Set<string> {
  const inside = new Set<string>();
  for (const file of sourceFiles(SCAN_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!new RegExp(TRANSACTION_CALL).test(lines[i])) continue;
      const block = captureBody(lines, i);
      for (const m of block.matchAll(/\b([A-Za-z0-9_]+)\s*\(/g)) inside.add(m[1]);
    }
  }
  return inside;
}

/**
 * ===========================================================================
 * BACKLOG-2569 — THE HEURISTICS, TESTED DIRECTLY
 * ===========================================================================
 * The scan below can only ever prove things about the tree as it stands today.
 * It cannot prove the RULE, and it could not have caught the bug this block
 * exists for: `updateContactRole` was cleared by a heuristic disagreement, so a
 * green scan was the SYMPTOM, not the evidence.
 *
 * These fixtures are TRANSCRIBED FROM REAL SOURCE at
 * `2910c79af82098f17067dbad0a35c1e33d0830a4`, never invented — an invented
 * fixture is how a control silently stops being a control (2026-08-04).
 *
 * They also outlive their subjects. `updateContactRole` is DELETED by
 * BACKLOG-2569, so fixture 1 is the only remaining proof that the guard can
 * still catch a multi-line sequential write at all.
 */
describe("the write heuristics themselves (BACKLOG-2569)", () => {
  // Transcribed verbatim from `updateContactRole`,
  // electron/services/db/transactionContactDbService.ts:433-454 @ 2910c79a,
  // DELETED by this task. Two sequential unwrapped writes: a multi-line
  // `UPDATE … \n SET …`, then a conditional single-line UPDATE, no exit between.
  const MULTILINE_THEN_SECOND_WRITE = `
  const sql = \`
    UPDATE transaction_contacts
    SET \${fields.join(", ")}
    WHERE transaction_id = ? AND contact_id = ? AND removed_at IS NULL
  \`;

  dbRun(sql, values);

  // Auto-update contact default_role
  if (updates.specific_role || updates.role) {
    dbRun(
      \`UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?\`,
      [updates.specific_role || updates.role, contactId]
    );
  }
`;

  // Transcribed from `createLink`, contactSourceLinkDbService.ts:244 @ 2910c79a.
  const UPSERT_SHAPE = `
  if (existing) {
    dbRun(\`UPDATE contact_source_links SET last_seen_at = ? WHERE id = ?\`, [now, existing.id]);
    return existing.id;
  }
  dbRun(\`INSERT INTO contact_source_links (id, contact_id) VALUES (?, ?)\`, [id, contactId]);
  return id;
`;

  // Transcribed from `markContactAsImported`, contactDbService.ts:765 @ 2910c79a.
  const IF_ELSE_ONE_WRITE_PER_BRANCH = `
  if (row) {
    dbRun(\`UPDATE contacts SET imported_at = ? WHERE id = ?\`, [now, row.id]);
  } else {
    dbRun(\`UPDATE contacts SET imported_at = ?, source = ? WHERE id = ?\`, [now, src, id]);
  }
`;

  // The multi-line half of the fixture above, standing alone.
  const LONE_MULTILINE_WRITE = `
  const sql = \`
    UPDATE transaction_contacts
    SET role = ?
    WHERE transaction_id = ?
  \`;
  dbRun(sql, values);
`;

  it("a multi-line write followed by a second sequential write is NOT branch-exclusive", () => {
    // THE BUG, pinned. Under the old line-by-line loop the multi-line
    // `UPDATE …\n SET …` matched no single line, so this returned `true` and
    // `updateContactRole` was cleared. Revert `writesAreBranchExclusive` to the
    // line-based version and THIS TEST IS THE ONE THAT GOES RED.
    expect(writesAreBranchExclusive(MULTILINE_THEN_SECOND_WRITE)).toBe(false);
    expect(writeCount(MULTILINE_THEN_SECOND_WRITE)).toBe(2);
  });

  it("the classic upsert (UPDATE + return, then INSERT) IS branch-exclusive", () => {
    expect(writesAreBranchExclusive(UPSERT_SHAPE)).toBe(true);
    expect(writeCount(UPSERT_SHAPE)).toBe(2);
  });

  it("if/else with one write per branch IS branch-exclusive", () => {
    expect(writesAreBranchExclusive(IF_ELSE_ONE_WRITE_PER_BRANCH)).toBe(true);
    expect(writeCount(IF_ELSE_ONE_WRITE_PER_BRANCH)).toBe(2);
  });

  it("a lone multi-line write is now VISIBLE to the branch-exclusive check (it was not before)", () => {
    // NOT a regression guard — this specifies CHANGED behaviour. Under the old
    // line-by-line loop a lone multi-line write matched no line, `seenWrite`
    // never set, and this returned FALSE. It now returns true (one write is
    // trivially exclusive). 22 single-write functions flip this way; all are
    // filtered out by `writeCount >= 2` before the check runs, so the offender
    // set is unaffected. This test is what pins that flip.
    expect(writesAreBranchExclusive(LONE_MULTILINE_WRITE)).toBe(true);
    expect(writeCount(LONE_MULTILINE_WRITE)).toBe(1);
  });

  // ==========================================================================
  // BACKLOG-2584 — a SIBLING `} else` is not an exclusivity witness
  // ==========================================================================
  // Control flow transcribed from `autoLinkTextsToTransaction`,
  // electron/services/messageMatchingService.ts:481-516 @ 0dca6beb1. The writes
  // are strictly sequential: N junction inserts inside the loop, then one bulk
  // messages UPDATE after it. The `} else {` at :493 closes `if (refId)`, which
  // is a SIBLING of the first write, not the branch containing it.
  //
  // The first write is shown as the SQL it actually executes, RESOLVED not
  // invented: the real line is `await createCommunicationReference(...)`, whose
  // body runs `dbRun(INSERT_COMMUNICATION_SQL, params)`, and that constant is
  // declared at electron/services/db/messageMatchingSql.ts:145-150 with exactly
  // the INSERT below. Resolving it keeps this heuristic test independent of the
  // call-token rule — and the need to resolve it at all is the hoisted-SQL floor
  // stated in the scan docblock.
  //
  // This fixture outlives its subject on purpose: BACKLOG-2550 will wrap this
  // path, and after that this is the only thing still proving the guard can
  // catch the shape. Same reason fixture 1 survives `updateContactRole`.
  const SIBLING_ELSE_BETWEEN_SEQUENTIAL_WRITES = `
  for (const match of filteredMatches) {
    try {
      dbRun(\`
        INSERT INTO communications (
          id, user_id, transaction_id, message_id,
          link_source, link_confidence, linked_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      \`, params);
      const refId = existingId ?? newId;

      if (refId) {
        result.linked++;
      } else {
        result.skipped++;
      }
    } catch (error) {
      result.errors.push(\`Failed to link message \${match.messageId}\`);
    }
  }

  if (result.linked > 0) {
    const linkedMessageIds = filteredMatches
      .slice(0, result.linked)
      .map((m) => m.messageId);

    dbRun(\`UPDATE messages SET transaction_id = ? WHERE id IN (?)\`, [transactionId, ...linkedMessageIds]);
  }
`;

  it("a SIBLING `} else` does not make two sequential writes exclusive (BACKLOG-2584)", () => {
    // THE SECOND BUG, pinned. Under the depth-blind rule any `} else` between
    // two writes cleared them, so this read as branch-exclusive and
    // `autoLinkTextsToTransaction` passed the guard. Revert the `} else` arm of
    // `writesAreBranchExclusive` to depth-blind and THIS TEST GOES RED.
    //
    expect(writesAreBranchExclusive(SIBLING_ELSE_BETWEEN_SEQUENTIAL_WRITES)).toBe(false);
  });

  it("an `} else` that DOES enclose the earlier write still clears it", () => {
    // The other direction, so the fix cannot pass by rejecting every `else`.
    // Same shape as IF_ELSE_ONE_WRITE_PER_BRANCH above, stated at depth: the
    // `} else` is strictly shallower than the write it separates.
    expect(writesAreBranchExclusive(IF_ELSE_ONE_WRITE_PER_BRANCH)).toBe(true);
    // And a `return` still clears from inside a deeper branch — the upsert.
    expect(writesAreBranchExclusive(UPSERT_SHAPE)).toBe(true);
  });

  // ==========================================================================
  // BACKLOG-3239 — the LATER write was never checked
  // ==========================================================================
  // Control flow transcribed from `ipc:system:initialize-secure-storage`,
  // electron/handlers/systemHandlers.ts:560-586 and :630-651 @ `73d3e3fbe`.
  // The two regions are joined as they appear; the span between them holds no
  // write and no exit shallower than write 1, verified by dumping the handler's
  // own stripped body with `braceDepths` before this fixture was written.
  //
  // THE SHAPE, and it is not the sibling-else of BACKLOG-2584: the `} else`
  // here DOES close the arm holding write 1, so 2584's depth test fires
  // correctly. Write 2 is the problem — it sits 65 lines past the end of that
  // arm, inside a SECOND `try` block, in neither arm. Both writes run on one
  // pass and the pair was cleared anyway.
  const DOWNSTREAM_WRITE_AFTER_AN_ELSE = `
  try {
    let localUser = await databaseService.getUserByEmail(pendingUser.email);

    if (!localUser) {
      await databaseService.createUser({
        id: pendingUser.supabaseId,
        email: pendingUser.email,
        is_active: true,
      });
      localUser = await databaseService.getUserById(pendingUser.supabaseId);
    } else {
      logService.info(
        "Local user already exists for pending deep link",
        "System",
        { email: pendingUser.email },
      );
    }
  } catch (userError) {
    logService.error("Failed to create pending deep link user", "System");
  }

  try {
    const authSession = await supabaseService.getAuthSession();
    if (authSession?.userId) {
      const userId = authSession.userId;
      let localUser = await databaseService.getUserById(userId);

      if (!localUser) {
        const cloudUser = await supabaseService.getUserById(userId);

        if (cloudUser) {
          await createLocalUserFromCloud(cloudUser);
        }
      }
    }
  } catch (error) {
    logService.error("Fallback user verification failed", "System");
  }
`;

  // The SAME fixture with write 2 moved INTO the else arm — the only edit is
  // which arm holds it. This is the over-correction control: a rule that has
  // started refusing every `if`/`else` fails HERE and passes the one above.
  const SECOND_WRITE_INSIDE_THE_ELSE_ARM = `
  try {
    let localUser = await databaseService.getUserByEmail(pendingUser.email);

    if (!localUser) {
      await databaseService.createUser({
        id: pendingUser.supabaseId,
        email: pendingUser.email,
        is_active: true,
      });
      localUser = await databaseService.getUserById(pendingUser.supabaseId);
    } else {
      await createLocalUserFromCloud(cloudUser);
      logService.info(
        "Local user already exists for pending deep link",
        "System",
        { email: pendingUser.email },
      );
    }
  } catch (userError) {
    logService.error("Failed to create pending deep link user", "System");
  }
`;

  const DEEPLINK_WRITERS = (n: string): boolean =>
    n === "createUser" || n === "createLocalUserFromCloud";

  it("a write DOWNSTREAM of the whole if/else is NOT cleared by its `} else` (BACKLOG-3239)", () => {
    // ANTI-VACUITY. The predicate only ever sees writes it is given, and a
    // fixture that counts ZERO writes returns `true` from the `seenWrite`
    // guard at the bottom — i.e. it would read as "exclusive" for the wrong
    // reason and this test would pass having proved nothing.
    const writes = writeStream(
      stripComments(DOWNSTREAM_WRITE_AFTER_AN_ELSE),
      DEEPLINK_WRITERS,
      null,
      null
    );
    expect(writes.map((w) => w.label)).toEqual(["createUser", "createLocalUserFromCloud"]);

    // THE DEFECT, pinned. Measured `true` at `73d3e3fbe` before the fix: the
    // `} else` closing write 1's arm cleared the pair without the rule ever
    // asking where write 2 was. Delete the `e.arm !== null && t.at > …` half of
    // the separation predicate and THIS TEST GOES RED.
    expect(
      writesAreBranchExclusive(DOWNSTREAM_WRITE_AFTER_AN_ELSE, DEEPLINK_WRITERS, null)
    ).toBe(false);
  });

  it("moving that same write INTO the else arm clears it again (BACKLOG-3239)", () => {
    const writes = writeStream(
      stripComments(SECOND_WRITE_INSIDE_THE_ELSE_ARM),
      DEEPLINK_WRITERS,
      null,
      null
    );
    expect(writes.map((w) => w.label)).toEqual(["createUser", "createLocalUserFromCloud"]);

    // The other direction. One edit separates this fixture from the one above —
    // which arm write 2 sits in — so a fix that over-corrects into refusing
    // every `if`/`else` cannot pass both.
    expect(
      writesAreBranchExclusive(SECOND_WRITE_INSIDE_THE_ELSE_ARM, DEEPLINK_WRITERS, null)
    ).toBe(true);
  });

  it("the arm of a braceless `else` is a STATED FLOOR, not a claim (BACKLOG-3239)", () => {
    // `elseArmRange` returns null for an `else` governing no block, so such an
    // `else` clears nothing and the pair is REPORTED. That is a false positive
    // and it is the direction this guard chooses on purpose — a listed offender
    // someone opens and reads, never silence. Swept across `electron/` at
    // `73d3e3fbe`, the only line of this shape is the fixture below; this test
    // states the floor rather than leaving it to prose. The sweep command is in
    // the `elseArmRange` docblock.
    const BRACELESS = `
  if (a) {
    dbRun(\`UPDATE contacts SET a = ? WHERE id = ?\`, [a, id]);
  } else dbRun(\`UPDATE contacts SET b = ? WHERE id = ?\`, [b, id]);
`;
    expect(writeCount(BRACELESS)).toBe(2);
    expect(writesAreBranchExclusive(BRACELESS)).toBe(false);
  });

  it("an `else if` arm is found through its condition (BACKLOG-3239)", () => {
    // `ipc:contacts:get-available` is a LIVE site of this shape — its two
    // `backfillImportedContactsFromExternal` calls sit either side of a
    // `} else if (externalContactDb.isStale(…))` at contactHandlers.ts:1602.
    // If the arm scan stopped at the first `{` after `else` it would find the
    // CONDITION's brace or none at all, and that correctly-exclusive handler
    // would become a false offender the moment this fix landed.
    const ELSE_IF_ARM = `
  if (needsFullSync) {
    dbRun(\`UPDATE contacts SET synced_at = ? WHERE user_id = ?\`, [now, userId]);
  } else if (isStale(userId, 24)) {
    dbRun(\`UPDATE contacts SET synced_at = ? WHERE user_id = ? AND stale = 1\`, [now, userId]);
  }
`;
    expect(writeCount(ELSE_IF_ARM)).toBe(2);
    expect(writesAreBranchExclusive(ELSE_IF_ARM)).toBe(true);
  });

  // ==========================================================================
  // BACKLOG-2584 — the generic form of the wrapper, pinned
  // ==========================================================================
  // Transcribed from `unlinkContactSource`, electron/services/contactProvenance.ts:246
  // @ 0dca6beb1. Five of the six `dbTransaction` call sites outside `db/` look
  // like this, and NONE of them was recognised as wrapping before this task.
  const GENERIC_FORM_WRAPPER = `
  return dbTransaction<UnlinkOutcome>(() => {
    recordVerdict({
      userId,
      contactId,
      sourceType: row.source_type,
      sourceRecordId: row.source_record_id,
      identityVerdict: "different_people",
      reason: "manual_unlink",
      matchedOn: row.match_method,
      decidedBy: "provenance_unlink",
    });
    deleteLinkById(linkId);
  });
`;

  it("a `dbTransaction<T>(...)` call reads as WRAPPED (BACKLOG-2584)", () => {
    // THE DEFECT, pinned. Delete `(?:<[^>]*>)?` from TRANSACTION_CALL and THIS
    // TEST IS THE ONE THAT GOES RED — along with four correctly-atomic
    // orchestration wrappers turning up as offenders in the scan below.
    expect(wrapsItself(GENERIC_FORM_WRAPPER)).toBe(true);

    // The negative half, so this cannot pass by `wrapsItself` returning true for
    // everything — the same anti-vacuity shape as the PRECONDITION below.
    expect(wrapsItself(`dbRun(\`INSERT INTO contacts (id) VALUES (?)\`, [id]);`)).toBe(false);

    // And the plain form still works. `contactHandlers.ts:2884` is the only
    // plain-form caller outside `db/`; if this regressed, that site would be the
    // one to lose its clearance.
    expect(wrapsItself(`dbTransaction(() => { dbRun(sql, v); });`)).toBe(true);
  });

  it("a NESTED generic is a STATED FLOOR, not a claim (BACKLOG-2584)", () => {
    // Not a wish — a measurement of what this guard cannot do, written as a test
    // so the floor cannot quietly become false. `[^>]*` stops at the first `>`.
    // ZERO nested-generic call sites exist at `0dca6beb1`. If this ever flips to
    // `true`, someone closed the floor and this test should be deleted with a note.
    expect(wrapsItself(`dbTransaction<Map<string, number>>(() => { dbRun(sql, v); });`)).toBe(false);
  });

  it("writeCount and the branch-exclusive check see the SAME writes", () => {
    // True BY CONSTRUCTION now that both derive from WRITE_PATTERN over
    // stripComments(). That is the POINT — it can only fail if someone
    // re-introduces the divergence that caused BACKLOG-2569. Do not delete this
    // as tautological; the tautology is the guarantee.
    for (const body of [
      MULTILINE_THEN_SECOND_WRITE,
      UPSERT_SHAPE,
      IF_ELSE_ONE_WRITE_PER_BRANCH,
      LONE_MULTILINE_WRITE,
    ]) {
      const seenByExclusiveCheck = stripComments(body).match(new RegExp(WRITE_PATTERN, "gi")) ?? [];
      expect(seenByExclusiveCheck.length).toBe(writeCount(body));
    }
  });
});

describe("the enumerator does NOT see a non-violation (BACKLOG-2584)", () => {
  // ==========================================================================
  // THE DIRECTION EVERY OTHER CONTROL MISSES
  // ==========================================================================
  // Every other test here proves "we can still SEE a violation." None proves
  // "we do not see a NON-violation" — and that is the direction this guard has
  // actually failed in: its first run reported nine offenders, SIX of them false
  // positives. Under the rule above, a false positive can only be quieted by
  // filing a bogus item or bending EXEMPT. Both are silencing.
  //
  // Transcribed from `electron/handlers/sharedAuthHandlers.ts:475-545` @0dca6beb1:
  // THREE separate registrations, ONE write each. Two are multi-line and
  // block-bodied; the FIRST is the one-liner identifier form the real file uses
  // at `:475` — `ipcMain.handle("auth:complete-pending-login", handleCompletePendingLogin);`
  //
  // THE ONE-LINER IS WHAT MAKES THIS FIXTURE ABLE TO FAIL, and it was missing.
  // An earlier version held only the two block-bodied registrations and claimed
  // it would catch a regression to brace matching. IT COULD NOT: an arrow
  // function's own braces balance, so a brace-matched capture stops cleanly at
  // the end of the first handler and never reaches the second. SR injected that
  // exact regression and the suite stayed 19/19 GREEN. A one-liner registration
  // contains no brace at all, which is the only shape that makes a brace-matched
  // capture run on — and it is the shape that produced three identical
  // `sharedAuthHandlers` rows in this task's first measurement.
  //
  // The assertion is the UNIT NAMES, and the claim is stated as MEASURED rather
  // than as predicted — the first draft of this comment predicted two different
  // failures and both runs disagreed with it.
  //
  // Both regressions produce the SAME observable, verified by injecting each:
  //   - `captureHandlerUnit` replaced by a plain brace-matched capture, and
  //   - the identifier-resolution arm disabled (`if (false && ...)`)
  // both make the one-liner stop resolving to its declaration. It is named
  // `ipc:auth:complete-pending-login` instead of `handleCompletePendingLogin`,
  // and its body becomes the FOLLOWING handler's. Each injection reddens this
  // test on exactly that first array element.
  //
  // WHICH ASSERTION IS LOAD-BEARING, because it is not the obvious one: the
  // per-unit write counts stay `[1, 1, 1]` under both regressions, since the
  // swallowed body carries one write just as the resolved declaration does. The
  // counts cannot tell the two apart. THE NAMES CAN. Do not "simplify" this to a
  // length or a total.
  const THREE_HANDLERS_ONE_WRITE_EACH = `
  ipcMain.handle("auth:complete-pending-login", handleCompletePendingLogin);

  ipcMain.handle(
    "auth:dev:expire-mailbox-token",
    async (_event, userId, provider) => {
      try {
        const token = await databaseService.getOAuthToken(userId, provider, "mailbox");
        if (!token) {
          return { success: false, error: "No token found" };
        }
        const expiredTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await databaseService.updateOAuthToken(token.id, {
          token_expires_at: expiredTime,
        });
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }
  );

  ipcMain.handle(
    "auth:dev:reset-onboarding",
    async (_event, userId) => {
      try {
        const db = databaseService.getRawDatabase();
        db.prepare(
          "UPDATE users_local SET email_onboarding_completed_at = NULL WHERE id = ?"
        ).run(userId);
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    }
  );

async function handleCompletePendingLogin(_event, userId) {
  await databaseService.completeEmailOnboarding(userId);
}
`;

  it("three handlers with one write each are THREE units, and none is an offender", () => {
    const units = unitsInFile(
      "electron/handlers/fixture.ts",
      THREE_HANDLERS_ONE_WRITE_EACH.split("\n"),
      dbLayerWriters()
    );

    // THREE units, named exactly. The first name is the resolved DECLARATION,
    // not a channel. That element is the whole control: both the brace-matching
    // regression and a disabled identifier arm turn it into
    // `ipc:auth:complete-pending-login`, measured by injecting each.
    expect(units.map((u) => u.name)).toEqual([
      "handleCompletePendingLogin",
      "ipc:auth:dev:expire-mailbox-token",
      "ipc:auth:dev:reset-onboarding",
    ]);

    // BACKLOG-3238 — why this fixture says `completeEmailOnboarding` and not
    // `updateUser`. BACKLOG-2546 gave `updateUser` a sync twin, so the exported
    // `updateUser` became a one-line delegate holding no SQL of its own and
    // LEFT `dbLayerWriters()` — this unit then read 0 writes and the assertion
    // below went red on correct code. `completeEmailOnboarding` writes
    // `users_local` in its own body and is not twinned, so it is a stable stand
    // in with the same meaning (the fixture's third handler already writes the
    // same column raw). The load-bearing assertion here is the NAMES array
    // above, which is unchanged.
    //
    // One write each: a db-layer writer call in the resolved declaration, a
    // db-layer writer call in the second, raw SQL in the third. Asserted per
    // unit, not as a total — a total cannot tell "one each" from "all three in
    // one handler". Measured limit, stated so nobody mistakes this line for the
    // control: these counts are UNCHANGED by both regressions above. They pin
    // the write rule, not the enumeration.
    expect(units.map((u) => unitWrites(u).length)).toEqual([1, 1, 1]);

    // And therefore nothing to report. This is the offender predicate itself,
    // minus the two repo-global clearing sets, which a fixture cannot supply.
    const offenders = units
      .filter((u) => unitWrites(u).length >= 2)
      .filter((u) => !wrapsItself(u.body))
      .filter((u) => !writesAreBranchExclusive(u.body, u.isDbWriterCall, u.name));
    expect(offenders).toEqual([]);
  });

  // The same two writes, in ONE registration. Written out rather than derived
  // from the fixture above, because a fixture built by editing another fixture
  // is a fixture nobody has read.
  const BOTH_WRITES_IN_ONE_HANDLER = `
  ipcMain.handle(
    "auth:dev:expire-and-reset",
    async (_event, userId, provider) => {
      const token = await databaseService.getOAuthToken(userId, provider, "mailbox");
      await databaseService.updateOAuthToken(token.id, {
        token_expires_at: expiredTime,
      });
      const db = databaseService.getRawDatabase();
      db.prepare(
        "UPDATE users_local SET email_onboarding_completed_at = NULL WHERE id = ?"
      ).run(userId);
      return { success: true };
    }
  );
`;

  it("the same two writes in ONE handler ARE reported", () => {
    // The other half, so the test above cannot pass by the enumerator seeing
    // nothing at all. One registration, two writes, no transaction, and no exit
    // between them — the shape the guard exists to catch.
    const units = unitsInFile(
      "electron/handlers/fixture.ts",
      BOTH_WRITES_IN_ONE_HANDLER.split("\n"),
      dbLayerWriters()
    );
    expect(units.map((u) => u.name)).toEqual(["ipc:auth:dev:expire-and-reset"]);
    expect(unitWrites(units[0]).length).toBe(2);

    const offenders = units
      .filter((u) => unitWrites(u).length >= 2)
      .filter((u) => !wrapsItself(u.body))
      .filter((u) => !writesAreBranchExclusive(u.body, u.isDbWriterCall, u.name));
    expect(offenders.map((u) => u.name)).toEqual(["ipc:auth:dev:expire-and-reset"]);
  });
});

/**
 * ===========================================================================
 * BACKLOG-3235 — THE WRITER SET FOLLOWS THE SYNCTWIN, TESTED DIRECTLY
 * ===========================================================================
 * The scan cannot prove this rule, for the same reason BACKLOG-2569 gave: a
 * green scan is compatible with the rule being wrong. These fixtures run the
 * REAL derivation (`dbWriterDeclsIn` + `writersFrom`) and the REAL enumeration
 * (`unitsInFile`) over transcribed source strings.
 *
 * TRANSCRIBED, NOT INVENTED. `DB_LAYER_WITH_TWINS` is
 * `electron/services/db/contactDbService.ts` @ `1cd39acd0`: the
 * `backfillContactEmails` wrapper VERBATIM from `:959-965`, its twin reduced to
 * its real SELECT (`:998`) and its real INSERT (`:1015-1019`), the
 * `backfillContactPhones` wrapper VERBATIM from `:1041-1047` with its twin's
 * INSERT (`:1081-1085`), and `createContact` reduced to its declaration
 * (`:358-361`) and its write (`:366-370`). Reductions are stated because a
 * reduction is a claim about what does not matter.
 *
 * The wrapper deliberately transcribed here is a `return xSync(...)` one, NOT a
 * `Promise.resolve` one: four of the seven real wrappers have this shape, and a
 * fixture using only the ruled `Promise.resolve` text would let a rule that
 * keyed on it pass.
 *
 * THE TWO NEGATIVE FIXTURES ARE ONE-LINE MUTATIONS OF THAT TRANSCRIPTION, not
 * separate inventions — so a failure points at the clause under test rather than
 * at a fixture nobody has read.
 */
describe("the writer set follows a syncTwin (BACKLOG-3235)", () => {
  const DB_LAYER_WITH_TWINS = `
export async function createContact(
  contactData: NewContact,
  origin: ContactOrigin,
): Promise<Contact> {
  const statement = sql\`
      INSERT INTO contacts (
        id, user_id, display_name, company, title, source, is_imported
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    \`;
  return dbRun(statement, values);
}

export async function backfillContactEmails(
  contactId: string,
  emails: string[],
  source: ContactInfoSource = "import",
): Promise<number> {
  return backfillContactEmailsSync(contactId, emails, source);
}

export function backfillContactEmailsSync(
  contactId: string,
  emails: string[],
  source: ContactInfoSource = "import",
): number {
  const existingSql = sql\`SELECT LOWER(email) as email FROM contact_emails WHERE contact_id = ?\`;
  const existingRows = dbAll<{ email: string }>(existingSql, [contactId]);
  const emailSql = sql\`
      INSERT OR IGNORE INTO contact_emails (
        id, contact_id, email, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    \`;
  return dbRun(emailSql, [emailId, contactId, normalizedEmail, isPrimary, source]).changes;
}

export async function backfillContactPhones(
  contactId: string,
  phones: string[],
  source: ContactInfoSource = "import",
): Promise<number> {
  return backfillContactPhonesSync(contactId, phones, source);
}

export function backfillContactPhonesSync(
  contactId: string,
  phones: string[],
  source: ContactInfoSource = "import",
): number {
  const phoneSql = sql\`
      INSERT OR IGNORE INTO contact_phones (
        id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    \`;
  return dbRun(phoneSql, [phoneId, contactId, phoneE164, phone, toLookupKey(phoneE164), isPrimary, source]).changes;
}
`;

  // The SAME pair, with exactly ONE thing changed: the wrapper no longer
  // mentions its twin. Pins the body check — delete that line and this reddens.
  const WRAPPER_WITHOUT_DELEGATION = `
export async function backfillContactEmails(
  contactId: string,
  emails: string[],
  source: ContactInfoSource = "import",
): Promise<number> {
  return Promise.resolve(0);
}

export function backfillContactEmailsSync(
  contactId: string,
  emails: string[],
  source: ContactInfoSource = "import",
): number {
  const emailSql = sql\`
      INSERT OR IGNORE INTO contact_emails (
        id, contact_id, email, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    \`;
  return dbRun(emailSql, [emailId, contactId, normalizedEmail, isPrimary, source]).changes;
}
`;

  // The SAME pair, with exactly ONE thing changed: the twin's INSERT is gone and
  // only its real SELECT remains. Pins `base.has(name + "Sync")` against a bare
  // declaration-existence check — which the fixture above CANNOT catch, because
  // its twin writes.
  const TWIN_THAT_ONLY_READS = `
export async function backfillContactEmails(
  contactId: string,
  emails: string[],
  source: ContactInfoSource = "import",
): Promise<number> {
  return backfillContactEmailsSync(contactId, emails, source);
}

export function backfillContactEmailsSync(
  contactId: string,
  emails: string[],
  source: ContactInfoSource = "import",
): number {
  const existingSql = sql\`SELECT LOWER(email) as email FROM contact_emails WHERE contact_id = ?\`;
  const existingRows = dbAll<{ email: string }>(existingSql, [contactId]);
  return existingRows.length;
}
`;

  // `contactHandlers.ts:2717-2780` @ `1cd39acd0`, CONTIGUOUS AND VERBATIM —
  // every line of the span, comments included. It is wrapped in an
  // `ipcMain.handle` registration because `unitsInFile` enumerates units, not
  // fragments; the shell is scaffolding, the span is not touched.
  //
  // Reducing it would be unsafe rather than merely lossy: the span contains NO
  // `return` and NO `} else`, which is exactly why `writesAreBranchExclusive`
  // declines to clear it. Dropping or introducing either while trimming would
  // silently reclassify the fixture.
  //
  // This is also the ONLY place in this file pinning TWO CONSECUTIVE `if` BLOCKS
  // WITH NO `else` — `IF_ELSE_ONE_WRITE_PER_BRANCH` pins if/else and
  // `SIBLING_ELSE_BETWEEN_SEQUENTIAL_WRITES` pins a sibling `} else`. Neither
  // covers the shape this fix actually surfaces.
  const CALLER_COMPOSING_THE_TWINS = `
  ipcMain.handle(
    "contacts:create",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      contactData: unknown,
    ): Promise<ContactResponse> => {
        const contact = await databaseService.createContact(
          {
            user_id: validatedUserId,
            // BACKLOG-2707 — \`?? ""\`, not \`|| "Unknown"\`. Same reason as the
            // import loop above; one substitution site left behind is how this
            // recurs.
            display_name: validatedData.name ?? "",
            email: validatedData.email ?? undefined,
            phone: validatedData.phone ?? undefined,
            company: validatedData.company ?? undefined,
            title: validatedData.title ?? undefined,
            source,
            is_imported: true,
          },
          // BACKLOG-2496 — "derived": this contact was typed into the Add
          // Contact form (or arrived from a message thread), so there is no
          // address-book record to point at and its origin row is synthetic,
          // keyed on its own id. The row is now written INSIDE the create
          // transaction, so the separate \`recordContactOrigin\` call that used
          // to sit below is gone: it could not fail to happen any more.
          { kind: "derived" },
        );

        /**
         * WHERE THIS CONTACT CAME FROM IS NO LONGER WRITTEN HERE (BACKLOG-2496).
         *
         * It used to be a \`recordContactOrigin(...)\` call on this line, AFTER
         * the contact had already been committed. That is the defect this item
         * closes: two separate writes, with nothing forcing the second, so a
         * crash or a throw between them left a contact with no origin —
         * indistinguishable afterwards from one a path never wrote.
         *
         * The origin is now a REQUIRED ARGUMENT to \`createContact\` above and is
         * written inside the same transaction as the contact. A create path that
         * does not state an origin does not compile, and one that does cannot
         * half-succeed.
         *
         * The four-way case analysis that used to sit here — listing which
         * create paths were covered and naming the import batch and the Android
         * promote as KNOWN GAPS — is obsolete: all of them now go through a
         * signature that requires it.
         */

        // BACKLOG-1270: Store ALL emails/phones (not just the primary)
        //
        // BACKLOG-2427: with the SAME provenance the contact itself was given.
        // These two calls stamped every value 'import' regardless — and the
        // manual Add Contact form arrives here with no \`source\` at all, so
        // \`source\` above resolves to "manual" while the addresses the user had
        // just typed were recorded as imported. The unlink is then entitled to
        // delete them: a stranger's address-book card sharing the contact's
        // office line was enough to take a client's own phone number off their
        // record.
        const valueSource = contactInfoSourceFor(source);
        const inputAllEmails = (contactData as { allEmails?: string[] })?.allEmails || [];
        const inputAllPhones = (contactData as { allPhones?: string[] })?.allPhones || [];
        if (inputAllEmails.length > 0) {
          await databaseService.backfillContactEmails(contact.id, inputAllEmails, valueSource);
          logService.info(\`[Contacts] Stored \${inputAllEmails.length} emails for new contact \${contact.id}\`, "Contacts");
        }
        if (inputAllPhones.length > 0) {
          await databaseService.backfillContactPhones(contact.id, inputAllPhones, valueSource);
          logService.info(\`[Contacts] Stored \${inputAllPhones.length} phones for new contact \${contact.id}\`, "Contacts");
        }
    },
  );
`;

  const declsOf = (src: string): { name: string; body: string }[] =>
    dbWriterDeclsIn(src.split("\n"));

  it("admits a wrapper that delegates to a writing twin — and did NOT before", () => {
    const decls = declsOf(DB_LAYER_WITH_TWINS);
    const before = writersFrom(decls, false);
    const after = writersFrom(decls);

    // The twin holds the SQL, so it is a writer under BOTH derivations.
    expect(before.has("backfillContactEmailsSync")).toBe(true);
    expect(after.has("backfillContactEmailsSync")).toBe(true);

    // The wrapper holds none. This is the defect, and then the fix.
    expect(before.has("backfillContactEmails")).toBe(false);
    expect(after.has("backfillContactEmails")).toBe(true);
    expect(before.has("backfillContactPhones")).toBe(false);
    expect(after.has("backfillContactPhones")).toBe(true);

    // Exact delta, not a size: pass 2 restores the delegating wrappers and
    // NOTHING else. A count would pass just as well if it swapped a name.
    expect([...after].filter((n) => !before.has(n)).sort()).toEqual([
      "backfillContactEmails",
      "backfillContactPhones",
    ]);
  });

  it("a db/ export that does NOT reference its twin is not admitted", () => {
    const writers = writersFrom(declsOf(WRAPPER_WITHOUT_DELEGATION));
    expect(writers.has("backfillContactEmailsSync")).toBe(true);
    // Naming coincidence is not delegation. `base` is BARE NAMES over 434 unique
    // names with six measured duplicates, so without the body check a `foo` in
    // one file pairs with a writing `fooSync` in another on the name alone.
    expect(writers.has("backfillContactEmails")).toBe(false);
  });

  it("a wrapper whose twin only READS is not admitted", () => {
    const writers = writersFrom(declsOf(TWIN_THAT_ONLY_READS));
    // The twin exists and is delegated to — but it issues no write, so neither
    // name is a writer. Pins the rule against "a twin declaration exists".
    expect(writers.has("backfillContactEmailsSync")).toBe(false);
    expect(writers.has("backfillContactEmails")).toBe(false);
  });

  it("reports a handler composing twin wrappers as an offender — and did NOT before", () => {
    const decls = declsOf(DB_LAYER_WITH_TWINS);
    const before = writersFrom(decls, false);
    const after = writersFrom(decls);

    // NOT `electron/services/db/...`: inside `db/` the raw-SQL rule stands and
    // call tokens are OFF, which would make every assertion below vacuous.
    const rel = "electron/handlers/contactHandlers.ts";
    const lines = CALLER_COMPOSING_THE_TWINS.split("\n");
    const unitsBefore = unitsInFile(rel, lines, before);
    const unitsAfter = unitsInFile(rel, lines, after);

    // The db/ pair and the caller are SEPARATE strings on purpose. In one
    // combined string `unitsInFile`'s `localWriters` rule would admit a
    // non-exported `backfillContactEmails` declaration at depth 1, and this test
    // would pass with the twin clause deleted.
    expect(unitsBefore.map((u) => u.name)).toEqual(["ipc:contacts:create"]);
    expect(unitsAfter.map((u) => u.name)).toEqual(["ipc:contacts:create"]);

    // Counts DERIVED FROM THIS FIXTURE'S CONTENTS: `createContact` is a raw-SQL
    // writer in both derivations, the two backfills only in the second.
    expect(unitWrites(unitsBefore[0]).length).toBe(1);
    expect(unitWrites(unitsAfter[0]).length).toBe(3);

    // THE ASSERTION THAT MATTERS. A write COUNT cannot separate a violation from
    // a non-violation — `length === 2` is equally true of a correctly
    // branch-exclusive upsert. Run the offender predicate itself and assert the
    // unit's NAME.
    const offenders = (units: Fn[]): string[] =>
      units
        .filter((u) => unitWrites(u).length >= 2)
        .filter((u) => !wrapsItself(u.body))
        .filter((u) => !writesAreBranchExclusive(u.body, u.isDbWriterCall, u.name))
        .map((u) => u.name);

    expect(offenders(unitsBefore)).toEqual([]);
    expect(offenders(unitsAfter)).toEqual(["ipc:contacts:create"]);
  });
});

/**
 * ===========================================================================
 * BACKLOG-3232 — THE ENUMERATOR OVER A CLASS, BOTH DIRECTIONS
 * ===========================================================================
 * Transcribed from `electron/services/transactionService/transactionService.ts`
 * @ `abaa1ff20`, never invented — the shapes are `_saveCommunications` (:513,
 * private, two writes), `removeContactFromTransaction` (:1344, public, one
 * write) and a constructor. The wrapped method transcribes the generic
 * `dbTransaction<LinkSourceOutcome>(() => {` form from
 * `electron/services/contactManualLink.ts:304` @ `abaa1ff20`.
 *
 * WHAT EACH ELEMENT IS LOAD-BEARING FOR — none of these is decoration:
 *
 *   - `oneWrite` proves the widening does NOT report a non-violation. This
 *     guard's first version reported nine offenders and SIX were false
 *     positives; a widening with no negative direction repeats that.
 *   - `_twoWrites` is PRIVATE, and it is reported. Lane G's real offender
 *     (`iPhoneSyncStorageService.rollbackSession`) is a private method, so a
 *     future "only public members" narrowing has to redden this line.
 *   - `wrapped` proves `wrapsItself` can read a method capture at all.
 *     `node.getText()` is a DIFFERENT capture from `captureBody` — it starts at
 *     the member's first token, not at column 0 — and if it were ever truncated
 *     the way BACKLOG-3225 truncates `captureBody`, this method would read as
 *     having no transaction and appear as a two-write offender.
 *   - The constructor pins `<ClassName>.constructor` keying. A bare
 *     `constructor` name collides with every other constructor in the same
 *     file, and `EXEMPT` / `KNOWN_UNWRAPPED` are keyed `file::name`.
 *
 * The class is NOT exported and holds no `export` keyword anywhere. That is
 * deliberate: it proves membership does not depend on an export, which is what
 * makes the 80 files enumerable regardless of which of the six escape shapes
 * they use (`export default new X()`, `export default x`, `export const x =
 * new X()`, a named re-export, and combinations).
 */
describe("the enumerator sees a class, in both directions (BACKLOG-3232)", () => {
  const CLASS_SHAPED_SERVICE = `
class TransactionService {
  private cache: Map<string, string> | null = null;

  constructor() {
    this.cache = null;
  }

  async removeContactFromTransaction(
    transactionId: string,
    contactId: string,
  ): Promise<void> {
    return await databaseService.unlinkContactFromTransaction(
      transactionId,
      contactId,
    );
  }

  private async _saveCommunications(
    userId: string,
    transactionId: string,
  ): Promise<void> {
    let emailRecord = await getEmailByExternalId(userId, externalId);

    if (!emailRecord) {
      emailRecord = await createEmail({
        user_id: userId,
        external_id: externalId,
      });
    }

    await databaseService.createCommunication(commData as NewCommunication);
  }

  async linkSourceToContact(contactId: string): Promise<LinkSourceOutcome> {
    return dbTransaction<LinkSourceOutcome>(() => {
      createEmail({ user_id: contactId });
      databaseService.createCommunication(commData as NewCommunication);
      return { ok: true } as LinkSourceOutcome;
    });
  }
}

export default new TransactionService();
`;

  const WRITERS = new Set(["createEmail", "createCommunication", "unlinkContactFromTransaction"]);
  const REL = "electron/services/transactionService/transactionService.ts";

  it("enumerates every member of a class that declares no `export function` at all", () => {
    const units = unitsInFile(REL, CLASS_SHAPED_SERVICE.split("\n"), WRITERS);

    // The OLD enumerator returned [] for this entire string. That is the defect.
    expect(units.map((u) => u.name)).toEqual([
      "TransactionService.constructor",
      "removeContactFromTransaction",
      "_saveCommunications",
      "linkSourceToContact",
    ]);
  });

  it("reports the two-write PRIVATE method and does NOT report the one-write method", () => {
    const units = unitsInFile(REL, CLASS_SHAPED_SERVICE.split("\n"), WRITERS);
    const byName = (n: string): Fn => units.find((u) => u.name === n) as Fn;

    // The negative direction first: one write is not a violation.
    expect(unitWrites(byName("removeContactFromTransaction")).length).toBe(1);

    // The positive direction: two writes, private, unwrapped -> reported.
    const twoWrites = byName("_saveCommunications");
    expect(unitWrites(twoWrites).length).toBe(2);
    expect(wrapsItself(twoWrites.body)).toBe(false);
    expect(writesAreBranchExclusive(twoWrites.body, twoWrites.isDbWriterCall, twoWrites.name)).toBe(false);
  });

  it("reads a transaction out of a METHOD capture — `node.getText()` is not `captureBody`", () => {
    const units = unitsInFile(REL, CLASS_SHAPED_SERVICE.split("\n"), WRITERS);
    const wrapped = units.find((u) => u.name === "linkSourceToContact") as Fn;

    // Two writes, so it would be an offender if the capture lost the wrapper.
    expect(unitWrites(wrapped).length).toBe(2);
    expect(wrapsItself(wrapped.body)).toBe(true);
  });
});

/**
 * ===========================================================================
 * BACKLOG-3312 — THE RESOLVER, TESTED DIRECTLY
 * ===========================================================================
 * The scan below can only prove things about the tree as it stands today. It
 * cannot prove the RULE — and on this defect a green scan was the SYMPTOM, not
 * the evidence: `pruneOldEntries` enumerated and reported clean for its whole
 * life under the widened enumerator.
 *
 * Every fixture here is TRANSCRIBED from real source at `8f17c1e16`, never
 * invented. `SQL_MODULE` is `electron/services/db/failureLogSql.ts`, `CONSUMER`
 * is the shape of `failureLogService.ts::pruneOldEntries`, and `PROSE_MODULE`
 * is `TRANSACTION_COLUMN_POLICY` from `db/transactionDbService.ts:310` — the
 * constant that made a naive resolver report a function with no defect.
 */
describe("a hoisted SQL constant is resolved, not pattern-matched (BACKLOG-3312)", () => {
  let dir = "";

  const SQL_MODULE = [
    'import { sql } from "./core/sqlText";',
    "",
    "export const PRUNE_BY_AGE_SQL = sql`DELETE FROM failure_log WHERE timestamp < datetime('now', ?)`;",
    "",
    "export const FAILURE_LOG_COUNT_SQL = sql`SELECT COUNT(*) as count FROM failure_log`;",
    "",
    "export const PRUNE_BY_CAP_SQL = sql`DELETE FROM failure_log WHERE id IN (",
    "            SELECT id FROM failure_log ORDER BY timestamp ASC LIMIT ?",
    "          )`;",
  ].join("\n");

  const CONSUMER = [
    'import { dbRun, dbGet } from "./dbConnection";',
    "import {",
    "  FAILURE_LOG_COUNT_SQL,",
    "  PRUNE_BY_AGE_SQL,",
    "  PRUNE_BY_CAP_SQL,",
    '} from "./failureLogSql";',
  ].join("\n");

  const PROSE_MODULE = [
    "export const TRANSACTION_COLUMN_POLICY = {",
    "  text_thread_count: {",
    "    insert: undefined,",
    '    why: "Owned by a hand-built `UPDATE transactions SET text_thread_count = ?` in communicationDbService.ts:1085 and :1125, which bypasses this writer and the whitelist entirely (BACKLOG-2739 Phase-2 input).",',
    "  },",
    "};",
  ].join("\n");

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-3312-"));
    fs.writeFileSync(path.join(dir, "failureLogSql.ts"), SQL_MODULE);
    fs.writeFileSync(path.join(dir, "consumer.ts"), CONSUMER);
    fs.writeFileSync(path.join(dir, "prose.ts"), PROSE_MODULE);
    fs.writeFileSync(
      path.join(dir, "proseConsumer.ts"),
      'import { TRANSACTION_COLUMN_POLICY } from "./prose";'
    );
    // A binding chain SIX hops long. The first resolver capped recursion at
    // four AND cached what it found at the cap, so a module first reached deep
    // resolved to nothing and stayed that way. Six, so a cap of four fails.
    fs.writeFileSync(path.join(dir, "hop6.ts"), "export const DEEP_SQL = `DELETE FROM deep_table WHERE id = ?`;");
    for (let i = 5; i >= 1; i--) {
      fs.writeFileSync(
        path.join(dir, `hop${i}.ts`),
        `export { DEEP_SQL } from "./hop${i + 1}";`
      );
    }
    fs.writeFileSync(path.join(dir, "deepConsumer.ts"), 'import { DEEP_SQL } from "./hop1";');
  });

  afterAll(() => {
    clearConstCaches();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves an imported constant to the writes its text issues, and a SELECT to none", () => {
    const consts = writeConstsIn(path.join(dir, "consumer.ts"));
    // Assert the SET, not its size: a count cannot tell "resolved the two
    // DELETEs" from "resolved a DELETE and the SELECT".
    expect([...consts.keys()].sort()).toEqual(["PRUNE_BY_AGE_SQL", "PRUNE_BY_CAP_SQL"]);
    expect(consts.get("PRUNE_BY_AGE_SQL")).toBe(1);
    expect(consts.get("PRUNE_BY_CAP_SQL")).toBe(1);
    expect(consts.has("FAILURE_LOG_COUNT_SQL")).toBe(false);
  });

  it("prose inside an object literal is NOT a write", () => {
    // Measured: without the SQL-text restriction this resolves, and
    // `db/transactionDbService.ts:979 updateTransaction` becomes a reported
    // offender — a function with no defect, which under this guard's own rule
    // could only be quieted by filing a bogus item.
    expect(writeCount(PROSE_MODULE)).toBeGreaterThan(0); // the text really does match
    expect([...writeConstsIn(path.join(dir, "proseConsumer.ts")).keys()]).toEqual([]);
  });

  it("the resolved set does not depend on visit order", () => {
    clearConstCaches();
    const askedFirst = writeConstsIn(path.join(dir, "deepConsumer.ts")).get("DEEP_SQL");

    clearConstCaches();
    // Warm every module in the chain from the far end before asking. Under the
    // first implementation this produced a DIFFERENT answer: 19 offenders on
    // one run and 20 on three others, from identical code.
    for (let i = 6; i >= 1; i--) writeConstsIn(path.join(dir, `hop${i}.ts`));
    const warmedFromTheEnd = writeConstsIn(path.join(dir, "deepConsumer.ts")).get("DEEP_SQL");

    expect(askedFirst).toBe(1);
    expect(warmedFromTheEnd).toBe(askedFirst);
    clearConstCaches();
  });

  it("a constant name is not matched as a SUBSTRING of a longer identifier", () => {
    const abs = path.join(dir, "consumer.ts");
    expect(constWriteOffsets("dbRun(PRUNE_BY_AGE_SQL, [d]);", abs).map((w) => w.label)).toEqual([
      "PRUNE_BY_AGE_SQL",
    ]);
    expect(constWriteOffsets("dbRun(LEGACY_PRUNE_BY_AGE_SQL_V2, [d]);", abs)).toEqual([]);
  });

  it("PRECONDITION: the unit that enumerated and counted ZERO now counts its two DELETEs", () => {
    // THE named false green. `failureLogService.ts` is class-shaped, so it
    // enumerated nothing until BACKLOG-3232; it then enumerated nine units and
    // counted ZERO writes in this one, over a site BACKLOG-2554 already called
    // unsafe. Revert the resolution and this goes red.
    const prune = scanUnits().find(
      (u) => u.file === "electron/services/failureLogService.ts" && u.name === "pruneOldEntries"
    );
    expect(prune).toBeDefined();
    // NAMES, not a count: the count cannot tell the two DELETEs from a DELETE
    // counted twice.
    expect(unitWrites(prune as Fn).map((w) => w.label).sort()).toEqual([
      "PRUNE_BY_AGE_SQL",
      "PRUNE_BY_CAP_SQL",
    ]);
  });

  it("the pattern is NOT widened — `writeCount` alone still sees nothing in that body", () => {
    // The forbidden fix was a regex matching things that LOOK like SQL constant
    // names. This is the difference, asserted: the body holds no SQL at any
    // pattern breadth, and the two writes come from resolving the declaration.
    const prune = scanUnits().find(
      (u) => u.file === "electron/services/failureLogService.ts" && u.name === "pruneOldEntries"
    ) as Fn;
    expect(writeCount(prune.body)).toBe(0);
    expect(unitWrites(prune).length).toBe(2);
  });

  it("a db/ writer that hoists its statement is in the writer set — it was not before", () => {
    // The floor `dbWriterDeclsIn` named at `0dca6beb1` and struck through above.
    // File-qualified by construction: both names are unique in `db/`.
    const writers = dbLayerWriters();
    expect(writers.has("clearSyncCursor")).toBe(true);
    expect(writers.has("updateLastMessageAtFromLookupTable")).toBe(true);
  });
});

describe("a multi-statement write may not ship without a transaction (BACKLOG-2530)", () => {
  const units = scanUnits();
  const insideATransaction = namesCalledInsideATransaction();

  it("PRECONDITION: the scan reaches the db layer AND the orchestration layer", () => {
    expect(units.length).toBeGreaterThan(50);
    // If this ever drops to zero the guard below passes vacuously — which is
    // the failure mode every check in this repo is now written to avoid.
    expect(units.some((u) => u.name === "createContact")).toBe(true);

    // BACKLOG-2584: the db-layer name above passed for this guard's whole life
    // while the orchestration layer was unscanned. Name one function from the
    // widened root, so a root that silently reverts to `db/` cannot pass.
    expect(units.some((u) => u.name === "unlinkContactSource")).toBe(true);
  });

  it("PRECONDITION: the IPC surface is enumerated at handler granularity", () => {
    // 243 of 323 `ipcMain.handle(` registrations put the channel on a LATER
    // line. A capture that reads only the `handle(` line misses 75% of handlers
    // and reports green over them. This channel is registered multi-line.
    expect(units.some((u) => u.name === "ipc:transactions:export-enhanced")).toBe(true);

    // And one registered through a wrapper — `wrapHandler(async (...) => {` —
    // which the paren-bounded capture has to see through.
    expect(units.some((u) => u.name === "ipc:transactions:link-emails")).toBe(true);

    // A registrar must NOT survive as its own unit: its brace-matched body
    // swallows every handler it registers, and it would report their writes
    // added together under a function that issues none.
    expect(units.some((u) => u.name === "registerContactHandlers")).toBe(false);
  });

  it("PRECONDITION: the db-layer writer set is populated and type fixtures are excluded", () => {
    // The composition rule stands entirely on this set. Empty set, green guard.
    expect(dbLayerWriters().size).toBeGreaterThan(50);

    // The exclusion is pinned, not merely written: assert the directory EXISTS
    // and that nothing from it was enumerated. Asserting absence alone would
    // pass just as well if the directory were renamed or deleted.
    expect(fs.existsSync(path.join(REPO_ROOT, "electron", "types", "__typefixtures__"))).toBe(true);
    expect(units.some((u) => u.file.includes("__typefixtures__"))).toBe(false);

    // BACKLOG-2549 — PIN. `recordExportCompletion` is what the two export
    // handlers now write through, so it is the single name that keeps them
    // countable. If its signature is ever rewritten with an INLINE object type
    // in the parameter list, `captureBody` closes before the body opens
    // (BACKLOG-3225), the function reads as having no writes, it drops out of
    // this set, and both handlers silently fall to 0 counted writes — green
    // because the guard went blind, not because the code is atomic. Keep the
    // named `ExportCompletionParams` interface.
    expect(dbLayerWriters().has("recordExportCompletion")).toBe(true);
  });

  it("PRECONDITION: a class-shaped service is enumerated at member granularity (BACKLOG-3232)", () => {
    // `databaseService.ts` yielded ZERO units for this guard's whole life. It is
    // named here rather than counted in the aggregate, because an aggregate
    // cannot tell "the class walk works" from "some other file grew".
    const dbSvc = units.filter((u) => u.file === "electron/services/databaseService.ts");
    expect(dbSvc.length).toBeGreaterThan(100);

    // THE method the EXEMPT block above says this guard "has never enumerated".
    // File-qualified: a bare name would also match a namesake elsewhere in the
    // tree, and this assertion exists precisely to prove THIS file is read.
    expect(dbSvc.some((u) => u.name === "runMigrations")).toBe(true);

    // And the other lane file the item names, so a walk that somehow only
    // reached one class cannot pass.
    expect(
      units.some(
        (u) =>
          u.file === "electron/services/transactionService/transactionService.ts" &&
          u.name === "unlinkMessages"
      )
    ).toBe(true);
  });

  it("PRECONDITION: every unit key is unique, and there are enough keys to matter", () => {
    // `EXEMPT` and `KNOWN_UNWRAPPED` are keyed `file::name`. A collision means
    // ONE entry silently covers TWO units — the bare-name failure this guard has
    // already been burned by three times (EXEMPT's re-key, `deleteLiveForceSet`,
    // and the known-list re-key).
    const byKey = new Map<string, string[]>();
    for (const u of units) {
      const k = exemptKey(u);
      byKey.set(k, [...(byKey.get(k) ?? []), `${u.file}:${u.line}`]);
    }

    // ASSERT THE COUNT, NOT ONLY THE ABSENCE. A collision check that silently
    // matches nothing passes exactly as loudly as one that matches everything.
    expect(byKey.size).toBeGreaterThan(2000);

    const collisions = [...byKey.entries()]
      .filter(([, at]) => at.length > 1)
      .map(([k, at]) => `${k} -> ${at.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("PRECONDITION: it can tell a wrapped write from an unwrapped one", () => {
    const wrapped = units.filter((u) => unitWrites(u).length >= 2 && wrapsItself(u.body));
    expect(wrapped.length).toBeGreaterThan(0);

    // BACKLOG-2569: the positive half alone passes vacuously if `wrapsItself`
    // ever returns true for everything. Assert the NEGATIVE half too — a body
    // that opens no transaction must not read as wrapped.
    expect(wrapsItself(`dbRun(\`INSERT INTO contacts (id) VALUES (?)\`, [id]);`)).toBe(false);
    expect(wrapsItself(`await dbTransaction(async () => { dbRun(sql, v); });`)).toBe(true);
  });

  function unwrapped(): Fn[] {
    return units
      .filter((u) => unitWrites(u).length >= 2)
      .filter((u) => !wrapsItself(u.body))
      .filter((u) => !writesAreBranchExclusive(u.body, u.isDbWriterCall, u.name, u.file))
      .filter((u) => !insideATransaction.has(u.name))
      .filter((u) => !(exemptKey(u) in EXEMPT));
  }

  it("NO NEW multi-write function ships without a transaction", () => {
    const offenders = unwrapped()
      .filter((f) => !(exemptKey(f) in KNOWN_UNWRAPPED))
      .map((f) => `${f.file}:${f.line}  ${f.name}  (${unitWrites(f).length} writes)`);

    // Exact set, not a count — a count cannot tell a new violation from a
    // different one that replaced it.
    expect(offenders).toEqual([]);
  });

  it("the known list may only SHRINK — an entry removed without a fix goes red", () => {
    const stillUnwrapped = unwrapped().map(exemptKey).sort();
    const claimed = Object.keys(KNOWN_UNWRAPPED).sort();

    // Anything claimed as known that is no longer unwrapped has been FIXED —
    // delete it from KNOWN_UNWRAPPED. Anything unwrapped and not claimed is a
    // new violation, caught by the test above.
    const fixedButStillListed = claimed.filter((n) => !stillUnwrapped.includes(n));
    expect(fixedButStillListed).toEqual([]);
  });

  it("every known entry says what a crash would leave, in plain terms", () => {
    for (const [name, damage] of Object.entries(KNOWN_UNWRAPPED)) {
      // "data could be inconsistent" is not a description. BACKLOG-2530 asks
      // for the intermediate state named concretely.
      expect(damage.length).toBeGreaterThan(40);
      expect(damage).not.toMatch(/inconsistent state|data integrity issue/i);
      expect(typeof name).toBe("string");
    }
  });

  it("the exemption list stays small and every entry gives a reason", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(reason).not.toMatch(/^(ok|fine|n\/a|todo)/i);
      expect(typeof name).toBe("string");
    }
    // A growing exemption list is the failure mode of every guard like this.
    expect(Object.keys(EXEMPT).length).toBeLessThanOrEqual(6);
  });
});
