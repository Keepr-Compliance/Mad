'use server';

/**
 * Member name edit — BACKLOG-3991.
 *
 * An admin or it_admin edits another member's first and last name through the
 * database function set_member_name. The function decides on the caller's own
 * session (auth.uid()), so it MUST be called on the user client: a service client
 * has no auth.uid() and every call would be refused.
 *
 * Order (same shape as memberLicense.ts): impersonation block, input check, user
 * session, target row, the caller's own admin / it_admin right in the TARGET's
 * organization (requireActiveOrgRole), then the function, which re-checks
 * everything under the organization lock, including whether the brokerage manages
 * users by hand (no JIT, SCIM or directory sync).
 */

import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/server';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';
import { MEMBER_NAME_ERRORS, memberNameInputError, normaliseMemberName } from '@/lib/users/memberName';

interface SetMemberNameInput {
  memberId: string;
  firstName: string;
  lastName: string;
}

export interface SetMemberNameResult {
  success: boolean;
  displayName?: string;
  error?: string;
}

export async function setMemberName(input: SetMemberNameInput): Promise<SetMemberNameResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { success: false, error: blocked.error };

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: MEMBER_NAME_ERRORS.notAuthenticated };

  const { data: target } = await supabase
    .from('organization_members')
    .select('id, organization_id')
    .eq('id', input.memberId)
    .single();
  if (!target) return { success: false, error: MEMBER_NAME_ERRORS.notFound };

  const membership = await requireActiveOrgRole(supabase, user.id, target.organization_id, ['admin', 'it_admin']);
  if (!membership.ok) return { success: false, error: MEMBER_NAME_ERRORS.notAuthorized };

  const firstName = typeof input.firstName === 'string' ? input.firstName : '';
  const lastName = typeof input.lastName === 'string' ? input.lastName : '';
  const inputError = memberNameInputError(firstName, lastName);
  if (inputError) return { success: false, error: inputError };

  const { data, error } = await supabase.rpc('set_member_name', {
    p_member_id: input.memberId,
    p_first: normaliseMemberName(firstName),
    p_last: normaliseMemberName(lastName),
  });

  if (error) {
    Sentry.captureException(error, { tags: { action: 'set_member_name' }, extra: { memberId: input.memberId } });
    return { success: false, error: MEMBER_NAME_ERRORS.failed };
  }

  const reply = (data && typeof data === 'object' ? data : null) as {
    success?: unknown;
    error?: unknown;
    display_name?: unknown;
  } | null;

  if (reply?.success === true) {
    return { success: true, displayName: typeof reply.display_name === 'string' ? reply.display_name : undefined };
  }

  switch (reply?.error) {
    case 'directory_managed':
      return { success: false, error: MEMBER_NAME_ERRORS.directoryManaged };
    case 'invalid_name':
      return { success: false, error: MEMBER_NAME_ERRORS.invalidName };
    case 'not_authorized':
    case 'own_membership':
    case 'invalid_target':
      return { success: false, error: MEMBER_NAME_ERRORS.refused };
    default:
      Sentry.captureMessage('set_member_name returned an unexpected reply', {
        level: 'error',
        extra: { memberId: input.memberId },
      });
      return { success: false, error: MEMBER_NAME_ERRORS.failed };
  }
}
