import type { OAuthProvider, SubscriptionTier, SubscriptionStatus } from "../types";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import sessionService from "./sessionService";
import supabaseService from "./supabaseService";
import {
  getSessionClearRequests,
  isSessionFileAwaitingWrite,
  setSessionFileAwaitingWrite,
} from "./sessionFileState";

/**
 * BACKLOG-3555: when does session.json describe a PREVIOUS session?
 *
 * A deep-link sign-in that lands while the database is closed cannot write the
 * new session: that happens in systemHandlers persistSessionForUser, after the
 * open. Until then session.json still holds whoever signed in before. Any
 * reader of the file in that window would answer for the OLD user.
 *
 * - generation: bumped on every deep-link sign-in; a call that waited for the
 *   database compares it before/after the wait.
 * - awaiting flag (held in the leaf module sessionFileState, BACKLOG-4076):
 *   set by setPendingDeepLinkUser (so it cannot be forgotten by main.ts),
 *   and by saveSignInSession when its first write fails (BACKLOG-3322). While it is set, every
 *   sessionService.loadSession() reader gets null and peekSession() reports
 *   "unreadable"; get-current-user and license:get also refuse explicitly. It
 *   is cleared inside the serialized sign-in write, only when that write
 *   succeeded, or by relaunching the app. There is no auto-clear and no expiry.
 * - overdue alarm: the flag is timestamped when set. If it is still set after
 *   SIGN_IN_WRITE_OVERDUE_MS, one warning goes to the log and to Sentry. It
 *   reports a stuck flag; it does not clear it.
 */

/** How long a sign-in may wait for its session write before it is reported. */
export const SIGN_IN_WRITE_OVERDUE_MS = 60_000;

/**
 * BACKLOG-3322: waits before each retry of a failed sign-in session write
 * (1 attempt + 3 retries). Sum 3.5 s, inside LicenseContext's bounded
 * re-ask (20 x 300 ms) and far inside SIGN_IN_WRITE_OVERDUE_MS.
 */
export const SIGN_IN_WRITE_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000];

export interface PendingDeepLinkUser {
  supabaseId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  provider: OAuthProvider;
  subscriptionTier?: SubscriptionTier;
  subscriptionStatus?: SubscriptionStatus;
  trialEndsAt?: string;
}

let generation = 0;
let pendingDeepLinkUser: PendingDeepLinkUser | null = null;
let awaitingSince: number | null = null;
let overdueTimer: ReturnType<typeof setTimeout> | null = null;
/** One report per stuck window; reset only by a successful write. */
let overdueReported = false;

function reportOverdueSignInWrite(): void {
  overdueTimer = null;
  if (!isSessionFileAwaitingWrite() || awaitingSince === null || overdueReported) return;
  overdueReported = true;
  const waitedMs = Date.now() - awaitingSince;
  void logService.warn(
    "Sign-in session write still pending; session reads stay refused until it succeeds",
    "SignInState",
    { waitedMs },
  );
  Sentry.captureMessage("Sign-in session write overdue", {
    level: "warning",
    tags: { component: "signInState" },
    extra: { waitedMs },
  });
}

export function noteSignIn(): void {
  generation += 1;
}

export function getSignInGeneration(): number {
  return generation;
}

/** Mark session.json stale and arm the overdue alarm (one per stuck window). */
function openSignInWriteWindow(): void {
  setSessionFileAwaitingWrite(true);
  if (awaitingSince === null) awaitingSince = Date.now();
  if (overdueTimer === null && !overdueReported) {
    overdueTimer = setTimeout(reportOverdueSignInWrite, SIGN_IN_WRITE_OVERDUE_MS);
    // Never keep the process alive just to report.
    overdueTimer.unref?.();
  }
}

/** Deep-link auth completed before the database was open: store the user AND mark session.json stale. */
export function setPendingDeepLinkUser(data: PendingDeepLinkUser): void {
  pendingDeepLinkUser = data;
  openSignInWriteWindow();
}

/** Drain. Does NOT clear the flag: the session is written after this returns. */
export function getAndClearPendingDeepLinkUser(): PendingDeepLinkUser | null {
  const user = pendingDeepLinkUser;
  pendingDeepLinkUser = null;
  return user;
}

/** Clears the flag. Used by saveSignInSession; exported so tests can reset between cases. */
export function markSignInSessionWritten(): void {
  setSessionFileAwaitingWrite(false);
  awaitingSince = null;
  overdueReported = false;
  if (overdueTimer !== null) {
    clearTimeout(overdueTimer);
    overdueTimer = null;
  }
}

type SignInSessionData = Parameters<typeof sessionService.saveSession>[0];

function waitUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

async function writeSignInSessionOnce(
  data: SignInSessionData,
  proceed: () => boolean,
  rethrow: boolean,
): Promise<boolean> {
  try {
    return await sessionService.saveSession(data, { endsSignInWait: true, proceed });
  } catch (error) {
    if (rethrow) throw error;
    return false;
  }
}

/**
 * The one way a sign-in writes session.json (main.ts DB-open branch and
 * systemHandlers persistSessionForUser). saveSession reports failure as `false`
 * (BACKLOG-3299), so only a write that returned true ends the stale window; a
 * caller cannot save without clearing. BACKLOG-4076: the flag itself is
 * cleared inside the serialized write (endsSignInWait, on EVERY attempt); the
 * call after the await only resets the overdue alarm bookkeeping (and keeps
 * the flag cleared when sessionService is replaced by a test double).
 *
 * BACKLOG-3322: a failed write is retried silently, SIGN_IN_WRITE_RETRY_DELAYS_MS
 * apart, each time with the SDK's current tokens. Never re-provisions. A
 * retry stops when the user signs out (any clearSession request) or a newer
 * sign-in starts; that check runs inside the session write lock. The first
 * failure fails closed (reads refused) on both branches; if every attempt
 * fails the flag stays set until relaunch (BACKLOG-4076 ruling G).
 */
export async function saveSignInSession(data: SignInSessionData): Promise<boolean> {
  const generationAtStart = generation;
  const clearsAtStart = getSessionClearRequests();
  const stillCurrent = () =>
    generation === generationAtStart && getSessionClearRequests() === clearsAtStart;
  let attemptData = data;
  for (let attempt = 0; ; attempt++) {
    const saved = await writeSignInSessionOnce(attemptData, stillCurrent, attempt === 0).catch(
      (error: unknown) => {
        openSignInWriteWindow();
        throw error;
      },
    );
    if (saved) {
      markSignInSessionWritten();
      if (attempt > 0) {
        void logService.info("Sign-in session written on retry", "SignInState", { attempt });
      }
      return true;
    }
    if (attempt === 0) openSignInWriteWindow();
    if (!stillCurrent()) return false;
    if (attempt >= SIGN_IN_WRITE_RETRY_DELAYS_MS.length) {
      reportSignInWriteGaveUp(attempt + 1);
      return false;
    }
    await waitUnref(SIGN_IN_WRITE_RETRY_DELAYS_MS[attempt]);
    if (!stillCurrent()) return false;
    const fresh = await supabaseService.getAuthSession();
    if (!fresh?.accessToken || !fresh.refreshToken) return false;
    attemptData = {
      ...data,
      supabaseTokens: { access_token: fresh.accessToken, refresh_token: fresh.refreshToken },
    };
  }
}

function reportSignInWriteGaveUp(attempts: number): void {
  // This IS the report for the stuck window; the overdue alarm stays quiet.
  overdueReported = true;
  if (overdueTimer !== null) {
    clearTimeout(overdueTimer);
    overdueTimer = null;
  }
  void logService.error(
    "Sign-in session write failed on every attempt; session reads stay refused until relaunch",
    "SignInState",
    { attempts },
  );
  Sentry.captureMessage("Sign-in session write failed after retries", {
    level: "error",
    tags: { component: "signInState" },
    extra: { attempts },
  });
}

export function isSignInAwaitingSessionWrite(): boolean {
  return isSessionFileAwaitingWrite();
}
