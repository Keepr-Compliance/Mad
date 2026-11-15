/**
 * Plain-words copy for the domain capture screens — BACKLOG-3962 PR3b.
 *
 * Reason codes come from public._domain_capture_eval (as `no:<code>`, returned without the prefix by
 * domain_capture_candidates and in domain_capture_start's `skipped`) plus `already_scheduled` from
 * domain_capture_start. Switch reasons are the domain_capture_switches reason CHECK.
 */

/** Why a person cannot be moved automatically. Every code the database can return is listed. */
export const CAPTURE_REASON_COPY: Record<string, string> = {
  no_user: 'This sign-in account no longer exists.',
  email_domain: 'Their email address is not on this domain.',
  not_personal: 'They do not have a personal Keepr account.',
  brokerage_member: 'They already belong to a brokerage on Keepr.',
  no_tenant:
    'They sign in with Microsoft, and this brokerage has no Microsoft directory connected, so Keepr cannot confirm the account is yours.',
  foreign_tenant: 'They sign in with a Microsoft account from a different organization.',
  no_attestation:
    'Only the email address matches. Keepr cannot confirm they sign in through your domain, so invite them instead.',
  already_scheduled: 'A move is already scheduled for them.',
  opted_out: 'They chose to keep their personal account, so they will not be moved.',
};

export const CAPTURE_REASON_FALLBACK = 'Keepr cannot move this account automatically.';

export function captureReasonCopy(code: string | null | undefined): string {
  if (!code) return CAPTURE_REASON_FALLBACK;
  return CAPTURE_REASON_COPY[code] ?? CAPTURE_REASON_FALLBACK;
}

/** Label for a switch that has ended (status other than scheduled), by reason then status. */
export const CAPTURE_ENDED_REASON_LABEL: Record<string, string> = {
  opted_out: 'Opted out',
  admin_cancelled: 'Cancelled by an admin',
  notice_undelivered: 'Cancelled — notice not delivered',
  claim_withdrawn: 'Cancelled — domain removed',
  claim_revoked: 'Cancelled — domain revoked by Keepr support',
  claim_lapsed: 'Cancelled — domain verification lapsed',
  claim_not_verified: 'Cancelled — domain not verified',
  not_eligible: 'Cancelled — no longer eligible',
  switch_error: 'Cancelled — the move failed',
  brokerage_suspended: 'Cancelled — brokerage suspended',
};

export function captureEndedLabel(status: string, reason: string | null | undefined): string {
  if (status === 'switched') return 'Switched';
  if (status === 'opted_out') return 'Opted out';
  if (status === 'failed') return 'The move failed';
  if (reason && CAPTURE_ENDED_REASON_LABEL[reason]) return CAPTURE_ENDED_REASON_LABEL[reason];
  return 'Cancelled';
}

export const CAPTURE_SECTION_TITLE = 'Move people onto your brokerage';
export const CAPTURE_SECTION_INTRO =
  'These people have a personal Keepr account on your verified domain. When you start a move, each one gets an email today and joins your brokerage in 14 days. Each can opt out until then.';
export const CAPTURE_CAN_MOVE = 'Can move';
export const CAPTURE_CANNOT_MOVE = "Can't move automatically";
export const CAPTURE_EMPTY_TITLE = 'Nobody to move';
export const CAPTURE_EMPTY_DESCRIPTION = 'No personal Keepr accounts use this domain.';
/** A scheduled move past its date, by the reason the hourly job last put it off. */
export const CAPTURE_DEFER_LABEL: Record<string, string> = {
  billing_not_ready: 'Waiting on billing setup',
  billing_setup_incomplete: 'Waiting on billing setup',
  dns_not_fresh: 'Waiting on DNS re-check',
};
export const CAPTURE_WAITING_LABEL = 'Waiting to move';
export function captureDeferLabel(reason: string | null | undefined): string {
  return (reason && CAPTURE_DEFER_LABEL[reason]) || CAPTURE_WAITING_LABEL;
}
export const CAPTURE_DEFER_DETAIL: Record<string, string> = {
  billing_not_ready: 'Moving accounts is not available yet. It runs on its own once it is.',
  billing_setup_incomplete: 'Finish the Billing step for this brokerage. The move runs on its own after that.',
  dns_not_fresh: "Keepr could not re-check your domain's DNS record. It tries again every hour.",
};
export const CAPTURE_LOAD_FAILED = 'The list of people could not be loaded. Try again later.';

export function captureScheduledLabel(dateText: string): string {
  return `Scheduled for ${dateText}`;
}

export const CAPTURE_NOTICE_RETRYING = 'The notice email is being retried.';

export function captureStartConfirmText(count: number, dateText: string): string {
  if (count === 1) return `This person gets an email today and moves on ${dateText}. They can opt out until then.`;
  return `These ${count} people get an email today and move on ${dateText}. Each can opt out until then.`;
}

export const CAPTURE_CANCEL_CONFIRM = 'Cancel this move? The person stays on their personal account.';

/** The personal-owner banner. */
export function captureBannerText(brokerageName: string, dateText: string): string {
  return `${brokerageName} will move your Keepr account on ${dateText}, or sooner if you join now.`;
}
export const CAPTURE_JOIN_BUTTON = 'Join now';
export function captureJoinConfirmTitle(brokerageName: string): string {
  return `Join ${brokerageName} now?`;
}
export function captureJoinConfirmText(brokerageName: string): string {
  return `Your account moves into ${brokerageName} now, and any personal Keepr plan on it ends. ${brokerageName} will manage this account. ${brokerageName} may need to assign you a license.`;
}
export function captureJoinDoneText(brokerageName: string): string {
  return `Your account is now part of ${brokerageName}.`;
}
export function captureJoinNoSeatText(brokerageName: string): string {
  return `${brokerageName} has no free license yet. An admin there can assign you one.`;
}
export const CAPTURE_JOIN_CONTINUE = 'Continue';
export const CAPTURE_BANNER_DETAIL =
  'After the move, the brokerage will manage this account and can end your access to it. If you keep your personal account, it stays separate and stays on your own plan.';
export const CAPTURE_KEEP_BUTTON = 'Keep my personal account';
export const CAPTURE_KEEP_CONFIRM_TITLE = 'Keep your personal account?';
export function captureKeepConfirmText(brokerageName: string): string {
  return `Your account will not move into ${brokerageName}. You can't undo this here.`;
}
export const CAPTURE_KEEP_DONE = "You'll keep your personal account.";

// switch_at is a UTC instant. Dates are shown in UTC with a fixed locale so the server render and
// the browser render of the same instant are identical (toLocaleDateString() uses each side's own
// time zone and locale, which breaks hydration near midnight).
const CAPTURE_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
export function formatCaptureDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : CAPTURE_DATE_FORMAT.format(d);
}
