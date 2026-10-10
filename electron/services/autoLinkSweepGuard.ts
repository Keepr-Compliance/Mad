/**
 * BACKLOG-3883: one full auto-link sweep per deal per input state.
 *
 * A "full sweep" runs autoLinkCommunicationsForContact for every assigned contact of a
 * deal, with the deal's own window and queueAmbiguousInsteadOfLinking = true. Three
 * callers run exactly that:
 *   - transactionService.createAuditedTransaction (the creation pass)
 *   - reviewStateService.syncReviewQueueForTransaction with no contact scope (the
 *     details screen's on-open review:sync)
 *   - transactionSyncTrigger's covered path (the create/open email trigger when the
 *     mailbox cache already covers the window)
 * On the founder's PC (BACKLOG-3883) a new deal's six contacts were each swept three
 * times in ~10 s on the main process: the creation pass, then two overlapping passes
 * from the callers above. The later two read the same inputs and could change nothing.
 *
 * The rule here:
 *   1. If a full sweep of this deal is in flight, WAIT for it — never join it: a joiner
 *      would inherit reads taken before whatever made it ask — then decide afresh.
 *   2. Skip when the auto-link input token (db/autoLinkInputTracker.ts) equals the one
 *      captured at the START of the last clean sweep of this deal. Captured at the start,
 *      so anything written while that sweep ran makes the next one run.
 *   3. Otherwise run, and remember the start token only if the sweep reports clean.
 *
 * Not used by the callers whose whole point is new input: the post-fetch pass in
 * emailSyncService, autoLinkNewMessagesForUser after an import, the contact-change sync
 * and the add-contact path. Those run as before.
 */
import { ensureDb } from "./db/core/dbConnection";
import logService from "./logService";
import {
  readAutoLinkInputToken,
  sameAutoLinkInputToken,
  type AutoLinkInputToken,
} from "./db/autoLinkInputTracker";

const inFlight = new Map<string, Promise<unknown>>();
const lastCleanSweep = new Map<string, AutoLinkInputToken>();

export type FullSweepOutcome<T> = { ran: true; value: T } | { ran: false; reason: "unchanged" };

function readToken(): AutoLinkInputToken | null {
  try {
    return readAutoLinkInputToken(ensureDb());
  } catch {
    return null;
  }
}

/**
 * Run `sweep` for `transactionId` unless an identical full sweep already covered the
 * current inputs. `sweep` resolves `clean: false` when any contact failed, so a failed
 * sweep is never remembered as covering anything.
 */
export async function runFullSweepOnce<T extends { clean: boolean }>(
  transactionId: string,
  sweep: () => Promise<T>,
  caller = "unknown",
): Promise<FullSweepOutcome<T>> {
  // Wait, then re-check: another waiter may have started a sweep meanwhile.
  for (let pending = inFlight.get(transactionId); pending; pending = inFlight.get(transactionId)) {
    void logService.info(`[AutoLink] sweep waiting for one in flight caller=${caller}`, "AutoLinkSweepGuard", { transactionId });
    try {
      await pending;
    } catch {
      // the other sweep's failure is its caller's to report
    }
  }

  // Synchronous from here to inFlight.set: no other sweep of this deal can start between.
  const token = readToken();
  if (token && sameAutoLinkInputToken(token, lastCleanSweep.get(transactionId))) {
    void logService.info(`[AutoLink] sweep skipped (inputs unchanged) caller=${caller}`, "AutoLinkSweepGuard", { transactionId });
    return { ran: false, reason: "unchanged" };
  }
  void logService.info(`[AutoLink] sweep start caller=${caller}`, "AutoLinkSweepGuard", { transactionId, tracked: token !== null });

  const running = sweep();
  inFlight.set(transactionId, running);
  try {
    const value = await running;
    if (token && value.clean) lastCleanSweep.set(transactionId, token);
    else lastCleanSweep.delete(transactionId);
    return { ran: true, value };
  } catch (error) {
    lastCleanSweep.delete(transactionId);
    throw error;
  } finally {
    if (inFlight.get(transactionId) === running) inFlight.delete(transactionId);
  }
}

/** One event-loop turn, so a long per-contact loop never holds the main process. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Test seam. */
export function __resetFullSweepGuardForTests(): void {
  inFlight.clear();
  lastCleanSweep.clear();
}
