import type { OAuthProvider, SubscriptionTier, SubscriptionStatus } from "../types";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import sessionService from "./sessionService";
import { isSessionFileAwaitingWrite, setSessionFileAwaitingWrite } from "./sessionFileState";

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
 *   set by setPendingDeepLinkUser (so it cannot be set without storing the
 *   pending user, and cannot be forgotten by main.ts). While it is set, every
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

/** Deep-link auth completed before the database was open: store the user AND mark session.json stale. */
export function setPendingDeepLinkUser(data: PendingDeepLinkUser): void {
  pendingDeepLinkUser = data;
  setSessionFileAwaitingWrite(true);
  if (awaitingSince === null) awaitingSince = Date.now();
  if (overdueTimer === null && !overdueReported) {
    overdueTimer = setTimeout(reportOverdueSignInWrite, SIGN_IN_WRITE_OVERDUE_MS);
    // Never keep the process alive just to report.
    overdueTimer.unref?.();
  }
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

/**
 * The one way a sign-in writes session.json (main.ts DB-open branch and
 * systemHandlers persistSessionForUser). saveSession reports failure as `false`
 * (BACKLOG-3299), so only a write that returned true ends the stale window; a
 * caller cannot save without clearing. BACKLOG-4076: the flag itself is
 * cleared inside the serialized write (endsSignInWait); the call after the
 * await only resets the overdue alarm bookkeeping (and keeps the flag cleared
 * when sessionService is replaced by a test double).
 */
export async function saveSignInSession(
  data: Parameters<typeof sessionService.saveSession>[0],
): Promise<boolean> {
  const saved = await sessionService.saveSession(data, { endsSignInWait: true });
  if (saved) markSignInSessionWritten();
  return saved;
}

export function isSignInAwaitingSessionWrite(): boolean {
  return isSessionFileAwaitingWrite();
}
