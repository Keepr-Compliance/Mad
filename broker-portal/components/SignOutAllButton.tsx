'use client';

/**
 * TASK-2062: Sign Out All Devices button with confirmation dialog.
 * Shows a confirmation prompt before executing global sign-out.
 */

import { useState } from 'react';
// Button kept on design-system: uses `dangerOutline`, which @keepr/ui lacks (Tier-2).
import { Button } from '@keepr/design-system';
import { AlertBanner } from '@keepr/ui';
import { signOutAllDevices } from '@/lib/actions/signOutAllDevices';

export function SignOutAllButton() {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await signOutAllDevices();
      // If we get here (no redirect), something went wrong
      if (!result.success) {
        setError(result.error || 'Failed to sign out of all devices');
        setConfirming(false);
      }
    } catch {
      // signOutAllDevices calls redirect() which throws NEXT_REDIRECT
      // This is expected behavior - the redirect will happen
    } finally {
      setLoading(false);
    }
  };

  if (confirming) {
    return (
      <AlertBanner variant="destructive">
        <p className="text-red-800 font-medium mb-2">
          Are you sure?
        </p>
        <p className="mb-4">
          This will sign you out of all devices, including desktop apps and other
          browser sessions. Everyone will need to log in again.
        </p>
        {error && (
          <p className="text-red-600 mb-3">{error}</p>
        )}
        <div className="flex gap-3">
          <Button
            variant="danger"
            onClick={handleSignOut}
            disabled={loading}
          >
            {loading ? 'Signing out...' : 'Yes, sign out all devices'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => { setConfirming(false); setError(null); }}
            disabled={loading}
          >
            Cancel
          </Button>
        </div>
      </AlertBanner>
    );
  }

  return (
    <Button
      variant="dangerOutline"
      onClick={() => setConfirming(true)}
    >
      Sign Out All Devices
    </Button>
  );
}
