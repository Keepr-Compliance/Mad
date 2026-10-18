/**
 * Map public_validate_invitation_token's JSONB to the invite landing page's shape.
 *
 * BACKLOG-3851 PR-2f: 'licensed' and 'first_name' are new keys (M4). A database
 * without M4 answers without them, so a missing 'licensed' means licensed: only
 * licensed === false shows the "without a license" line.
 */

const ROLE_LABELS: Record<string, string> = {
  agent: 'Agent',
  broker: 'Broker',
  admin: 'Admin',
  it_admin: 'IT Admin',
};

export interface ValidateInvitationRpcResult {
  valid: boolean;
  error?: string;
  email?: string;
  org_name?: string;
  role?: string;
  licensed?: boolean;
  first_name?: string | null;
}

export interface InviteLandingInfo {
  valid: true;
  email?: string;
  orgName?: string;
  role?: string;
  licensed: boolean;
  firstName: string | null;
}

export function mapValidInvitation(result: ValidateInvitationRpcResult): InviteLandingInfo {
  return {
    valid: true,
    email: result.email,
    orgName: result.org_name,
    role: ROLE_LABELS[result.role ?? ''] || result.role,
    licensed: result.licensed !== false,
    firstName: result.first_name?.trim() || null,
  };
}

/** Shown on the landing page and in the invite email for an invitation without a license. */
export const UNLICENSED_INVITE_LINE = "You'll join without a license until your admin assigns one.";
