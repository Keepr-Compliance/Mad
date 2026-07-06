/**
 * LicenseCard - Displays user's license/subscription information
 *
 * Shows license tier, status, and expiry. Edit button is on the card header.
 */

import { Shield } from 'lucide-react';
import { Card } from '@keepr/design-system';
import { EditLicenseDialog } from './EditLicenseDialog';
import { formatDate } from '@/lib/format';

interface License {
  id: string;
  license_type: string | null;
  license_key: string | null;
  status: string | null;
  trial_status: string | null;
  trial_expires_at: string | null;
  transaction_count: number | null;
  transaction_limit: number | null;
  expires_at: string | null;
  created_at: string;
}

function getStatusColor(status: string | null): string {
  switch (status) {
    case 'active':
      return 'bg-success-50 text-success-600';
    case 'expired':
      return 'bg-danger-50 text-danger-600';
    case 'trial':
      return 'bg-warning-50 text-warning-600';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}

export function LicenseCard({ licenses }: { licenses: License[] }) {
  // Use first license for the header edit button
  const primaryLicense = licenses[0] ?? null;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
          <Shield className="h-4 w-4 text-gray-400" />
          Licenses
        </h3>
        {primaryLicense && (
          <EditLicenseDialog
            license={{
              id: primaryLicense.id,
              status: primaryLicense.status,
              expires_at: primaryLicense.expires_at,
              license_type: primaryLicense.license_type,
            }}
          />
        )}
      </div>

      {licenses.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No licenses found.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {licenses.map((lic) => (
            <li
              key={lic.id}
              className="p-3 rounded-md bg-gray-50 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900 capitalize">
                    {lic.license_type || 'Standard'}
                  </p>
                  {lic.license_key && (
                    <p className="text-xs text-gray-400 font-mono">{lic.license_key}</p>
                  )}
                </div>
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(lic.status)}`}
                >
                  {lic.status || 'unknown'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>Expires: {lic.expires_at ? formatDate(lic.expires_at, 'N/A') : 'No expiration'}</span>
                <span>
                  Transactions: {lic.transaction_count ?? 0}
                  {lic.transaction_limit && lic.transaction_limit < 999999
                    ? ` / ${lic.transaction_limit.toLocaleString()}`
                    : ' (unlimited)'}
                </span>
                {lic.trial_status && (
                  <>
                    <span>Trial: {lic.trial_status}</span>
                    <span>Trial expires: {formatDate(lic.trial_expires_at, 'N/A')}</span>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
