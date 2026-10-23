'use client';

/**
 * Org Settings > People — BACKLOG-4007 PR-4, People v2. The brokerage's billing contact, IT
 * contact, office contacts and IT provider (MSP). The panel is shared with the admin portal
 * (@keepr/ui OrgPeoplePanel); the database decides who may change what. Each role's Edit
 * popup holds "Invite new person" itself (org_people_invite through invitePerson).
 *
 * linkUsers: names link to the member page (/dashboard/users/<member id>). That page admits
 * admins and IT admins only, so only the Org Settings mount for those roles passes it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@keepr/design-system';
import { OrgPeoplePanel, type OrgPeopleView } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@/lib/billing/phone';
import { invitePerson, listOrgContacts, removeOrgContact, saveOrgContact } from '@/lib/actions/orgContacts';

export interface PeopleCardProps {
  organizationId: string;
  readOnly?: boolean;
  /** Names link to the member page (admin / IT admin callers only). */
  linkUsers?: boolean;
}

const PHONE_RULE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

/** The broker portal's member page is keyed by the membership id. */
export function brokerUserHref(person: { member_id: string }): string {
  return `/dashboard/users/${person.member_id}`;
}

export function PeopleCard({ organizationId, readOnly = false, linkUsers = false }: PeopleCardProps) {
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
            userHref={linkUsers && !readOnly ? brokerUserHref : undefined}
            actions={{
              save: (input) => saveOrgContact(organizationId, input),
              remove: (id) => removeOrgContact(organizationId, id),
              invite: (slot, input) => invitePerson(organizationId, { slot, ...input }),
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
