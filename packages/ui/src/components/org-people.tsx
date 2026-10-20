'use client';

/**
 * OrgPeoplePanel — a brokerage's people: billing contact, IT contact, office contacts and MSP
 * (BACKLOG-4007 PR-4). One panel for both portals: staff on the admin organization page, the
 * brokerage admin under Org Settings in the broker portal. The portal passes the data and the
 * actions; every rule is enforced by the database RPCs (org_contact_save, org_contact_remove,
 * org_billing_login_set), so this component only presents.
 *
 * One picker for every role: "Select existing user" (the default) or "Create new person". A broker picks from
 * the brokerage's own members; staff can also search Keepr users (a user in another brokerage is
 * shown and cannot be picked).
 *
 * Copy rule (founder): short sentences; lists show 5 and "Show more".
 */

import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Input, Label, Select } from '@keepr/design-system';

export type OrgContactRole = 'billing' | 'it' | 'office' | 'msp';

export interface OrgPeopleContact {
  id: string;
  role: OrgContactRole;
  name: string;
  /** null for the billing contact when the caller is an IT admin (3855: Broker/Admin only). */
  email: string | null;
  phone: string | null;
  company_name: string | null;
  member_id: string | null;
  /** 'billing_only', a member role ('admin', 'it_admin', ...), or null (contact only). */
  login: string | null;
  login_claimed?: boolean;
}

export interface OrgPeopleMember {
  user_id: string;
  member_id: string;
  role: string;
  name: string;
  email: string;
}

export interface OrgPeopleView {
  /** May add, change and remove IT, office and MSP contacts. */
  can_edit: boolean;
  /**
   * May change the billing contact and the billing-only login (staff, broker, admin; not an IT
   * admin — founder e8571c1f). Absent = same as can_edit (the database sends it).
   */
  can_edit_billing?: boolean;
  deal_status: string | null;
  contacts: OrgPeopleContact[];
  members: OrgPeopleMember[];
}

export interface OrgPeopleUserHit {
  user_id: string;
  name: string;
  email: string;
  status: 'this_brokerage' | 'no_brokerage' | 'other_brokerage';
}

export interface OrgPeopleSaveInput {
  id?: string;
  role: OrgContactRole;
  name?: string;
  email?: string;
  phone?: string;
  company_name?: string;
  user_id?: string;
}

export type OrgPeopleResult = { ok: true; note?: string } | { ok: false; error: string };

export interface OrgPeopleActions {
  save: (input: OrgPeopleSaveInput) => Promise<OrgPeopleResult>;
  remove: (contactId: string) => Promise<OrgPeopleResult>;
  setBillingLogin: (enable: boolean) => Promise<OrgPeopleResult>;
  /** Staff only: search Keepr users by name or email. */
  searchUsers?: (query: string) => Promise<OrgPeopleUserHit[]>;
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
  /** Read-only (support session): no buttons. */
  readOnly?: boolean;
}

const ROLES: Array<{ key: OrgContactRole; label: string; sub: string; multi: boolean }> = [
  { key: 'billing', label: 'Billing contact', sub: 'Gets the invoices. Set in the setup guide.', multi: false },
  { key: 'it', label: 'IT contact', sub: 'Optional.', multi: false },
  { key: 'office', label: 'Office contacts', sub: 'Optional. Several allowed.', multi: true },
  { key: 'msp', label: 'IT provider (MSP)', sub: 'Optional. A company and its people.', multi: true },
];

const SHOW = 5;

/** One sentence per refusal code from the contact RPCs. Exported for the tests. */
export function orgPeopleErrorMessage(code: string): string {
  const m: Record<string, string> = {
    contact_name_required: 'Enter a name.',
    contact_email_required: 'Enter a valid email.',
    invalid_phone: 'Enter a valid phone number.',
    company_name_required: 'Enter the IT provider company.',
    it_contact_exists: 'There is already an IT contact. Change that one instead.',
    contact_exists: 'This person is already listed in this role.',
    user_not_found: 'That user cannot be added here.',
    user_in_other_brokerage: 'This user belongs to another brokerage.',
    billing_set_in_setup: 'The billing contact is set in the setup guide.',
    billing_contact_required: 'The billing contact can be changed, not removed.',
    no_deal: 'Set up billing first.',
    contact_not_found: 'That contact no longer exists. Reload the page.',
    billing_login_exists: 'This brokerage already has a billing-only login.',
    has_personal_account: 'This person already has their own Keepr account. Pick another billing contact or invite them as a member.',
    already_member: 'This person already has a login in this brokerage.',
    duplicate_invitation: 'This email already has an open invitation to Keepr.',
    account_suspended: 'This brokerage is suspended.',
    billing_setup_incomplete: 'Finish the Billing step first.',
    no_billing_contact: 'Add a billing contact first.',
    no_billing_login: 'There is no billing-only login to remove.',
    not_authorized: 'You cannot change people for this brokerage.',
  };
  return m[code] ?? 'Something went wrong. Please try again.';
}

function loginBadge(c: OrgPeopleContact) {
  if (c.login === 'billing_only') return <Badge hue="purple">Billing-only login</Badge>;
  if (c.login) return <Badge hue="blue">Has a login</Badge>;
  return <Badge hue="gray">Contact only</Badge>;
}

interface PickerState {
  role: OrgContactRole;
  id?: string;
  mode: 'new' | 'existing';
  name: string;
  email: string;
  phone: string;
  company: string;
  userId: string;
}

function emptyPicker(role: OrgContactRole, company = ''): PickerState {
  return { role, mode: 'existing', name: '', email: '', phone: '', company, userId: '' };
}

export function OrgPeoplePanel({ view, actions, phone, onChanged, readOnly = false }: OrgPeoplePanelProps) {
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<OrgPeopleUserHit[]>([]);
  const [phoneTouched, setPhoneTouched] = useState(false);

  const editable = view.can_edit && !readOnly;
  const editableBilling = editable && view.can_edit_billing !== false;
  const rowEditable = (role: OrgContactRole) => (role === 'billing' ? editableBilling : editable);
  const waiting = view.deal_status === 'draft';
  const byRole = useMemo(() => {
    const out: Record<OrgContactRole, OrgPeopleContact[]> = { billing: [], it: [], office: [], msp: [] };
    for (const c of view.contacts) out[c.role]?.push(c);
    return out;
  }, [view.contacts]);
  const billing = byRole.billing[0] ?? null;

  const run = async (fn: () => Promise<OrgPeopleResult>, done?: () => void) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      setError(orgPeopleErrorMessage(r.error));
      return;
    }
    if (r.note) setNotice(r.note);
    done?.();
    onChanged();
  };

  const openPicker = (p: PickerState) => {
    setPicker(p);
    setError(null);
    setNotice(null);
    setPhoneTouched(false);
    setQuery('');
    setHits([]);
  };

  const phoneRequired = picker?.role === 'billing';
  const phoneOk = picker ? (picker.phone.trim() === '' ? !phoneRequired : phone.isValid(picker.phone)) : true;

  const savePicker = () => {
    if (!picker) return;
    const input: OrgPeopleSaveInput =
      picker.mode === 'existing'
        ? { id: picker.id, role: picker.role, user_id: picker.userId, phone: picker.phone, company_name: picker.company }
        : { id: picker.id, role: picker.role, name: picker.name, email: picker.email, phone: picker.phone, company_name: picker.company };
    void run(() => actions.save(input), () => setPicker(null));
  };

  const search = async (q: string) => {
    setQuery(q);
    if (!actions.searchUsers || q.trim().length < 2) {
      setHits([]);
      return;
    }
    setHits(await actions.searchUsers(q.trim()));
  };

  // "Select existing user": the brokerage's members, plus staff search results.
  const existingChoices: Array<{ user_id: string; name: string; email: string; status: OrgPeopleUserHit['status'] }> = [
    ...view.members.map((m) => ({ user_id: m.user_id, name: m.name, email: m.email, status: 'this_brokerage' as const })),
    ...hits.filter((h) => !view.members.some((m) => m.user_id === h.user_id)),
  ];

  const roleLabel = (r: OrgContactRole) => ROLES.find((x) => x.key === r)?.label ?? r;

  return (
    <div className="space-y-4 text-left" data-testid="org-people">
      {error ? <Alert variant="error">{error}</Alert> : null}
      {notice ? <Alert variant="info">{notice}</Alert> : null}

      <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
        {ROLES.map((r) => {
          const people = byRole[r.key];
          const shown = expanded[r.key] ? people : people.slice(0, SHOW);
          const canAdd = rowEditable(r.key) && (r.key !== 'billing' ? r.multi || people.length === 0 : !waiting);
          return (
            <li key={r.key} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between" data-role={r.key}>
              <div className="min-w-0 sm:w-1/3">
                <p className="text-sm font-semibold text-gray-900">{r.label}</p>
                <p className="text-xs text-gray-500">{r.key === 'billing' && waiting ? 'Set in the setup guide.' : r.sub}</p>
                {r.key === 'billing' && editable && !editableBilling ? (
                  <p className="text-xs text-gray-500">Only a broker or admin can change it.</p>
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
                        {c.phone ? ` · ${c.phone}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {loginBadge(c)}
                      {rowEditable(c.role) ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              openPicker({
                                role: c.role,
                                id: c.id,
                                mode: 'new',
                                name: c.name,
                                email: c.email ?? '',
                                phone: c.phone ?? '',
                                company: c.company_name ?? '',
                                userId: '',
                              })
                            }
                          >
                            Change
                          </Button>
                          {c.role !== 'billing' ? (
                            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => actions.remove(c.id))}>
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
                {r.key === 'billing' && billing && editableBilling ? (
                  <div className="pt-1">
                    {billing.login === 'billing_only' ? (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => actions.setBillingLogin(false))}>
                        Remove billing-only login
                      </Button>
                    ) : !billing.member_id ? (
                      <>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => actions.setBillingLogin(true))}>
                          Give billing-only login
                        </Button>
                        <p className="mt-1 text-xs text-gray-500">Sees Billing and Support only. Uses no seat. One per brokerage.</p>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {canAdd && !(r.key === 'billing' && people.length > 0) ? (
                <div className="sm:pl-4">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => openPicker(emptyPicker(r.key, r.key === 'msp' ? people[0]?.company_name ?? '' : ''))}
                  >
                    {people.length > 0 ? 'Add another' : 'Add person'}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {picker ? (
        <div className="rounded-md border border-gray-200 p-4" role="group" aria-label={`Add person: ${roleLabel(picker.role)}`}>
          <p className="text-sm font-semibold text-gray-900">
            {picker.id ? 'Change' : 'Add'} {roleLabel(picker.role).toLowerCase()}
          </p>
          {!picker.id ? (
            <fieldset className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <legend className="sr-only">Create or select</legend>
              {(['existing', 'new'] as const).map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm text-gray-900">
                  <input
                    type="radio"
                    className="h-4 w-4 border-gray-300 bg-white text-primary-600 focus:ring-primary-500"
                    name="op-mode"
                    checked={picker.mode === m}
                    onChange={() => setPicker({ ...picker, mode: m })}
                  />
                  {m === 'existing' ? 'Select existing user' : 'Create new person'}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {picker.mode === 'new' ? (
              <>
                <div>
                  <Label htmlFor="op-name" required className="text-gray-900">Full name</Label>
                  <Input id="op-name" className="text-gray-900" value={picker.name} onChange={(e) => setPicker({ ...picker, name: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor="op-email" required className="text-gray-900">Email</Label>
                  <Input id="op-email" type="email" className="text-gray-900" value={picker.email} onChange={(e) => setPicker({ ...picker, email: e.target.value })} />
                </div>
              </>
            ) : (
              <>
                {actions.searchUsers ? (
                  <div>
                    <Label htmlFor="op-search" className="text-gray-900">Search users</Label>
                    <Input id="op-search" className="text-gray-900" value={query} placeholder="Name or email" onChange={(e) => void search(e.target.value)} />
                  </div>
                ) : null}
                <div>
                  <Label htmlFor="op-user" className="text-gray-900">User</Label>
                  <Select id="op-user" className="text-gray-900" value={picker.userId} onChange={(e) => setPicker({ ...picker, userId: e.target.value })}>
                    <option value="">Choose a user</option>
                    {existingChoices.map((u) => (
                      <option key={u.user_id} value={u.user_id} disabled={u.status === 'other_brokerage'}>
                        {u.name} ({u.email}){u.status === 'other_brokerage' ? ' · in another brokerage' : u.status === 'no_brokerage' ? ' · no brokerage' : ''}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            )}
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
            {picker.role === 'msp' ? (
              <div>
                <Label htmlFor="op-company" required className="text-gray-900">IT provider company</Label>
                <Input id="op-company" className="text-gray-900" value={picker.company} onChange={(e) => setPicker({ ...picker, company: e.target.value })} />
              </div>
            ) : null}
          </div>
          <p className="mt-3 text-xs text-gray-500">Contact only: no sign-in and no seat.</p>
          <div className="mt-4 flex justify-end gap-3">
            <Button variant="secondary" disabled={busy} onClick={() => setPicker(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !phoneOk || (picker.mode === 'existing' && !picker.userId)}
              onClick={savePicker}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
