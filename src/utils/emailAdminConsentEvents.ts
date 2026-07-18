/**
 * Email Admin-Consent Events Utility (BACKLOG-2007)
 *
 * Lightweight renderer event bus for surfacing an organization admin-consent
 * block detected during an email-connect attempt. The main process classifies
 * the OAuth failure (Microsoft AADSTS admin-consent codes) and reports it via
 * the mailbox-connected IPC result; `useEmailHandlers` re-emits it as a window
 * event so the onboarding EmailConnectStep can render a "Request IT approval"
 * flow — without threading admin-consent state through the onboarding state
 * machine.
 *
 * Mirrors the emailConnectionEvents pattern (TASK-1730).
 *
 * @module utils/emailAdminConsentEvents
 */

import { useEffect, useCallback } from "react";

/** Event name constant for type safety and consistency. */
export const EMAIL_ADMIN_CONSENT_BLOCKED = "email-admin-consent-blocked";

/**
 * Payload describing a detected admin-consent block.
 */
export interface EmailAdminConsentEventDetail {
  /** The provider whose connect attempt was blocked. */
  provider: "google" | "microsoft";
  /** The raw provider error message (for logging / support). */
  error?: string;
}

/**
 * Emit an admin-consent-blocked event. Call this when a mailbox-connect attempt
 * failed because the org tenant admin has not consented to the application.
 *
 * @param detail - provider + optional raw error
 */
export function emitEmailAdminConsentBlocked(
  detail: EmailAdminConsentEventDetail,
): void {
  window.dispatchEvent(
    new CustomEvent<EmailAdminConsentEventDetail>(EMAIL_ADMIN_CONSENT_BLOCKED, {
      detail,
    }),
  );
}

/**
 * React hook to listen for admin-consent-blocked events. Handles cleanup on
 * unmount.
 *
 * @param callback - called with the block detail when an event fires
 */
export function useEmailAdminConsentListener(
  callback: (detail: EmailAdminConsentEventDetail) => void,
): void {
  const handleEvent = useCallback(
    (event: Event) => {
      const customEvent = event as CustomEvent<EmailAdminConsentEventDetail>;
      callback(customEvent.detail);
    },
    [callback],
  );

  useEffect(() => {
    window.addEventListener(EMAIL_ADMIN_CONSENT_BLOCKED, handleEvent);
    return () => {
      window.removeEventListener(EMAIL_ADMIN_CONSENT_BLOCKED, handleEvent);
    };
  }, [handleEvent]);
}
