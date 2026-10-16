'use server';

/**
 * Member licence actions — BACKLOG-3851 PR-2b.
 *
 * Assign, unassign or reactivate one member's brokerage licence through the
 * database function set_member_license. The function decides on the caller's
 * own session (auth.uid()), so it MUST be called on the user client: a service
 * client has no auth.uid() and every call would be refused.
 *
 * Order (same shape as deactivateUser.ts): impersonation block, user session,
 * target row, the caller's own admin / it_admin right in the TARGET's
 * organization (requireActiveOrgRole), then the function, which re-checks
 * everything under the organization lock.
 */

import * as Sentry from '@sentry/nextjs';
import { createClient } from '@/lib/supabase/server';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';
import { MEMBER_LICENSE_ERRORS } from '@/lib/users/memberLicenseActions';
import type { MemberLicenseAction } from '@/lib/users/memberLicenseActions';

interface SetMemberLicenseInput {
  memberId: string;
  action: MemberLicenseAction;
}

export interface SetMemberLicenseResult {
  success: boolean;
  licenseStatus?: string;
  /** The organization has no free licence: show the out-of-licenses prompt. */
  outOfSeats?: boolean;
  error?: string;
}

const ACTIONS: readonly MemberLicenseAction[] = ['assign', 'unassign', 'reactivate'];

export async function setMemberLicense(input: SetMemberLicenseInput): Promise<SetMemberLicenseResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { success: false, error: blocked.error };

  if (!ACTIONS.includes(input.action)) {
    return { success: false, error: MEMBER_LICENSE_ERRORS.invalidTransition };
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: MEMBER_LICENSE_ERRORS.notAuthenticated };

  const { data: target } = await supabase
    .from('organization_members')
    .select('id, user_id, role, organization_id, license_status')
    .eq('id', input.memberId)
    .single();

  if (!target) return { success: false, error: MEMBER_LICENSE_ERRORS.notFound };

  const membership = await requireActiveOrgRole(supabase, user.id, target.organization_id, ['admin', 'it_admin']);
  if (!membership.ok) return { success: false, error: MEMBER_LICENSE_ERRORS.notAuthorized };

  const { data, error } = await supabase.rpc('set_member_license', {
    p_member_id: input.memberId,
    p_action: input.action,
  });

  if (error) {
    Sentry.captureException(error, {
      tags: { action: 'set_member_license' },
      extra: { memberId: input.memberId, licenseAction: input.action },
    });
    return { success: false, error: MEMBER_LICENSE_ERRORS.failed };
  }

  return mapSetMemberLicenseResult(data, input);
}

/** The function's jsonb reply -> the portal's result. Expected refusals are not sent to Sentry. */
function mapSetMemberLicenseResult(data: unknown, input: SetMemberLicenseInput): SetMemberLicenseResult {
  const reply = (data && typeof data === 'object' ? data : null) as {
    success?: unknown;
    error?: unknown;
    license_status?: unknown;
  } | null;

  if (reply?.success === true && typeof reply.license_status === 'string') {
    return { success: true, licenseStatus: reply.license_status };
  }

  switch (reply?.error) {
    case 'seat_limit_reached':
      return { success: false, outOfSeats: true };
    // Unemittable from this action today (the caller is itself a manager and is
    // not the target); kept as a defensive mapping.
    case 'last_manager':
      return { success: false, error: MEMBER_LICENSE_ERRORS.lastManager };
    case 'not_authorized':
      return { success: false, error: MEMBER_LICENSE_ERRORS.notAuthorized };
    case 'invalid_transition':
      return { success: false, error: MEMBER_LICENSE_ERRORS.invalidTransition };
    default:
      Sentry.captureMessage('set_member_license returned an unexpected reply', {
        level: 'error',
        extra: { memberId: input.memberId, licenseAction: input.action },
      });
      return { success: false, error: MEMBER_LICENSE_ERRORS.failed };
  }
}
