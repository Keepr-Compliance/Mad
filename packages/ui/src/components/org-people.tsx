'use client';

/**
 * OrgPeoplePanel — a brokerage's people: billing contact, IT contact, office contacts and MSP
 * (BACKLOG-4007 PR-4, People v2). One panel for both portals: staff on the admin organization
 * page, the brokerage under Org Settings in the broker portal. The portal passes the data and
 * the actions; every rule is enforced by the database RPCs (org_contact_save,
 * org_contact_remove, org_people_invite), so this component only presents.
 *
 * People v2 (founder 34ff8b68 / 723b63de): every contact is a member of the brokerage.
 * - "Select existing user": the brokerage's members in one searchable Dropdown (BACKLOG-4032).
 * - "Invite new person" (billing, IT contact, MSP; never office): the portal's own invite
 *   dialog with the role preset, opened through onAddNew.
 * - An agent or broker picked as the IT contact / MSP becomes an IT admin after a confirm.
 * - Phone: shown and editable only for callers who may write phones (can_edit_phone).
 *
 * Copy rule (founder): short sentences; lists show 5 and "Show more".
 */

import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Input, Label } from '@keepr/design-system';
import { Dropdown, type DropdownOption } from './dropdown';

export type OrgContactRole = 'billing' | 'it' | 'office' | 'msp';
export type OrgPeopleInviteSlot = 'billing' | 'it' | 'msp';

export interface OrgPeopleContact {
  id: string;
  role: OrgContactRole;
  name: string;
  /** null for the billing contact when the caller is an IT admin (3855). */
  email: string | null;
  /** null when the caller may not read it (agents never reach this panel). */
  phone: string | null;
  company_name: string | null;
  member_id: string;
  /** 'billing_only' or the member's role ('admin', 'it_admin', ...). */
  login: string | null;
  login_claimed?: boolean;
}

export interface OrgPeopleMember {
  member_id: string;
  /** null for an invitation not yet accepted. */
  user_id: string | null;
  role: string;
  license_status?: string;
  billing_only?: boolean;
  name: string;
  email: string;
  phone?: string | null;
  /** The identity provider owns this person's role (group mapping). */
  idp_managed?: boolean;
  pending?: boolean;
}

export interface OrgPeopleView {
  /** May change office contacts (and anything else the flags below allow). */
  can_edit: boolean;
  /** May change the billing contact (staff, admin, broker). Absent = can_edit. */
  can_edit_billing?: boolean;
  /** May change the IT contact and MSP (staff, admin, IT admin; founder R7). Absent = can_edit. */
  can_edit_it?: boolean;
  /** May see and write phones from People (staff, admin, broker). Absent = false. */
  can_edit_phone?: boolean;
  deal_status: string | null;
  contacts: OrgPeopleContact[];
  members: OrgPeopleMember[];
}

export interface OrgPeopleSaveInput {
  id?: string;
  role: OrgContactRole;
  member_id: string;
  phone?: string;
  company_name?: string;
  confirm_role_change?: boolean;
}

export type OrgPeopleResult = { ok: true; note?: string } | { ok: false; error: string; role?: string };

export interface OrgPeopleActions {
  save: (input: OrgPeopleSaveInput) => Promise<OrgPeopleResult>;
  remove: (contactId: string) => Promise<OrgPeopleResult>;
}

export interface OrgPeoplePhoneRule {
  isValid: (raw: string) => boolean;
  format: (raw: string) => string;
  error: string;
}

export interface OrgPeoplePanelProps {
  view: OrgPeopleView;
  actions: OrgPeopleActions;
  phone: OrgPeoplePhoneRule;
  /** Called after any successful change, so the portal re-reads the list. */
  onChanged: () => void;
  /** "Invite new person": the portal opens its invite dialog with the role preset. */
  onAddNew?: (slot: OrgPeopleInviteSlot, companyName?: string) => void;
  /** Read-only (support session): no buttons. */
  readOnly?: boolean;
}

const ROLES: Array<{ key: OrgContactRole; label: string; sub: string; multi: boolean }> = [
  { key: 'billing', label: 'Billing contact', sub: 'Gets the invoices.', multi: false },
  { key: 'it', label: 'IT contact', sub: 'Optional. Becomes an IT admin.', multi: false },
  { key: 'office', label: 'Office contacts', sub: 'Optional. Several allowed.', multi: true },
  { key: 'msp', label: 'IT provider (MSP)', sub: 'Optional. A company and its people.', multi: true },
];

const ROLE_NAMES: Record<string, string> = {
  agent: 'Agent',
  broker: 'Broker',
  admin: 'Admin',
  it_admin: 'IT admin',
};

const SHOW = 5;

/** One sentence per refusal code from the People RPCs. Exported for the tests. */
export function orgPeopleErrorMessage(code: string): string {
  const m: Record<string, string> = {
    invalid_phone: 'Enter a valid phone number.',
    company_name_required: 'Enter the IT provider company.',
    contact_email_required: 'Enter a valid email.',
    it_contact_exists: 'There is already an IT contact. Change that one instead.',
    contact_exists: 'This person is already listed in this role.',
    user_not_found: 'That person is not a member of this brokerage.',
    user_in_other_brokerage: 'This person belongs to another brokerage.',
    billing_set_in_setup: 'The billing contact is set in the setup guide.',
    billing_contact_required: 'The billing contact can be changed, not removed.',
    no_deal: 'Set up billing first.',
    contact_not_found: 'That contact no longer exists. Reload the page.',
    has_personal_account: 'This person already has their own Keepr account. Pick another billing contact or invite them as a member.',
    already_member: 'This person is already a member. Pick them from the list.',
    duplicate_invitation: 'This email already has an open invitation to Keepr.',
    account_suspended: 'This brokerage is suspended.',
    billing_setup_incomplete: 'Finish the Billing step first.',
    seat_limit_reached: 'No license is free. The IT contact uses a seat.',
    needs_license: 'Assign this person a license first. The IT contact uses a seat.',
    managed_by_idp: 'Managed by your identity provider.',
    cannot_change_own_role: 'You cannot change your own role.',
    not_authorized: 'You cannot change people for this brokerage.',
  };
  return m[code] ?? 'Something went wrong. Please try again.';
}

function loginBadge(c: OrgPeopleContact) {
  if (c.login === 'billing_only') return <Badge hue="purple">Billing-only login</Badge>;
  if (!c.login_claimed) return <Badge hue="gray">Invited</Badge>;
  return <Badge hue="blue">{ROLE_NAMES[c.login ?? ''] ?? 'Member'}</Badge>;
}

interface PickerState {
  role: OrgContactRole;
  id?: string;
  memberId: string;
  phone: string;
  company: string;
  /** Set when the database asked to confirm a role change (from this role to IT admin). */
  confirmFrom?: string;
}

/** May this member fill this slot? null = yes, else the reason shown in the list. */
function pickBlock(role: OrgContactRole, m: OrgPeopleMember): string | null {
  if (role !== 'it' && role !== 'msp') return null;
  if (m.role === 'admin' || m.role === 'it_admin') return null;
  if (m.billing_only || m.pending || m.license_status !== 'active') return 'Needs a license first';
  if (m.idp_managed) return 'Managed by your identity provider.';
  return null;
}

export function OrgPeoplePanel({ view, actions, phone, onChanged, onAddNew, readOnly = false }: OrgPeoplePanelProps) {
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [phoneTouched, setPhoneTouched] = useState(false);

  const editable = view.can_edit && !readOnly;
  const rowEditable = (role: OrgContactRole) => {
    if (!editable) return false;
    if (role === 'billing') return view.can_edit_billing !== false;
    if (role === 'it' || role === 'msp') return view.can_edit_it !== false;
    return true;
  };
  const phoneEditable = editable && view.can_edit_phone === true;
  const waiting = view.deal_status === 'draft';
  const byRole = useMemo(() => {
    const out: Record<OrgContactRole, OrgPeopleContact[]> = { billing: [], it: [], office: [], msp: [] };
    for (const c of view.contacts) out[c.role]?.push(c);
    return out;
  }, [view.contacts]);

  // US/CA numbers are stored as +1 and ten digits; show them through the existing phone formatter.
  const displayPhone = (stored: string) => {
    const m = /^\+1([2-9]\d{9})$/.exec(stored);
    return m ? phone.format(m[1]) : stored;
  };

  const memberById = (id: string) => view.members.find((m) => m.member_id === id);

  const openPicker = (p: PickerState) => {
    setPicker(p);
    setError(null);
    setNotice(null);
    setPhoneTouched(false);
  };

  const picked = picker ? memberById(picker.memberId) : undefined;
  // Billing needs a phone: typed now, or already on the person.
  const phoneRequired = picker?.role === 'billing' && !picked?.phone;
  const phoneOk = !picker || !phoneEditable
    ? true
    : picker.phone.trim() === ''
      ? !phoneRequired
      : phone.isValid(picker.phone);

  const savePicker = async (confirm = false) => {
    if (!picker) return;
    const input: OrgPeopleSaveInput = {
      id: picker.id,
      role: picker.role,
      member_id: picker.memberId,
      ...(phoneEditable && picker.phone.trim() !== '' ? { phone: picker.phone } : {}),
      ...(picker.role === 'msp' ? { company_name: picker.company } : {}),
      ...(confirm ? { confirm_role_change: true } : {}),
    };
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await actions.save(input);
    setBusy(false);
    if (!r.ok) {
      if (r.error === 'role_change_needs_confirm') {
        setPicker({ ...picker, confirmFrom: r.role ?? 'agent' });
        return;
      }
      setError(orgPeopleErrorMessage(r.error));
      return;
    }
    if (r.note) setNotice(r.note);
    setPicker(null);
    onChanged();
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await actions.remove(id);
    setBusy(false);
    if (!r.ok) {
      setError(orgPeopleErrorMessage(r.error));
      return;
    }
    onChanged();
  };

  // "Select existing user": every member this slot may list (billing-only people only for billing).
  // The Dropdown searches name, email and role itself and looks the trigger label up in this full
  // list, so the current pick needs no pinning against the search.
  const choices: DropdownOption[] = picker
    ? view.members
        .filter((m) => picker.role === 'billing' || !m.billing_only || m.member_id === picker.memberId)
        .map((m) => {
          const block = pickBlock(picker.role, m);
          const role = m.billing_only ? 'Billing only' : ROLE_NAMES[m.role] ?? m.role;
          return {
            value: m.member_id,
            label: m.name,
            description: `${m.email} · ${role}${m.pending ? ' · invited' : ''}`,
            keywords: [m.email],
            ...(block ? { disabled: true, hint: block } : {}),
          };
        })
    : [];

  const roleLabel = (r: OrgContactRole) => ROLES.find((x) => x.key === r)?.label ?? r;
  const confirmName = picked?.name ?? 'This person';

  return (
    <div className="space-y-4 text-left" data-testid="org-people">
      {error ? <Alert variant="error">{error}</Alert> : null}
      {notice ? <Alert variant="info">{notice}</Alert> : null}

      <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
        {ROLES.map((r) => {
          const people = byRole[r.key];
          const shown = expanded[r.key] ? people : people.slice(0, SHOW);
          const can = rowEditable(r.key) && !(r.key === 'billing' && waiting);
          const canAdd = can && (r.multi || people.length === 0);
          const canInvite = can && !!onAddNew && r.key !== 'office' && (r.multi || people.length === 0 || r.key === 'billing');
          return (
            <li key={r.key} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between" data-role={r.key}>
              <div className="min-w-0 sm:w-1/3">
                <p className="text-sm font-semibold text-gray-900">{r.label}</p>
                <p className="text-xs text-gray-500">{r.key === 'billing' && waiting ? 'Set in the setup guide.' : r.sub}</p>
                {editable && !rowEditable(r.key) ? (
                  <p className="text-xs text-gray-500">
                    {r.key === 'billing' ? 'Only a broker or admin can change it.' : 'Only an admin or IT admin can change it.'}
                  </p>
                ) : null}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                {people.length === 0 ? <p className="text-sm italic text-gray-500">No one added</p> : null}
                {shown.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {c.name}
                        {c.company_name ? <span className="font-normal text-gray-500"> · {c.company_name}</span> : null}
                      </p>
                      <p className="break-all text-xs text-gray-500">
                        {c.email}
                        {c.phone ? `${c.email ? ' · ' : ''}${displayPhone(c.phone)}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {loginBadge(c)}
                      {rowEditable(c.role) && !(c.role === 'billing' && waiting) ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              openPicker({
                                role: c.role,
                                id: c.role === 'billing' ? undefined : c.id,
                                memberId: c.member_id,
                                phone: c.phone ? displayPhone(c.phone) : '',
                                company: c.company_name ?? '',
                              })
                            }
                          >
                            Change
                          </Button>
                          {c.role !== 'billing' ? (
                            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void remove(c.id)}>
                              Remove
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
                {people.length > SHOW && !expanded[r.key] ? (
                  <button type="button" className="text-sm text-primary-600" onClick={() => setExpanded({ ...expanded, [r.key]: true })}>
                    Show more ({people.length - SHOW})
                  </button>
                ) : null}
              </div>
              {canAdd || canInvite ? (
                <div className="flex flex-wrap gap-2 sm:pl-4">
                  {canAdd && !(r.key === 'billing' && people.length > 0) ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        openPicker({ role: r.key, memberId: '', phone: '', company: r.key === 'msp' ? people[0]?.company_name ?? '' : '' })
                      }
                    >
                      {people.length > 0 ? 'Add another' : 'Add person'}
                    </Button>
                  ) : null}
                  {canInvite ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => onAddNew?.(r.key as OrgPeopleInviteSlot, r.key === 'msp' ? people[0]?.company_name ?? undefined : undefined)}
                    >
                      Invite new person
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {picker ? (
        <div className="rounded-md border border-gray-200 p-4" role="group" aria-label={`Select person: ${roleLabel(picker.role)}`}>
          <p className="text-sm font-semibold text-gray-900">
            {picker.id || picker.role === 'billing' ? 'Change' : 'Add'} {roleLabel(picker.role).toLowerCase()}
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Dropdown
              label="User"
              id="op-user"
              options={choices}
              value={picker.memberId || null}
              placeholder="Choose a user"
              searchPlaceholder="Search name or email"
              onChange={(v) => {
                const m = memberById(v);
                setPicker({ ...picker, memberId: v, confirmFrom: undefined, phone: m?.phone ? displayPhone(m.phone) : '' });
              }}
            />
            {phoneEditable ? (
              <div>
                <Label htmlFor="op-phone" required={phoneRequired} className="text-gray-900">Phone</Label>
                <Input
                  id="op-phone"
                  type="tel"
                  className="text-gray-900"
                  value={picker.phone}
                  onChange={(e) => setPicker({ ...picker, phone: phone.format(e.target.value) })}
                  onBlur={() => setPhoneTouched(true)}
                  aria-invalid={phoneTouched && !phoneOk}
                />
                {phoneTouched && !phoneOk ? (
                  <p role="alert" className="mt-1 text-sm text-red-600">
                    {phone.error}
                  </p>
                ) : null}
              </div>
            ) : null}
            {picker.role === 'msp' ? (
              <div>
                <Label htmlFor="op-company" required className="text-gray-900">IT provider company</Label>
                <Input id="op-company" className="text-gray-900" value={picker.company} onChange={(e) => setPicker({ ...picker, company: e.target.value })} />
              </div>
            ) : null}
          </div>
          {picker.confirmFrom ? (
            <div className="mt-4">
              <Alert variant="warning">
                {confirmName} is now {ROLE_NAMES[picker.confirmFrom] ?? picker.confirmFrom}. Saving makes them an IT admin.
              </Alert>
            </div>
          ) : null}
          <div className="mt-4 flex justify-end gap-3">
            <Button variant="secondary" disabled={busy} onClick={() => setPicker(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !phoneOk || !picker.memberId}
              onClick={() => void savePicker(!!picker.confirmFrom)}
            >
              {busy ? 'Saving…' : picker.confirmFrom ? 'Make IT admin' : 'Save'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
