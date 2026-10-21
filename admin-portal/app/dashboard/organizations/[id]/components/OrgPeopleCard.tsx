'use client';

/**
 * People on the organization page — BACKLOG-4007 PR-4, People v2 (staff). Billing contact, IT
 * contact, office contacts and IT provider (MSP). Shown next to the Billing card (same
 * billing.view gate); the database refuses writes without billing.manage. "Invite new person"
 * opens the Users page's InviteUserDialog with the organization locked and the role preset
 * (founder 723b63de).
 */

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@keepr/design-system';
import { OrgPeoplePanel, type OrgPeopleInviteSlot, type OrgPeopleView } from '@keepr/ui';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@keepr/shared';
import { InviteUserDialog } from '@/app/dashboard/users/components/InviteUserDialog';
import {
  invitePersonAction,
  listOrgContactsAction,
  removeOrgContactAction,
  saveOrgContactAction,
} from '@/lib/actions/orgContacts';

const PHONE_RULE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

export function OrgPeopleCard({ organizationId, organizationName }: { organizationId: string; organizationName?: string }) {
  const [view, setView] = useState<OrgPeopleView | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState<{ slot: OrgPeopleInviteSlot; companyName?: string } | null>(null);

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
          onAddNew={(slot, companyName) => setAdding({ slot, companyName })}
          actions={{
            save: (input) => saveOrgContactAction(organizationId, input),
            remove: (id) => removeOrgContactAction(organizationId, id),
          }}
        />
      ) : failed ? (
        <p className="text-sm text-gray-600">People could not be loaded.</p>
      ) : (
        <p className="text-sm text-gray-500">Loading…</p>
      )}
      {adding && view ? (
        <InviteUserDialog
          lockedOrganization={{ id: organizationId, name: organizationName ?? 'This brokerage' }}
          onClose={() => setAdding(null)}
          onInvited={() => void load()}
          people={{
            slot: adding.slot,
            companyName: adding.companyName,
            phoneAllowed: view.can_edit_phone === true,
            phoneRule: PHONE_RULE,
            submit: (input) => invitePersonAction(organizationId, { slot: adding.slot, ...input }),
          }}
        />
      ) : null}
    </Card>
  );
}
