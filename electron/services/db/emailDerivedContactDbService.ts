/**
 * People found in the user's email — the producer (BACKLOG-1717).
 *
 * Builds the unsaved records the pickers offer, from `email_participants`. The
 * statements themselves, and the reasoning behind every term in them, are in
 * `emailDerivedContactsSql.ts`; this file is the two ways to run them.
 *
 * ===========================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ===========================================================================
 * **It does not consult the plan feature or the user's Settings switches.**
 * Both are read in the IPC handler, BEFORE this is called, and a read with
 * nothing enabled never reaches the database at all. Putting the gate here as
 * well would put a network read on a read-only worker thread, and would hide
 * from the handler which of the four reasons produced an empty list — the
 * thing the founder's first "nobody shows up" report needs the log to answer.
 *
 * The one rule that IS here rather than in the handler is the per-mailbox
 * fail-closed check, and it is in the SQL rather than in either of these
 * functions: that way the worker and the main-thread fallback cannot disagree
 * about it, because there is only one place it exists.
 *
 * **It writes nothing.** No migration, no stored `inferred` row. A person
 * becomes a contact only when the user picks them and `contacts:import` runs.
 */

import { dbAll } from "./core/dbConnection";
import { queryContacts, isPoolReady } from "../../workers/contactWorkerPool";
import logService from "../logService";
import {
  runEmailDerivedQueryOn,
  MAILBOX_ADDRESS_SQL,
  MAILBOX_TOKEN_PROVIDER,
  type EmailDerivedProvider,
  type EmailDerivedRecord,
} from "./emailDerivedContactsSql";

export type { EmailDerivedProvider, EmailDerivedRecord } from "./emailDerivedContactsSql";

/**
 * The address stored for one of the user's mailboxes, or null.
 *
 * FOR THE LOG LINE ONLY. The rule that a mailbox with no stored address
 * contributes no people is enforced in the producer's SQL, where the worker
 * and the main thread both run it; this read exists so the handler can say
 * WHICH of the four reasons produced an empty list. The founder's first report
 * will be "nobody shows up", and that sentence has four different causes.
 */
export function getMailboxAddress(
  userId: string,
  provider: EmailDerivedProvider,
): string | null {
  const rows = dbAll<{ connected_email_address: string | null }>(
    MAILBOX_ADDRESS_SQL,
    [userId, MAILBOX_TOKEN_PROVIDER[provider]],
  );
  const value = rows[0]?.connected_email_address;
  return value && value.trim() !== "" ? value.trim() : null;
}

/**
 * Run the producer on the main thread.
 *
 * This is the worker's fallback rather than the normal path — see the async
 * version below for why.
 */
export function getEmailDerivedContacts(
  userId: string,
  providers: readonly EmailDerivedProvider[],
): EmailDerivedRecord[] {
  if (providers.length === 0) return [];

  // The SAME function the worker calls, handed this process's connection.
  // Two implementations of one read is how the worker and the fallback come to
  // disagree (BACKLOG-2457); there is only one here.
  return runEmailDerivedQueryOn(
    { prepare: (text: string) => ({ all: (...params: unknown[]) => dbAll(text as never, params) }) },
    userId,
    providers,
  );
}

/**
 * Run the producer off the main thread.
 *
 * At the founder's corpus this is single-digit milliseconds, but the read
 * grows with the mailbox: measured 77 ms at 20,000 emails and ~400 ms at
 * 100,000. The second number is why this does not run on the main thread when
 * it does not have to — 400 ms there is a visible stall on a picker open.
 *
 * Falls back to the synchronous path when the pool is not ready, which is what
 * the address-book read beside it already does. Both run the same statements
 * and the same fold.
 */
export async function getEmailDerivedContactsAsync(
  userId: string,
  providers: readonly EmailDerivedProvider[],
  timeoutMs: number = 30_000,
): Promise<EmailDerivedRecord[]> {
  if (providers.length === 0) return [];

  if (!isPoolReady()) {
    void logService.debug(
      "[EmailDerived] Worker pool not ready — running the read on the main thread",
      "EmailDerived",
    );
    return getEmailDerivedContacts(userId, providers);
  }

  return (await queryContacts("emailDerived", userId, timeoutMs, {
    providers: [...providers],
  })) as EmailDerivedRecord[];
}
