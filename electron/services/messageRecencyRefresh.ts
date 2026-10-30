/**
 * BACKLOG-3222: the three recency writes that follow a Mac Messages import,
 * committed together or not at all.
 *
 *   1. contacts.last_inbound_at            (communication-dates plan)
 *   2. phone_last_message                  (full recompute from messages)
 *   3. external_contacts.last_message_at   (derived from 2)
 *
 * Before this module each ran in its own try/catch and its own transaction
 * (or none), so a crash or an error between them left the tables disagreeing.
 *
 * Shape: the contacts plan is a slow read that runs on a dedicated worker
 * (BACKLOG-3837), and `dbTransaction` cannot take an async body. So the plan is
 * read FIRST, off the main thread, and then all three writes are applied in ONE
 * synchronous transaction. If the plan cannot be read, nothing is written (the
 * founder's ruling on BACKLOG-3222: all or nothing); the next import retries.
 *
 * Do not add a try/catch inside the transaction body. A caught error there
 * commits the steps around it, which is the exact defect this module removes.
 * Logs go after the commit.
 */
import { dbTransaction } from "./db/core/dbConnection";
import { planCommunicationDates, applyCommunicationDatesPlanSync } from "./db/contactDbService";
import { backfillPhoneLastMessageTableSync } from "./db/messageDbService";
import { updateLastMessageAtFromLookupTable } from "./db/externalContactDbService";
import logService from "./logService";

export interface MessageRecencyRefreshCounts {
  contacts: number;
  phones: number;
  external: number;
}

export async function refreshMessageRecencyAfterImport(userId: string): Promise<MessageRecencyRefreshCounts> {
  const startedAt = Date.now();
  const plan = await planCommunicationDates(userId);

  const counts = dbTransaction((): MessageRecencyRefreshCounts => {
    const contacts = applyCommunicationDatesPlanSync(plan);
    const phones = backfillPhoneLastMessageTableSync(userId);
    const external = updateLastMessageAtFromLookupTable(userId);
    return { contacts, phones, external };
  });

  void logService.info("Message recency refreshed after import", "MessageRecencyRefresh", {
    updatedContacts: counts.contacts,
    phonesUpdated: counts.phones,
    updatedExternalContacts: counts.external,
    planRows: plan.length,
    durationMs: Date.now() - startedAt,
  });

  return counts;
}
