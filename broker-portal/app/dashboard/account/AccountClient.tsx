'use client';

/**
 * My Account — the interactive half of /dashboard/account. BACKLOG-3078.
 *
 * Session Management lives here and nowhere else. ActiveSessionsList documents
 * itself as "devices where the user is currently logged in" and
 * SignOutAllButton signs THAT PERSON out everywhere, so both belong on a
 * personal surface rather than beside SCIM tokens and org retention policy.
 *
 * BACKLOG-3079 adds the identity card and the person's saved desktop
 * preferences to this page.
 */

import { SignOutAllButton } from '@/components/SignOutAllButton';
import { ActiveSessionsList } from '@/components/ActiveSessionsList';
import { useImpersonation } from '@/components/providers/ImpersonationProvider';
// Card family/PageHeader are Tier-2 (no @keepr/ui equivalent yet).
import { Card, CardContent, CardHeader, PageHeader } from '@keepr/design-system';
import { AlertBanner } from '@keepr/ui';

export default function AccountClient() {
  const { isImpersonating } = useImpersonation();

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="My Account"
        subtitle="Your Keepr account and the devices you are signed in on"
      />

      {isImpersonating && (
        <AlertBanner variant="warning">Read-only during support session</AlertBanner>
      )}

      {/* Session Management — moved from org settings by BACKLOG-3078. */}
      <Card padding="none">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">
            Session Management
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            View active sessions and manage device access
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <ActiveSessionsList />

          {/* Sign Out All Devices (hidden during impersonation: a support
              session must never be able to sign the customer out). */}
          {!isImpersonating && (
            <div className="pt-4 border-t border-gray-200">
              <p className="text-sm text-gray-700 mb-3">
                Sign out of all devices, including desktop apps and other browser sessions.
              </p>
              <SignOutAllButton />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
