// ============================================
// CONTACT IPC HANDLERS
// This file contains contact handlers to be registered in main.js
// ============================================

import { ipcMain, BrowserWindow, app } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "crypto";
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
} from "../services/db/contactDbService";
import { getContactNames } from "../services/contactsService";
import type { ContactInfo, PhoneToContactInfo } from "../services/contactsService";
import { resolveHandles } from "../services/contactResolutionService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import * as externalContactDb from "../services/db/externalContactDbService";
import type { ExternalContactSource } from "../services/db/externalContactDbService";
import { recordPicker, recordLinks } from "../services/contactIngestionFunnel";
import {
  createLink,
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
import { buildEvidence } from "../services/contactLinkEvidence";
import {
  proposeLink,
  listVerdicts,
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
}

/**
 * BACKLOG-1900 (P0.2): Map a shadow-table `ExternalContactSource` to the
 * persisted `contacts.source` (`ContactSource`) value so distinct origins are
 * preserved at import time instead of being flattened to `contacts_app`.
 *
 * - `iphone`, `android_sync`, `outlook`, `google_contacts` pass through as
 *   their own distinct persisted source (the v48 CHECK + `validSources`
 *   allow-list accept all four).
 * - `macos` (desktop Contacts App) and any unrecognised value fall back to
 *   `contacts_app` — `macos` is not a persisted `ContactSource`, and the
 *   desktop address book intentionally stays `contacts_app`.
 *
 * The result flows unchanged through the renderer import call into
 * `contacts:create` / `contacts:import`, which persist it verbatim.
 */
function toPersistedContactSource(
  externalSource: string | null | undefined,
): ContactSource {
  switch (externalSource) {
    case "iphone":
      return "iphone";
    case "android_sync":
      return "android_sync";
    case "outlook":
      return "outlook";
    case "google_contacts":
      return "google_contacts";
    // "macos" (desktop address book) and anything unknown => contacts_app
    default:
      return "contacts_app";
  }
}

/**
 * BACKLOG-2316: Normalize a display name for comparison — lowercase, drop the
 * punctuation that distinguishes an abbreviated surname ("Jane S." vs
 * "Jane Smith"), and collapse whitespace. Returns "" for a missing name.
 */
function normalizeContactName(name: string | null | undefined): string {
  return (name || "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * BACKLOG-2316: Decide whether two display names could plausibly belong to the
 * SAME person. Used to gate phone-based dedup so that two DISTINCT people who
 * merely share a normalized number (a household / office line) are BOTH kept,
 * while the same person recorded across sources ("Jane Smith" / "Jane S.") is
 * still collapsed.
 *
 * Rule: an empty name can't contradict (compatible). Otherwise compare token by
 * token up to the shorter name's length; every aligned token pair must be
 * prefix-compatible (one a prefix of the other). So "Jane Smith" ~ "Jane S." is
 * compatible, but "Margaret …" / "John …" and "… Smith" / "… Jones" are not.
 * Nickname forms (Bob/Robert) are intentionally treated as distinct — the app
 * cannot safely assume they are one person, and keeping both is the safe error.
 *
 * ---------------------------------------------------------------------------
 * BACKLOG-2399 — A LONE TOKEN IS NEVER ENOUGH TO CLAIM TWO PEOPLE ARE ONE
 * ---------------------------------------------------------------------------
 * Because the loop only ran to the SHORTER name's length, a single-token name
 * was prefix-compatible with EVERY longer name starting with that token:
 *
 *     "Margaret"  vs  "Margaret Chen"   -> compatible  -> second one dropped
 *
 * On a shared office line that silently removed a DISTINCT person from the
 * import picker — she could not be imported at all, and nothing said so.
 *
 * The shape was mostly unreachable before: an org-labelled card compared as
 * "miller - seller", which collides with nothing. BACKLOG-2399 relabels that
 * whole population to bare first names, which is exactly this shape, so the
 * latent case became a common one. The predicate is pre-existing; the relabel
 * is what made it bite, so it is fixed here rather than left as a side effect.
 *
 * A single token that is not an exact match is therefore treated as NOT
 * compatible. That follows the rule this function already states — "keeping
 * both is the safe error" — and the harms are not symmetric: a duplicate row in
 * the picker is visible and the user can ignore it, whereas a person who never
 * appears cannot be imported and leaves no trace. Exact matches ("Margaret" /
 * "Margaret") still collapse via the equality check above.
 */
function namesAreCompatible(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeContactName(a);
  const nb = normalizeContactName(b);
  if (!na || !nb) return true;
  if (na === nb) return true;

  const ta = na.split(" ");
  const tb = nb.split(" ");

  // BACKLOG-2399: one bare token carries too little to overrule a shared line.
  if (ta.length === 1 || tb.length === 1) return false;

  const len = Math.min(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = ta[i];
    const y = tb[i];
    if (!x.startsWith(y) && !y.startsWith(x)) return false;
  }
  return true;
}

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

function toSourceIdentity(contact: ImportableContact): SourceIdentity | null {
  const recordId = contact.externalRecordId;
  const sourceType = contact.externalSourceType;
  if (!recordId || !sourceType || !EXTERNAL_SOURCE_TYPES.has(sourceType)) {
    return null;
  }
  return {
    sourceType: sourceType as ExternalContactSource,
    sourceRecordId: recordId,
    externalUuid: contact.externalUuid ?? null,
  };
}

/**
 * Write the crosswalk row for a contact the user has just imported.
 *
 * `match_method` is `'source_id'`: the user selected this exact source record,
 * so the link is asserted, not inferred. Failures are logged and swallowed —
 * an import that succeeded must not be reported as failed because a link could
 * not be written, and the opportunistic linker will create it on the next sync.
 */
function linkImportedContact(
  userId: string,
  contactId: string,
  identity: SourceIdentity | null,
): void {
  if (!identity) return;
  try {
    createLink({
      userId,
      contactId,
      sourceType: identity.sourceType,
      sourceRecordId: identity.sourceRecordId,
      matchMethod: "source_id",
      externalUuid: identity.externalUuid,
    });
  } catch (error) {
    logService.warn(
      `[Contacts] could not write a source link on import: ${error}`,
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
function runOpportunisticLinking(userId: string): void {
  try {
    const summary = linkExternalContactsForUser(userId);
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

async function backfillImportedContactsFromExternal(userId: string): Promise<{ updated: number }> {
  // Only run once per user per session — this is a maintenance task, not needed on every load
  if (backfilledUsers.has(userId)) {
    return { updated: 0 };
  }
  backfilledUsers.add(userId);

  try {
    // TASK-1956: Use worker pool to run backfill off main thread when available
    if (isPoolReady()) {
      const result = await queryContacts('backfill', userId) as Array<{ updated: number }>;
      const updated = result[0]?.updated ?? 0;
      if (updated > 0) {
        logService.info(`Backfilled ${updated} imported contacts from external_contacts (worker)`, "Contacts", { userId });
      }
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
        const importedContacts =
          await databaseService.getImportedContactsByUserIdAsync(validatedUserId);
        const importedEmails = new Set(
          importedContacts.map((c) => c.email?.toLowerCase()).filter(Boolean),
        );

        // Build a set of normalized phones from imported contacts
        const importedPhones = new Set<string>();
        for (const ic of importedContacts) {
          if (ic.phone) {
            const normalized = toE164(ic.phone);
            if (normalized && normalized !== "+") {
              importedPhones.add(normalized);
            }
          }
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

        // TASK-1950: Check contact source preferences
        const macosEnabled = await isContactSourceEnabled(validatedUserId, "direct", "macosContacts", true);
        const iphoneEnabled = await isContactSourceEnabled(validatedUserId, "direct", "iphoneContacts", true);
        const outlookEnabled = await isContactSourceEnabled(validatedUserId, "direct", "outlookContacts", true);
        const googleContactsEnabled = await isContactSourceEnabled(validatedUserId, "direct", "googleContacts", true);

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

        // BACKLOG-2316: Deduplication state. Email is a strong identity signal,
        // so a shared email always collapses. A shared phone is NOT — many
        // distinct people share a household/office line — so we remember which
        // NAMES have claimed each normalized phone and only treat a later
        // contact as a duplicate when its name is compatible with one of them.
        // Name-only matching was removed entirely: it silently dropped distinct
        // people who happen to share a name string (e.g. multiple "Margaret"s).
        const seenEmails = new Set<string>();
        const seenPhoneNames = new Map<string, Set<string>>();

        type DedupContact = {
          name?: string | null;
          display_name?: string | null;
          email?: string | null;
          emails?: string[];
          phone?: string | null;
          phones?: string[];
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
         * A contact is a duplicate of something already seen when it shares an
         * email, OR shares a normalized phone with a previously-seen contact
         * whose name is compatible (same person recorded twice — not two people
         * on one line).
         */
        function isDuplicate(contact: DedupContact): boolean {
          // Email — strong identity signal, collapses regardless of name.
          const email = contact.email?.toLowerCase();
          if (email && seenEmails.has(email)) return true;
          if (contact.emails) {
            for (const e of contact.emails) {
              if (e && seenEmails.has(e.toLowerCase())) return true;
            }
          }

          // Phone — only a duplicate when the names are compatible.
          const name = contact.name || contact.display_name;
          for (const p of collectPhones(contact)) {
            const normalizedPhone = toE164(p);
            if (!normalizedPhone || normalizedPhone === "+") continue;
            const seenNames = seenPhoneNames.get(normalizedPhone);
            if (!seenNames) continue;
            for (const seenName of seenNames) {
              if (namesAreCompatible(name, seenName)) return true;
            }
          }

          return false;
        }

        /**
         * Mark a contact's identifiers as seen for deduplication. Each of the
         * contact's normalized phones records this contact's (normalized) name
         * so a later shared-phone contact can be name-compared against it.
         */
        function markAsSeen(contact: DedupContact): void {
          const email = contact.email?.toLowerCase();
          if (email) seenEmails.add(email);
          if (contact.emails) {
            for (const e of contact.emails) {
              if (e) seenEmails.add(e.toLowerCase());
            }
          }

          const nameKey = normalizeContactName(contact.name || contact.display_name);
          for (const p of collectPhones(contact)) {
            const normalizedPhone = toE164(p);
            if (!normalizedPhone || normalizedPhone === "+") continue;
            let names = seenPhoneNames.get(normalizedPhone);
            if (!names) {
              names = new Set<string>();
              seenPhoneNames.set(normalizedPhone, names);
            }
            names.add(nameKey);
          }
        }

        // STEP 1: Get unimported contacts from database (iPhone synced contacts)
        // These take precedence because they have real DB IDs
        // TASK-1950: Skip if macOS/iPhone contacts source is disabled
        const unimportedDbContacts = (macosEnabled || iphoneEnabled)
          ? await databaseService.getUnimportedContactsByUserId(validatedUserId)
          : [];

        logService.info(
          `[Main] Found ${unimportedDbContacts.length} unimported contacts from database (iPhone sync)`,
          "Contacts",
        );

        for (const dbContact of unimportedDbContacts) {
          // Skip if already imported. BACKLOG-2316: match ONLY on strong
          // identifiers (email / normalized phone). Name matching was removed —
          // it hid a distinct unimported contact whenever ANY already-imported
          // contact shared the same name string (e.g. a second "Margaret").
          const dbEmailLower = dbContact.email?.toLowerCase();
          if (dbEmailLower && importedEmails.has(dbEmailLower)) {
            alreadyImportedCount++;
            continue;
          }
          if (dbContact.phone) {
            const normalizedPhone = toE164(dbContact.phone);
            if (normalizedPhone && normalizedPhone !== "+" && importedPhones.has(normalizedPhone)) {
              alreadyImportedCount++;
              continue;
            }
          }

          // Skip if this is a duplicate (by email, or shared phone + compatible name)
          if (isDuplicate(dbContact)) {
            duplicateSuppressedCount++;
            continue;
          }

          // Mark this contact's identifiers as seen
          markAsSeen(dbContact);

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
        // TASK-1950: Only sync macOS/iPhone contacts if source is enabled
        if (macosEnabled || iphoneEnabled) {
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
                externalContactDb.fullSync(validatedUserId, macOSContacts);

                // BACKLOG-2401: link BEFORE the backfill, so the backfill can
                // resolve through anything linked here. Runs on this path (the
                // FIRST sync a user ever gets) as well as the manual Settings
                // sync — "no backfill migration, it self-heals during sync"
                // only holds if linking runs on the syncs users actually trigger.
                runOpportunisticLinking(validatedUserId);

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

                  externalContactDb.fullSync(validatedUserId, macOSContacts);

                  // BACKLOG-2401: see the initial-sync branch above. This is the
                  // stale-shadow background refresh, the path that runs most
                  // often in normal use and therefore the one convergence
                  // actually depends on.
                  runOpportunisticLinking(validatedUserId);

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
          if (extContact.source === "iphone" && !iphoneEnabled && !macosEnabled) {
            sourceDisabledCount++;
            continue;
          }
          if (extContact.source === "macos" && !macosEnabled) {
            sourceDisabledCount++;
            continue;
          }
          if (extContact.source !== "outlook" && extContact.source !== "google_contacts" && extContact.source !== "iphone" && extContact.source !== "macos" && !macosEnabled) {
            sourceDisabledCount++;
            continue;
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

          const primaryEmail = extContact.emails?.[0]?.toLowerCase();

          // Skip if already imported. BACKLOG-2316: match ONLY on strong
          // identifiers (email here, phone below) — never on name alone, which
          // suppressed distinct external contacts that shared a name with an
          // already-imported contact.
          if (primaryEmail && importedEmails.has(primaryEmail)) {
            alreadyImportedCount++;
            continue;
          }

          // Check if already imported by phone
          if (extContact.phones && extContact.phones.length > 0) {
            let phoneAlreadyImported = false;
            for (const phone of extContact.phones) {
              const normalized = toE164(phone);
              if (
                normalized &&
                normalized !== "+" &&
                importedPhones.has(normalized)
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

          // Skip if already added from iPhone-synced contacts
          if (isDuplicate(extContactForDedup)) {
            duplicateSuppressedCount++;
            continue;
          }

          // Mark as seen
          markAsSeen(extContactForDedup);

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
        const newContactSources: Array<SourceIdentity | null> = [];

        for (const contact of contactsToImport) {
          const sanitizedContact = sanitizeObject(contact) as ImportableContact;
          const validatedData = validateContactData(sanitizedContact, false);
          const sourceIdentity = toSourceIdentity(sanitizedContact);

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
            newContactSources.push(sourceIdentity);
          }
        }

        let processed = 0;

        // Mark existing DB contacts as imported and backfill any missing emails/phones
        // Also update source to "contacts_app" when importing from macOS Contacts
        for (const { id, contact } of existingDbContacts) {
          logService.warn(`[DIAG-1270] DB contact backfill: ${contact.name}, contact.allEmails=[${(contact.allEmails || []).join(', ')}], contact.allPhones=[${(contact.allPhones || []).join(', ')}]`, 'Contacts');
          await databaseService.markContactAsImported(id, contact.source || "contacts_app");

          // BACKLOG-2401: record WHERE this contact came from, at the one moment
          // the answer is known for certain. match_method is 'source_id' because
          // the user picked this exact source record — nothing was inferred.
          linkImportedContact(validatedUserId, id, toSourceIdentity(contact));

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

        // Batch create new contacts (much faster with transaction)
        if (newContactsToCreate.length > 0) {
          logService.info(
            `[Main] Batch importing ${newContactsToCreate.length} new contacts...`,
            "Contacts"
          );

          const createdIds = databaseService.createContactsBatch(
            newContactsToCreate,
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
          // createdIds is index i of newContactsToCreate — and therefore of
          // newContactSources. Guarded on length so a future batch that skips a
          // row cannot silently mis-attribute every link after it.
          if (createdIds.length === newContactSources.length) {
            for (let i = 0; i < createdIds.length; i++) {
              linkImportedContact(validatedUserId, createdIds[i], newContactSources[i]);
            }
          } else {
            logService.warn(
              `[Contacts] createContactsBatch returned ${createdIds.length} ids for ` +
                `${newContactSources.length} inputs — source links skipped for this batch ` +
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
        const contact = await databaseService.createContact({
          user_id: validatedUserId,
          display_name: validatedData.name || "Unknown",
          email: validatedData.email ?? undefined,
          phone: validatedData.phone ?? undefined,
          company: validatedData.company ?? undefined,
          title: validatedData.title ?? undefined,
          source,
          is_imported: true,
        });

        // BACKLOG-1270: Store ALL emails/phones (not just the primary)
        const inputAllEmails = (contactData as { allEmails?: string[] })?.allEmails || [];
        const inputAllPhones = (contactData as { allPhones?: string[] })?.allPhones || [];
        if (inputAllEmails.length > 0) {
          await databaseService.backfillContactEmails(contact.id, inputAllEmails);
          logService.info(`[Contacts] Stored ${inputAllEmails.length} emails for new contact ${contact.id}`, "Contacts");
        }
        if (inputAllPhones.length > 0) {
          await databaseService.backfillContactPhones(contact.id, inputAllPhones);
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

        // Convert null to undefined for TypeScript strict mode
        const updatesData = {
          ...validatedUpdates,
          name: validatedUpdates.name ?? undefined,
          email: validatedUpdates.email ?? undefined,
          phone: validatedUpdates.phone ?? undefined,
          company: validatedUpdates.company ?? undefined,
          title: validatedUpdates.title ?? undefined,
        };

        await databaseService.updateContact(validatedContactId, updatesData);

        // TASK-1995: Multi-email/phone array update support
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawUpdates = sanitizeObject(updates || {}) as any;

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
          canDelete: transactions.length === 0,
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

        // Check if contact has associated transactions
        const check =
          await databaseService.getTransactionsByContact(validatedContactId);
        if (check.length > 0) {
          return {
            success: false,
            error: "Cannot delete contact with associated transactions",
            canDelete: false,
            transactions: check,
            count: check.length,
          };
        }

        await databaseService.deleteContact(validatedContactId);

        // Audit log contact deletion
        await auditService.log({
          userId,
          action: "CONTACT_DELETE",
          resourceType: "CONTACT",
          resourceId: validatedContactId,
          metadata: { name: contactName },
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

        // Check if contact has associated transactions
        const check =
          await databaseService.getTransactionsByContact(validatedContactId);
        if (check.length > 0) {
          return {
            success: false,
            error: "Cannot remove contact with associated transactions",
            canDelete: false,
            transactions: check,
            count: check.length,
          };
        }

        await databaseService.removeContact(validatedContactId);

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
        const result = externalContactDb.fullSync(validatedUserId, macOSContacts);

        // BACKLOG-2401: opportunistic linking, BEFORE the backfill so the
        // backfill can resolve through any link created here.
        //
        // This is what replaces the one-time migration the founder ruled out:
        // contacts imported before the crosswalk existed cannot be re-imported
        // to acquire a link (the already-imported filter skips them) and would
        // otherwise silently stop receiving updates forever. Linking them here
        // is less code than a batch job, has no upgrade path to get wrong, and
        // converges as syncs run.
        runOpportunisticLinking(validatedUserId);

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
    ): Promise<{ success: boolean; remaining?: number; error?: string }> => {
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
        return { success: true, remaining: outcome.remaining };
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
