/**
 * UserProfileCard - Displays user profile information
 *
 * Shows name, email, avatar, auth provider, and key dates.
 * Includes suspend/unsuspend action button via SuspendDialog client component.
 */

import { Card } from '@keepr/design-system';
import { SuspendDialog } from './SuspendDialog';
import { ImpersonateButton } from './ImpersonateButton';
import { formatTimestamp } from '@/lib/format';

interface UserProfile {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  oauth_provider: string | null;
  status: string | null;
  subscription_tier: string | null;
  created_at: string;
  last_login_at: string | null;
}

function getInitials(name: string | null, email: string | null): string {
  if (name) {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  if (email) {
    return email[0].toUpperCase();
  }
  return '?';
}

interface UserProfileCardProps {
  user: UserProfile;
  canImpersonate?: boolean;
  isOwnProfile?: boolean;
}

export function UserProfileCard({ user, canImpersonate = false, isOwnProfile = false }: UserProfileCardProps) {
  const displayName = user.display_name || user.email || 'Unknown User';
  const initials = getInitials(user.display_name, user.email);

  return (
    <Card>
      <div className="flex items-start gap-4">
        {/* Avatar */}
        {user.avatar_url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={user.avatar_url}
            alt={displayName}
            className="h-16 w-16 rounded-full object-cover"
          />
        ) : (
          <div className="h-16 w-16 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center text-xl font-semibold">
            {initials}
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-bold text-gray-900 truncate">
              {displayName}
            </h2>
            <div className="flex items-center gap-2">
              {canImpersonate && user.status !== 'suspended' && user.status !== 'banned' && (
                <ImpersonateButton
                  userId={user.id}
                  userName={displayName}
                  isOwnProfile={isOwnProfile}
                />
              )}
              <SuspendDialog
                userId={user.id}
                userName={displayName}
                isSuspended={user.status === 'suspended'}
              />
            </div>
          </div>
          {user.email && (
            <p className="text-sm text-gray-500 truncate">{user.email}</p>
          )}

          {/* Provider badge */}
          {user.oauth_provider && (
            <span className="mt-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
              {user.oauth_provider}
            </span>
          )}
        </div>
      </div>

      {/* Dates grid */}
      <dl className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Created
          </dt>
          <dd className="mt-1 text-sm text-gray-900">
            {formatTimestamp(user.created_at, 'Never')}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Last Sign In
          </dt>
          <dd className="mt-1 text-sm text-gray-900">
            {formatTimestamp(user.last_login_at, 'Never')}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Status
          </dt>
          <dd className="mt-1 text-sm text-gray-900">
            {user.status || 'active'}
          </dd>
        </div>
      </dl>

      {/* User ID (monospace, for quick copy) */}
      <div className="mt-4 pt-4 border-t border-gray-100">
        <span className="text-xs text-gray-400">ID: </span>
        <code className="text-xs text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded">
          {user.id}
        </code>
      </div>
    </Card>
  );
}
