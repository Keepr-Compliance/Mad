/**
 * LicenseCard - the user's account standing (BACKLOG-3859: titled "Account").
 *
 * Shows account status and device limit per license row. License type, trial
 * fields, expiry and transaction counts are no longer shown: the plan a user
 * is on is the Plan card's job, and those columns are vestigial. license_type
 * and expires_at are still read, for the Edit dialog only.
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
  max_devices: number | null;
  expires_at: string | null;
  created_at: string;
}

function getStatusColor(status: string | null): string {
  switch (status) {
    case 'active':
      return 'bg-success-50 text-success-600';
    case 'expired':
      return 'bg-danger-50 text-danger-600';
    case 'suspended':
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
          Account
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
                  <p className="text-sm font-medium text-gray-900">Account status</p>
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
                <span>Device limit: {lic.max_devices ?? 'not set'}</span>
                <span>Since: {formatDate(lic.created_at, 'N/A')}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
