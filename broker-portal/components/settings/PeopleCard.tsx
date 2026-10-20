'use client';

/**
 * Org Settings > People — BACKLOG-4007 PR-4. The brokerage's billing contact, IT contact,
 * office contacts and IT provider (MSP), and the one billing-only login. The panel is shared
 * with the admin portal (@keepr/ui OrgPeoplePanel); the database decides who may change what.
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@keepr/design-system';
import { OrgPeoplePanel, type OrgPeopleView } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@/lib/billing/phone';
import { listOrgContacts, removeOrgContact, saveOrgContact, setOrgBillingLogin } from '@/lib/actions/orgContacts';

export interface PeopleCardProps {
  organizationId: string;
  readOnly?: boolean;
}

const PHONE_RULE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

export function PeopleCard({ organizationId, readOnly = false }: PeopleCardProps) {
  const [view, setView] = useState<OrgPeopleView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const r = await listOrgContacts(organizationId);
    setView(r.ok ? r.view : null);
    setFailed(!r.ok);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card padding="none">
      <CardHeader>
        <h2 className="text-lg font-semibold text-gray-900">People</h2>
        <p className="mt-1 text-sm text-gray-600">Billing contact, IT contact, office contacts and your IT provider.</p>
      </CardHeader>
      <CardContent>
        {view ? (
          <OrgPeoplePanel
            view={view}
            readOnly={readOnly}
            phone={PHONE_RULE}
            onChanged={() => void load()}
            actions={{
              save: (input) => saveOrgContact(organizationId, input),
              remove: (id) => removeOrgContact(organizationId, id),
              setBillingLogin: (enable) => setOrgBillingLogin(organizationId, enable),
            }}
          />
        ) : failed ? (
          <p className="text-sm text-gray-600">People could not be loaded.</p>
        ) : (
          <p className="text-sm text-gray-500">Loading…</p>
        )}
      </CardContent>
    </Card>
  );
}
