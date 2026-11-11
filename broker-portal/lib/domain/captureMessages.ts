/**
 * Messages and result type of the domain capture actions (lib/actions/domainCapture.ts) —
 * BACKLOG-3962 PR3a. Kept out of the 'use server' file, which may export only async functions.
 */

export const DOMAIN_CAPTURE_UNAVAILABLE = 'Moving accounts by domain is not available yet. Try again later.';
export const DOMAIN_CAPTURE_FAILED = 'Something went wrong. Nothing was changed. Try again.';
export const DOMAIN_CAPTURE_NOT_AUTHORIZED = 'Only an admin of this brokerage can do this.';
export const DOMAIN_CAPTURE_NOT_VERIFIED = 'This domain is not verified, so no accounts can be moved.';
export const DOMAIN_CAPTURE_NOT_FOUND = 'That scheduled move was not found.';
export const DOMAIN_CAPTURE_NOT_SCHEDULED = 'That move is no longer scheduled.';
export const DOMAIN_CAPTURE_BILLING_NOT_READY = 'Moving accounts is not available yet. Try again later.';
export const DOMAIN_CAPTURE_BILLING_SETUP = 'Finish the Billing step for this brokerage first, then move accounts.';
export const DOMAIN_CAPTURE_CONFIRM = 'Confirm that you want to keep your account separate.';
export const DOMAIN_CAPTURE_TOO_LATE = 'The move has already started, so it can no longer be stopped here.';
export const DOMAIN_CAPTURE_SIGNED_OUT = 'Sign in to opt out.';

export interface DomainCaptureActionResult {
  success: boolean;
  message: string;
  scheduled?: number;
  noticesSent?: number;
  noticesQueued?: number;
  noticesUndelivered?: number;
  skipped?: Array<{ user_id: string; reason: string }>;
}
