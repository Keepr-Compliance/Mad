'use client';

/**
 * People on the organization page — BACKLOG-4007 PR-4 (staff). Billing contact, IT contact,
 * office contacts, IT provider (MSP) and the one billing-only login. Shown next to the Billing
 * card (same billing.view gate); the database refuses writes without billing.manage.
 */

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@keepr/design-system';
import { OrgPeoplePanel, type OrgPeopleView } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@keepr/shared';
import {
  listOrgContactsAction,
  removeOrgContactAction,
  saveOrgContactAction,
  searchUsersForContactAction,
  setOrgBillingLoginAction,
} from '@/lib/actions/orgContacts';

const PHONE_RULE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

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
          actions={{
            save: (input) => saveOrgContactAction(organizationId, input),
            remove: (id) => removeOrgContactAction(organizationId, id),
            setBillingLogin: (enable) => setOrgBillingLoginAction(organizationId, enable),
            searchUsers: (q) => searchUsersForContactAction(organizationId, q),
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
