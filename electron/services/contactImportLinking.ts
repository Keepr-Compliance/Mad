/**
 * BACKLOG-4180 — the linking pass `contacts:import` runs, scoped to the
 * contacts the import touched.
 *
 * The full pass (`linkExternalContactsForUser` + the unique-name rule) reads
 * every source record, normalises every phone with libphonenumber and owner-
 * looks-up every named record, on the main thread. Run after an import of ONE
 * contact, that froze the app for the whole address book.
 *
 * An import changes saved contacts and the crosswalk rows for the records the
 * user picked. It changes no source record. So the only records whose
 * resolution can change are those that share an identifier (phone or email) or
 * a name with a touched contact. This runs the same two steps, in the same
 * order, over exactly those:
 *
 *   1. the crosswalk / content pass over records sharing an identifier
 *      (`linkExternalContactsForContacts`, FULL match index), then
 *   2. the unique-name rule over the name groups containing a touched contact
 *      or a record the crosswalk assigns to one (`NameGroupScope`).
 *
 * Order is load-bearing for the same reason as in the full pass: the name rule
 * reads the crosswalk the content pass writes.
 *
 * Synchronous. The scheduler's hold relies on the read completing in one tick.
 *
 * TRANSACTIONS: unchanged from the full pass. Content links commit in
 * `linkSourceRecords`' per-slice `dbTransaction`; the name rule writes as it
 * does in the full pass. Nothing here opens a transaction of its own.
 */

import { linkExternalContactsForContacts } from "./contactSourceLinker";
import {
  runUniqueNameAutoLinkForMode,
  type AskPair,
} from "./contactNameAutoLink";
import type { LinkProposalReason } from "./db/contactLinkReviewDbService";
import { resolveContactAutoLinkMode, type ContactAutoLinkMode } from "./contactAutoLinkPolicy";
import logService from "./logService";

export interface ImportScopedLinkingResult {
  candidateRecords: number;
  contentLinked: number;
  nameLinked: number;
  nameAsked: number;
}

/**
 * Never throws: an import that committed must not be reported as failed
 * because linking hit a problem. Each step is caught on its own, like the full
 * pass (`runOpportunisticLinking`).
 *
 * `mode` defaults to the user's resolved auto-link mode; the parameter exists
 * for the parity suite, which compares this against the full pass per mode.
 */
export function runImportScopedLinkingPass(
  userId: string,
  contactIds: readonly string[],
  onAsk?: (
    pair: AskPair,
    ctx: { reason: LinkProposalReason; holderCount: number; displayName: string },
  ) => void,
  mode?: ContactAutoLinkMode,
): ImportScopedLinkingResult {
  const result: ImportScopedLinkingResult = {
    candidateRecords: 0,
    contentLinked: 0,
    nameLinked: 0,
    nameAsked: 0,
  };

  try {
    const summary = linkExternalContactsForContacts(userId, contactIds);
    result.candidateRecords = summary.resolutions.length;
    result.contentLinked = summary.contentMatched;
  } catch (error) {
    logService.warn(`[Contacts] import-scoped source linking failed: ${error}`, "Contacts");
  }

  try {
    const nameSummary = runUniqueNameAutoLinkForMode(
      mode ?? resolveContactAutoLinkMode(userId),
      userId,
      onAsk,
      { contactIds },
    );
    result.nameLinked = nameSummary.autoLinked;
    result.nameAsked = nameSummary.asked;
  } catch (error) {
    logService.warn(`[Contacts] import-scoped unique-name linking failed: ${error}`, "Contacts");
  }

  return result;
}
