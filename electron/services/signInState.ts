import type { OAuthProvider, SubscriptionTier, SubscriptionStatus } from "../types";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";
import sessionService from "./sessionService";

/**
 * BACKLOG-3555: when does session.json describe a PREVIOUS session?
 *
 * A deep-link sign-in that lands while the database is closed cannot write the
 * new session: that happens in systemHandlers persistSessionForUser, after the
 * open. Until then session.json still holds whoever signed in before. A
 * get-current-user or license:get call that reads it in that window answers
 * for the OLD user (and get-current-user can restore, clear or migrate on it).
 *
 * - generation: bumped on every deep-link sign-in; a call that waited for the
 *   database compares it before/after the wait.
 * - awaiting flag: set by setPendingDeepLinkUser (so it cannot be set without
 *   storing the pending user, and cannot be forgotten by main.ts), cleared only
 *   when a session write actually succeeded.
 * - overdue alarm: the flag is timestamped when set. If it is still set after
 *   SIGN_IN_WRITE_OVERDUE_MS, one warning goes to the log and to Sentry. A flag
 *   that is never cleared otherwise fails silently: every later
 *   get-current-user answers "Superseded" and license:get answers the
 *   placeholder until the app restarts.
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
let signInAwaitingSessionWrite = false;
let pendingDeepLinkUser: PendingDeepLinkUser | null = null;
let awaitingSince: number | null = null;
let overdueTimer: ReturnType<typeof setTimeout> | null = null;
/** One report per stuck window; reset only by a successful write. */
let overdueReported = false;

function reportOverdueSignInWrite(): void {
  overdueTimer = null;
  if (!signInAwaitingSessionWrite || awaitingSince === null || overdueReported) return;
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
  signInAwaitingSessionWrite = true;
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
  signInAwaitingSessionWrite = false;
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
 * caller cannot save without clearing.
 */
export async function saveSignInSession(
  data: Parameters<typeof sessionService.saveSession>[0],
): Promise<boolean> {
  const saved = await sessionService.saveSession(data);
  if (saved) markSignInSessionWritten();
  return saved;
}

export function isSignInAwaitingSessionWrite(): boolean {
  return signInAwaitingSessionWrite;
}
