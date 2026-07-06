/**
 * OrganizationCard - Displays the user's organization membership
 *
 * Shows org name (linked), role, join date, and plan info (linked).
 */

import Link from 'next/link';
import { ArrowRight, Building2 } from 'lucide-react';
import { Card } from '@keepr/design-system';
import { formatDate } from '@/lib/format';

interface OrgMembership {
  organization_id: string;
  org_name: string | null;
  role: string | null;
  joined_at: string | null;
  plan_id?: string | null;
  plan_name?: string | null;
  plan_tier?: string | null;
}

function getRoleBadgeColor(role: string | null): string {
  switch (role) {
    case 'owner':
      return 'bg-purple-100 text-purple-800';
    case 'admin':
      return 'bg-primary-100 text-primary-800';
    case 'member':
      return 'bg-gray-100 text-gray-800';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}

export function OrganizationCard({
  memberships,
}: {
  memberships: OrgMembership[];
}) {
  return (
    <Card>
      <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
        <Building2 className="h-4 w-4 text-gray-400" />
        Organizations
      </h3>

      {memberships.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">
          No organization memberships found.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {memberships.map((m) => (
            <li
              key={m.organization_id}
              className="flex items-center justify-between p-3 rounded-md bg-gray-50"
            >
              <div>
                <Link
                  href={`/dashboard/organizations/${m.organization_id}`}
                  className="text-sm font-medium text-primary-600 hover:text-primary-700 hover:underline"
                >
                  {m.org_name || 'Unnamed Organization'}
                </Link>
                <p className="text-xs text-gray-500">
                  Joined {formatDate(m.joined_at)}
                </p>
                {m.plan_id && m.plan_name && (
                  <Link
                    href={`/dashboard/plans/${m.plan_id}`}
                    className="inline-flex items-center gap-1 mt-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
                  >
                    {m.plan_name} ({m.plan_tier}) <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleBadgeColor(m.role)}`}
              >
                {m.role || 'unknown'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
