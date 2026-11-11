/**
 * A mailbox-connect attempt that a newer attempt replaced (BACKLOG-3283, Path 3).
 *
 * `startLocalServer()` closes any running callback server before it starts a new
 * one. It now also rejects the old attempt's `codePromise` with this error, so the
 * old attempt's background task ends instead of waiting forever.
 *
 * The handlers must stay SILENT on this error. The renderer's
 * `onMailboxConnected` listeners are per provider, not per attempt: a
 * `{ success: false }` push from the old attempt would be read by the new
 * attempt's listener as its own failure and clear its spinner mid-flight.
 *
 * @module electron/services/authAttemptSuperseded
 */
export class AuthAttemptSupersededError extends Error {
  constructor() {
    super("Mailbox connect attempt superseded by a newer attempt");
    this.name = "AuthAttemptSupersededError";
  }
}

export function isAuthAttemptSuperseded(error: unknown): error is AuthAttemptSupersededError {
  return error instanceof AuthAttemptSupersededError;
}
