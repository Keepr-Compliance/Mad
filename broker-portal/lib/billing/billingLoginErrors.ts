/** BACKLOG-4007 PR-4: words for the billing-only login's refusals. Client-safe (no imports). */

/** One sentence for each refusal the database can return when the login is not created. */
export function billingLoginErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'already_member':
      return 'This person already has a login in your brokerage.';
    case 'duplicate_invitation':
      return 'This email already has an open invitation to Keepr.';
    case 'user_in_other_brokerage':
      return 'This person belongs to another brokerage.';
    case 'has_personal_account':
      return 'This person already has their own Keepr account. Pick another billing contact or invite them as a member.';
    case 'billing_login_exists':
      return 'Your brokerage already has a billing-only login.';
    case 'account_suspended':
      return 'Your brokerage account is suspended.';
    case 'billing_setup_incomplete':
      return 'Finish the Billing step first.';
    case 'no_billing_contact':
      return 'Add a billing contact first.';
    default:
      return 'The billing-only login could not be created.';
  }
}
