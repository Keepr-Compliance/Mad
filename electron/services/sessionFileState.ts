/**
 * BACKLOG-4076: is session.json known to describe a PREVIOUS session?
 *
 * Set when a deep-link sign-in lands before its session can be written
 * (signInState.setPendingDeepLinkUser). While it is set, sessionService
 * refuses every read of the file (loadSession -> null, peekSession ->
 * "unreadable"). It is cleared inside the serialized sign-in write, only when
 * that write succeeded (sessionService.saveSession with endsSignInWait).
 *
 * A leaf module with NO imports, so sessionService and signInState can both
 * use it without an import cycle.
 */
let awaitingWrite = false;

export function setSessionFileAwaitingWrite(value: boolean): void {
  awaitingWrite = value;
}

export function isSessionFileAwaitingWrite(): boolean {
  return awaitingWrite;
}

/**
 * BACKLOG-3322: every clearSession() call, counted when it is REQUESTED (before
 * it queues), whether or not the unlink later succeeds. A sign-in write retry
 * compares it inside the write lock so it never writes after a sign-out.
 */
let clearRequests = 0;

export function noteSessionClearRequested(): void {
  clearRequests += 1;
}

export function getSessionClearRequests(): number {
  return clearRequests;
}
