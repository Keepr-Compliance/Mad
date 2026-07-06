'use client';

import { useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@keepr/design-system';
import { updateLicense } from '@/lib/admin-queries';

interface LicenseData {
  id: string;
  status: string | null;
  expires_at: string | null;
  license_type: string | null;
}

interface EditLicenseDialogProps {
  license: LicenseData;
}

const LICENSE_STATUSES = ['active', 'suspended', 'expired', 'cancelled'] as const;
const LICENSE_TYPES = ['trial', 'individual', 'team'] as const;

/**
 * EditLicenseDialog - Modal form for editing license fields.
 *
 * Opens an HTML <dialog> with pre-filled form fields.
 * Only sends changed fields to the RPC.
 */
export function EditLicenseDialog({ license }: EditLicenseDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state -- initialized from current license values
  const [status, setStatus] = useState(license.status ?? 'active');
  const [expiresAt, setExpiresAt] = useState(
    license.expires_at ? license.expires_at.split('T')[0] : ''
  );
  const [licenseType, setLicenseType] = useState(license.license_type ?? 'free');

  const openDialog = useCallback(() => {
    // Reset form to current values when opening
    setStatus(license.status ?? 'active');
    setExpiresAt(license.expires_at ? license.expires_at.split('T')[0] : '');
    setLicenseType(license.license_type ?? 'free');
    setError(null);
    dialogRef.current?.showModal();
  }, [license]);

  const closeDialog = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLoading(true);
      setError(null);

      // Build changes object -- only include fields that changed
      const changes: Record<string, unknown> = {};

      if (status !== (license.status ?? 'active')) {
        changes.status = status;
      }

      const currentExpires = license.expires_at ? license.expires_at.split('T')[0] : '';
      if (expiresAt !== currentExpires) {
        changes.expires_at = expiresAt ? new Date(expiresAt).toISOString() : null;
      }

      if (licenseType !== (license.license_type ?? 'free')) {
        changes.license_type = licenseType;
      }

      if (Object.keys(changes).length === 0) {
        closeDialog();
        setLoading(false);
        return;
      }

      try {
        const result = await updateLicense(license.id, changes);

        if (result.error) {
          setError(result.error.message);
          return;
        }

        closeDialog();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      } finally {
        setLoading(false);
      }
    },
    [status, expiresAt, licenseType, license, closeDialog, router]
  );

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-md text-primary-700 bg-primary-50 hover:bg-primary-100 border border-primary-200 transition-colors"
      >
        Edit License
      </button>

      <dialog
        ref={dialogRef}
        className="rounded-lg shadow-xl border border-gray-200 p-0 backdrop:bg-black/50 max-w-md w-full"
      >
        <form onSubmit={handleSubmit} className="p-6">
          <h3 className="text-lg font-semibold text-gray-900">Edit License</h3>
          <p className="mt-1 text-sm text-gray-500">
            Update license fields below. Only changed values will be saved.
          </p>

          <div className="mt-4 space-y-4">
            {/* Status */}
            <div>
              <label
                htmlFor="license-status"
                className="block text-sm font-medium text-gray-700"
              >
                Status
              </label>
              <select
                id="license-status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={loading}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              >
                {LICENSE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            {/* License Type */}
            <div>
              <label
                htmlFor="license-type"
                className="block text-sm font-medium text-gray-700"
              >
                License Type
              </label>
              <select
                id="license-type"
                value={licenseType}
                onChange={(e) => setLicenseType(e.target.value)}
                disabled={loading}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              >
                {LICENSE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            {/* Expires At */}
            <div>
              <label
                htmlFor="license-expires"
                className="block text-sm font-medium text-gray-700"
              >
                Expires At
              </label>
              <input
                id="license-expires"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                disabled={loading}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              />
            </div>

          </div>

          {error && (
            <div className="mt-3 rounded-md bg-danger-50 p-3">
              <p className="text-sm text-danger-700">{error}</p>
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={closeDialog}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading}
            >
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Saving...
                </span>
              ) : (
                'Save Changes'
              )}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
