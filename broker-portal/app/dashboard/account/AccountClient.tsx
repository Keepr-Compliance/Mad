'use client';

/**
 * My Account — BACKLOG-3078 (the page and Session Management) and
 * BACKLOG-3079 (the identity card and the saved settings).
 *
 * Everything here is READ-ONLY and says so. The desktop app is the source of
 * truth for these values; a second writer would be a second source of truth,
 * and this page exists so a person — and Keepr support, through impersonation —
 * can SEE what is stored, which today is possible nowhere except the desktop.
 */

import { SignOutAllButton } from '@/components/SignOutAllButton';
import { ActiveSessionsList } from '@/components/ActiveSessionsList';
import { useImpersonation } from '@/components/providers/ImpersonationProvider';
import { groupPreferences } from '@/lib/account/preferenceLabels';
// From accountView, NOT getAccountView: that module imports the server-only
// Supabase client, and pulling it into a client component fails `next build`.
import { providerDisplayName, type AccountView } from '@/lib/account/accountView';
// Badge/Card family/PageHeader are Tier-2 (no @keepr/ui equivalent yet).
import { Badge, Card, CardContent, CardHeader, PageHeader } from '@keepr/design-system';
import { AlertBanner } from '@keepr/ui';

export interface AccountClientProps {
  account: AccountView | null;
}

function formatRole(role: string | null): string | null {
  if (!role) return null;
  return role
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-600">{label}</span>
      <span className="text-sm text-gray-900 text-right break-words">{value}</span>
    </div>
  );
}

export default function AccountClient({ account }: AccountClientProps) {
  const { isImpersonating } = useImpersonation();

  const identity = account?.identity ?? null;
  const provider = providerDisplayName(identity?.authProvider ?? null);
  const name = identity?.displayName || 'User';
  const initial = (identity?.displayName || identity?.email || '?')
    .charAt(0)
    .toUpperCase();

  const sections = account?.preferences ? groupPreferences(account.preferences) : [];
  const hasPreferences = sections.length > 0;
  /** null/undefined means NO user_preferences row; {} means a row with nothing
   *  in it. The two get different empty states, so they are separated here
   *  rather than collapsed into one falsy check. */
  const hasPreferencesRow = Boolean(account?.preferences);
  const orgRetentionYears =
    typeof account?.orgRetentionYears === 'number' ? account.orgRetentionYears : null;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="My Account"
        subtitle="Your Keepr account, your saved settings, and the devices you are signed in on"
      />

      {isImpersonating && (
        <AlertBanner variant="warning">Read-only during support session</AlertBanner>
      )}

      {/* Account information — mirrors the desktop app's Account panel so the
          two surfaces describe the same account in the same words. */}
      <Card padding="none">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Account</h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-full bg-primary-600 flex items-center justify-center text-white text-xl font-semibold shrink-0">
              {initial}
            </div>
            <div className="min-w-0">
              <p className="text-base font-semibold text-gray-900 truncate">{name}</p>
              {identity?.email && (
                <p className="text-sm text-gray-600 truncate">{identity.email}</p>
              )}
            </div>
          </div>

          {provider && (
            <div>
              <Badge hue="blue">Signed in with {provider}</Badge>
            </div>
          )}

          <div>
            {formatRole(identity?.role ?? null) && (
              <DetailRow label="Role" value={formatRole(identity!.role)!} />
            )}
            {identity?.organizationName && (
              <DetailRow label="Organization" value={identity.organizationName} />
            )}
            {identity?.userId && <DetailRow label="User ID" value={identity.userId} />}
            {identity?.createdAt && (
              <DetailRow
                label="Member Since"
                value={new Date(identity.createdAt).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Email retention policy set by the brokerage.
          Stated as a fact about the organization and NOTHING MORE. The org
          settings page claims this "overrides individual settings in the
          desktop app", but no desktop code reads organizations.retention_years
          — the column appears in the desktop tree only as a type field
          (shared/types/submissions.ts). Repeating the override claim here would
          be the same false promise one surface further out. Filed on the item. */}
      {orgRetentionYears !== null && (
        <Card padding="none">
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">
              Email Retention Policy
            </h2>
            <p className="mt-1 text-sm text-gray-500">Set by your brokerage</p>
          </CardHeader>
          <CardContent>
            <DetailRow
              label="Retain emails for"
              value={`${orgRetentionYears} year${orgRetentionYears === 1 ? '' : 's'}`}
            />
          </CardContent>
        </Card>
      )}

      {/* Saved desktop settings, read-only. */}
      <Card padding="none">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Desktop App Settings</h2>
          <p className="mt-1 text-sm text-gray-500">
            {account?.preferencesUpdatedAt
              ? `Changed in the desktop app. Last updated ${new Date(
                  account.preferencesUpdatedAt
                ).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}.`
              : 'Changed in the desktop app.'}
          </p>
        </CardHeader>
        <CardContent>
          {!hasPreferencesRow ? (
            <p className="text-sm text-gray-500">
              No settings saved yet. They appear here once you have used the desktop app.
            </p>
          ) : !hasPreferences ? (
            <p className="text-sm text-gray-500">
              No settings saved yet. Everything is on its default.
            </p>
          ) : (
            <div className="space-y-6">
              {sections.map((section) => (
                <div key={section.group}>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">
                    {section.group}
                  </h3>
                  <div>
                    {section.rows.map((row) => (
                      <DetailRow key={row.path} label={row.label} value={row.display} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Session Management — moved from org settings by BACKLOG-3078. */}
      <Card padding="none">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Session Management</h2>
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
