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

// "Join now" (joinNowSelf).
export const DOMAIN_CAPTURE_JOIN_CONFIRM = 'Confirm that you want to join now.';
export const DOMAIN_CAPTURE_JOIN_SIGNED_OUT = 'Sign in to continue.';
export const DOMAIN_CAPTURE_JOIN_CANCELLED = 'This move can no longer happen, so your account stays personal.';
export const DOMAIN_CAPTURE_JOIN_OPTED_OUT = 'You chose to keep your personal account.';
export const DOMAIN_CAPTURE_JOIN_MOVE_CANCELLED = 'This move was cancelled. Your account stays personal.';

/**
 * Plain words for a "Join now" that did not go through. Codes are runCaptureJoinNow's
 * (lib/domain/captureJoinNow.ts): the _domain_capture_join_now / _domain_capture_switch errors,
 * plus 'cancelled', 'unavailable' and 'failed'. Every deferral says nothing changed.
 */
export function joinNowErrorMessage(code: string, brokerageName: string, dateText: string, rowStatus?: string): string {
  switch (code) {
    case 'dns_not_fresh':
      return `Keepr couldn't confirm ${brokerageName}'s domain just now. Nothing changed. Try again in a few minutes.`;
    case 'billing_not_ready':
      return `Joining early isn't available yet. Nothing changed. Your move is still set for ${dateText}.`;
    case 'billing_setup_incomplete':
      return `${brokerageName} hasn't finished setting up billing, so you can't join yet. Nothing changed.`;
    case 'not_scheduled':
      if (rowStatus === 'opted_out') return DOMAIN_CAPTURE_JOIN_OPTED_OUT;
      if (rowStatus === 'switched') return `Your account is already part of ${brokerageName}.`;
      if (rowStatus === 'cancelled') return DOMAIN_CAPTURE_JOIN_MOVE_CANCELLED;
      return DOMAIN_CAPTURE_NOT_SCHEDULED;
    case 'cancelled':
      return DOMAIN_CAPTURE_JOIN_CANCELLED;
    case 'switch_not_found':
      return DOMAIN_CAPTURE_NOT_FOUND;
    case 'unavailable':
      return DOMAIN_CAPTURE_UNAVAILABLE;
    default:
      return DOMAIN_CAPTURE_FAILED;
  }
}

export interface DomainCaptureActionResult {
  success: boolean;
  message: string;
  /** joinNowSelf: the person is now a member of the brokerage */
  joined?: boolean;
  /** joinNowSelf: joined with a license (a free seat existed) */
  licensed?: boolean;
  /** joinNowSelf: the brokerage's name, for the success state */
  brokerageName?: string;
  scheduled?: number;
  noticesSent?: number;
  noticesQueued?: number;
  noticesUndelivered?: number;
  skipped?: Array<{ user_id: string; reason: string }>;
}
