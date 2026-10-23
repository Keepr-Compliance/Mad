'use client';

/**
 * People on the organization page — BACKLOG-4007 PR-4, People v2 (staff). Billing contact, IT
 * contact, office contacts and IT provider (MSP). Shown next to the Billing card (same
 * billing.view gate); the database refuses writes without billing.manage. Each role's Edit
 * popup holds "Invite new person" itself (org_people_invite through invitePersonAction).
 * Names link to the staff user page (/dashboard/users/<user id>).
 */

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@keepr/design-system';
import { OrgPeoplePanel, type OrgPeopleUserRef, type OrgPeopleView } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@keepr/shared';
import {
  invitePersonAction,
  listOrgContactsAction,
  removeOrgContactAction,
  saveOrgContactAction,
} from '@/lib/actions/orgContacts';

const PHONE_RULE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

/** The admin portal's user page is keyed by the user id. */
export function adminUserHref(person: OrgPeopleUserRef): string {
  return `/dashboard/users/${person.user_id}`;
}

export function OrgPeopleCard({ organizationId }: { organizationId: string }) {
  const [view, setView] = useState<OrgPeopleView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const v = await listOrgContactsAction(organizationId);
    setView(v);
    setFailed(v === null);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-900">People</h2>
        <p className="mt-1 text-sm text-gray-600">Billing contact, IT contact, office contacts and IT provider.</p>
      </div>
      {view ? (
        <OrgPeoplePanel
          view={view}
          phone={PHONE_RULE}
          onChanged={() => void load()}
          userHref={adminUserHref}
          actions={{
            save: (input) => saveOrgContactAction(organizationId, input),
            remove: (id) => removeOrgContactAction(organizationId, id),
            invite: (slot, input) => invitePersonAction(organizationId, { slot, ...input }),
          }}
        />
      ) : failed ? (
        <p className="text-sm text-gray-600">People could not be loaded.</p>
      ) : (
        <p className="text-sm text-gray-500">Loading…</p>
      )}
    </Card>
  );
}
