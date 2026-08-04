/**
 * Phase 2 of contact processing — BACKLOG-2474.
 *
 * ===========================================================================
 * WHAT THIS EXISTS TO FIX
 * ===========================================================================
 * The matching engine (`contactSourceLinker` + `contactNameAutoLink`) has never
 * had a source filter: it selects from `external_contacts` scoped by `user_id`
 * alone. It has always been able to match a macOS record against an Outlook one.
 *
 * What it did NOT have was a caller. Its three call sites all sat downstream of
 * the macOS shadow-table sync, behind `macosEnabled`/`iphoneEnabled` gates. A
 * Windows user on Outlook + the Android companion has both flags false, so the
 * pass never ran for them — not late, never. Their review queue was permanently
 * empty, which is indistinguishable from "nothing to review".
 *
 * ===========================================================================
 * WHY A COALESCER AND NOT A CALL PER SOURCE
 * ===========================================================================
 * The obvious fix — call the pass at the end of each source's sync — reproduces
 * the founder's original bug in a new shape. From his log, one "Sync now":
 *
 *     23:00:45.594  macOS sync complete, name pass ran over 1128 records
 *     23:00:47.257  Outlook inserted: 3
 *
 * A per-source call means the macOS pass runs against a set that does not yet
 * contain the Outlook records, and the Outlook pass runs against a set that
 * does. Whichever source lands last is the only one that ever sees a complete
 * picture, and every other source's records are judged against a partial one.
 *
 * There is no "the sync run finished" event to hook instead. Verified:
 *   - The only orchestrator is renderer-side (`SyncOrchestratorService`), and it
 *     never sees `iphone` or `android_sync`.
 *   - `MacOSContactsImportSettings.handleImportAll` bypasses it entirely, firing
 *     three syncs in parallel, fire-and-forget, with no join. That is almost
 *     certainly the 1.7s gap above.
 *   - Two of the five sources never touch `ipcMain` at all: `android_sync`
 *     arrives over HTTP from the paired companion, `iphone` from a device-sync
 *     completion callback.
 *
 * So the barrier is CONSTRUCTED here, by observation rather than declaration:
 * every writer signals, and the pass runs once the writes go quiet.
 *
 * ===========================================================================
 * THE CONTRACT — READ THIS BEFORE ASSERTING ON PASS COUNTS
 * ===========================================================================
 * **At most one pass per quiet period, and every written record is seen by some
 * pass.** NOT "exactly one pass per sync run".
 *
 * The stronger claim would be false and a test asserting it would be pinning a
 * property the system does not have. `contactSyncService.syncAll` awaits its
 * providers sequentially and each one completes its entire network fetch before
 * writing — paginated Graph with a per-request throttle and 429 backoff. That
 * inter-source gap routinely exceeds any quiet window worth having, so a
 * sequential run legitimately produces two passes.
 *
 * That is harmless, and it is why this module does not chase a bigger window:
 * the pass is idempotent (`proposeLink` is INSERT OR IGNORE against a pair
 * UNIQUE; `createLink` is guarded) and costs ~80ms at 1,100 records. Two cheap
 * idempotent passes beat one pass that misses records.
 */

import logService from "./logService";

/**
 * How the scheduler runs the pass.
 *
 * INJECTED, not imported. The pass itself lives in `contactHandlers.ts` because
 * it owns the crosswalk-then-name ordering, the review-queue write and the
 * funnel metrics; a service importing a handler module would be a circular
 * dependency. This module therefore knows *when*, and nothing about *what*.
 */
export interface ContactLinkingRunner {
  /** Run the pass for one user. May be async (it awaits the backfill). */
  run: (userId: string) => Promise<void> | void;
  /**
   * Called after a pass settles, successfully or not.
   *
   * Best-effort by contract: it reaches a possibly-stale BrowserWindow
   * reference, and the renderer's own mount-refresh is the backstop. Never let
   * a notify failure escape into the scheduler.
   */
  notify?: (userId: string) => void;
}

/**
 * Quiet period. Sized against the founder's observed 1.7s macOS -> Outlook gap
 * on the parallel `handleImportAll` path, which is the shape this actually
 * collapses into one pass.
 */
export const QUIET_PERIOD_MS = 2500;

/**
 * Ceiling from the FIRST pending request, so a steady drip of writes cannot
 * push the pass out indefinitely.
 *
 * THE ACTUAL WORST-CASE DELAY IS `MAX_DEFERRAL_MS + QUIET_PERIOD_MS`, not
 * `MAX_DEFERRAL_MS`. The ceiling is only evaluated when a NEW request arrives,
 * so the last request to land just under the ceiling still arms a full quiet
 * period: writes at t=0, 2400, 4800 … 19200 and then silence put the pass at
 * 21700 ms. Bounding it exactly would need a second timer for a guarantee
 * nothing depends on, so the loose bound is deliberate — but it is the bound,
 * and a reader sizing anything against it needs the real number.
 */
export const MAX_DEFERRAL_MS = 20000;

interface PendingRun {
  timer: ReturnType<typeof setTimeout>;
  /** When this pending window opened — the ceiling is measured from here. */
  firstRequestedAt: number;
}

let runner: ContactLinkingRunner | null = null;

const pending = new Map<string, PendingRun>();
/** Users whose pass is executing right now. Guards against re-entry. */
const inFlight = new Set<string>();
/** Users who signalled while their own pass was mid-flight. */
const rerunRequested = new Set<string>();
/**
 * Per-user hold depth. While above zero, no pass may run for that user.
 *
 * Taken by a sync that has written rows it might still ROLL BACK — today the
 * iPhone path, whose `storeContacts` lands rows under a `sync_session_id` and
 * then spends minutes copying attachments, during which a cancel deletes them
 * again (TASK-2110).
 *
 * Suppressing that path's own signal is not enough, and a test proved it: the
 * pass reads the whole table, so a macOS or Outlook sync finishing during that
 * window runs a pass that sees the provisional rows and links them. The hold is
 * what makes "these rows are not judgeable yet" a property of the DATA rather
 * than of who happened to signal.
 */
const holds = new Map<string, number>();
/** Users who signalled while held — the pass they asked for still owes them. */
const heldRequests = new Set<string>();

/**
 * Wire the scheduler up. Called once from `registerContactHandlers`.
 *
 * Until this is called every entry point below is a no-op that creates NO
 * timers. That matters for the test suites that exercise the real
 * `externalContactDbService`: they must not acquire a background timer, and
 * jest must not report an open handle because of one.
 */
export function configureContactLinking(next: ContactLinkingRunner): void {
  runner = next;
}

/**
 * A source just wrote contact records. Schedule the pass; do not run it.
 *
 * Called from the three `external_contacts` INSERT sites, which are the only
 * places in the main process a record can enter the shadow table.
 */
export function requestContactLinking(userId: string): void {
  if (!runner || !userId) return;

  // Held: remember that a pass is owed, but arm nothing. Release re-arms it.
  if ((holds.get(userId) ?? 0) > 0) {
    heldRequests.add(userId);
    return;
  }

  const existing = pending.get(userId);
  const now = Date.now();

  if (existing) {
    clearTimeout(existing.timer);
    // The ceiling is measured from the FIRST request in this window, so a
    // stream of writes cannot keep pushing the pass away.
    if (now - existing.firstRequestedAt >= MAX_DEFERRAL_MS) {
      pending.delete(userId);
      void execute(userId, "ceiling");
      return;
    }
  }

  const firstRequestedAt = existing?.firstRequestedAt ?? now;
  const timer = setTimeout(() => {
    pending.delete(userId);
    void execute(userId, "quiet-period");
  }, QUIET_PERIOD_MS);

  // Never hold the app open for a pending pass. Electron's main process and
  // jest both care: an un-unref'd timer keeps the event loop alive.
  timer.unref?.();

  pending.set(userId, { timer, firstRequestedAt });
}

/**
 * Run the pass now, without waiting for the quiet period.
 *
 * For `contacts:import`: a discrete user action, with the user watching, where
 * the whole point is that a duplicate created by THIS import is found without
 * requiring a later sync. Cancels any pending coalesced run as redundant.
 */
export async function runContactLinkingNow(userId: string): Promise<void> {
  if (!runner || !userId) return;

  // Even an immediate run defers under a hold. An import landing mid-iPhone-
  // sync would otherwise judge rows that a cancel is about to delete — the
  // immediacy is worth less than the correctness, and the hold windows are
  // short and rare.
  if ((holds.get(userId) ?? 0) > 0) {
    heldRequests.add(userId);
    return;
  }

  cancelPendingContactLinking(userId);
  await execute(userId, "immediate");
}

/**
 * Suspend passes for a user while rollback-eligible rows are in the table.
 *
 * Depth-counted so nested or overlapping syncs compose. ALWAYS pair with
 * `releaseContactLinking` in a `finally` — a hold that is never released
 * silently disables matching for that user until the app restarts.
 */
export function holdContactLinking(userId: string): void {
  if (!userId) return;
  holds.set(userId, (holds.get(userId) ?? 0) + 1);
  // Anything already armed must not fire mid-hold; it is re-armed on release.
  const existing = pending.get(userId);
  if (existing) {
    clearTimeout(existing.timer);
    pending.delete(userId);
    heldRequests.add(userId);
  }
}

/** Lift one hold. At depth zero, any pass owed from the hold window is armed. */
export function releaseContactLinking(userId: string): void {
  if (!userId) return;
  const depth = holds.get(userId) ?? 0;
  if (depth <= 1) {
    holds.delete(userId);
    if (heldRequests.delete(userId)) requestContactLinking(userId);
    return;
  }
  holds.set(userId, depth - 1);
}

/**
 * Drop scheduled work. With no argument, drops it for every user.
 *
 * Called on logout (the pass must not run for a signed-out user, and a notify
 * must not reach a window now showing someone else) and on app quit.
 */
export function cancelPendingContactLinking(userId?: string): void {
  if (userId === undefined) {
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    rerunRequested.clear();
    heldRequests.clear();
    holds.clear();
    return;
  }
  const existing = pending.get(userId);
  if (existing) {
    clearTimeout(existing.timer);
    pending.delete(userId);
  }
  rerunRequested.delete(userId);
  heldRequests.delete(userId);
}

/**
 * Run the pass, never overlapping with itself for the same user.
 *
 * The runner became async when it took on the backfill re-run, so two timers
 * for one user could otherwise interleave two passes over the same rows. A
 * signal arriving mid-flight re-arms afterwards instead of running concurrently
 * — it must not be dropped, because it represents records the in-flight pass
 * may have started too early to see.
 *
 * ===========================================================================
 * THIS FUNCTION DOES NOT RE-CHECK THE HOLD, AND THAT IS LOAD-BEARING
 * ===========================================================================
 * A hold taken between the timer firing and the pass reading the table would
 * not be honoured. That is safe TODAY for exactly one reason: the pass is
 * SYNCHRONOUS up to its first await. `runLinkingPassWithBackfill`
 * (`contactHandlers.ts`) calls `runOpportunisticLinking` — itself fully
 * synchronous — as its first statement, before any await, so the whole read of
 * `external_contacts` completes in one uninterrupted tick. Nothing can take a
 * hold in between, because nothing else can run.
 *
 * IF THAT EVER CHANGES — an await added before the pass, the pass moved to the
 * worker pool, the read made async — the hold silently stops protecting
 * anything and provisional iPhone rows become linkable again. NOTHING WOULD GO
 * RED: every existing test would still pass, because the hazard is a scheduling
 * interleaving no test can create while the pass is synchronous.
 *
 * So: making the pass async requires re-checking `holds` here, immediately
 * before `active.run`, and again after any await inside the runner.
 */
async function execute(userId: string, reason: string): Promise<void> {
  const active = runner;
  if (!active) return;

  if (inFlight.has(userId)) {
    rerunRequested.add(userId);
    return;
  }

  inFlight.add(userId);
  try {
    await active.run(userId);
  } catch (error) {
    // A linking failure must never escape: it is opportunistic, the next signal
    // retries it, and it must not take down a sync or an import that succeeded.
    logService.warn(
      `[Contacts] linking pass (${reason}) failed: ${error}`,
      "ContactLinkingScheduler",
    );
  } finally {
    inFlight.delete(userId);

    // Outside the run's try/catch above but inside its own, because notify
    // reaches a BrowserWindow reference that may be stale.
    try {
      active.notify?.(userId);
    } catch (error) {
      logService.warn(
        `[Contacts] linking pass notify failed: ${error}`,
        "ContactLinkingScheduler",
      );
    }

    if (rerunRequested.delete(userId)) {
      requestContactLinking(userId);
    }
  }
}

/** Test seam. Drops all scheduled work AND the injected runner. */
export function __resetContactLinkingScheduler(): void {
  cancelPendingContactLinking();
  inFlight.clear();
  runner = null;
}

/** Test seam. Whether a pass is scheduled for this user. */
export function __hasPendingContactLinking(userId: string): boolean {
  return pending.has(userId);
}
