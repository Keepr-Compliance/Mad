'use client';

/**
 * Org Settings > People — BACKLOG-4007 PR-4, People v2. The brokerage's billing contact, IT
 * contact, office contacts and IT provider (MSP). The panel is shared with the admin portal
 * (@keepr/ui OrgPeoplePanel); the database decides who may change what. "Invite new person"
 * opens the Users page's InviteUserModal with the role preset (founder 723b63de).
 */

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@keepr/design-system';
import { OrgPeoplePanel, type OrgPeopleInviteSlot, type OrgPeopleView } from '@keepr/ui';
import InviteUserModal from '@/components/users/InviteUserModal';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@/lib/billing/phone';
import { invitePerson, listOrgContacts, removeOrgContact, saveOrgContact } from '@/lib/actions/orgContacts';

export interface PeopleCardProps {
  organizationId: string;
  readOnly?: boolean;
}

const PHONE_RULE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

export function PeopleCard({ organizationId, readOnly = false }: PeopleCardProps) {
  const [view, setView] = useState<OrgPeopleView | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState<{ slot: OrgPeopleInviteSlot; companyName?: string } | null>(null);

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
            onAddNew={(slot, companyName) => setAdding({ slot, companyName })}
            actions={{
              save: (input) => saveOrgContact(organizationId, input),
              remove: (id) => removeOrgContact(organizationId, id),
            }}
          />
        ) : failed ? (
          <p className="text-sm text-gray-600">People could not be loaded.</p>
        ) : (
          <p className="text-sm text-gray-500">Loading…</p>
        )}
      </CardContent>
      {adding && view ? (
        <InviteUserModal
          isOpen
          organizationId={organizationId}
          onClose={() => {
            setAdding(null);
            void load();
          }}
          people={{
            slot: adding.slot,
            companyName: adding.companyName,
            phoneAllowed: view.can_edit_phone === true,
            phoneRule: PHONE_RULE,
            submit: (input) => invitePerson(organizationId, { slot: adding.slot, ...input }),
          }}
        />
      ) : null}
    </Card>
  );
}
