/**
 * Email Connect-Failed Events Utility (BACKLOG-3281)
 *
 * Lightweight renderer event bus for reporting that a mailbox-connect attempt
 * ENDED IN FAILURE. Without it the onboarding EmailConnectStep has no terminal
 * signal for a failed attempt: it clears its "Connecting..." state only on
 * `context.emailConnected === true` or on an admin-consent block, so every
 * other outcome leaves the Connect button spinning and disabled forever.
 *
 * Two producers in `useEmailHandlers`, both terminal for the flow:
 *  - the pre-flight IPC result resolving `success: false` (the flow never
 *    started, so no mailbox-connected event will ever arrive), and
 *  - a `${provider}:mailbox-connected` event carrying `success: false`.
 *
 * Deliberately NOT a `finally`: `googleConnectMailbox` resolves as soon as the
 * browser is opened, long before the user consents, so a `finally` would clear
 * the spinner while the flow is still legitimately in progress.
 *
 * Mirrors emailAdminConsentEvents (BACKLOG-2007), which mirrors
 * emailConnectionEvents (TASK-1730).
 *
 * @module utils/emailConnectFailedEvents
 */

import { useEffect, useCallback } from "react";

/** Event name constant for type safety and consistency. */
export const EMAIL_CONNECT_FAILED = "email-connect-failed";

/**
 * Payload describing a mailbox-connect attempt that ended in failure.
 */
export interface EmailConnectFailedEventDetail {
  /** The provider whose connect attempt failed. */
  provider: "google" | "microsoft";
  /** The raw provider/main-process error message (for display and support). */
  error?: string;
}

/**
 * Emit a connect-failed event. Call this when a mailbox-connect attempt has
 * terminated without connecting — and only then, never merely because the
 * awaited IPC call returned.
 *
 * @param detail - provider + optional raw error
 */
export function emitEmailConnectFailed(
  detail: EmailConnectFailedEventDetail,
): void {
  window.dispatchEvent(
    new CustomEvent<EmailConnectFailedEventDetail>(EMAIL_CONNECT_FAILED, {
      detail,
    }),
  );
}

/**
 * React hook to listen for connect-failed events. Handles cleanup on unmount.
 *
 * @param callback - called with the failure detail when an event fires
 */
export function useEmailConnectFailedListener(
  callback: (detail: EmailConnectFailedEventDetail) => void,
): void {
  const handleEvent = useCallback(
    (event: Event) => {
      const customEvent = event as CustomEvent<EmailConnectFailedEventDetail>;
      callback(customEvent.detail);
    },
    [callback],
  );

  useEffect(() => {
    window.addEventListener(EMAIL_CONNECT_FAILED, handleEvent);
    return () => {
      window.removeEventListener(EMAIL_CONNECT_FAILED, handleEvent);
    };
  }, [handleEvent]);
}
