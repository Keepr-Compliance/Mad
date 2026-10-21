/**
 * Billing step copy and constants — BACKLOG-4007 PR-3. Shared by the server action and the page
 * (no server-only imports here).
 */

/** The Terms link the login page already uses (founder 591d68aa). */
export const TERMS_URL = 'https://keeprcompliance.com/terms';
/** Recorded with every acceptance (org_terms_acceptances.terms_version). */
export const TERMS_VERSION = 'keepr-terms-2026-10';

/** BACKLOG-4007: the invite trigger's refusal while billing setup is unfinished (founder e4d40740 Q3). */
export const BILLING_SETUP_INCOMPLETE_ERROR = 'Finish the Billing step of your account setup before inviting people.';

const MESSAGES: Record<string, string> = {
  terms_not_accepted: 'Agree to the Terms of Service and this order to continue.',
  version_conflict: 'Your Keepr account manager changed this order. Review the new details and confirm again.',
  not_waiting: 'Billing setup is already complete.',
  account_suspended: 'This account is suspended. Contact your Keepr account manager.',
  invalid_phone: 'Enter a valid phone number for the billing contact.',
  contact_name_required: "Enter the billing contact's name.",
  contact_email_required: "Enter the billing contact's email.",
  invalid_contact: 'Choose who receives the invoices.',
  company_name_required: 'Enter the legal company name.',
  billing_address_required: 'Enter the full billing address. A state is required for US addresses.',
  billing_not_live: 'Billing is not available yet. Contact your Keepr account manager.',
  no_deal: 'There is no order to confirm yet. Contact your Keepr account manager.',
  no_price: 'This order has no price yet. Contact your Keepr account manager.',
  invalid_terms: 'Something went wrong. Please try again.',
  not_authenticated: 'Your session ended. Sign in again.',
  not_authorized: 'Only a broker or admin of this brokerage can finish billing setup.',
  // BACKLOG-4007 People v2: "Someone else" who is not a member gets the billing-only login; a
  // refusal stops setup (PM c7c276be item 4). has_personal_account is the founder's sentence (b7f3cefe).
  has_personal_account: 'This person already has their own Keepr account. Pick another billing contact or invite them as a member.',
  duplicate_invitation: 'This email already has an open invitation to Keepr. Pick another billing contact.',
  user_in_other_brokerage: 'This person belongs to another brokerage. Pick another billing contact.',
  already_member: 'This person is already a member of your brokerage.',
};

export function billingSetupErrorMessage(code: string): string {
  return MESSAGES[code] ?? 'Something went wrong. Please try again.';
}

/** "$24.99" from cents. */
export function formatCents(cents: number | null | undefined): string {
  if (typeof cents !== 'number') return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

/** "October 30, 2026" from a date-only "2026-10-30", never shifted by the viewer's time zone. */
export function formatDateOnly(d: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? '');
  if (!m) return '—';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
