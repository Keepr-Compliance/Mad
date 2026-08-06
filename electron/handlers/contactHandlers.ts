// ============================================
// CONTACT IPC HANDLERS
// This file contains contact handlers to be registered in main.js
// ============================================

import { ipcMain, BrowserWindow, app } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "crypto";
import * as Sentry from "@sentry/electron/main";
import databaseService, {
  TransactionWithRoles as DbTransactionWithRoles,
  ContactMessageThread,
} from "../services/databaseService";
import failureLogService from "../services/failureLogService";
import {
  getContactEmailEntries,
  getContactPhoneEntries,
  syncContactEmails,
  setContactPrimaryEmail,
  syncContactPhones,
  setContactPrimaryPhone,
  getEmailNameMap,
  applyContactBackfillSync,
  type ContactBackfillPlanRow,
} from "../services/db/contactDbService";
import type { RemovedContactRow } from "../services/db/contactDbService";
import { dbTransaction } from "../services/db/core/dbConnection";
import { getContactNames } from "../services/contactsService";
import type { ContactInfo, PhoneToContactInfo } from "../services/contactsService";
import { resolveHandles } from "../services/contactResolutionService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import * as externalContactDb from "../services/db/externalContactDbService";
import type { ExternalContactSource } from "../services/db/externalContactDbService";
import { recordPicker, recordLinks } from "../services/contactIngestionFunnel";
import { toPersistedContactSource } from "../utils/contactSourceVocabulary";
import {
  cancelPendingContactLinking,
  configureContactLinking,
  requestContactLinking,
  runContactLinkingNow,
} from "../services/contactLinkingScheduler";
import {
  createLink,
  findContactIdBySourceRecord,
  getLinkedSourceKeys,
  sourceKey,
} from "../services/db/contactSourceLinkDbService";
import {
  CONTACT_SOURCE_RECORDS_SQL,
  type ContactSourceRecordRow,
} from "../services/db/contactSourceLinkSql";
import { linkExternalContactsForUser } from "../services/contactSourceLinker";
// BACKLOG-2410 — the contact-level review queue and contact provenance.
import { runUniqueNameAutoLink } from "../services/contactNameAutoLink";
// BACKLOG-2459: `sourceLabel` names a folded record's address book in the same
// words the review queue uses, rather than minting a second mapping here.
import { buildEvidence, sourceLabel } from "../services/contactLinkEvidence";
import {
  proposeLink,
  listVerdicts,
  getRejectedSourceKeys,
  type LinkProposalReason,
} from "../services/db/contactLinkReviewDbService";
import {
  countReviewQueue,
  getReviewQueue,
  confirmProposal,
  rejectProposal,
  type ReviewQueueCluster,
} from "../services/contactLinkReview";
import {
  getContactProvenance,
  unlinkContactSource,
  type ContactSourceProvenance,
} from "../services/contactProvenance";
import type { UnlinkSourceResponse } from "../types/ipc/window-api-contacts";
import { queryContacts, isPoolReady } from "../workers/contactWorkerPool";
import { dbAll, dbRun } from "../services/db/core/dbConnection";
import type { Contact, Transaction, ContactSource, Communication } from "../types/models";

// Import validation utilities
import {
  ValidationError,
  validateContactId,
  validateContactData,
  validateString,
  sanitizeObject,
} from "../utils/validation";
import { toE164 } from "../utils/phoneNormalization";
import { namesAreCompatible, normalizeContactName } from "../utils/contactNameCompat";
import { contactInfoSourceFor } from "../utils/contactValueProvenance";
import { applyLinkedSourceValues } from "../services/contactSourceValues";
import {
  recordContactOrigin,
  type ContactOrigin,
} from "../services/db/contactOriginLink";
import { getValidUserId } from "../utils/userIdHelper";
import { isContactSourceEnabled } from "../utils/preferenceHelper";
import contactSyncService from "../services/contactSyncService";
import { OutlookContactProvider } from "../services/providers/outlookContactProvider";
import { GoogleContactProvider } from "../services/providers/googleContactProvider";

// Import handler types
import type {
  AvailableContact,
  ImportableContact,
  ExistingDbContactRecord,
  NewContactData,
} from "../types/handlerTypes";

// Type definitions
interface ContactResponse {
  success: boolean;
  error?: string;
  contact?: Contact;
  contacts?: Contact[] | AvailableContact[];
  contactsStatus?: unknown;
  canDelete?: boolean;
  transactions?: Transaction[] | DbTransactionWithRoles[];
  count?: number;
  transactionCount?: number;
  /**
   * BACKLOG-2367: whether `contacts:restore` actually cleared a tombstone.
   * `success: true, restored: false` is a stale click on an already-active
   * contact — a no-op, not an error.
   */
  restored?: boolean;
}

/**
 * BACKLOG-2367 — response for `contacts:get-removed`.
 *
 * Deliberately NOT `ContactResponse`. That interface's `contacts` field is
 * `Contact[] | AvailableContact[]`, and a removed-contact row is neither: it
 * carries `removed_at`, `removed_reason` and `active_role_count`, which are the
 * only three fields the section actually renders as distinct from a normal
 * contact card. Reusing the loose type would have let the handler return rows
 * missing all three and still compile.
 */
interface RemovedContactsResponse {
  success: boolean;
  error?: string;
  contacts?: RemovedContactRow[];
}

/**
 * BACKLOG-1900 (P0.2) source translation — `toPersistedContactSource` MOVED to
 * `electron/utils/contactSourceVocabulary.ts`. BACKLOG-2472 and BACKLOG-2473
 * each required the move independently, and both reasons are live:
 *
 * BACKLOG-2472 — it is now used on a SECOND path. The contacts list derives each
 * contact's live source set from the crosswalk, which speaks
 * `ExternalContactSource`, while the filter and the card speak `ContactSource`.
 * A copy in each place is how a newly added source ends up filed under
 * "Contacts App" on one path only.
 *
 * BACKLOG-2473 — it used to be private to this file, with nothing anywhere
 * enumerating what it can emit, so a new source value could be added here and be
 * covered by no filter leaf at all, hiding those contacts from EVERY filter with
 * all tests green. SR named that the highest-value missing test in the contacts
 * work. The function now sits beside the list of values it can return, and
 * `contactFilterModel.vocabularyCoverage.test.ts` asserts the filter covers them.
 *
 * It is imported at the top of this file; the call site below is unchanged.
 */

/**
 * BACKLOG-2416: the name-compatibility rule MOVED to
 * `electron/utils/contactNameCompat.ts`.
 *
 * It used to be private to this file, which is how the renderer's picker dedup
 * (`src/utils/contactPickerList.matchesSeen`) came to answer the same question
 * differently — it matched on phone UNCONDITIONALLY, so two people sharing an
 * office line survived the rule below and were then collapsed to one row on
 * screen. There is now one statement of the rule, mirrored for the renderer
 * (which cannot import from `electron/`) and held in step by a parity test.
 */


/**
 * BACKLOG-2316: Build the macOS shadow-table sync payload from a person-deduped
 * list when available, falling back to the phone-keyed `phoneToContactInfo`
 * map (deduped by record id) for older callers / test doubles that only provide
 * the map. Iterating the person list avoids the phone-map last-wins overwrite
 * that dropped a contact whose sole phone is shared with another person, and it
 * also collapses the N-per-phone duplication the phone map produced.
 */
function buildMacOSContactsForSync(
  contacts: ContactInfo[] | undefined,
  phoneToContactInfo: PhoneToContactInfo,
): externalContactDb.MacOSContact[] {
  if (contacts && contacts.length > 0) {
    return contacts.map((c) => ({
      name: c.name,
      phones: c.phones,
      emails: c.emails,
      company: c.company,
      recordId: c.recordId || `auto-${randomUUID().slice(0, 8)}`,
      // BACKLOG-2401: carried through so the capture reaches the shadow table.
      externalUuid: c.externalUuid ?? null,
    }));
  }

  const byRecord = new Map<string, externalContactDb.MacOSContact>();
  for (const info of Object.values(phoneToContactInfo)) {
    const key = info.recordId || info.name || randomUUID();
    if (byRecord.has(key)) continue;
    byRecord.set(key, {
      name: info.name,
      phones: info.phones,
      emails: info.emails,
      company: info.company,
      recordId: info.recordId || `auto-${randomUUID().slice(0, 8)}`,
      externalUuid: info.externalUuid ?? null,
    });
  }
  return Array.from(byRecord.values());
}

/** Reference to mainWindow for emitting progress events */
let _mainWindow: BrowserWindow | null = null;

/**
 * Backfill emails/phones for all imported contacts from external_contacts.
 * Called after external contacts sync to ensure imported contacts have
 * all emails/phones from macOS Contacts.
 */
// ---------------------------------------------------------------------------
// BACKLOG-2401 — source identity plumbing
// ---------------------------------------------------------------------------

/** The PAIR that identifies a record in its origin system, plus the captured
 *  (unused) portable identifier. */
interface SourceIdentity {
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  externalUuid: string | null;
}

/**
 * `contacts.source` and `contact_source_links.source_type` are DIFFERENT
 * vocabularies and conflating them is the mistake the CHECK constraint exists
 * to catch: macOS is `'contacts_app'` in the first and `'macos'` in the second.
 * Only the second is valid here, so an unrecognised value yields no link rather
 * than a row the database would reject.
 */
const EXTERNAL_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "macos",
  "iphone",
  "outlook",
  "google_contacts",
  "android_sync",
]);

/**
 * BACKLOG-2478: stands in for a NULL or empty `external_contacts.source` in the
 * picker's unrecognised-source log.
 *
 * The column is `TEXT DEFAULT 'macos'` with no CHECK and no NOT NULL
 * (schema.sql:1262), and `externalContactDbService` casts `row.source as
 * ExternalContactSource` over it — so the union type is a promise the database
 * does not keep, and a null can arrive here at runtime. Without a sentinel a
 * null source would be shown and never logged, which is the one case the
 * "visible but auditable" argument cannot afford to lose.
 */
const NULL_SOURCE_SENTINEL = "(null/empty)";

/*
 * `toSourceIdentity` (SINGULAR) WAS DELETED HERE — do not reintroduce it.
 *
 * It read one `(externalRecordId, externalSourceType)` pair and returned `null`
 * for anything else, which is the behaviour that caused BACKLOG-2458: a
 * collapsed picker row stands for several source records and it could only ever
 * describe one of them. `toSourceIdentities` (plural) replaces it everywhere.
 *
 * Left as a comment rather than silently removed because nothing would catch
 * its return — a single-identity reader compiles cleanly, passes lint, and
 * reintroduces the exact defect the plural form exists to prevent.
 */

/**
 * Why a picker row yielded no source identity at all.
 *
 * Returned rather than merely logged so the caller can aggregate — an
 * "import everything" run over a thousand address-book rows must not emit a
 * thousand warning lines, but it must not stay silent either (BACKLOG-2458 I2).
 */
type IdentitySkipReason =
  | "no-external-record" // a local `contacts` row; there is no source behind it
  | "unrecognised-source-type"; // a source string the crosswalk cannot store

/**
 * EVERY source identity a picker row stands for (BACKLOG-2458).
 *
 * The row's own `(externalRecordId, externalSourceType)` PLUS every record the
 * picker folded into it. Deduped on the pair, because the representative also
 * appears in `collapsedSources` and a source record must be claimed once.
 *
 * Order is the representative first, then the collapsed records in the order
 * the picker absorbed them, so the crosswalk rows a given import writes are
 * reproducible rather than dependent on Map iteration.
 */
function toSourceIdentities(contact: ImportableContact): {
  identities: SourceIdentity[];
  skipped: IdentitySkipReason | null;
} {
  const identities: SourceIdentity[] = [];
  const seen = new Set<string>();
  let sawUnrecognisedSource = false;

  const consider = (
    sourceType: string | null | undefined,
    sourceRecordId: string | null | undefined,
    externalUuid: string | null | undefined,
  ): void => {
    if (!sourceRecordId || !sourceType) return;
    if (!EXTERNAL_SOURCE_TYPES.has(sourceType)) {
      // A source string the `contact_source_links` CHECK constraint would
      // reject. Recorded so the skip is explicable rather than a row that
      // silently never appears.
      sawUnrecognisedSource = true;
      return;
    }
    // The same canonical PAIR key the crosswalk itself uses, so "already
    // considered" here means exactly what "already claimed" means there.
    const key = sourceKey(sourceType as ExternalContactSource, sourceRecordId);
    if (seen.has(key)) return;
    seen.add(key);
    identities.push({
      sourceType: sourceType as ExternalContactSource,
      sourceRecordId,
      externalUuid: externalUuid ?? null,
    });
  };

  consider(contact.externalSourceType, contact.externalRecordId, contact.externalUuid);
  for (const collapsed of contact.collapsedSources ?? []) {
    consider(collapsed.sourceType, collapsed.sourceRecordId, collapsed.externalUuid);
  }

  if (identities.length > 0) return { identities, skipped: null };
  return {
    identities,
    skipped: sawUnrecognisedSource ? "unrecognised-source-type" : "no-external-record",
  };
}

/** What one contact's link attempt did. Aggregated by the import handler. */
interface LinkImportOutcome {
  /** Crosswalk rows newly written (an already-linked pair counts 0). */
  created: number;
  /** Identities offered to the crosswalk, whether or not they were new. */
  attempted: number;
  /** Set when the row carried NO usable identity — the BACKLOG-2458 I2 path. */
  skipped: IdentitySkipReason | null;
}

/**
 * Write the crosswalk rows for a contact the user has just imported.
 *
 * `match_method` is `'source_id'` for every one of them: the user selected a
 * row that stands for these exact source records, so the link is asserted, not
 * inferred. That is the strongest evidence this system ever gets, and it is
 * written HERE, at import — not left to the opportunistic linker on the next
 * sync, which re-derives the same fact by content matching (weaker) and cannot
 * derive it at all for records sharing no email or phone.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY THE OLD DOCBLOCK WAS HALF TRUE (BACKLOG-2458)
 * ---------------------------------------------------------------------------
 * This function used to open `if (!identity) return;` and its docblock said
 * "failures are logged and swallowed". Only THROWN failures were — the early
 * return logged nothing, and it was the common path: a picker row that had been
 * collapsed, or that came from the local `contacts` table, carries no single
 * source pair. So the one function that records user intent recorded nothing,
 * silently, and the founder's imported contact was matched by CONTENT on the
 * following sync as if he had never chosen it.
 *
 * A skip is now RETURNED so the caller can report it. Thrown failures are still
 * swallowed, and that part of the old reasoning stands: an import that
 * succeeded must not be reported as failed because a link could not be written.
 */
function linkImportedContact(
  userId: string,
  contactId: string,
  identities: SourceIdentity[],
  skipped: IdentitySkipReason | null = null,
): LinkImportOutcome {
  if (identities.length === 0) {
    return { created: 0, attempted: 0, skipped: skipped ?? "no-external-record" };
  }
  let created = 0;
  try {
    for (const identity of identities) {
      const result = createLink({
        userId,
        contactId,
        sourceType: identity.sourceType,
        sourceRecordId: identity.sourceRecordId,
        matchMethod: "source_id",
        externalUuid: identity.externalUuid,
      });
      if (result.created) created++;
    }
    // BACKLOG-2423: the import already copies the values the PICKER carried;
    // this copies what the linked SOURCE RECORDS hold, which is a superset once
    // the shadow rows have been refreshed since the picker was built. Run once
    // after every link, because it reads all of them. Idempotent, so on the
    // common path it inserts nothing.
    applyLinkedSourceValues(userId, contactId);
  } catch (error) {
    logService.warn(
      `[Contacts] could not write a source link on import: ${error}`,
      "Contacts",
    );
  }
  return { created, attempted: identities.length, skipped: null };
}

/**
 * Report what the import managed to record about WHERE its contacts came from.
 *
 * One line, not one per contact: "import everything" runs over ~1000 rows and a
 * per-contact warning would be unreadable in exactly the support ticket it
 * exists to serve. Contact ids are sampled rather than listed in full for the
 * same reason; the counts are exact.
 *
 * Ids only — never a name, an email or a phone number. This lands in support
 * tickets (see the same rule on `backfillImportedContactsFromExternal`).
 */
function reportImportLinking(
  outcomes: Array<{ contactId: string; outcome: LinkImportOutcome }>,
): void {
  const skipped = outcomes.filter((o) => o.outcome.skipped !== null);
  const linksWritten = outcomes.reduce((n, o) => n + o.outcome.created, 0);
  const contactsLinked = outcomes.filter((o) => o.outcome.attempted > 0).length;

  logService.info(
    `[Contacts] import linking: ${contactsLinked} of ${outcomes.length} contacts carried a ` +
      `source identity, ${linksWritten} crosswalk row(s) written as source_id`,
    "Contacts",
  );

  if (skipped.length === 0) return;

  const byReason = new Map<IdentitySkipReason, string[]>();
  for (const { contactId, outcome } of skipped) {
    const reason = outcome.skipped as IdentitySkipReason;
    const ids = byReason.get(reason) ?? [];
    ids.push(contactId);
    byReason.set(reason, ids);
  }
  for (const [reason, ids] of byReason) {
    const sample = ids.slice(0, 10).join(", ");
    const idList = `Contact id(s): ${sample}${ids.length > 10 ? `, +${ids.length - 10} more` : ""}`;

    // THE TWO REASONS ARE NOT THE SAME EVENT, SO THEY DO NOT SHARE A LEVEL
    // (SR review, PR #2194).
    //
    // `no-external-record` is the ordinary, correct outcome for a contact typed
    // by hand or held only in the local `contacts` table: there is no source
    // record behind it, so nothing was lost and no later sync will "recover"
    // anything. Warning about it — and claiming a loss — would be false on the
    // common path and would train the reader to skip exactly the line the other
    // reason needs them to read.
    if (reason === "no-external-record") {
      logService.info(
        `[Contacts] ${ids.length} imported contact(s) had no source record behind them, ` +
          `so no crosswalk row applies. Expected for hand-entered contacts. ${idList}`,
        "Contacts",
      );
      continue;
    }

    // `unrecognised-source-type` IS a defect: a record exists and names a
    // source the crosswalk's CHECK constraint would reject, so the user's own
    // choice is genuinely dropped and only content matching can recover it.
    logService.warn(
      `[Contacts] ${ids.length} imported contact(s) recorded NO source link (${reason}); ` +
        `the user's own choice of record was not captured for them and any link will have ` +
        `to be re-derived by content matching on a later sync. ${idList}`,
      "Contacts",
    );
  }
}

/**
 * Run the opportunistic linking pass and publish its counts.
 *
 * Never throws into the sync: a sync that succeeded must not be reported as
 * failed because linking hit a problem, and the next sync retries anyway.
 */
function runOpportunisticLinking(userId: string): number {
  let linksCreated = 0;
  try {
    const summary = linkExternalContactsForUser(userId);
    linksCreated += summary.idMatched + summary.contentMatched;
    recordLinks({
      recordsIn: summary.resolutions.length,
      idMatched: summary.idMatched,
      contentMatched: summary.contentMatched,
      flagged: summary.flagged,
      unmatched: summary.unmatched,
      // BACKLOG-2410 — content matches refused because the user has already
      // said "different people". Published rather than dropped: this whole
      // feature turns on "asked and answered" being distinguishable from
      // "never asked", and a funnel that folds declines into `unmatched` cannot
      // make that distinction on the one screen support actually reads.
      declined: summary.declined,
    });
  } catch (error) {
    logService.warn(`[Contacts] opportunistic source linking failed: ${error}`, "Contacts");
  }

  // BACKLOG-2410 part 3 — the unique-exact-name rule, run AFTER the crosswalk
  // pass and never before it.
  //
  // Order is load-bearing, not stylistic. The name rule counts holders and
  // collapses a saved contact into any source record it already owns; that
  // collapse reads the crosswalk. Running it first would see a half-populated
  // crosswalk, count one person as two, and refuse links it should make — a
  // silent under-linking that looks exactly like the rule working correctly.
  try {
    const nameSummary = runUniqueNameAutoLink(userId, (pair, ctx) => {
      fileNameQuestion(userId, pair, ctx);
    });
    linksCreated += nameSummary.autoLinked;
    if (nameSummary.autoLinked > 0 || nameSummary.asked > 0) {
      logService.info(
        `[Contacts] unique-name pass: auto-linked ${nameSummary.autoLinked}, ` +
          `asked ${nameSummary.asked}, barred by a previous answer ${nameSummary.barredByVerdict}`,
        "Contacts",
      );
    }
  } catch (error) {
    logService.warn(`[Contacts] unique-name auto-linking failed: ${error}`, "Contacts");
  }

  return linksCreated;
}

/**
 * Phase 2, as the scheduler runs it — BACKLOG-2474.
 *
 * The linking pass, plus the ONE thing that used to depend on the pass being
 * called inline: the backfill.
 *
 * `contacts:get-available` is reachable without ever loading the Contacts
 * screen (transaction details -> Edit Contacts, and the audit assignment flow),
 * and on that ordering `contacts:get-all` has not run, so the once-per-session
 * `backfilledUsers` gate is still unconsumed. The deleted inline call at the
 * old `:1200` genuinely did run before the backfill on that path. Losing that
 * would leave the backfill reading an unpopulated crosswalk and — being
 * one-shot per session — never re-reading it, which drops exactly the
 * renamed-contact case the crosswalk was built for (a contact resolvable ONLY
 * through `contact_source_links`, not by email or phone fallback).
 *
 * So the ordering is preserved by RE-OPENING the gate instead of by call
 * position: if the pass created links, the crosswalk now says something it did
 * not say before, and the backfill is worth re-running. Guarded on links
 * created because that backfill loop is per-contact and must not run on every
 * pass.
 */
async function runLinkingPassWithBackfill(userId: string): Promise<void> {
  const linksCreated = runOpportunisticLinking(userId);
  if (linksCreated === 0) return;

  backfilledUsers.delete(userId);
  const backfillResult = await backfillImportedContactsFromExternal(userId);
  if (backfillResult.updated > 0) {
    logService.info(
      `[Contacts] re-ran backfill after ${linksCreated} new link(s): ` +
        `${backfillResult.updated} contact(s) updated`,
      "Contacts",
    );
  }
}

/**
 * A row id arriving from the renderer.
 *
 * These are UUIDs this process minted and handed out; nothing about them is
 * user-authored. The check exists so a malformed or absent argument fails at the
 * IPC boundary naming the field, rather than reaching a query as `undefined` and
 * returning a confusing empty result. Every id-taking service below ALSO
 * re-checks ownership against the row — this is a shape check, not the
 * authorisation.
 */
function requireUuidArg(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 64) {
    throw new ValidationError(`${fieldName} is missing or malformed`, fieldName);
  }
  return value.trim();
}

/**
 * Turn a name-rule refusal into a queue question.
 *
 * Best-effort, exactly like the crosswalk's own proposal writes: a sync must not
 * fail because a question could not be filed, and the pass is idempotent so the
 * next one re-files it.
 */
function fileNameQuestion(
  userId: string,
  pair: { contactId: string; sourceType: ExternalContactSource; sourceRecordId: string },
  ctx: { reason: LinkProposalReason; holderCount: number; displayName: string },
): void {
  try {
    const built = buildEvidence({
      userId,
      contactId: pair.contactId,
      sourceType: pair.sourceType,
      sourceRecordId: pair.sourceRecordId,
      reason: ctx.reason,
      matchedOn: "name",
      matchedValues: [ctx.displayName],
      nameHolderCount: ctx.holderCount,
      nameText: ctx.displayName,
    });
    proposeLink({
      userId,
      contactId: pair.contactId,
      sourceType: pair.sourceType,
      sourceRecordId: pair.sourceRecordId,
      reason: ctx.reason,
      matchedOn: "name",
      identityAssessment: built.identityAssessment,
      relationshipAssessment: built.relationshipAssessment,
      // Everything sharing this name is one question, however many pairs it
      // decomposes into.
      clusterKey: `name:${ctx.displayName.trim().toLowerCase()}`,
      evidence: built.evidence,
    });
  } catch (error) {
    logService.warn(`[Contacts] could not file a name review question: ${error}`, "Contacts");
  }
}

// Track which users have already been backfilled this session
const backfilledUsers = new Set<string>();

/**
 * Users already offered a one-shot reconciliation pass this session
 * (BACKLOG-2474). See the call site in `contacts:get-available`.
 *
 * Cleared on logout alongside `backfilledUsers` so a second user signing in to
 * the same running app is reconciled on their own terms rather than inheriting
 * the first user's "already done".
 */
const linkingReconciledUsers = new Set<string>();

/**
 * Drop per-session contact bookkeeping — BACKLOG-2474.
 *
 * Exported for the logout path. Both Sets are keyed by user id, so leaving them
 * populated across a user switch would silently skip work the new user needs.
 */
export function resetContactSessionState(): void {
  backfilledUsers.clear();
  linkingReconciledUsers.clear();
  cancelPendingContactLinking();
}

/**
 * Apply the worker's plan, retrying if the database is momentarily locked, and
 * reporting to Sentry if it never lands (BACKLOG-2536).
 *
 * WITH ONE WRITER THIS SHOULD NEVER RETRY. That is the point of keeping it: a
 * busy database now means something is holding the write lock that we do not
 * know about, and silence about that is what the old code gave us — it logged a
 * warning, returned zero, and marked the user done for the session.
 */
async function applyBackfillPlanWithRetry(
  plan: ContactBackfillPlanRow[],
  userId: string,
): Promise<number> {
  const delaysMs = [0, 250, 1000];
  let lastError: unknown = null;

  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      return applyContactBackfillSync(plan);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // Anything that is not a lock is not worth retrying — a schema or
      // constraint failure will fail identically every time.
      if (!/SQLITE_BUSY|database is locked/i.test(message)) break;
      logService.warn("Contact backfill hit a locked database, retrying", "Contacts", { userId, delay });
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  logService.error("Contact backfill failed to apply", "Contacts", { userId, error: message });
  Sentry.captureException(lastError instanceof Error ? lastError : new Error(message), {
    tags: { area: "contacts", operation: "backfill-apply" },
    extra: { plannedContacts: plan.length },
  });
  // Rethrow so the caller does NOT mark this user done for the session.
  throw lastError instanceof Error ? lastError : new Error(message);
}

async function backfillImportedContactsFromExternal(userId: string): Promise<{ updated: number }> {
  // Only run once per user per session — this is a maintenance task, not needed on every load.
  //
  // BACKLOG-2536: the flag is NOT set here. It used to be set BEFORE the `try`,
  // so a failure marked the user done for the session and the backfill never
  // ran again until the app restarted — a partial backfill that reported
  // success. It is now set only after the work actually completes.
  if (backfilledUsers.has(userId)) {
    return { updated: 0 };
  }

  try {
    // TASK-1956 / BACKLOG-2536: the worker PLANS off the main thread; the main
    // process is the only writer. See `applyContactBackfillSync` for why the
    // worker writing was not merely contention but an unfixable race.
    if (isPoolReady()) {
      const plan = (await queryContacts('backfill', userId)) as ContactBackfillPlanRow[];
      const updated = await applyBackfillPlanWithRetry(plan, userId);
      if (updated > 0) {
        logService.info(`Backfilled ${updated} imported contacts from external_contacts (worker-planned)`, "Contacts", { userId });
      }
      backfilledUsers.add(userId);
      return { updated };
    }

    // Fallback: run on main thread if pool not ready
    let updated = 0;

    // BACKLOG-2401 — THE DEFECT THIS FUNCTION EXISTED TO DEMONSTRATE.
    //
    // This loop used to be:
    //     SELECT emails_json, phones_json FROM external_contacts
    //      WHERE user_id = ? AND name = ?          -- ? = contacts.display_name
    //
    // Display-name string equality was the ONLY bridge from a saved contact
    // back to its address-book row. Jane Seller marries, updates her name in
    // Contacts.app, and the next sync refreshes the shadow row under the new
    // name — so this lookup finds nothing, her saved record is permanently
    // orphaned (no phone or email update ever reaches it again), and she
    // re-offers herself in the import picker as a new person. Nothing surfaced
    // any of it; it accumulated silently.
    //
    // Now: resolve through the crosswalk, which is keyed on the source record
    // rather than on what that record currently says. A rename changes the
    // name; it does not change ZUNIQUEID, so the link holds and the update
    // lands. Contacts with no crosswalk row yet fall through to the SAME
    // email/phone matching used everywhere else — NEVER back to name.
    const importedContacts = dbAll<{ id: string }>(
      `SELECT id FROM contacts WHERE user_id = ? AND is_imported = 1`,
      [userId],
    );

    for (const contact of importedContacts) {
      // Every linked source record, in the declared precedence order. A person
      // present in macOS AND Outlook contributes BOTH sets — backfill is
      // additive and dedupes, so reading them all is strictly more complete
      // than picking a winner, and the order is total so it is reproducible.
      const externals = dbAll<ContactSourceRecordRow>(CONTACT_SOURCE_RECORDS_SQL, [
        { userId, contactId: contact.id },
      ]);
      if (externals.length === 0) continue;

      let emailsAdded = 0;
      let phonesAdded = 0;
      for (const external of externals) {
        const emails: string[] = external.emails_json ? JSON.parse(external.emails_json) : [];
        const phones: string[] = external.phones_json ? JSON.parse(external.phones_json) : [];
        emailsAdded += await databaseService.backfillContactEmails(contact.id, emails);
        phonesAdded += await databaseService.backfillContactPhones(contact.id, phones);
      }

      if (emailsAdded > 0 || phonesAdded > 0) {
        updated++;
        // No display name in the log line — this ends up in support tickets.
        logService.debug(
          `Backfilled a contact via ${externals[0].matched_by}: +${emailsAdded} emails, +${phonesAdded} phones`,
          "Contacts",
        );
      }
    }

    if (updated > 0) {
      logService.info(`Backfilled ${updated} imported contacts from external_contacts`, "Contacts", { userId });
    }

    return { updated };
  } catch (error) {
    logService.warn(`Failed to backfill imported contacts: ${error}`, "Contacts");
    return { updated: 0 };
  }
}

/**
 * Register all contact-related IPC handlers
 * @param mainWindow - The main browser window for emitting progress events
 */
export function registerContactHandlers(mainWindow: BrowserWindow): void {
  _mainWindow = mainWindow;

  // TASK-2300: Register contact sync providers
  // TASK-2301: Both providers registered here (not at module load) to avoid side effects during import
  contactSyncService.registerProvider(new OutlookContactProvider());
  contactSyncService.registerProvider(new GoogleContactProvider());

  // BACKLOG-2474 — hand Phase 2 to the scheduler.
  //
  // The runner is injected rather than imported so the scheduler stays free of
  // the handler layer (it would be a circular import), and so it knows only
  // WHEN to run, never what the pass does. Until this call, every scheduler
  // entry point is a no-op that creates no timers.
  configureContactLinking({
    run: runLinkingPassWithBackfill,
    notify: () => {
      // Its own channel, NOT `contacts:external-sync-complete`. That event is
      // also consumed by ImportContactsModal, which reloads the available list
      // when it fires — and this notify fires DURING an import, from the very
      // modal that is open. Repopulating the picker mid-import would invalidate
      // the selection Set against freshly-minted contact ids, which is the
      // id-swap family of bug that has bitten this area repeatedly.
      if (_mainWindow && !_mainWindow.isDestroyed()) {
        _mainWindow.webContents.send("contacts:link-review-updated");
      }
    },
  });

  // Get all imported contacts for a user (local database only)
  ipcMain.handle(
    "contacts:get-all",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<ContactResponse> => {
      try {
        const t0 = Date.now();

        // BACKLOG-551: Validate user ID exists in local DB
        // BACKLOG-615: Return empty array gracefully during deferred DB init (onboarding)
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          logService.info("[Contacts] No local user yet, returning empty contacts (deferred DB init)", "Contacts");
          return {
            success: true,
            contacts: [],
          };
        }

        // TASK-1956: Use worker thread to avoid blocking main process during contact load
        const importedContacts =
          await databaseService.getImportedContactsByUserIdAsync(validatedUserId);

        logService.debug(
          `[PERF] contacts.getAll: ${Date.now() - t0}ms, ${importedContacts.length} contacts`,
          "Contacts",
        );

        // Backfill missing emails/phones in background (once per session, non-blocking)
        // Deferred so it doesn't block the initial contact list render
        backfillImportedContactsFromExternal(validatedUserId).then((backfillResult) => {
          if (backfillResult.updated > 0) {
            logService.info(
              `Backfilled ${backfillResult.updated} imported contacts with missing emails/phones`,
              "Contacts",
            );
          }
        }).catch((err) => {
          logService.warn(`Background backfill failed: ${err}`, "Contacts");
        });

        return {
          success: true,
          contacts: importedContacts,
        };
      } catch (error) {
        logService.error("Get contacts failed", "Contacts", {
          userId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get available contacts for import (from external sources + unimported DB contacts)
  // TASK-1773: Uses external_contacts shadow table for instant loading
  ipcMain.handle(
    "contacts:get-available",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<ContactResponse> => {
      try {
        logService.info(
          "[Main] Getting available contacts for import (shadow table)",
          "Contacts",
          { userId },
        );

        // BACKLOG-551: Validate user ID exists in local DB
        // BACKLOG-615: Return empty array gracefully during deferred DB init (onboarding)
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          logService.info("[Contacts] No local user yet, returning empty available contacts (deferred DB init)", "Contacts");
          return {
            success: true,
            contacts: [],
            contactsStatus: { loaded: true },
          };
        }

        // QA ISOLATION (BACKLOG-1977): under the DOUBLE-gated E2E harness
        // (`!app.isPackaged && KEEPR_E2E === '1'`, identical to isE2EServeDistMode /
        // permissionHandlers) the "available" set MUST be empty — it is otherwise
        // sourced from the real machine (STEP 1 unimported-DB rows, STEP 2 the live
        // macOS Contacts.framework read via getContactNames(), STEP 3 the
        // external_contacts shadow table). On a developer/CI Mac that leaks ~1000
        // real address-book contacts into the isolated fixture profile, so the
        // fixture-based contacts-filter cell (which seeds a KNOWN is_imported=1
        // corpus and OBSERVES it via count-contacts.js) renders extras the oracle
        // never accounts for. The seeded corpus is is_imported=1 and reaches the UI
        // through the SEPARATE `contacts:get-all` path (getImportedContactsByUserId),
        // so returning an empty external set here leaves the fixture intact while
        // stopping the leak. Inert in any shipped build (app.isPackaged === true).
        if (!app.isPackaged && process.env.KEEPR_E2E === "1") {
          logService.info(
            "[E2E] KEEPR_E2E=1 — skipping external/address-book contacts read; returning empty available set (QA isolation, BACKLOG-1977)",
            "Contacts",
          );
          return {
            success: true,
            contacts: [],
            contactsStatus: { loaded: true },
          };
        }

        // Get already imported contact identifiers to filter them out.
        // BACKLOG-2316: only strong identifiers (email + normalized phone) are
        // used to detect already-imported contacts — name-based matching was
        // removed because it over-suppressed distinct same-named people.
        // TASK-1956: Use async worker version to avoid blocking main process
        const activeImported =
          await databaseService.getImportedContactsByUserIdAsync(validatedUserId);

        // BACKLOG-2365 — A REMOVED CONTACT IS STILL A CONTACT WE KNOW ABOUT.
        //
        // This filter decides what the picker OFFERS, by subtracting the people
        // we already have. `getImportedContactsByUserIdAsync` now hides removed
        // contacts, so unless they are added back here removal undoes itself
        // through the import path: Madison deletes a duplicate, the next macOS
        // sync runs, the contact no longer matches this filter, the picker
        // offers her as though she were new, and re-importing her silently
        // resurrects the contact she deleted.
        //
        // A tombstone means "we know about this person" — which is exactly the
        // question this filter asks. So removed contacts are VISIBLE here and
        // hidden from every list, which is the correct way round for both.
        const removedContacts =
          await databaseService.getRemovedContactIdentifiers(validatedUserId);
        const importedContacts = [...activeImported, ...removedContacts];

        /**
         * =====================================================================
         * AN EMAIL ADDRESS DOES NOT IDENTIFY A PERSON EITHER (BACKLOG-2531)
         * =====================================================================
         * This was a bare `Set<string>` of imported primary emails, and any
         * candidate whose address appeared in it was declared already-imported
         * with no further question asked.
         *
         * That is the SAME defect BACKLOG-2416 fixed one line below for phone
         * numbers — and the fix stopped at phones. A household address is
         * shared exactly as an office line is: a married couple on one
         * `home@`, an assistant's address recorded on their manager's card.
         *
         * WHAT IT COST. The second person was declared already-imported, so
         * they never appeared in the picker, so they could never BE imported.
         * Their correspondence then landed on the FIRST person's contact — and
         * on a transaction under audit, that is one person's mail inside
         * another person's compliance record. Silent: no error, just a contact
         * with more history than they should have.
         *
         * Now email -> the names of the imported contacts holding it, so the
         * same name gate applies to both identifiers. ONE rule, not a strict
         * one and a blind one.
         *
         * Note what this deliberately does NOT do: it does not stop suppressing
         * a genuine duplicate. "Margaret C." is prefix-compatible with
         * "Margaret Chen" and stays hidden. Sarah and Tom are not compatible,
         * and Tom is offered. The gate distinguishes the two cases that a bare
         * identifier match cannot.
         */
        const importedEmailNames = new Map<string, Set<string>>();
        for (const ic of importedContacts) {
          const email = ic.email?.toLowerCase();
          if (!email) continue;
          let names = importedEmailNames.get(email);
          if (!names) {
            names = new Set<string>();
            importedEmailNames.set(email, names);
          }
          names.add(normalizeContactName(ic.name || ic.display_name));
        }

        /**
         * Does an already-imported contact plausibly OWN this email address?
         *
         * A shared address alone is not ownership. An imported contact must
         * also carry a name this candidate could belong to. Mirrors
         * `phoneClaimedByImported` below — deliberately the same shape, because
         * two shapes is how the two rules drifted apart in the first place.
         */
        function emailClaimedByImported(
          email: string,
          candidateName: string | null | undefined,
        ): boolean {
          const names = importedEmailNames.get(email);
          if (!names) return false;
          for (const importedName of names) {
            if (namesAreCompatible(candidateName, importedName)) return true;
          }
          return false;
        }

        // BACKLOG-2416 — A PHONE NUMBER DOES NOT IDENTIFY A PERSON.
        //
        // This used to be a bare `Set<string>` of normalized phones, and a
        // candidate whose number appeared in it was declared already-imported
        // with no further question asked. That is the rule the backend's own
        // `isDuplicate` (below) had already rejected: it requires
        // `namesAreCompatible` before a shared phone may collapse two records,
        // precisely because household and office lines are shared by distinct
        // people. Two layers, two answers to "are these the same person?".
        //
        // It is now phone -> the names of the imported contacts holding it, so
        // the same name gate applies. Margaret Chen and Margaret Torres on one
        // brokerage line stop hiding each other.
        const importedPhoneNames = new Map<string, Set<string>>();
        for (const ic of importedContacts) {
          if (!ic.phone) continue;
          const normalized = toE164(ic.phone);
          if (!normalized || normalized === "+") continue;
          let names = importedPhoneNames.get(normalized);
          if (!names) {
            names = new Set<string>();
            importedPhoneNames.set(normalized, names);
          }
          names.add(normalizeContactName(ic.name || ic.display_name));
        }

        /**
         * Does an already-imported contact plausibly OWN this phone number?
         *
         * A shared line alone is not ownership. An imported contact must also
         * carry a name this candidate could belong to.
         */
        function phoneClaimedByImported(
          normalizedPhone: string,
          candidateName: string | null | undefined,
        ): boolean {
          const names = importedPhoneNames.get(normalizedPhone);
          if (!names) return false;
          for (const importedName of names) {
            if (namesAreCompatible(candidateName, importedName)) return true;
          }
          return false;
        }

        // BACKLOG-2401: the AUTHORITATIVE already-imported test — every
        // (source_type, source_record_id) pair already claimed by a saved
        // contact.
        //
        // This is checked BEFORE the email/phone sets below, and it is what
        // makes a renamed contact stop reappearing in this picker as a new
        // person: identity is the record, not the display name and not the
        // current contents of the record.
        //
        // It must match on ANY of a contact's crosswalk rows, not just one —
        // otherwise a person present in macOS AND Outlook re-offers themselves
        // once per source (catalogue C13). Because the set is keyed by the
        // PAIR, two sources that happen to issue the same id string cannot
        // suppress each other.
        //
        // The email/phone sets are KEPT as the fallback for contacts that have
        // no crosswalk row yet (imported before this shipped, or manually
        // created). Nothing regresses while the crosswalk converges.
        //
        // DEGRADES, NEVER FAILS. The crosswalk sharpens this filter; it is not
        // required to run it. If the read fails, fall back to the email/phone
        // sets — precisely the behaviour that shipped before this table existed
        // — rather than failing the whole picker and leaving the user unable to
        // import anyone at all. Logged, so a persistent failure is visible
        // rather than merely quiet.
        let linkedSourceKeys: Set<string>;
        try {
          linkedSourceKeys = getLinkedSourceKeys(validatedUserId);
        } catch (error) {
          logService.warn(
            `[Contacts] source-link lookup unavailable, falling back to email/phone matching: ${error}`,
            "Contacts",
          );
          linkedSourceKeys = new Set<string>();
        }

        // BACKLOG-2427 — RECORDS THE USER HAS EXPLICITLY RELEASED.
        //
        // "Not this person" deletes the crosswalk row and records a
        // `different_people` verdict. Without this read the released record
        // promptly disappeared instead of becoming importable: it still shares
        // the contact's phone (that is WHY it was wrongly linked, and the phone
        // may legitimately live on a source that is still linked), so the
        // content checks below re-classified it as already-imported. The user
        // was left unable to undo the merge, unable to import the other person
        // separately, and still had the rejected address in their audit.
        //
        // The user's own answer outranks a content resemblance. Checked only
        // AFTER the crosswalk check below, so a record rejected from contact A
        // but legitimately linked to contact B stays suppressed.
        //
        // DEGRADES, NEVER FAILS — same contract as the crosswalk read above. An
        // empty set is the pre-BACKLOG-2427 behaviour, not a broken picker.
        let rejectedSourceKeys: Set<string>;
        try {
          rejectedSourceKeys = getRejectedSourceKeys(validatedUserId);
        } catch (error) {
          // A BREADCRUMB, NOT JUST A WARNING (SR review, PR #2186).
          //
          // The verdict is now the SOLE mechanism that returns a released
          // record to this picker — the removal cannot do it, because the
          // stranding phone legitimately survives on a still-linked source.
          // So this catch firing reproduces the founder's original bug exactly:
          // "Not this person" silently becomes a one-way disappearance. A
          // warning in a log file nobody reads is not enough for a failure
          // whose only symptom is a record that quietly is not there.
          Sentry.addBreadcrumb({
            category: "contacts",
            message: "Verdict lookup failed; released source records will stay hidden in the picker",
            level: "error",
            data: {
              backlog: "BACKLOG-2427",
              error: error instanceof Error ? error.message : String(error),
            },
          });
          logService.warn(
            `[Contacts] verdict lookup unavailable; released source records may stay hidden: ${error}`,
            "Contacts",
          );
          rejectedSourceKeys = new Set<string>();
        }

        // TASK-1950: Check contact source preferences
        const macosEnabled = await isContactSourceEnabled(validatedUserId, "direct", "macosContacts", true);
        const iphoneEnabled = await isContactSourceEnabled(validatedUserId, "direct", "iphoneContacts", true);
        const outlookEnabled = await isContactSourceEnabled(validatedUserId, "direct", "outlookContacts", true);
        const googleContactsEnabled = await isContactSourceEnabled(validatedUserId, "direct", "googleContacts", true);
        // BACKLOG-2478: `androidContacts` has been written by onboarding since
        // BACKLOG-1900 (`ContactSourceStep.tsx:123`) and READ BY NOTHING until
        // now. Android records had no gate of their own and fell to the
        // catch-all in the filter loop below, which answered the question using
        // the *macOS* preference. See the long note at that deletion site for
        // why that was wrong but NOT, as first diagnosed, a Windows outage.
        //
        // Default `true` on purpose, and it carries real weight: the key is only
        // written when the user declared an Android phone (`phoneType:
        // "android"` at ContactSourceStep.tsx:138 keeps it out of
        // `visibleSources` otherwise), so for most users it is ABSENT. Absent
        // must mean shown — the same reading the other four sources take.
        const androidEnabled = await isContactSourceEnabled(validatedUserId, "direct", "androidContacts", true);

        // Convert Contacts app data to contact objects
        const availableContacts: AvailableContact[] = [];

        // BACKLOG-2391: picker funnel counters. Every `continue` below is a
        // contact the user asked for and did not get; until now none of those
        // drops were countable, so a report of "my contacts are missing" could
        // not be told apart from "they were never read off the Mac".
        // Counters only — never a per-contact line (this runs over ~1000 rows).
        let sourceDisabledCount = 0;
        let alreadyImportedCount = 0;
        let duplicateSuppressedCount = 0;
        // BACKLOG-2458: of the records `duplicateSuppressedCount` counts, how
        // many handed their SOURCE IDENTITY to the row that absorbed them. The
        // gap between the two is the set whose identity is genuinely lost (a
        // local `contacts` row has no source record behind it), so the two
        // numbers together say whether the carry is working in the field
        // instead of only in a test.
        let collapsedIdentitiesCarried = 0;

        // BACKLOG-2478: distinct source values outside EXTERNAL_SOURCE_TYPES.
        // These are now SHOWN rather than dropped (see the filter loop), so this
        // is the only trace that an unrecognised source was ever encountered.
        // A Set, emitted once after the loop — never a per-contact line, for the
        // same reason as the counters above (this runs over ~1000 rows).
        const unknownSources = new Set<string>();

        // BACKLOG-2316: Deduplication state. Email is a strong identity signal,
        // so a shared email always collapses. A shared phone is NOT — many
        // distinct people share a household/office line — so we remember which
        // NAMES have claimed each normalized phone and only treat a later
        // contact as a duplicate when its name is compatible with one of them.
        // Name-only matching was removed entirely: it silently dropped distinct
        // people who happen to share a name string (e.g. multiple "Margaret"s).
        //
        // BACKLOG-2458: each identifier now remembers WHICH ROW claimed it, not
        // merely that something did. A suppressed record is not discarded — it
        // is folded INTO the row that absorbed it, and folding requires knowing
        // which row that was. `seenEmails: Set<string>` could not answer that,
        // which is the mechanical reason the user's own choice was thrown away:
        // the picker knew two records were one person and had nowhere to put
        // the conclusion.
        //
        // Values are indices into `availableContacts`, assigned before the push
        // so they are the index the row is about to occupy.
        /**
         * BACKLOG-2531 — SAME SHAPE AS THE PHONE MAP, AND FOR THE SAME REASON.
         *
         * This was `Map<string, number>`: an address to the row that claimed
         * it, with no name recorded, so a later row sharing the address folded
         * into it unconditionally. `seenPhoneOwners` below has always carried
         * the holder's NAME and required `namesAreCompatible` before collapsing
         * — the phone rule was fixed by BACKLOG-2416 and the email rule was
         * left behind.
         *
         * Found by the founder testing the picker fix: Tom Whitfield stopped
         * being hidden from the list, and was then COLLAPSED INTO Sarah's row
         * instead, with the interface explaining that both list the same
         * address. Same defect, a different pass — the suppression moved rather
         * than ending.
         */
        const seenEmailOwner = new Map<string, Array<{ name: string; owner: number }>>();
        const seenPhoneOwners = new Map<string, Array<{ name: string; owner: number }>>();

        type DedupContact = {
          name?: string | null;
          display_name?: string | null;
          email?: string | null;
          emails?: string[];
          phone?: string | null;
          phones?: string[];
        };

        /**
         * The row a contact duplicates, AND what the two agreed on
         * (BACKLOG-2459).
         *
         * This replaced a bare `number | null`. The rule is unchanged — every
         * branch returns the same owner it returned before — but a bare index
         * could say only THAT two records were one person, never WHY, and "why"
         * is the whole of what has to be shown to the user.
         */
        type DuplicateMatch = {
          owner: number;
          matchedOn: "email" | "phone";
          /** The value as saved on the LOSING record, unnormalised. */
          matchedValue: string;
        };

        /** Collect every raw phone string on a contact (single + array). */
        function collectPhones(contact: DedupContact): string[] {
          const out: string[] = [];
          if (contact.phone) out.push(contact.phone);
          if (contact.phones) {
            for (const p of contact.phones) if (p) out.push(p);
          }
          return out;
        }

        /**
         * The index of the already-kept row this contact duplicates, or `null`
         * when it is nobody's duplicate.
         *
         * A contact duplicates a kept row when it shares an email, OR shares a
         * normalized phone with it AND their names are compatible (the same
         * person recorded twice — not two people on one line).
         *
         * BACKLOG-2458: this replaced a boolean `isDuplicate`. The RULE is
         * unchanged, deliberately and verifiably — every existing case in
         * `contact-handlers.pickerIdentity.test.ts` still holds. What changed is
         * that the answer now names the row, so the loser's identity has
         * somewhere to go.
         */
        /**
         * The row that owns this address, IF one of its claimants could be this
         * person. A shared address alone is not ownership (BACKLOG-2531).
         *
         * Mirrors the phone branch below deliberately. Two shapes is how these
         * two rules drifted apart for four months.
         */
        function emailOwnerFor(
          email: string,
          candidateName: string | null | undefined,
        ): number | undefined {
          const claimants = seenEmailOwner.get(email);
          if (!claimants) return undefined;
          for (const claimant of claimants) {
            if (namesAreCompatible(candidateName, claimant.name)) return claimant.owner;
          }
          return undefined;
        }

        /** First claim wins PER NAME, matching the phone map's behaviour. */
        function rememberEmailOwner(email: string, name: string, owner: number): void {
          let claimants = seenEmailOwner.get(email);
          if (!claimants) {
            claimants = [];
            seenEmailOwner.set(email, claimants);
          }
          if (!claimants.some((c) => c.name === name)) claimants.push({ name, owner });
        }

        function findDuplicateOwner(contact: DedupContact): DuplicateMatch | null {
          // BACKLOG-2531: the name is read HERE, before either identifier is
          // tested, because BOTH now need it. It used to be declared further
          // down, next to the phone branch — the only branch that used it.
          const name = normalizeContactName(contact.name || contact.display_name);

          // Email — a shared address is not proof of the same person. The name
          // must be compatible too, exactly as the phone branch below requires.
          // BACKLOG-2370 recorded this asymmetry ("email collapses regardless of
          // name") while fixing a different problem; it survived that item, 2416
          // and 2458, because each was solving something else.
          const email = contact.email?.toLowerCase();
          if (email) {
            const owner = emailOwnerFor(email, name);
            // BACKLOG-2459: the value reported is the one the user has SAVED
            // (`contact.email`), never the lowercased comparison key.
            // Comparison must normalise or two spellings are two people; the
            // sentence must not, or it names something unrecognisable.
            if (owner !== undefined) {
              return { owner, matchedOn: "email", matchedValue: contact.email as string };
            }
          }
          if (contact.emails) {
            for (const e of contact.emails) {
              if (!e) continue;
              const owner = emailOwnerFor(e.toLowerCase(), name);
              if (owner !== undefined) {
                return { owner, matchedOn: "email", matchedValue: e };
              }
            }
          }

          // Phone — only a duplicate when the names are compatible. `name` is
          // now declared above, because the email branch needs it too.
          for (const p of collectPhones(contact)) {
            const normalizedPhone = toE164(p);
            if (!normalizedPhone || normalizedPhone === "+") continue;
            const holders = seenPhoneOwners.get(normalizedPhone);
            if (!holders) continue;
            for (const holder of holders) {
              if (namesAreCompatible(name, holder.name)) {
                return { owner: holder.owner, matchedOn: "phone", matchedValue: p };
              }
            }
          }

          return null;
        }

        /**
         * Record, for display, that a row absorbed a record (BACKLOG-2459).
         *
         * The twin of `absorbSourceIdentity` below. That one keeps the folded
         * record's IDENTITY so the import can write a crosswalk row; this one
         * keeps it in WORDS so the user can be told it happened. Both are called
         * at the same `continue`, because the moment a record is dropped is the
         * only moment anything still knows it existed — after it, the record is
         * not merely hidden from the screen, it is absent from the array the
         * renderer receives.
         *
         * `sourceLabel` is resolved here rather than sent as an enum: at this
         * point the value is still an `ExternalContactSource`, the vocabulary
         * `sourceLabel()` is keyed on. A row from the local contacts table has
         * no address book behind it and passes `null`.
         */
        function absorbDisplayRecord(
          ownerIndex: number,
          folded: { label: string | null; sourceLabel: string | null } & DuplicateMatch,
        ): void {
          const owner = availableContacts[ownerIndex];
          if (!owner) return;
          const existing = owner.absorbedRecords ?? [];
          existing.push({
            label: folded.label,
            sourceLabel: folded.sourceLabel,
            matchedOn: folded.matchedOn,
            matchedValue: folded.matchedValue,
          });
          owner.absorbedRecords = existing;
        }

        /**
         * Mark a contact's identifiers as seen for deduplication, owned by the
         * row at `owner`. Each of the contact's normalized phones records this
         * contact's (normalized) name so a later shared-phone contact can be
         * name-compared against it.
         *
         * First claim wins for an email: the row that arrived first is the one
         * a later duplicate folds into, which matches the order the funnel
         * counters and the list itself are built in.
         */
        function markAsSeen(contact: DedupContact, owner: number): void {
          const email = contact.email?.toLowerCase();
          const ownerName = normalizeContactName(contact.name || contact.display_name);
          if (email) rememberEmailOwner(email, ownerName, owner);
          if (contact.emails) {
            for (const e of contact.emails) {
              if (!e) continue;
              rememberEmailOwner(e.toLowerCase(), ownerName, owner);
            }
          }

          const nameKey = normalizeContactName(contact.name || contact.display_name);
          for (const p of collectPhones(contact)) {
            const normalizedPhone = toE164(p);
            if (!normalizedPhone || normalizedPhone === "+") continue;
            let holders = seenPhoneOwners.get(normalizedPhone);
            if (!holders) {
              holders = [];
              seenPhoneOwners.set(normalizedPhone, holders);
            }
            if (!holders.some((h) => h.name === nameKey && h.owner === owner)) {
              holders.push({ name: nameKey, owner });
            }
          }
        }

        /**
         * Fold a suppressed record's SOURCE IDENTITY into the row that absorbed
         * it (BACKLOG-2458 I1).
         *
         * The row's details are the representative's and stay that way — only
         * the identity set grows. That set is what the import turns into
         * `source_id` crosswalk rows, so the user's decision to accept the
         * collapsed row is recorded for every record it stands for, rather than
         * being left for the next sync to re-derive by content matching (which
         * cannot succeed at all when the records share no email or phone).
         */
        function absorbSourceIdentity(
          ownerIndex: number,
          sourceType: string | null | undefined,
          sourceRecordId: string | null | undefined,
          externalUuid: string | null | undefined,
        ): void {
          const owner = availableContacts[ownerIndex];
          if (!owner || !sourceType || !sourceRecordId) return;
          if (!EXTERNAL_SOURCE_TYPES.has(sourceType)) return;
          const existing = owner.collapsedSources ?? [];
          if (
            existing.some(
              (s) => s.sourceType === sourceType && s.sourceRecordId === sourceRecordId,
            )
          ) {
            return;
          }
          existing.push({ sourceType, sourceRecordId, externalUuid: externalUuid ?? null });
          owner.collapsedSources = existing;
          collapsedIdentitiesCarried++;
        }

        // STEP 1: Get unimported contacts from the local `contacts` table.
        // These take precedence because they have real DB IDs.
        //
        // BACKLOG-2486: THIS OR IS LEFT INTACT ON PURPOSE. The other three
        // iPhone/macOS ORs were split; this one was examined and deliberately
        // not touched, so that "why is this one different" has an answer.
        //
        // 1. It is NOT an iPhone gate, whatever the old comment said.
        //    `getUnimportedContactsByUserId` is `FROM contacts WHERE user_id = ?
        //    AND is_imported = 0` (`contactDbService.ts:656-685`) — there is no
        //    source predicate in the SQL at all.
        //
        // 2. NOTHING IN PRODUCTION WRITES `is_imported = 0` ANY MORE. The column
        //    defaults to 1 (`schema.sql:174`); both INSERT sites default it to 1
        //    (`contactDbService.ts:353`, `:213-217`); the only UPDATEs set it to
        //    1 (`:696`, `:700`) — there is no reset-to-0 path; and no caller
        //    under `electron/` passes `is_imported: false`. So on a current
        //    install this query returns NOTHING and the gate governs an empty
        //    set either way. The live iPhone records reach this picker through
        //    the `external_contacts` loop below, which is where the real fix is.
        //
        // 3. The legacy rows that DO exist on older installs cannot be
        //    attributed. The historical iPhone writer hard-coded
        //    `source = 'contacts_app'`, never `'iphone'` (deleted in `c3dcbea4`,
        //    the commit that moved iPhone contacts to `external_contacts`), and
        //    migration v49's own note says pre-P0.2 imports "collapsed every
        //    non-outlook/google origin (iPhone, Android, macOS address book,
        //    unknown) into `contacts.source='contacts_app'`"
        //    (`databaseService.ts:2256-2258`). They are indistinguishable.
        //
        // 4. And they may not be read for filtering even if they were: `schema.sql:151`
        //    states it as a rule — "FIRST-IMPORT PROVENANCE ONLY. IT MUST NEVER
        //    BE READ FOR FILTERING."
        //
        // Narrowing this to `iphoneEnabled` would therefore hide legacy macOS
        // and Android rows on the strength of a docstring that the SQL does not
        // support, for zero proven benefit. Left as-is, and the residual gap
        // (a legacy install where iPhone is off and these rows still appear) is
        // recorded in the PR rather than silently closed.
        const unimportedDbContacts = (macosEnabled || iphoneEnabled)
          ? await databaseService.getUnimportedContactsByUserId(validatedUserId)
          : [];

        logService.info(
          // BACKLOG-2486: was "(iPhone sync)". It is not — see the gate note
          // above. These are legacy local rows of indeterminate origin, and on a
          // current install there are none, because nothing writes
          // `is_imported = 0` any more.
          `[Main] Found ${unimportedDbContacts.length} unimported legacy contacts in the local table`,
          "Contacts",
        );

        for (const dbContact of unimportedDbContacts) {
          // Skip if already imported. BACKLOG-2316: match ONLY on strong
          // identifiers (email / normalized phone). Name matching was removed —
          // it hid a distinct unimported contact whenever ANY already-imported
          // contact shared the same name string (e.g. a second "Margaret").
          const dbEmailLower = dbContact.email?.toLowerCase();
          if (
            dbEmailLower &&
            emailClaimedByImported(dbEmailLower, dbContact.name || dbContact.display_name)
          ) {
            alreadyImportedCount++;
            continue;
          }
          if (dbContact.phone) {
            // BACKLOG-2416: a shared line is not proof of the same person — the
            // holder's name must be compatible too.
            const normalizedPhone = toE164(dbContact.phone);
            if (
              normalizedPhone &&
              normalizedPhone !== "+" &&
              phoneClaimedByImported(normalizedPhone, dbContact.name || dbContact.display_name)
            ) {
              alreadyImportedCount++;
              continue;
            }
          }

          // Skip if this is a duplicate (by email, or shared phone + compatible name)
          //
          // BACKLOG-2458: no SOURCE IDENTITY is absorbed here. These rows come
          // from the local `contacts` table and carry no external record, so a
          // suppressed one has nothing to hand the import — which is exactly
          // the gap `collapsedIdentitiesCarried` makes visible.
          //
          // BACKLOG-2459: it still has a NAME and an agreed identifier, and the
          // user still loses a row. Having no crosswalk identity is a reason not
          // to tell the import about it, not a reason not to tell the person.
          const dbDuplicate = findDuplicateOwner(dbContact);
          if (dbDuplicate !== null) {
            duplicateSuppressedCount++;
            absorbDisplayRecord(dbDuplicate.owner, {
              label: dbContact.name || dbContact.display_name || null,
              // No address book behind it — see AbsorbedContactRecord.sourceLabel.
              sourceLabel: null,
              ...dbDuplicate,
            });
            continue;
          }

          // Mark this contact's identifiers as seen, owned by the row this
          // contact is about to become (pushed immediately below).
          markAsSeen(dbContact, availableContacts.length);

          // Query actual emails/phones from contact_emails/contact_phones tables
          // (BACKLOG-1270: was hardcoded as [] which dropped all email data)
          const dbEmails = getContactEmailEntries(dbContact.id).map(e => e.email);
          const dbPhones = getContactPhoneEntries(dbContact.id).map(p => p.phone);

          availableContacts.push({
            id: dbContact.id, // Use actual DB ID so we can mark as imported
            name: dbContact.name || dbContact.display_name,
            phone: dbContact.phone || null,
            email: dbContact.email || null,
            company: dbContact.company || null,
            source: dbContact.source || "contacts_app",
            isFromDatabase: true, // Flag to distinguish from macOS Contacts app
            allPhones: dbPhones,
            allEmails: dbEmails,
            // BACKLOG-1689 / BACKLOG-1727: forward the JOIN-derived timestamp so
            // the picker sort can interleave message-derived externals by recency
            // instead of dropping them to the bottom with NULL.
            last_communication_at: (dbContact as { last_communication_at?: string | null }).last_communication_at || null,
          });
        }

        // STEP 2: TASK-1773 - Read from external_contacts shadow table
        //
        // BACKLOG-2486: gated on `macosContacts` ALONE. Everything inside this
        // block is the MAC ADDRESS BOOK and nothing else — `getContactNames()`
        // reads the macOS Contacts API, `buildMacOSContactsForSync` shapes it,
        // and `fullSync` deletes stale rows `source='macos'` ONLY
        // (`externalContactDbService.ts:1032`). No iPhone row is read or written
        // here, so `iphoneEnabled` had no business deciding whether it runs.
        //
        // Under the old OR, a user with macOS off and iPhone on still paid for a
        // full address-book read whose every row was then dropped one loop below
        // by the `source === "macos" && !macosEnabled` branch. Work done to be
        // discarded.
        //
        // `contacts:sync-external` (the Settings "re-import" button, :2987 at the
        // time of writing) has ALWAYS gated this same read on `macosEnabled`
        // alone. The two now agree; before this change the automatic path and the
        // manual path could reach opposite conclusions about the same address
        // book.
        if (macosEnabled) {
          // Check if shadow table is populated, if not trigger background sync
          const cachedCount = externalContactDb.getCount(validatedUserId);

          if (cachedCount === 0) {
            // Shadow table is empty - need initial population
            // Do blocking sync on first load only (non-blocking after)
            logService.info(
              "[Main] External contacts shadow table empty, doing initial sync",
              "Contacts",
            );

            try {
              // Read from macOS Contacts API
              const { phoneToContactInfo, contacts } = await getContactNames();

              if (
                (contacts && contacts.length > 0) ||
                (phoneToContactInfo && Object.keys(phoneToContactInfo).length > 0)
              ) {
                // BACKLOG-2316: build the sync payload from the person-deduped
                // list so a contact whose only phone is shared is not lost.
                const macOSContacts = buildMacOSContactsForSync(
                  contacts,
                  phoneToContactInfo,
                );

                // Full sync: upsert + delete stale + update dates
                //
                // BACKLOG-2474: the inline `runOpportunisticLinking` that used
                // to sit here is gone. `fullSync` -> `upsertFromMacOS` now
                // signals the scheduler itself, so linking happens once after
                // ALL sources in this run have written rather than once per
                // source — and the backfill ordering this call used to
                // guarantee is preserved inside the scheduler's runner.
                externalContactDb.fullSync(validatedUserId, macOSContacts);

                // Backfill any missing emails/phones for already-imported contacts
                const backfillResult = await backfillImportedContactsFromExternal(validatedUserId);
                if (backfillResult.updated > 0) {
                  logService.info(
                    `[Main] Backfilled ${backfillResult.updated} imported contacts with missing emails/phones`,
                    "Contacts",
                  );
                }
              }
            } catch (syncErr) {
              logService.warn(`[Main] Initial external contacts sync failed: ${syncErr}`, "Contacts");
            }
          } else if (externalContactDb.isStale(validatedUserId, 24)) {
            // Shadow table has data but is stale - trigger background sync
            // SR Engineer requirement: Non-blocking first load
            logService.info(
              "[Main] External contacts shadow table stale, triggering background sync",
              "Contacts",
            );

            setImmediate(async () => {
              try {
                const { phoneToContactInfo, contacts } = await getContactNames();

                if (
                  (contacts && contacts.length > 0) ||
                  (phoneToContactInfo && Object.keys(phoneToContactInfo).length > 0)
                ) {
                  // BACKLOG-2316: person-deduped payload (see initial-sync path).
                  const macOSContacts = buildMacOSContactsForSync(
                    contacts,
                    phoneToContactInfo,
                  );

                  // BACKLOG-2474: linking is signalled by the write itself (see
                  // the initial-sync branch above), not called here.
                  externalContactDb.fullSync(validatedUserId, macOSContacts);

                  // Backfill any missing emails/phones for already-imported contacts
                  const backfillResult = await backfillImportedContactsFromExternal(validatedUserId);
                  if (backfillResult.updated > 0) {
                    logService.info(
                      `[Main] Background sync: Backfilled ${backfillResult.updated} imported contacts`,
                      "Contacts",
                    );
                  }

                  // Notify renderer that sync is complete
                  if (_mainWindow && !_mainWindow.isDestroyed()) {
                    _mainWindow.webContents.send("contacts:external-sync-complete");
                  }
                }
              } catch (err) {
                logService.warn(`[Main] Background external contacts sync failed: ${err}`, "Contacts");
              }
            });
          }
        }

        // BACKLOG-2474 — OUTSIDE the `macosEnabled || iphoneEnabled` gate above,
        // deliberately, and once per user per session.
        //
        // Everything else that reaches Phase 2 is triggered by a WRITE. That is
        // the right trigger, but it cannot help a user whose records were all
        // written by an earlier build: nothing writes this session, so nothing
        // signals, and a Windows user on Outlook + Android would still see a
        // permanently empty review queue after upgrading. This is the one
        // trigger that is not a write, and it exists for exactly that user.
        //
        // Session-gated because it is reconciliation, not a response to new
        // data — the picker is opened repeatedly and the pass has nothing new
        // to say on the second open. Same one-shot pattern as `backfilledUsers`.
        if (!linkingReconciledUsers.has(validatedUserId)) {
          linkingReconciledUsers.add(validatedUserId);
          requestContactLinking(validatedUserId);
        }

        // Read from shadow table (already sorted by last_message_at DESC, NULLS LAST)
        // TASK-1956: Use async worker thread to avoid blocking main process (~3.7s freeze with 1000+ contacts)
        const externalContacts = await externalContactDb.getAllForUserAsync(validatedUserId);

        logService.info(
          `[Main] Read ${externalContacts.length} contacts from shadow table`,
          "Contacts",
        );

        // STEP 3: Add external contacts (filtering out already imported)
        // TASK-1950: Also filter by source preference
        for (const extContact of externalContacts) {
          // Skip contacts from disabled sources
          if (extContact.source === "outlook" && !outlookEnabled) {
            sourceDisabledCount++;
            continue;
          }
          if (extContact.source === "google_contacts" && !googleContactsEnabled) {
            sourceDisabledCount++;
            continue;
          }
          // BACKLOG-2486: `iphone` answers to `iphoneContacts` and NOTHING else.
          //
          // This read `!iphoneEnabled && !macosEnabled`. On a Mac `macosContacts`
          // is on for essentially every user, so the second clause was always
          // false and unticking iPhone Contacts suppressed NOTHING. Proven by
          // execution in the SR review of PR #2201: stored `iphone:true` and
          // stored `iphone:false` wrote byte-identical contact sets.
          //
          // The OR was never a decision that these two sources are one thing. It
          // was added in `c774e198` ("iPhone contacts not stored/displayed on
          // Windows") to rescue Windows, where `macosContacts` is NEVER WRITTEN
          // — the card carries `platforms: ["macos"]` — so the original
          // `macosEnabled`-only gate read false and dropped every iPhone record.
          // ORing with the Mac preference made Windows work by borrowing an
          // unrelated answer, and cost macOS its toggle.
          //
          // That Windows problem is now solved at its own layer: `iphoneContacts`
          // is the sole member of BACKEND_DERIVED_DEFAULT_KEYS, so an absent key
          // derives `!isMacOS` — true on Windows (`contactSourceDefaults.ts:140`).
          // Windows keeps working without borrowing anything.
          if (extContact.source === "iphone" && !iphoneEnabled) {
            sourceDisabledCount++;
            continue;
          }
          if (extContact.source === "macos" && !macosEnabled) {
            sourceDisabledCount++;
            continue;
          }
          // BACKLOG-2478: android_sync is gated BY NAME, like the four above.
          // It previously had no named branch and fell through to the catch-all
          // described below, which decided its fate using an unrelated
          // preference (the Mac address book).
          if (extContact.source === "android_sync" && !androidEnabled) {
            sourceDisabledCount++;
            continue;
          }
          // BACKLOG-2478: THE CATCH-ALL WAS DELETED HERE — do not reintroduce it.
          //
          // It read `source is none of the four named && !macosEnabled`.
          //
          // WHAT IT DID **NOT** DO — the obvious reading is wrong, and was
          // asserted here in an earlier revision of this comment. It did NOT
          // hide Android contacts on Windows:
          //
          //   * `macosContacts` carries `platforms: ["macos"]` and onboarding
          //     writes only `visibleSources` (ContactSourceStep.tsx:71,306-310),
          //     so on Windows the key is NEVER WRITTEN.
          //   * The only other writer is the Settings toggle, which renders
          //     inside `{isMacOS && ...}` (MacOSContactsImportSettings.tsx:500).
          //     Also never on Windows.
          //   * `isContactSourceEnabled` fails OPEN — `typeof value === "boolean"
          //     ? value : defaultValue` (preferenceHelper.ts:36-37) — and every
          //     caller here passes `true`.
          //
          // Absent key => `macosEnabled === true` on Windows => the catch-all
          // evaluated FALSE and dropped nothing. It only ever fired for a user
          // who EXPLICITLY disabled the Mac address book (2 of 13 production
          // preference rows at the time of writing, both macOS users).
          //
          // THE ACTUAL DEFECT is narrower and worth stating plainly: whether an
          // Android or unrecognised record appeared was decided by a preference
          // about a DIFFERENT source, and it happened to come out right only
          // because that preference fails open. Correct by accident is not
          // correct — it inverts the moment someone disables the Mac address
          // book, and it silently re-breaks for whichever source is added next.
          // Every source now answers to its own preference.
          //
          // All five members of EXTERNAL_SOURCE_TYPES (macos, iphone, outlook,
          // google_contacts, android_sync) have a named branch above, so this
          // point is reached only by a source outside the known vocabulary —
          // and `external_contacts.source` is `TEXT DEFAULT 'macos'`, NULLABLE,
          // with NO CHECK constraint (schema.sql:1262), so those values are
          // genuinely reachable rather than hypothetical.
          //
          // An unrecognised source is VISIBLE. The decisive reason is not a
          // judgement call, it is the status quo: because `macosEnabled`
          // defaults to true, unknown-source rows have ALREADY been flowing
          // through the already-imported check, the dedup pass and `sourceKey()`
          // for 11 of those 13 users. This branch does not open a new state; it
          // makes an existing majority state unconditional and deterministic.
          // Hiding them would have NARROWED behaviour for those users and
          // rebuilt the same silent-drop trap for the next source added.
          //
          // Supporting reasons:
          //  1. The WRITE path is the real gate. A row exists in
          //     `external_contacts` only because an importer ran behind its own
          //     pairing/connection. (Deliberately "pairing/connection", not
          //     "preference": `localSyncService.storeContacts` has no
          //     `isContactSourceEnabled` call — for android_sync, pairing IS the
          //     gate.) This branch cannot surface anything the write path did
          //     not already store.
          //  2. The failure modes are asymmetric. Hiding fails silently and
          //     undiagnosably — no error, no counter the user can see, the
          //     contacts are simply not there. Showing fails loudly and
          //     recoverably: a row appears and the user declines to import it.
          //     The picker is a SELECTION surface; nothing is persisted without
          //     an explicit import.
          //
          // Recorded rather than waved through, so "visible by default" stays a
          // decision someone can audit in the field instead of a silent one.
          // NULL/empty is recorded under a sentinel rather than skipped: a
          // nullable column with no CHECK is precisely the case this argument
          // leans on, so it must not be the one case that stays silent.
          if (!extContact.source || !EXTERNAL_SOURCE_TYPES.has(extContact.source)) {
            unknownSources.add(extContact.source || NULL_SOURCE_SENTINEL);
          }

          // BACKLOG-2401: source identity FIRST. If a saved contact already
          // claims this exact source record, it is imported — full stop, and
          // regardless of what its name or details say now. This is the check
          // that survives a rename in the address book; the content checks
          // below cannot, because they compare against details that the rename
          // may have changed.
          if (
            extContact.external_record_id &&
            linkedSourceKeys.has(sourceKey(extContact.source, extContact.external_record_id))
          ) {
            alreadyImportedCount++;
            continue;
          }

          // BACKLOG-2427: the user has said, in as many words, that this record
          // is NOT the contact it resembles. The content checks below ask
          // whether it resembles one — a question already answered. Skipping
          // them is what makes "Not this person" recoverable instead of a
          // one-way disappearance.
          //
          // Safe to place after the crosswalk check and before the content
          // checks: a released record has no crosswalk row for the contact that
          // rejected it, and if some OTHER contact legitimately claims it the
          // crosswalk check above has already suppressed it.
          const releasedByUser =
            !!extContact.external_record_id &&
            rejectedSourceKeys.has(sourceKey(extContact.source, extContact.external_record_id));

          const primaryEmail = extContact.emails?.[0]?.toLowerCase();

          // Skip if already imported. BACKLOG-2316: match ONLY on strong
          // identifiers (email here, phone below) — never on name alone, which
          // suppressed distinct external contacts that shared a name with an
          // already-imported contact.
          if (
            !releasedByUser &&
            primaryEmail &&
            emailClaimedByImported(primaryEmail, extContact.name)
          ) {
            alreadyImportedCount++;
            continue;
          }

          // Check if already imported by phone. BACKLOG-2416: the number alone
          // never decides it — an imported contact holding it must also have a
          // compatible name.
          if (!releasedByUser && extContact.phones && extContact.phones.length > 0) {
            let phoneAlreadyImported = false;
            for (const phone of extContact.phones) {
              const normalized = toE164(phone);
              if (
                normalized &&
                normalized !== "+" &&
                phoneClaimedByImported(normalized, extContact.name)
              ) {
                phoneAlreadyImported = true;
                break;
              }
            }
            if (phoneAlreadyImported) {
              alreadyImportedCount++;
              continue;
            }
          }

          // Create dedup-check object
          const extContactForDedup = {
            name: extContact.name,
            email: extContact.emails?.[0] || null,
            emails: extContact.emails,
            phone: extContact.phones?.[0] || null,
            phones: extContact.phones,
          };

          // Skip if already added from iPhone-synced contacts.
          //
          // BACKLOG-2458 — THE ROW ABSORBS THIS RECORD'S IDENTITY.
          //
          // This `continue` is where the founder's Casey Lane was lost. He
          // exists in both the Mac address book and Outlook on one shared
          // number; the picker collapsed them correctly and then dropped the
          // loser entirely, so importing the row wrote one crosswalk entry at
          // most and the other record was rediscovered by CONTENT matching on
          // the next sync — a weaker reason for a fact the user had already
          // settled, and one that cannot be derived at all when two records
          // share no email or phone.
          const duplicateOwner = findDuplicateOwner(extContactForDedup);
          if (duplicateOwner !== null) {
            duplicateSuppressedCount++;
            absorbSourceIdentity(
              duplicateOwner.owner,
              extContact.source,
              extContact.external_record_id,
              extContact.external_uuid,
            );
            // BACKLOG-2459 — and say so. This `continue` is the only place the
            // folded record still exists; everything downstream, the renderer
            // included, sees a list it was already removed from.
            absorbDisplayRecord(duplicateOwner.owner, {
              label: extContact.name || null,
              sourceLabel: EXTERNAL_SOURCE_TYPES.has(extContact.source)
                ? sourceLabel(extContact.source as ExternalContactSource)
                : null,
              ...duplicateOwner,
            });
            continue;
          }

          // Mark as seen, owned by the row pushed immediately below.
          markAsSeen(extContactForDedup, availableContacts.length);

          availableContacts.push({
            id: extContact.id, // Use shadow table ID
            name: extContact.name,
            phone: extContact.phones?.[0] || null,
            email: extContact.emails?.[0] || null,
            company: extContact.company || null,
            // BACKLOG-1900 (P0.2): persist the distinct origin (iphone /
            // android_sync / outlook / google_contacts). macOS desktop address
            // book and unknown sources stay contacts_app. Previously every
            // non-outlook/google source (incl. iphone, android_sync) was
            // silently downgraded to contacts_app here.
            source: toPersistedContactSource(extContact.source),
            allPhones: extContact.phones || [],
            allEmails: extContact.emails || [],
            isFromDatabase: false,
            // last_message_at is already computed in shadow table
            last_communication_at: extContact.last_message_at,
            // BACKLOG-2401: carry the SOURCE identity through to import so a
            // crosswalk row can be written. `id` above is the shadow row's own
            // UUID (regenerated on every upsert attempt); this pair is what
            // actually identifies the record in its origin system.
            externalRecordId: extContact.external_record_id,
            externalSourceType: extContact.source,
            externalUuid: extContact.external_uuid ?? null,
            // BACKLOG-2458: the row stands for its OWN record from the moment
            // it is created, so a row that never absorbs anything still
            // presents one identity rather than an absent field the import
            // would have to special-case. Records folded in later append here.
            collapsedSources:
              extContact.external_record_id && EXTERNAL_SOURCE_TYPES.has(extContact.source)
                ? [
                    {
                      sourceType: extContact.source,
                      sourceRecordId: extContact.external_record_id,
                      externalUuid: extContact.external_uuid ?? null,
                    },
                  ]
                : [],
          });
        }

        // Contacts are already sorted by last_message_at from shadow table
        // Just need to ensure the combined list respects the order
        // Sort the full list: most recent first, then by name
        availableContacts.sort((a, b) => {
          const dateA = a.last_communication_at ? new Date(a.last_communication_at).getTime() : 0;
          const dateB = b.last_communication_at ? new Date(b.last_communication_at).getTime() : 0;
          if (dateA !== dateB) {
            return dateB - dateA; // Most recent first
          }
          // Secondary sort by name
          const nameA = (a.name || '').toLowerCase();
          const nameB = (b.name || '').toLowerCase();
          return nameA.localeCompare(nameB);
        });

        // BACKLOG-2478: an unrecognised source is shown, not dropped, so say so
        // once. Without this the decision is invisible: the rows just appear,
        // and nobody debugging "where did these come from" has a thread to pull.
        if (unknownSources.size > 0) {
          const unknown = Array.from(unknownSources).sort();
          logService.warn(
            `[Contacts] Picker showed records from ${unknown.length} unrecognised source(s): ${unknown.join(", ")}`,
            "Contacts",
          );
          Sentry.addBreadcrumb({
            category: "contacts",
            message: "Picker encountered unrecognised contact source(s); records shown, not hidden",
            level: "warning",
            data: { backlog: "BACKLOG-2478", sources: unknown },
          });
        }

        // BACKLOG-2391: funnel stage 4. Emitted in the order the filters are
        // actually applied above (source -> already-imported -> duplicate), so
        // the arithmetic closes: in - disabled - imported - dup = shown.
        recordPicker({
          dbRowsIn: unimportedDbContacts.length,
          externalRowsIn: externalContacts.length,
          rowsIn: unimportedDbContacts.length + externalContacts.length,
          sourceDisabled: sourceDisabledCount,
          alreadyImported: alreadyImportedCount,
          duplicateSuppressed: duplicateSuppressedCount,
          collapsedIdentitiesCarried,
          shown: availableContacts.length,
        });

        return {
          success: true,
          contacts: availableContacts,
          contactsStatus: { loaded: true }, // Shadow table always available
        };
      } catch (error) {
        logService.error("[Main] Get available contacts failed:", "Contacts", {
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Import contacts from external sources
  ipcMain.handle(
    "contacts:import",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      contactsToImport: unknown[],
    ): Promise<ContactResponse> => {
      try {
        logService.info("[Main] Importing contacts", "Contacts", {
          userId,
          count: contactsToImport.length,
        });

        // BACKLOG-551: Validate user ID exists in local DB
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return {
            success: false,
            error: "No valid user found in database",
          };
        }

        // Validate contacts array
        if (!Array.isArray(contactsToImport)) {
          throw new ValidationError(
            "Contacts to import must be an array",
            "contactsToImport",
          );
        }

        if (contactsToImport.length === 0) {
          throw new ValidationError(
            "No contacts provided for import",
            "contactsToImport",
          );
        }

        if (contactsToImport.length > 5000) {
          throw new ValidationError(
            "Cannot import more than 5000 contacts at once",
            "contactsToImport",
          );
        }

        const importedContacts: Contact[] = [];
        const total = contactsToImport.length;

        // Separate contacts into two groups
        const existingDbContacts: ExistingDbContactRecord[] = [];
        const newContactsToCreate: NewContactData[] = [];
        // BACKLOG-2401: parallel to newContactsToCreate, index for index, so the
        // ids returned by createContactsBatch can be paired back to the source
        // record each contact came from. createContactsBatch preserves input
        // order, which is what makes the pairing sound.
        //
        // BACKLOG-2458: now a SET per contact, not one identity. A picker row
        // may stand for several source records, and each of them gets its own
        // `source_id` crosswalk row.
        const newContactSources: Array<{
          identities: SourceIdentity[];
          skipped: IdentitySkipReason | null;
        }> = [];
        // Every link attempt this import made, reported in one line at the end
        // rather than one line per contact (BACKLOG-2458 I2).
        const linkOutcomes: Array<{ contactId: string; outcome: LinkImportOutcome }> = [];

        for (const contact of contactsToImport) {
          const sanitizedContact = sanitizeObject(contact) as ImportableContact;
          const validatedData = validateContactData(sanitizedContact, false);
          const sourceIdentities = toSourceIdentities(sanitizedContact);

          if (
            sanitizedContact.isFromDatabase &&
            sanitizedContact.id &&
            !sanitizedContact.id.startsWith("contacts-app-")
          ) {
            logService.warn(`[DIAG-1270] Import path: ${sanitizedContact.name || validatedData.name} → existingDB, allEmails=[${(sanitizedContact.allEmails || []).join(', ')}]`, 'Contacts');
            existingDbContacts.push({ id: sanitizedContact.id, contact: sanitizedContact });
          } else {
            logService.warn(`[DIAG-1270] Import path: ${sanitizedContact.name || validatedData.name} → newCreate, allEmails=[${(sanitizedContact.allEmails || []).join(', ')}]`, 'Contacts');
            newContactsToCreate.push({
              user_id: validatedUserId,
              display_name: validatedData.name || "Unknown",
              email: validatedData.email ?? undefined,
              phone: validatedData.phone ?? undefined,
              company: validatedData.company ?? undefined,
              title: validatedData.title ?? undefined,
              source: sanitizedContact.source || "contacts_app",
              is_imported: true,
              allPhones: sanitizedContact.allPhones || [],
              allEmails: sanitizedContact.allEmails || [],
            });
            newContactSources.push(sourceIdentities);
          }
        }

        let processed = 0;

        // Mark existing DB contacts as imported and backfill any missing emails/phones
        // Also update source to "contacts_app" when importing from macOS Contacts
        for (const { id, contact } of existingDbContacts) {
          logService.warn(`[DIAG-1270] DB contact backfill: ${contact.name}, contact.allEmails=[${(contact.allEmails || []).join(', ')}], contact.allPhones=[${(contact.allPhones || []).join(', ')}]`, 'Contacts');
          await databaseService.markContactAsImported(id, contact.source || "contacts_app");

          // BACKLOG-2401 / BACKLOG-2458: record WHERE this contact came from, at
          // the one moment the answer is known for certain, for EVERY source
          // record the picked row stands for. match_method is 'source_id'
          // because the user picked a row representing these exact records —
          // nothing was inferred.
          const dbIdentities = toSourceIdentities(contact);
          linkOutcomes.push({
            contactId: id,
            outcome: linkImportedContact(
              validatedUserId,
              id,
              dbIdentities.identities,
              dbIdentities.skipped,
            ),
          });

          // Backfill emails/phones from macOS Contacts if available
          if (contact.allEmails && contact.allEmails.length > 0) {
            await databaseService.backfillContactEmails(id, contact.allEmails);
          }
          if (contact.allPhones && contact.allPhones.length > 0) {
            await databaseService.backfillContactPhones(id, contact.allPhones);
          }

          const updatedContact = await databaseService.getContactById(id);
          if (updatedContact) {
            importedContacts.push(updatedContact);
          }
          processed++;
          if (_mainWindow && !_mainWindow.isDestroyed()) {
            _mainWindow.webContents.send("contacts:import-progress", {
              current: processed,
              total,
              percent: Math.round((processed / total) * 100),
            });
          }
        }

        /**
         * =====================================================================
         * BACKLOG-2525 — IMPORTING THE SAME SOURCE RECORD TWICE IS ONE CONTACT.
         * =====================================================================
         * Founder, 2026-08-05, on `5037fcfc`: *"the import button seems like
         * it's not working — you can click it a few times and nothing happens.
         * i was able to click it three times and i went back to the list and i
         * see rosey 3 times"*. Three real `contacts` rows.
         *
         * This handler splits its input on `isFromDatabase` ALONE (:1979-1983).
         * An address-book row carries `isFromDatabase: false`, so it went
         * straight to `createContactsBatch` and nothing ever asked whether the
         * source record behind it was already claimed by a saved contact.
         *
         * WHY THE RECORD IDENTITY AND NOT THE DISPLAY NAME. The path this flow
         * used before BACKLOG-2510 (`contacts:create`, :2166-2193 →
         * `contactDbService.ts:465-475`) guarded on exact `LOWER(display_name)`.
         * Restoring THAT would reintroduce the defect BACKLOG-2316 removed from
         * the picker: two genuinely different clients who share a name are two
         * contacts, and a name guard silently discards the second. BACKLOG-2510
         * exists precisely so we record WHICH address-book entry a contact came
         * from — a strictly stronger key, and one already written.
         *
         * It is also the SAME `(source_type, source_record_id)` pair that
         * `createLink` holds UNIQUE (`contactSourceLinkDbService.ts:260-264`)
         * and that `contacts:get-available` suppresses on (:1695-1701). One key,
         * three consumers, agreeing by construction rather than by three rules
         * that have to be kept in step.
         *
         * ---------------------------------------------------------------------
         * WHY THIS SITS HERE AND NOT WHERE IT READS MORE NATURALLY
         * ---------------------------------------------------------------------
         * A guard against re-entry is only as good as the window between reading
         * and writing. The main process is a single JS thread, so the check and
         * the crosswalk write that makes it true must fall in ONE SYNCHRONOUS
         * STRETCH — otherwise three overlapping invocations all read "unclaimed"
         * at their own `await` boundary and all three insert.
         *
         * From here to `linkImportedContact` below there is no `await`:
         * `createContactsBatch` is synchronous (`contactDbService.ts:317-331`,
         * `dbTransaction` takes a sync callback) and so is `linkImportedContact`.
         * Moving this check earlier — next to `toSourceIdentities` at :1974,
         * which is where it reads better — puts the existing-DB loop's `await`s
         * between the read and the write and reopens the exact race. Do not.
         *
         * Pinned by execution, three concurrent invocations with no `await`
         * between them: `contact-handlers.importIdempotent-2525.test.ts`.
         */
        const claimedByExisting: Array<{
          contactId: string;
          identities: SourceIdentity[];
          skipped: IdentitySkipReason | null;
        }> = [];
        // BACKLOG-2496 — each carries the origin it will be created WITH, so the
        // crosswalk rows land inside `createContactsBatch`'s transaction rather
        // than in a loop afterwards. See the push below.
        const unclaimedToCreate: Array<NewContactData & { origin: ContactOrigin }> = [];
        const unclaimedSources: typeof newContactSources = [];

        for (let i = 0; i < newContactsToCreate.length; i++) {
          const source = newContactSources[i];
          // ANY identity being claimed settles it. A collapsed picker row stands
          // for several source records (BACKLOG-2458); if even one of them is
          // already owned, the person is already imported and a second contact
          // would be a duplicate that owns nothing.
          let incumbent: string | null = null;
          for (const identity of source.identities) {
            incumbent = findContactIdBySourceRecord(
              validatedUserId,
              identity.sourceType,
              identity.sourceRecordId,
            );
            if (incumbent) break;
          }

          if (incumbent) {
            claimedByExisting.push({ contactId: incumbent, ...source });
          } else {
            /**
             * BACKLOG-2496 — THE ORIGIN TRAVELS WITH THE CONTACT.
             *
             * The crosswalk rows for an import used to be written by a loop
             * AFTER `createContactsBatch` returned, outside its transaction. An
             * interruption between the two left contacts committed with no
             * origin, and that is not a cosmetic gap: BACKLOG-2525's duplicate
             * guard reads `findContactIdBySourceRecord` a few lines above, so an
             * address-book entry whose crosswalk row never landed reads as
             * UNCLAIMED and the next press creates a second contact.
             *
             * Passing the identities in means the rows are written by the batch,
             * inside the one transaction that also inserts the contact.
             *
             * A row carrying NO identity still gets an origin — the synthetic
             * one, from `contacts.source` — because "derived" is the truthful
             * answer for a picker row with no external record behind it, and a
             * contact with no origin at all is the state being eliminated.
             */
            unclaimedToCreate.push({
              ...newContactsToCreate[i],
              origin:
                source.identities.length > 0
                  ? { kind: "sourceRecords", identities: source.identities }
                  : { kind: "derived" },
            });
            unclaimedSources.push(source);
          }
        }

        if (claimedByExisting.length > 0) {
          logService.info(
            `[Contacts] import: ${claimedByExisting.length} row(s) already claimed by a saved ` +
              `contact — returned the existing contact rather than creating a duplicate ` +
              `(BACKLOG-2525)`,
            "Contacts",
          );
        }

        // Re-link rather than no-op. A collapsed row whose representative is
        // claimed may still carry records nothing owns yet; those belong on the
        // incumbent. `createLink` is idempotent, so the claimed pair costs a
        // read and writes nothing.
        for (const claimed of claimedByExisting) {
          linkOutcomes.push({
            contactId: claimed.contactId,
            outcome: linkImportedContact(
              validatedUserId,
              claimed.contactId,
              claimed.identities,
              claimed.skipped,
            ),
          });
        }

        // Batch create new contacts (much faster with transaction)
        if (unclaimedToCreate.length > 0) {
          logService.info(
            `[Main] Batch importing ${unclaimedToCreate.length} new contacts...`,
            "Contacts"
          );

          const createdIds = databaseService.createContactsBatch(
            unclaimedToCreate,
            (current, _batchTotal) => {
              const overallCurrent = existingDbContacts.length + current;
              if (_mainWindow && !_mainWindow.isDestroyed()) {
                _mainWindow.webContents.send("contacts:import-progress", {
                  current: overallCurrent,
                  total,
                  percent: Math.round((overallCurrent / total) * 100),
                });
              }
            }
          );

          // BACKLOG-2401: pair each created id back to the source record it came
          // from. createContactsBatch preserves input order, so index i of
          // createdIds is index i of unclaimedToCreate — and therefore of
          // unclaimedSources. Guarded on length so a future batch that skips a
          // row cannot silently mis-attribute every link after it.
          //
          // BACKLOG-2525: the two arrays are the POST-GUARD ones. They are built
          // in one pass above and stay index-for-index with each other; pairing
          // created ids against the pre-guard `newContactSources` would
          // mis-attribute every link after the first already-claimed row.
          if (createdIds.length === unclaimedSources.length) {
            for (let i = 0; i < createdIds.length; i++) {
              linkOutcomes.push({
                contactId: createdIds[i],
                outcome: linkImportedContact(
                  validatedUserId,
                  createdIds[i],
                  unclaimedSources[i].identities,
                  unclaimedSources[i].skipped,
                ),
              });
            }
          } else {
            logService.warn(
              `[Contacts] createContactsBatch returned ${createdIds.length} ids for ` +
                `${unclaimedSources.length} inputs — source links skipped for this batch ` +
                `rather than guessed (BACKLOG-2401). They will be created on the next sync.`,
              "Contacts",
            );
          }

          // Fetch created contacts
          for (const id of createdIds) {
            const contact = await databaseService.getContactById(id);
            if (contact) {
              importedContacts.push(contact);
            }
          }
        }

        /**
         * BACKLOG-2525 — return the INCUMBENT, so a repeat press is a no-op the
         * user can see rather than an error.
         *
         * `Contacts.tsx:459-461` reads `result.contacts[0]` and throws
         * "Failed to import contact" when it is absent. Skipping the insert and
         * returning nothing would turn the second press into a visible failure
         * on a screen where nothing is actually wrong — the person IS imported.
         * Handing back the existing contact makes the second press land on the
         * same card the first one opened.
         */
        for (const claimed of claimedByExisting) {
          const contact = await databaseService.getContactById(claimed.contactId);
          if (contact) {
            importedContacts.push(contact);
          }
        }

        // BACKLOG-2458 I2 — the skip is no longer silent.
        reportImportLinking(linkOutcomes);

        // BACKLOG-2474 — run the pass NOW, not on the next sync.
        //
        // Importing a second record of someone already imported from another
        // source is the single most likely way to create a duplicate, and it is
        // the moment the user is most able to answer a question about it. The
        // import writes its own crosswalk row for the record the user picked
        // (`linkImportedContact` above), but nothing was running the NAME rule
        // that finds the same person under a different source — so from the
        // user's side the duplicate check simply did not exist.
        //
        // Immediate rather than coalesced: this is a discrete user action with
        // the user waiting, not one writer among several in a sync run. Awaited
        // so the queue is populated before the renderer refreshes.
        await runContactLinkingNow(validatedUserId);

        logService.info(
          `[Main] Successfully imported ${importedContacts.length} contacts`,
          "Contacts",
        );

        return {
          success: true,
          contacts: importedContacts,
        };
      } catch (error) {
        logService.error("[Main] Import contacts failed:", "Contacts", {
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get contacts sorted by recent activity and address relevance
  ipcMain.handle(
    "contacts:get-sorted-by-activity",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      propertyAddress: string | null = null,
    ): Promise<ContactResponse> => {
      try {
        logService.info(
          "[Main] Getting contacts sorted by activity",
          "Contacts",
          { userId, propertyAddress },
        );

        // BACKLOG-551: Validate user ID exists in local DB
        // BACKLOG-615: Return empty array gracefully during deferred DB init (onboarding)
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          logService.info("[Contacts] No local user yet, returning empty sorted contacts (deferred DB init)", "Contacts");
          return {
            success: true,
            contacts: [],
          };
        }

        // Validate propertyAddress (optional)
        const validatedAddress = propertyAddress
          ? validateString(propertyAddress, "propertyAddress", {
              required: false,
              maxLength: 500,
            })
          : undefined;

        // Get only imported contacts sorted by activity
        const importedContacts =
          await databaseService.getContactsSortedByActivity(
            validatedUserId,
            validatedAddress ?? undefined,
          );

        logService.info(
          `[Main] Returning ${importedContacts.length} imported contacts sorted by activity`,
          "Contacts",
        );

        return {
          success: true,
          contacts: importedContacts,
        };
      } catch (error) {
        logService.error("[Main] Get sorted contacts failed:", "Contacts", {
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Create new contact
  ipcMain.handle(
    "contacts:create",
    async (
      event: IpcMainInvokeEvent,
      userId: string,
      contactData: unknown,
    ): Promise<ContactResponse> => {
      try {
        // DIAG-1270: Log raw input to contacts:create
        const rawInput = contactData as Record<string, unknown>;
        logService.warn(`[DIAG-1270] contacts:create raw input: allEmails=${JSON.stringify(rawInput?.allEmails)}, allPhones=${JSON.stringify(rawInput?.allPhones)}, name=${rawInput?.name}`, "Contacts");

        // BACKLOG-551: Validate user ID exists in local DB
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return {
            success: false,
            error: "No valid user found in database",
          };
        }
        const validatedData = validateContactData(contactData, false);

        // Check for duplicate contact by name (to prevent multiple imports of the same message contact)
        if (validatedData.name) {
          const existingByName = await databaseService.findContactByName(
            validatedUserId,
            validatedData.name
          );
          if (existingByName) {
            // BACKLOG-2473 — THIS EARLY RETURN IS A SECOND CREATE PATH.
            //
            // It returns before the origin write further down, so a contact
            // first reached through this branch would never get a crosswalk row
            // at all. Harmless today, because the source filter still falls back
            // to the `contacts.source` scalar — but step 4 of BACKLOG-2473
            // removes that fallback, and such a contact would then be invisible
            // under EVERY filter.
            //
            // Safe on an already-existing contact: the write is INSERT OR IGNORE
            // keyed on (user, source_type, `origin:<contactId>`), so a contact
            // that already has its origin row is a no-op.
            recordContactOrigin(
              validatedUserId,
              existingByName.id,
              (existingByName as { source?: string }).source,
            );
            return {
              success: true,
              contact: existingByName,
            };
          }
        }

        // Extract source from input data (falls back to "manual" if not provided)
        // BACKLOG-1900 (P0.1): allow distinct per-origin sources so an inbound
        // 'iphone'/'outlook'/'android_sync' value is preserved, not coerced to "manual".
        const validSources: ContactSource[] = ["manual", "email", "sms", "messages", "contacts_app", "inferred", "google_contacts", "outlook", "android_sync", "iphone"];
        const inputSource = (contactData as { source?: string })?.source;
        const source: ContactSource = validSources.includes(inputSource as ContactSource)
          ? (inputSource as ContactSource)
          : "manual";
        const contact = await databaseService.createContact(
          {
            user_id: validatedUserId,
            display_name: validatedData.name || "Unknown",
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
          // transaction, so the separate `recordContactOrigin` call that used
          // to sit below is gone: it could not fail to happen any more.
          { kind: "derived" },
        );

        /**
         * WHERE THIS CONTACT CAME FROM IS NO LONGER WRITTEN HERE (BACKLOG-2496).
         *
         * It used to be a `recordContactOrigin(...)` call on this line, AFTER
         * the contact had already been committed. That is the defect this item
         * closes: two separate writes, with nothing forcing the second, so a
         * crash or a throw between them left a contact with no origin —
         * indistinguishable afterwards from one a path never wrote.
         *
         * The origin is now a REQUIRED ARGUMENT to `createContact` above and is
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
        // manual Add Contact form arrives here with no `source` at all, so
        // `source` above resolves to "manual" while the addresses the user had
        // just typed were recorded as imported. The unlink is then entitled to
        // delete them: a stranger's address-book card sharing the contact's
        // office line was enough to take a client's own phone number off their
        // record.
        const valueSource = contactInfoSourceFor(source);
        const inputAllEmails = (contactData as { allEmails?: string[] })?.allEmails || [];
        const inputAllPhones = (contactData as { allPhones?: string[] })?.allPhones || [];
        if (inputAllEmails.length > 0) {
          await databaseService.backfillContactEmails(contact.id, inputAllEmails, valueSource);
          logService.info(`[Contacts] Stored ${inputAllEmails.length} emails for new contact ${contact.id}`, "Contacts");
        }
        if (inputAllPhones.length > 0) {
          await databaseService.backfillContactPhones(contact.id, inputAllPhones, valueSource);
          logService.info(`[Contacts] Stored ${inputAllPhones.length} phones for new contact ${contact.id}`, "Contacts");
        }

        // Audit log contact creation
        await auditService.log({
          userId: validatedUserId,
          action: "CONTACT_CREATE",
          resourceType: "CONTACT",
          resourceId: contact.id,
          metadata: { name: contact.name },
          success: true,
        });

        logService.info("Contact created", "Contacts", {
          userId: validatedUserId,
          contactId: contact.id,
        });

        return {
          success: true,
          contact,
        };
      } catch (error) {
        logService.error("Create contact failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Get contact edit data (emails/phones with row IDs for multi-entry editing)
  ipcMain.handle(
    "contacts:get-edit-data",
    async (
      _event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<{
      success: boolean;
      emails?: { id: string; email: string; is_primary: boolean }[];
      phones?: { id: string; phone: string; is_primary: boolean }[];
      error?: string;
    }> => {
      try {
        const validatedContactId = validateContactId(contactId);
        if (!validatedContactId) {
          throw new ValidationError("Contact ID validation failed", "contactId");
        }

        const emails = getContactEmailEntries(validatedContactId);
        const phones = getContactPhoneEntries(validatedContactId);

        return { success: true, emails, phones };
      } catch (error) {
        logService.error("Get contact edit data failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Update contact
  ipcMain.handle(
    "contacts:update",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
      updates: unknown,
    ): Promise<ContactResponse> => {
      try {
        // Validate inputs
        const validatedContactId = validateContactId(contactId); // Validated, will throw if invalid
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }
        const validatedUpdates = validateContactData(
          sanitizeObject(updates || {}),
          true,
        );

        // Get contact before update for audit logging
        const existingContact =
          await databaseService.getContactById(validatedContactId);
        const userId = existingContact?.user_id || "unknown";

        /**
         * ===================================================================
         * ONLY THE FIELDS THE CALLER ACTUALLY SENT (BACKLOG-2534)
         * ===================================================================
         * This block used to materialise ALL FIVE fields whether or not the
         * caller supplied them:
         *
         *     name: validatedUpdates.name ?? undefined,   // …and four more
         *
         * `?? undefined` reads like "leave it alone". It is not. **The writer
         * writes any key that is PRESENT, whatever its value**, and `undefined`
         * binds as NULL at the shipping driver — measured, not assumed:
         *
         *     UPDATE t SET company = ?, title = ? WHERE id = ?  .run(undefined, undefined, 'a')
         *       -> changes = 1
         *       -> row { id: 'a', company: null, title: null }
         *
         * So a caller sending only `{ name: "Dana Olsen-Reyes" }` — a name
         * correction and nothing else — **emptied her company and job title**,
         * reported success, and told nobody. Those fields feed the transaction
         * party list and the exported audit.
         *
         * The edit form happens to send every field on every save, which is the
         * only reason this was latent rather than a live incident. **That is a
         * property of one caller, not a guarantee** — and BACKLOG-2528 was
         * exactly what happens when the two sides of this boundary drift.
         *
         * Building the object from the keys the caller actually sent removes
         * the asymmetry: absent means absent, and an explicit `null` still
         * clears the column for callers that mean it.
         */
        const updatesData = Object.fromEntries(
          Object.entries(validatedUpdates).filter(([, v]) => v !== undefined),
        ) as typeof validatedUpdates;

        // TASK-1995: Multi-email/phone array update support
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawUpdates = sanitizeObject(updates || {}) as any;

        /**
         * ===================================================================
         * ONE EDIT, ONE TRANSACTION (BACKLOG-2496 / BACKLOG-2530)
         * ===================================================================
         * Saving the edit form is up to three separate writes: the `contacts`
         * row, then the email set, then the phone set. Unwrapped, an
         * interruption partway through left a contact carrying the NEW name
         * with the OLD phone numbers, or — worse, because the address writers
         * delete before they insert — with no addresses at all.
         *
         * Now the whole edit either lands or it does not. A failed save leaves
         * the contact byte-identical to before it was pressed.
         *
         * THE INNER CALLS ARE EACH ATOMIC TOO, so this nests. That is
         * deliberate: `syncContactEmails` and friends are called directly from
         * other paths and must be safe there. Production escalates a nested
         * transaction to a SAVEPOINT, and the test helper now does the same
         * (BACKLOG-2496; a plain nested BEGIN is an error on both engines).
         *
         * IT CALLS `updateContactSync`, NOT THE ASYNC WRAPPER. `dbTransaction`
         * takes a synchronous callback, and an `async` function turns a throw
         * into a REJECTED PROMISE rather than a synchronous throw — so the
         * transaction would have seen the callback return normally and
         * COMMITTED, with the failure arriving later as an unhandled rejection.
         * That would have been an atomicity hole dressed as a fix.
         */
        dbTransaction(() => {
          databaseService.updateContactSync(validatedContactId, updatesData);

          if (Array.isArray(rawUpdates.emails)) {
            syncContactEmails(validatedContactId, rawUpdates.emails);
            logService.info("Contact emails synced (multi)", "Contacts", {
              contactId: validatedContactId,
              count: rawUpdates.emails.length,
            });
          } else if (validatedUpdates.email !== undefined) {
            setContactPrimaryEmail(validatedContactId, validatedUpdates.email as string);
          }

          if (Array.isArray(rawUpdates.phones)) {
            syncContactPhones(validatedContactId, rawUpdates.phones);
            logService.info("Contact phones synced (multi)", "Contacts", {
              contactId: validatedContactId,
              count: rawUpdates.phones.length,
            });
          } else if (validatedUpdates.phone !== undefined) {
            setContactPrimaryPhone(validatedContactId, validatedUpdates.phone as string);
          }
        });

        const contact =
          await databaseService.getContactById(validatedContactId);

        // Audit log contact update
        await auditService.log({
          userId,
          action: "CONTACT_UPDATE",
          resourceType: "CONTACT",
          resourceId: validatedContactId,
          metadata: { updatedFields: Object.keys(validatedUpdates) },
          success: true,
        });

        logService.info("Contact updated", "Contacts", {
          userId,
          contactId: validatedContactId,
        });

        return {
          success: true,
          contact: contact || undefined,
        };
      } catch (error) {
        logService.error("Update contact failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Check if contact can be deleted (get associated transactions)
  ipcMain.handle(
    "contacts:checkCanDelete",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<ContactResponse> => {
      try {
        logService.info(
          "[Main] Checking if contact can be deleted",
          "Contacts",
          { contactId },
        );

        // Validate input
        const validatedContactId = validateContactId(contactId); // Validated, will throw if invalid
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }

        const transactions =
          await databaseService.getTransactionsByContact(validatedContactId);

        return {
          success: true,
          // BACKLOG-2365: always true. Removal is a tombstone now, not a
          // cascading DELETE, so having transactions no longer makes a contact
          // undeletable. The `transactions` payload below is retained and is
          // the reason this handler still has callers — Contacts.tsx and
          // TransactionDetailsTab.tsx use it purely to LIST a contact's
          // transactions, not to gate anything.
          canDelete: true,
          transactions: transactions,
          count: transactions.length,
        };
      } catch (error) {
        logService.error(
          "[Main] Check can delete contact failed:",
          "Contacts",
          { contactId, error },
        );
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Delete contact
  ipcMain.handle(
    "contacts:delete",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<ContactResponse> => {
      try {
        // Validate input
        const validatedContactId = validateContactId(contactId); // Validated, will throw if invalid
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }

        // Get contact before delete for audit logging
        const existingContact =
          await databaseService.getContactById(validatedContactId);
        const userId = existingContact?.user_id || "unknown";
        const contactName = existingContact?.name || "unknown";

        // BACKLOG-2365: the "cannot delete a contact with associated
        // transactions" guard is GONE, deliberately and with founder approval.
        //
        // It never expressed a policy about who may be removed. It existed
        // because removal used to be a hard DELETE whose cascade destroyed the
        // contact's roles on those very transactions — a barrier standing in
        // front of an unrecoverable operation. Removal now writes a tombstone
        // and every transaction_contacts row survives, so the operation it was
        // guarding no longer exists. Keeping it would mean the one contact a
        // user most needs to correct — the one already attached to a live deal
        // — is the one contact they still cannot touch.
        await databaseService.deleteContact(validatedContactId, "user_deleted");

        // Audit log contact removal. Carries the reason alongside the name so
        // the trail distinguishes a deliberate delete from an un-import.
        await auditService.log({
          userId,
          action: "CONTACT_DELETE",
          resourceType: "CONTACT",
          resourceId: validatedContactId,
          metadata: { name: contactName, reason: "user_deleted" },
          success: true,
        });

        logService.info("Contact deleted", "Contacts", {
          userId,
          contactId: validatedContactId,
        });

        return {
          success: true,
        };
      } catch (error) {
        logService.error("Delete contact failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Remove contact from local database (un-import)
  ipcMain.handle(
    "contacts:remove",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<ContactResponse> => {
      try {
        logService.info(
          "[Main] Removing contact from local database",
          "Contacts",
          { contactId },
        );

        // Validate input
        const validatedContactId = validateContactId(contactId); // Validated, will throw if invalid
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }

        // BACKLOG-2365: same guard, same removal, same reason as contacts:delete
        // above. This is the path the Clients & Contacts remove button actually
        // takes, so leaving the guard here would have left the founder-facing
        // flow behaving exactly as before no matter what the delete path did.
        //
        // Read the contact BEFORE the removal so the audit entry can name who
        // was removed — after it, the row is tombstoned but the name is still
        // readable, so ordering is belt-and-braces rather than strictly needed.
        const removedContact =
          await databaseService.getContactById(validatedContactId);

        await databaseService.removeContact(validatedContactId);

        // BACKLOG-2365: this path had NO audit entry, while contacts:delete did
        // — and this is the one a user actually presses. A compliance product
        // that keeps the data but loses the record of who removed it, and when,
        // has kept the wrong half.
        await auditService.log({
          userId: removedContact?.user_id || "unknown",
          action: "CONTACT_DELETE",
          resourceType: "CONTACT",
          resourceId: validatedContactId,
          metadata: {
            name: removedContact?.name || "unknown",
            reason: "user_unimported",
          },
          success: true,
        });

        return {
          success: true,
        };
      } catch (error) {
        logService.error("[Main] Remove contact failed:", "Contacts", {
          contactId,
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // BACKLOG-2367: contacts the user has removed, for the "Removed contacts"
  // section of Clients & Contacts.
  //
  // Returns `success: true` with an empty list when the DB is not yet
  // initialised, matching every other read in this file — an onboarding user
  // has no removed contacts, and erroring would make the section render a
  // failure state on a perfectly healthy fresh install.
  ipcMain.handle(
    "contacts:get-removed",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<RemovedContactsResponse> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: true, contacts: [] };
        }

        const contacts = await databaseService.getRemovedContacts(validatedUserId);
        return { success: true, contacts };
      } catch (error) {
        logService.error("Get removed contacts failed", "Contacts", {
          userId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // BACKLOG-2367: undo a contact removal.
  //
  // The counterpart to `contacts:delete` / `contacts:remove` above. Both of
  // those log CONTACT_DELETE and distinguish themselves through
  // `metadata.reason`; this one logs CONTACT_UPDATE with `reason: "restore"`.
  //
  // The verb has to come from the permitted set: `audit_logs.action` carries a
  // CHECK constraint (schema.sql) and contains no RESTORE verb, while
  // `auditService.log` swallows write failures by design. A new verb would
  // therefore write no row at all and still report success — a restore that
  // looks audited and is not. Extending the CHECK means rebuilding an
  // append-only compliance table, which this task has no business doing.
  ipcMain.handle(
    "contacts:restore",
    async (
      _event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<ContactResponse> => {
      try {
        const validatedContactId = validateContactId(contactId);
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }

        // Read BEFORE the restore so the audit entry can name who came back and
        // what the original removal reason was — `restoreContact` clears
        // `removed_reason`, so afterwards it is gone.
        const contact =
          await databaseService.getContactById(validatedContactId);

        const restored = await databaseService.restoreContact(validatedContactId);

        if (restored) {
          await auditService.log({
            userId: contact?.user_id || "unknown",
            action: "CONTACT_UPDATE",
            resourceType: "CONTACT",
            resourceId: validatedContactId,
            metadata: {
              name: contact?.name || "unknown",
              reason: "restore",
              // What the contact was removed FOR, preserved in the trail before
              // the column is cleared.
              restored_from: contact?.removed_reason ?? null,
            },
            success: true,
          });
        }

        logService.info("Contact restore", "Contacts", {
          contactId: validatedContactId,
          restored,
        });

        // `restored: false` means the contact was already active — a stale
        // click, not a failure. Reported as a successful no-op so the UI
        // neither shows an error nor claims it restored something.
        return { success: true, restored };
      } catch (error) {
        logService.error("Restore contact failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Search contacts (database-level search for contact selection)
  // This fixes the LIMIT 200 issue where contacts beyond position 200 were unsearchable
  ipcMain.handle(
    "contacts:search",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      query: string,
    ): Promise<ContactResponse> => {
      try {
        // BACKLOG-551: Validate user ID exists in local DB
        // BACKLOG-615: Return empty array gracefully during deferred DB init (onboarding)
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          logService.info("[Contacts] No local user yet, returning empty search results (deferred DB init)", "Contacts");
          return {
            success: true,
            contacts: [],
          };
        }

        // For empty/short queries, return the default sorted list
        if (!query || query.length < 2) {
          logService.info(
            "[Main] Short query, returning sorted contacts",
            "Contacts",
            { userId, queryLength: query?.length || 0 },
          );
          const contacts = await databaseService.getContactsSortedByActivity(validatedUserId);
          return {
            success: true,
            contacts,
          };
        }

        // Validate and sanitize query
        const validatedQuery = validateString(query, "query", {
          required: true,
          maxLength: 200,
        });

        if (!validatedQuery) {
          throw new ValidationError("Query validation failed", "query");
        }

        logService.info(
          "[Main] Searching contacts in database",
          "Contacts",
          { userId, query: validatedQuery },
        );

        // Perform database-level search
        const contacts = databaseService.searchContactsForSelection(
          validatedUserId,
          validatedQuery,
        );

        logService.info(
          `[Main] Found ${contacts.length} contacts matching query`,
          "Contacts",
          { userId, resultCount: contacts.length },
        );

        return {
          success: true,
          contacts,
        };
      } catch (error) {
        logService.error("[Main] Search contacts failed:", "Contacts", {
          userId,
          query,
          error,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Look up contact names by phone numbers (batch)
  ipcMain.handle(
    "contacts:get-names-by-phones",
    async (
      _event: IpcMainInvokeEvent,
      phones: string[],
    ): Promise<{ success: boolean; names: Record<string, string>; error?: string }> => {
      try {
        if (!Array.isArray(phones)) {
          return { success: false, names: {}, error: "phones must be an array" };
        }

        const namesMap = await databaseService.getContactNamesByPhones(phones);

        // Convert Map to plain object for IPC
        const names: Record<string, string> = {};
        namesMap.forEach((name, phone) => {
          names[phone] = name;
        });

        return { success: true, names };
      } catch (error) {
        logService.error("Get contact names by phones failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          names: {},
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-2026: Resolve any mix of phone numbers, emails, and Apple IDs to contact names
  ipcMain.handle(
    "contacts:resolve-handles",
    async (
      _event: IpcMainInvokeEvent,
      handles: string[],
      userId?: string,
    ): Promise<{ success: boolean; names: Record<string, string>; error?: string }> => {
      try {
        if (!Array.isArray(handles)) {
          return { success: false, names: {}, error: "handles must be an array" };
        }

        // Pass userId to enable external_contacts lookup (iPhone, macOS, Outlook, Google)
        const validatedUserId = userId ? await getValidUserId(userId, "Contacts") : undefined;
        const names = await resolveHandles(handles, validatedUserId ?? undefined);
        return { success: true, names };
      } catch (error) {
        logService.error("Resolve handles failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          names: {},
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // BACKLOG-1762: Build an email -> display_name map for the user's contacts.
  // Email views use this to resolve display names when the header carries no name.
  ipcMain.handle(
    "contacts:get-email-name-map",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{ success: boolean; nameMap: Record<string, string>; error?: string }> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, nameMap: {}, error: "No valid user found in database" };
        }

        const nameMap = getEmailNameMap(validatedUserId);
        return { success: true, nameMap };
      } catch (error) {
        logService.error("Get email name map failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          nameMap: {},
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-1773: Trigger manual sync of external contacts from macOS
  ipcMain.handle(
    "contacts:syncExternal",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      inserted?: number;
      deleted?: number;
      total?: number;
      /**
       * BACKLOG-2404 — how much of the address-book set this sync actually
       * covered. Carried on the RESULT because this is the handler the user
       * triggers from Settings: if a partial read cannot reach the renderer,
       * "read 2 of 3" exists only in a log nobody opens, and the panel reports
       * a clean sync for a read that lost an entire account.
       */
      read?: {
        found: number;
        read: number;
        failed: number;
        coverage: "complete" | "partial" | "none";
      };
      error?: string;
    }> => {
      try {
        logService.info("[Main] Manual external contacts sync requested", "Contacts", { userId });

        // Validate user ID
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        // TASK-1950: Check if macOS contacts source is enabled
        const macosEnabled = await isContactSourceEnabled(validatedUserId, "direct", "macosContacts", true);
        if (!macosEnabled) {
          logService.info("[Main] macOS contacts sync skipped (disabled in preferences)", "Contacts", { userId: validatedUserId });
          return { success: true, inserted: 0, deleted: 0, total: 0 };
        }

        // Read from macOS Contacts API
        const { phoneToContactInfo, contacts, status } = await getContactNames();

        // BACKLOG-2404: built once, returned on EVERY exit below — including
        // the "nothing found" one. A caller that only learns the coverage on
        // success cannot distinguish "no contacts on this Mac" from "none of
        // her three address books would open", which is the same ambiguity one
        // level down.
        //
        // OMITTED, NEVER FABRICATED, when the reader did not report it. The
        // temptation is to default to zeros; that would be inventing a
        // measurement, and `read 0 of 0` is indistinguishable from "we never
        // looked" — the precise ambiguity this epic keeps having to delete.
        // Absent means unreported, and the renderer draws nothing.
        const read =
          status && typeof status.booksFound === "number"
            ? {
                found: status.booksFound,
                read: status.booksRead,
                failed: status.booksFailed,
                coverage: status.coverage,
              }
            : undefined;

        if (
          (!contacts || contacts.length === 0) &&
          (!phoneToContactInfo || Object.keys(phoneToContactInfo).length === 0)
        ) {
          return { success: false, read, error: "No contacts found in macOS Contacts" };
        }

        // BACKLOG-2316: person-deduped payload (see initial-sync path).
        const macOSContacts = buildMacOSContactsForSync(
          contacts,
          phoneToContactInfo,
        );

        // Full sync: upsert + delete stale + update dates
        //
        // BACKLOG-2401's opportunistic linking still happens — it is just no
        // longer called from here. BACKLOG-2474 moved the trigger onto the
        // write itself (`upsertFromMacOS`), because a call at THIS point runs
        // before the Outlook/Google/Android records of the same sync run have
        // landed, and judges them against a set that does not contain them.
        // The scheduler collapses all of a run's writes into one later pass.
        const result = externalContactDb.fullSync(validatedUserId, macOSContacts);

        // Backfill any imported contacts with new emails/phones from external_contacts
        const backfillResult = await backfillImportedContactsFromExternal(validatedUserId);

        logService.info("[Main] External contacts manual sync complete", "Contacts", {
          inserted: result.inserted,
          deleted: result.deleted,
          total: result.total,
          backfilled: backfillResult.updated,
          coverage: read?.coverage,
        });

        return {
          success: true,
          inserted: result.inserted,
          deleted: result.deleted,
          total: result.total,
          read,
        };
      } catch (error) {
        logService.error("[Main] External contacts sync failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-1773: Get external contacts sync status
  ipcMain.handle(
    "contacts:getExternalSyncStatus",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      lastSyncAt?: string | null;
      isStale?: boolean;
      contactCount?: number;
      error?: string;
    }> => {
      try {
        // Validate user ID
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        const lastSyncAt = externalContactDb.getLastSyncTime(validatedUserId);
        const isStale = externalContactDb.isStale(validatedUserId, 24);
        const contactCount = externalContactDb.getCount(validatedUserId);

        return {
          success: true,
          lastSyncAt,
          isStale,
          contactCount,
        };
      } catch (error) {
        logService.error("[Main] Get external sync status failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-1991: Get contact source stats (per-source counts)
  ipcMain.handle(
    "contacts:getSourceStats",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      stats?: Record<string, number>;
      error?: string;
    }> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        const stats = externalContactDb.getContactSourceStats(validatedUserId);
        return { success: true, stats };
      } catch (error) {
        logService.error("[Main] Get contact source stats failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Force re-import: wipe ALL external contacts (all sources), then re-import from enabled sources
  ipcMain.handle(
    "contacts:forceReimport",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      cleared: number;
      error?: string;
    }> => {
      try {
        logService.info("[Main] Force re-import requested — wiping all sources", "Contacts", { userId });

        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, cleared: 0, error: "No valid user found in database" };
        }

        // Wipe ALL external contacts regardless of which sources are enabled
        const countBefore = externalContactDb.getCount(validatedUserId);
        externalContactDb.clearAllForUser(validatedUserId);
        const totalCleared = countBefore;

        logService.info("[Main] Force re-import wipe complete", "Contacts", {
          userId: validatedUserId,
          cleared: totalCleared,
        });

        return { success: true, cleared: totalCleared };
      } catch (error) {
        logService.error("[Main] Force re-import wipe failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          cleared: 0,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-1921: Sync Outlook contacts to external_contacts table
  // TASK-2300: Delegates to contactSyncService for provider-agnostic sync
  ipcMain.handle(
    "contacts:syncOutlookContacts",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      count?: number;
      reconnectRequired?: boolean;
      /** BACKLOG-2142: dead-token discriminator forwarded to the renderer. */
      tokenExpired?: boolean;
      error?: string;
    }> => {
      try {
        logService.info("[Main] Outlook contacts sync requested", "Contacts", { userId });

        // Validate user ID
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        // TASK-2300: Delegate to contactSyncService
        const result = await contactSyncService.syncProvider(validatedUserId, 'outlook');

        if (!result.success) {
          return {
            success: false,
            error: result.error || "Failed to sync Outlook contacts",
            reconnectRequired: result.reconnectRequired,
            tokenExpired: result.tokenExpired,
          };
        }

        logService.info("[Main] Outlook contacts sync complete", "Contacts", {
          userId: validatedUserId,
          count: result.count,
        });

        return {
          success: true,
          count: result.count,
        };
      } catch (error) {
        logService.error("[Main] Outlook contacts sync failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        // TASK-2058: Log failure for offline diagnostics
        failureLogService.logFailure(
          "outlook_contacts_sync",
          error instanceof Error ? error.message : "Unknown error"
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // TASK-2303: Sync Google contacts to external_contacts table
  // Mirrors syncOutlookContacts pattern, delegates to contactSyncService
  ipcMain.handle(
    "contacts:syncGoogleContacts",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{
      success: boolean;
      count?: number;
      reconnectRequired?: boolean;
      /** BACKLOG-2142: dead-token discriminator forwarded to the renderer. */
      tokenExpired?: boolean;
      error?: string;
    }> => {
      try {
        logService.info("[Main] Google contacts sync requested", "Contacts", { userId });

        // Validate user ID
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) {
          return { success: false, error: "No valid user found in database" };
        }

        // Delegate to contactSyncService (GoogleContactProvider registered in TASK-2301)
        const result = await contactSyncService.syncProvider(validatedUserId, 'google_contacts');

        if (!result.success) {
          return {
            success: false,
            error: result.error || "Failed to sync Google contacts",
            reconnectRequired: result.reconnectRequired,
            tokenExpired: result.tokenExpired,
          };
        }

        logService.info("[Main] Google contacts sync complete", "Contacts", {
          userId: validatedUserId,
          count: result.count,
        });

        return {
          success: true,
          count: result.count,
        };
      } catch (error) {
        logService.error("[Main] Google contacts sync failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        // Log failure for offline diagnostics
        failureLogService.logFailure(
          "google_contacts_sync",
          error instanceof Error ? error.message : "Unknown error"
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Update contact default_role (manual override)
  ipcMain.handle(
    "contacts:update-default-role",
    async (
      event: IpcMainInvokeEvent,
      contactId: string,
      role: string,
    ): Promise<ContactResponse> => {
      try {
        const validatedContactId = validateContactId(contactId);
        if (!validatedContactId) {
          throw new ValidationError(
            "Contact ID validation failed",
            "contactId",
          );
        }
        const validatedRole = validateString(role, "role");
        if (!validatedRole) {
          throw new ValidationError("Role validation failed", "role");
        }

        dbRun(
          `UPDATE contacts SET default_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [validatedRole, validatedContactId]
        );

        logService.info("Contact default_role updated", "Contacts", {
          contactId: validatedContactId,
          role: validatedRole,
        });

        return { success: true };
      } catch (error) {
        logService.error("Update contact default_role failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            error: `Validation error: ${error.message}`,
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // BACKLOG-1933: Get all emails involving a contact's addresses, aggregated
  // across ALL transactions. Returns hydrated Communication rows ready for
  // EmailViewModal. No silent catch — errors return { success:false, error }.
  ipcMain.handle(
    "contacts:get-emails",
    async (
      _event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<{ success: boolean; emails?: Communication[]; error?: string }> => {
      try {
        const validatedContactId = validateContactId(contactId);
        if (!validatedContactId) {
          throw new ValidationError("Contact ID validation failed", "contactId");
        }

        const emails = await databaseService.getEmailsForContact(validatedContactId);
        return { success: true, emails };
      } catch (error) {
        logService.error("Get contact emails failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return { success: false, error: `Validation error: ${error.message}` };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // BACKLOG-1933: Get all text-message threads involving a contact's phones,
  // aggregated across ALL transactions. Returns thread groups ready for
  // ConversationViewModal. No silent catch.
  ipcMain.handle(
    "contacts:get-messages",
    async (
      _event: IpcMainInvokeEvent,
      contactId: string,
    ): Promise<{ success: boolean; messages?: ContactMessageThread[]; error?: string }> => {
      try {
        const validatedContactId = validateContactId(contactId);
        if (!validatedContactId) {
          throw new ValidationError("Contact ID validation failed", "contactId");
        }

        const messages = await databaseService.getMessagesForContact(validatedContactId);
        return { success: true, messages };
      } catch (error) {
        logService.error("Get contact messages failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return { success: false, error: `Validation error: ${error.message}` };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // =========================================================================
  // BACKLOG-2410 — CONTACT LINK REVIEW QUEUE
  // =========================================================================
  //
  // These channels are the ONLY route by which a withheld identity match
  // reaches a human. Every one of them returns `{ success: false, error }`
  // rather than throwing, matching the rest of this file: the review panel is a
  // secondary surface on the contacts screen and an unhandled rejection there
  // would take the whole screen down with it.

  // The number on the "Review N possible duplicates" button. Deliberately its
  // own channel: the count is read on every contacts-screen mount, the full
  // queue only when the panel is opened.
  ipcMain.handle(
    "contacts:review-queue-count",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{ success: boolean; count?: number; error?: string }> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        // No user yet (deferred DB init during onboarding) is not an error and
        // must not be reported as one — it is zero, and the button hides.
        if (!validatedUserId) return { success: true, count: 0 };
        return { success: true, count: countReviewQueue(validatedUserId) };
      } catch (error) {
        logService.warn(
          `[Contacts] review queue count failed: ${error instanceof Error ? error.message : error}`,
          "Contacts",
        );
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  ipcMain.handle(
    "contacts:get-review-queue",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{ success: boolean; clusters?: ReviewQueueCluster[]; error?: string }> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) return { success: true, clusters: [] };
        return { success: true, clusters: getReviewQueue(validatedUserId) };
      } catch (error) {
        logService.error("Get contact review queue failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  ipcMain.handle(
    "contacts:confirm-link",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      proposalId: string,
    ): Promise<{ success: boolean; linked?: boolean; alsoRejected?: number; error?: string }> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) return { success: false, error: "No local user." };
        const validatedProposalId = requireUuidArg(proposalId, "proposalId");
        const outcome = confirmProposal(validatedUserId, validatedProposalId);
        if (!outcome.ok) return { success: false, error: outcome.error };
        return { success: true, linked: outcome.linked, alsoRejected: outcome.alsoRejected };
      } catch (error) {
        logService.error("Confirm contact link failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  ipcMain.handle(
    "contacts:reject-link",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      proposalId: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) return { success: false, error: "No local user." };
        const validatedProposalId = requireUuidArg(proposalId, "proposalId");
        const outcome = rejectProposal(validatedUserId, validatedProposalId);
        if (!outcome.ok) return { success: false, error: outcome.error };
        return { success: true };
      } catch (error) {
        logService.error("Reject contact link failed", "Contacts", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // The labelled set. Not read by any screen today — it exists so threshold
  // calibration and matcher regression tests (BACKLOG-2273 stage 2) have a
  // supported way to reach the verdicts without a second copy of the SQL.
  ipcMain.handle(
    "contacts:get-link-verdicts",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<{ success: boolean; verdicts?: unknown[]; error?: string }> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        if (!validatedUserId) return { success: true, verdicts: [] };
        return { success: true, verdicts: listVerdicts(validatedUserId) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // =========================================================================
  // BACKLOG-2410 — CONTACT PROVENANCE
  // =========================================================================

  ipcMain.handle(
    "contacts:get-sources",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      contactId: string,
    ): Promise<{ success: boolean; sources?: ContactSourceProvenance[]; error?: string }> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        const validatedContactId = validateContactId(contactId);
        if (!validatedContactId) {
          throw new ValidationError("Contact ID validation failed", "contactId");
        }
        if (!validatedUserId) return { success: true, sources: [] };
        return { success: true, sources: getContactProvenance(validatedUserId, validatedContactId) };
      } catch (error) {
        logService.error("Get contact sources failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return { success: false, error: `Validation error: ${error.message}` };
        }
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  ipcMain.handle(
    "contacts:unlink-source",
    async (
      _event: IpcMainInvokeEvent,
      userId: string,
      contactId: string,
      linkId: string,
    ): Promise<UnlinkSourceResponse> => {
      try {
        const validatedUserId = await getValidUserId(userId, "Contacts");
        const validatedContactId = validateContactId(contactId);
        if (!validatedContactId) {
          throw new ValidationError("Contact ID validation failed", "contactId");
        }
        if (!validatedUserId) return { success: false, error: "No local user." };
        const outcome = unlinkContactSource(
          validatedUserId,
          validatedContactId,
          requireUuidArg(linkId, "linkId"),
        );
        if (!outcome.ok) return { success: false, error: outcome.error };
        // BACKLOG-2427: the counts cross the boundary too. The renderer's copy
        // ("the contact and the other sources stay") was true about sources and
        // silent about the emails and phones already copied — which also
        // stayed. It can only stop being silent if it is told.
        return {
          success: true,
          remaining: outcome.remaining,
          removedEmails: outcome.removedEmails,
          removedPhones: outcome.removedPhones,
          ...(outcome.retainedReason ? { retainedReason: outcome.retainedReason } : {}),
        };
      } catch (error) {
        logService.error("Unlink contact source failed", "Contacts", {
          contactId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (error instanceof ValidationError) {
          return { success: false, error: `Validation error: ${error.message}` };
        }
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

}
