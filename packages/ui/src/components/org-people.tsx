'use client';

/**
 * OrgPeoplePanel — a brokerage's people: billing contact, IT contact, office contacts and MSP
 * (BACKLOG-4007 PR-4, People v2). One panel for both portals: staff on the admin organization
 * page, the brokerage under Org Settings in the broker portal. The portal passes the data and
 * the actions; every rule is enforced by the database RPCs (org_contact_save,
 * org_contact_remove, org_people_invite), so this component only presents.
 *
 * People v2 (founder 34ff8b68 / 723b63de): every contact is a member of the brokerage.
 * People popups (founder-approved mockup, BACKLOG-4007 follow-up): each role row shows its
 * people (name, role pill, email · phone) and ONE "Edit" button that opens a kit Dialog.
 * - Billing / IT contact: "Choose a user" (the brokerage's members in one searchable Dropdown)
 *   or "Invite new person" (actions.invite, org_people_invite, role preset by slot). Remove sits
 *   in the footer for the IT contact; the billing contact can be changed, not removed.
 * - Office / MSP: the current people with an inline phone and a remove button, an "Add a
 *   person" Dropdown; Save applies the changes one RPC at a time. Office is existing members
 *   only; MSP adds the company name and an invite tab.
 * - An agent or broker picked as the IT contact / MSP becomes an IT admin after a confirm.
 * - Phone: shown and editable only for callers who may write phones (can_edit_phone).
 * - userHref: the portal's link to a person's user page (null = plain text).
 * - pickerPresentation: 'sheet' opens the user pickers in a BottomSheet (phone width, 4032).
 *
 * Copy rule (founder): short sentences; lists show 5 and "Show more".
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Alert, Badge, Button, Input, Label, type BadgeHue } from '@keepr/design-system';
import { Dropdown, type DropdownOption } from './dropdown';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { SegmentedTabs } from './phone/segmented-tabs';

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

/** "Invite new person" (org_people_invite): the fields the portals' invite dialogs sent. */
export interface OrgPeopleInviteInput {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  companyName?: string;
}

export type OrgPeopleInviteResult =
  | { ok: true; emailSent: boolean; inviteLink: string | null }
  | { ok: false; error: string };

export interface OrgPeopleActions {
  save: (input: OrgPeopleSaveInput) => Promise<OrgPeopleResult>;
  remove: (contactId: string) => Promise<OrgPeopleResult>;
  /** Absent = no "Invite new person" tab. */
  invite?: (slot: OrgPeopleInviteSlot, input: OrgPeopleInviteInput) => Promise<OrgPeopleInviteResult>;
}

export interface OrgPeoplePhoneRule {
  isValid: (raw: string) => boolean;
  format: (raw: string) => string;
  error: string;
}

/** A person with a Keepr login (pending invitations have no user id and get no link). */
export interface OrgPeopleUserRef {
  member_id: string;
  user_id: string;
}

export interface OrgPeoplePanelProps {
  view: OrgPeopleView;
  actions: OrgPeopleActions;
  phone: OrgPeoplePhoneRule;
  /** Called after any successful change, so the portal re-reads the list. */
  onChanged: () => void;
  /** The portal's link to this person's user page; null (or absent) = the name is plain text. */
  userHref?: (person: OrgPeopleUserRef) => string | null;
  /** Read-only (support session): no buttons. */
  readOnly?: boolean;
  /**
   * How the user pickers open (BACKLOG-4032): 'popover' (default) or 'sheet' (a BottomSheet,
   * for phone width). The portal decides from its own media query.
   */
  pickerPresentation?: 'popover' | 'sheet';
}

const ROLES: Array<{ key: OrgContactRole; label: string; sub: string }> = [
  { key: 'billing', label: 'Billing contact', sub: 'Gets the invoices.' },
  { key: 'it', label: 'IT contact', sub: 'Optional. Becomes an IT admin.' },
  { key: 'office', label: 'Office contacts', sub: 'Optional. Several allowed.' },
  { key: 'msp', label: 'IT provider (MSP)', sub: 'Optional. A company and its people.' },
];

const DIALOG: Record<OrgContactRole, { title: string; sub: string }> = {
  billing: { title: 'Edit billing contact', sub: 'One person. Gets the invoices.' },
  it: { title: 'Edit IT contact', sub: 'One person. They become an IT admin.' },
  office: { title: 'Edit office contacts', sub: 'Pick people who already have a login. Several allowed.' },
  msp: { title: 'Edit IT provider', sub: 'A company and its people. They become IT admins.' },
};

const ROLE_NAMES: Record<string, string> = {
  agent: 'Agent',
  broker: 'Broker',
  admin: 'Admin',
  it_admin: 'IT admin',
};

const ROLE_HUES: Record<string, BadgeHue> = {
  admin: 'purple',
  it_admin: 'blue',
  agent: 'green',
  broker: 'amber',
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
  if (c.login === 'billing_only') return <Badge hue="gray">Billing-only login</Badge>;
  if (!c.login_claimed) return <Badge hue="gray">Invited</Badge>;
  return <Badge hue={ROLE_HUES[c.login ?? ''] ?? 'gray'}>{ROLE_NAMES[c.login ?? ''] ?? 'Member'}</Badge>;
}

function memberBadge(m: OrgPeopleMember) {
  if (m.billing_only) return <Badge hue="gray">Billing-only login</Badge>;
  if (m.pending) return <Badge hue="gray">Invited</Badge>;
  return <Badge hue={ROLE_HUES[m.role] ?? 'gray'}>{ROLE_NAMES[m.role] ?? m.role}</Badge>;
}

/** "an Agent", "a Broker". */
function withArticle(word: string): string {
  return `${/^[AEIOU]/i.test(word) ? 'an' : 'a'} ${word}`;
}

/** May this member fill this slot? null = yes, else the reason shown in the list. */
function pickBlock(role: OrgContactRole, m: OrgPeopleMember): string | null {
  if (role !== 'it' && role !== 'msp') return null;
  if (m.role === 'admin' || m.role === 'it_admin') return null;
  if (m.billing_only || m.pending || m.license_status !== 'active') return 'Needs a license first';
  if (m.idp_managed) return 'Managed by your identity provider.';
  return null;
}

const isMultiRole = (role: OrgContactRole) => role === 'office' || role === 'msp';

type Tab = 'choose' | 'invite';

interface InviteDraft {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
}

const EMPTY_INVITE: InviteDraft = { email: '', firstName: '', lastName: '', phone: '' };

/** One person in the multi-person dialog. contactId is set for people already saved. */
interface MultiRow {
  memberId: string;
  contactId?: string;
  phone: string;
  /** The phone as saved (formatted), to tell a change from no change. */
  savedPhone: string;
  /** The company as saved on this person's contact (MSP), to tell a change from no change. */
  savedCompany: string;
}

interface EditorState {
  role: OrgContactRole;
  tab: Tab;
  /** Single roles: the IT contact being changed (billing saves without an id, as before). */
  contactId?: string;
  memberId: string;
  phone: string;
  /** Multi roles. */
  rows: MultiRow[];
  removed: string[];
  company: string;
  invite: InviteDraft;
  /** The database asked to confirm a role change: the op to resend, the person, their role. */
  confirm?: { op: string; name: string; from: string };
  /** Multi save: ops already applied, so a resume after the confirm never resends them. */
  applied: string[];
}

interface Op {
  key: string;
  name: string;
  run: (confirm: boolean) => Promise<OrgPeopleResult>;
}

export function OrgPeoplePanel({
  view,
  actions,
  phone,
  onChanged,
  userHref,
  readOnly = false,
  pickerPresentation = 'popover',
}: OrgPeoplePanelProps) {
  const [ed, setEd] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // Set after a multi save that changed or failed: the next view from the portal rebuilds the
  // open editor, so ids and saved values come from the server and not from the stale rows.
  const resync = useRef(false);

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

  const hrefFor = (memberId: string): string | null => {
    if (!userHref) return null;
    const m = memberById(memberId);
    if (!m || !m.user_id || m.pending) return null;
    return userHref({ member_id: m.member_id, user_id: m.user_id });
  };

  /** "Invite new person", today's rule: billing always, IT only while empty, MSP always, office never. */
  const canInvite = (role: OrgContactRole) =>
    !!actions.invite && role !== 'office' && (role !== 'it' || byRole.it.length === 0);

  const openEditor = (role: OrgContactRole) => {
    const people = byRole[role];
    const first = people[0];
    const single = !isMultiRole(role);
    const company = role === 'msp' ? first?.company_name ?? '' : '';
    setEd({
      role,
      tab: 'choose',
      contactId: role === 'it' ? first?.id : undefined,
      memberId: single && first ? first.member_id : '',
      phone: single && first?.phone ? displayPhone(first.phone) : '',
      rows: single
        ? []
        : people.map((c) => {
            const p = c.phone ? displayPhone(c.phone) : '';
            return { memberId: c.member_id, contactId: c.id, phone: p, savedPhone: p, savedCompany: c.company_name ?? '' };
          }),
      removed: [],
      company,
      invite: EMPTY_INVITE,
      applied: [],
    });
    setError(null);
    setNotice(null);
    setTouched({});
  };

  const close = () => {
    setEd(null);
    setError(null);
  };

  const nameOf = (memberId: string) =>
    memberById(memberId)?.name ?? view.contacts.find((c) => c.member_id === memberId)?.name ?? 'This person';

  const phoneFine = (raw: string, required: boolean) =>
    !phoneEditable ? true : raw.trim() === '' ? !required : phone.isValid(raw);

  // ---------------------------------------------------------------- single person: save / remove
  const saveSingle = async (s: EditorState, confirm: boolean) => {
    const input: OrgPeopleSaveInput = {
      ...(s.role === 'it' && s.contactId ? { id: s.contactId } : {}),
      role: s.role,
      member_id: s.memberId,
      ...(phoneEditable && s.phone.trim() !== '' ? { phone: s.phone } : {}),
      ...(confirm ? { confirm_role_change: true } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const r = await actions.save(input);
      if (!r.ok) {
        if (r.error === 'role_change_needs_confirm') {
          setEd({ ...s, confirm: { op: 'single', name: nameOf(s.memberId), from: r.role ?? 'agent' } });
          return;
        }
        setError(orgPeopleErrorMessage(r.error));
        return;
      }
      if (r.note) setNotice(r.note);
      setEd(null);
      onChanged();
    } catch {
      setError(orgPeopleErrorMessage('unexpected'));
    } finally {
      setBusy(false);
    }
  };

  const removeSingle = async (s: EditorState) => {
    if (!s.contactId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await actions.remove(s.contactId);
      if (!r.ok) {
        setError(orgPeopleErrorMessage(r.error));
        return;
      }
      setEd(null);
      onChanged();
    } catch {
      setError(orgPeopleErrorMessage('unexpected'));
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- several people: save a diff
  const multiOps = (s: EditorState): Op[] => {
    const ops: Op[] = [];
    for (const id of s.removed) {
      const c = view.contacts.find((x) => x.id === id);
      ops.push({ key: `rm:${id}`, name: c?.name ?? 'This person', run: () => actions.remove(id) });
    }
    for (const row of s.rows) {
      const isNew = !row.contactId;
      const companyChanged = s.role === 'msp' && s.company.trim() !== row.savedCompany.trim();
      if (!isNew && row.phone === row.savedPhone && !companyChanged) continue;
      const input: OrgPeopleSaveInput = {
        ...(row.contactId ? { id: row.contactId } : {}),
        role: s.role,
        member_id: row.memberId,
        ...(phoneEditable && row.phone.trim() !== '' ? { phone: row.phone } : {}),
        ...(s.role === 'msp' ? { company_name: s.company } : {}),
      };
      ops.push({
        // An update's key carries the values, so a later edit of the same person is a new op.
        key: isNew ? `add:${row.memberId}` : `up:${row.memberId}:${row.phone}:${s.role === 'msp' ? s.company.trim() : ''}`,
        name: nameOf(row.memberId),
        run: (confirm) => actions.save(confirm ? { ...input, confirm_role_change: true } : input),
      });
    }
    return ops.filter((o) => !s.applied.includes(o.key));
  };

  const saveMulti = async (s: EditorState) => {
    const applied = [...s.applied];
    let changed = false;
    setBusy(true);
    setError(null);
    try {
      for (const op of multiOps(s)) {
        let r: OrgPeopleResult;
        try {
          r = await op.run(s.confirm?.op === op.key);
        } catch {
          r = { ok: false, error: 'unexpected' };
        }
        if (!r.ok) {
          if (r.error === 'role_change_needs_confirm') {
            setEd({ ...s, applied, confirm: { op: op.key, name: op.name, from: r.role ?? 'agent' } });
            if (changed) {
              resync.current = true;
              onChanged();
            }
          } else {
            // Name whose change failed, say the ones before it were saved, and re-read the list.
            const earlier = applied.length > 0 ? ' The changes before this one were saved.' : '';
            setEd({ ...s, applied, confirm: undefined });
            setError(`${op.name}: ${orgPeopleErrorMessage(r.error)}${earlier}`);
            resync.current = true;
            onChanged();
          }
          return;
        }
        applied.push(op.key);
        changed = true;
        if (r.note) setNotice(r.note);
      }
      setEd(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // After a failed or confirm-paused multi save the portal re-reads the list. Rebuild the open
  // editor from it: saved people get their ids and saved values, so a later remove or phone edit
  // reaches the database; what the user still wants (unsaved adds, edits, removes) is kept.
  useEffect(() => {
    if (!resync.current || !ed || !isMultiRole(ed.role)) return;
    resync.current = false;
    const server = view.contacts.filter((c) => c.role === ed.role);
    const ids = new Set(server.map((c) => c.id));
    const rows: MultiRow[] = [];
    for (const c of server) {
      if (ed.removed.includes(c.id)) continue;
      const stored = c.phone ? displayPhone(c.phone) : '';
      const old = ed.rows.find((r) => r.memberId === c.member_id);
      rows.push({ memberId: c.member_id, contactId: c.id, phone: old ? old.phone : stored, savedPhone: stored, savedCompany: c.company_name ?? '' });
    }
    for (const r of ed.rows) {
      if (!server.some((c) => c.member_id === r.memberId)) rows.push({ memberId: r.memberId, phone: r.phone, savedPhone: '', savedCompany: '' });
    }
    setEd({ ...ed, rows, removed: ed.removed.filter((id) => ids.has(id)), applied: [] });
    // Runs when the portal hands over a new view; ed is read from this render.
  }, [view]);

  // ---------------------------------------------------------------- invite
  const sendInvite = async (s: EditorState) => {
    if (!actions.invite || s.role === 'office') return;
    const slot: OrgPeopleInviteSlot = s.role;
    const email = s.invite.email.trim();
    setBusy(true);
    setError(null);
    try {
      const r = await actions.invite(slot, {
        email,
        firstName: s.invite.firstName.trim(),
        lastName: s.invite.lastName.trim(),
        phone: phoneEditable ? s.invite.phone.trim() : '',
        ...(slot === 'msp' ? { companyName: s.company.trim() } : {}),
      });
      if (!r.ok) {
        setError(orgPeopleErrorMessage(r.error));
        return;
      }
      setNotice(
        r.emailSent
          ? `Invite sent to ${email}.`
          : `The invite was created but the email could not be sent. Share this link with ${email}: ${r.inviteLink ?? ''}`
      );
      setEd(null);
      onChanged();
    } catch {
      setError(orgPeopleErrorMessage('unexpected'));
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- dropdown options
  const optionsFor = (role: OrgContactRole, current: string, exclude: string[] = []): DropdownOption[] => {
    // The current contact is always a member; if the caller's member list lacks them, still name them.
    const saved = current && !memberById(current) ? view.contacts.find((c) => c.member_id === current) : undefined;
    const fallback: DropdownOption[] = saved ? [{ value: saved.member_id, label: saved.name, description: saved.email ?? undefined }] : [];
    return fallback.concat(memberOptions(role, current, exclude));
  };

  const memberOptions = (role: OrgContactRole, current: string, exclude: string[]): DropdownOption[] =>
    view.members
      .filter((m) => role === 'billing' || !m.billing_only || m.member_id === current)
      .filter((m) => !exclude.includes(m.member_id))
      .map((m) => {
        const block = pickBlock(role, m);
        const roleName = m.billing_only ? 'Billing only' : ROLE_NAMES[m.role] ?? m.role;
        return {
          value: m.member_id,
          label: m.name,
          description: `${m.email} · ${roleName}${m.pending ? ' · invited' : ''}`,
          keywords: [m.email],
          ...(block ? { disabled: true, hint: block } : {}),
        };
      });

  // ---------------------------------------------------------------- card
  const nameNode = (name: string, memberId: string) => {
    const href = hrefFor(memberId);
    return href ? (
      <a href={href} className="text-sm font-medium text-primary-600 hover:underline">
        {name}
      </a>
    ) : (
      <span className="text-sm font-medium text-gray-900">{name}</span>
    );
  };

  const personLine = (c: OrgPeopleContact) => (
    <div key={c.id} className="flex min-w-0 flex-col gap-0.5" data-testid="org-person">
      <div className="flex flex-wrap items-center gap-2">
        {nameNode(c.name, c.member_id)}
        {loginBadge(c)}
      </div>
      {c.email || c.phone ? (
        <p className="break-all text-xs text-gray-500">
          {c.email}
          {c.phone ? `${c.email ? ' · ' : ''}${displayPhone(c.phone)}` : ''}
        </p>
      ) : null}
    </div>
  );

  /** MSP: the company name above its people. */
  const mspGroups = (people: OrgPeopleContact[]) => {
    const groups: Array<{ company: string; people: OrgPeopleContact[] }> = [];
    for (const c of people) {
      const company = c.company_name ?? '';
      const g = groups.find((x) => x.company === company);
      if (g) g.people.push(c);
      else groups.push({ company, people: [c] });
    }
    return groups;
  };

  // ---------------------------------------------------------------- dialog parts
  const phoneInput = (
    id: string,
    value: string,
    onChange: (v: string) => void,
    opts: { label?: string; required?: boolean; ariaLabel?: string; compact?: boolean }
  ) => {
    const showErr = touched[id] === true && !phoneFine(value, opts.required === true);
    return (
      <div className={opts.compact ? 'w-36 shrink-0' : undefined}>
        {opts.label ? (
          <Label htmlFor={id} required={opts.required} className="text-gray-900">
            {opts.label}
            {opts.required ? null : <span className="font-normal text-gray-500"> (optional)</span>}
          </Label>
        ) : null}
        <Input
          id={id}
          type="tel"
          className="text-gray-900"
          placeholder={opts.compact ? 'Phone' : '(202) 555-0100'}
          aria-label={opts.ariaLabel}
          value={value}
          onChange={(e) => onChange(phone.format(e.target.value))}
          onBlur={() => setTouched((t) => ({ ...t, [id]: true }))}
          aria-invalid={showErr}
        />
        {showErr && !opts.compact ? (
          <p role="alert" className="mt-1 text-sm text-red-600">
            {phone.error}
          </p>
        ) : null}
      </div>
    );
  };

  const companyField = (s: EditorState) =>
    s.role === 'msp' ? (
      <div>
        <Label htmlFor="op-company" required className="text-gray-900">
          IT provider company
        </Label>
        <Input id="op-company" className="text-gray-900" value={s.company} onChange={(e) => setEd({ ...s, company: e.target.value })} />
      </div>
    ) : null;

  const inviteBody = (s: EditorState) => {
    const setInvite = (patch: Partial<InviteDraft>) => setEd({ ...s, invite: { ...s.invite, ...patch } });
    return (
      <div className="space-y-4" role="tabpanel" id="op-panel">
        {companyField(s)}
        <div>
          <Label htmlFor="op-invite-email" required className="text-gray-900">
            Work email
          </Label>
          <Input id="op-invite-email" type="email" className="text-gray-900" value={s.invite.email} onChange={(e) => setInvite({ email: e.target.value })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="op-invite-first" className="text-gray-900">
              First name
            </Label>
            <Input id="op-invite-first" className="text-gray-900" value={s.invite.firstName} onChange={(e) => setInvite({ firstName: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="op-invite-last" className="text-gray-900">
              Last name
            </Label>
            <Input id="op-invite-last" className="text-gray-900" value={s.invite.lastName} onChange={(e) => setInvite({ lastName: e.target.value })} />
          </div>
        </div>
        {phoneEditable
          ? phoneInput('op-invite-phone', s.invite.phone, (v) => setInvite({ phone: v }), { label: 'Phone', required: s.role === 'billing' })
          : null}
        <p className="text-sm text-gray-600" data-testid="op-seat-line">
          {s.role === 'billing' ? (
            <>
              We email them an invite. They join with a <strong className="font-semibold text-gray-900">Billing-only login</strong> and use no seat.
            </>
          ) : (
            <>
              We email them an invite. They join as an <strong className="font-semibold text-gray-900">IT admin</strong> and use 1 seat.
            </>
          )}
        </p>
      </div>
    );
  };

  const confirmAlert = (s: EditorState) =>
    s.confirm ? (
      <Alert variant="warning">
        {s.confirm.name} is {withArticle(ROLE_NAMES[s.confirm.from] ?? s.confirm.from)} now. Saving makes them an IT admin.
      </Alert>
    ) : null;

  const tabs = (s: EditorState) =>
    canInvite(s.role) ? (
      <SegmentedTabs
        ariaLabel="Who"
        fill
        panelId="op-panel"
        value={s.tab}
        onValueChange={(v) => {
          setEd({ ...s, tab: v === 'invite' ? 'invite' : 'choose', confirm: undefined });
          setError(null);
        }}
        items={[
          { value: 'choose', label: s.role === 'msp' ? 'Choose users' : 'Choose a user' },
          { value: 'invite', label: 'Invite new person' },
        ]}
      />
    ) : null;

  const singleBody = (s: EditorState, phoneRequired: boolean) => (
    <div className="space-y-4" role={canInvite(s.role) ? 'tabpanel' : undefined} id="op-panel">
      <Dropdown
        label="User"
        id="op-user"
        options={optionsFor(s.role, s.memberId)}
        value={s.memberId || null}
        presentation={pickerPresentation}
        placeholder="Choose a user"
        searchPlaceholder="Search name or email"
        onChange={(v) => {
          const m = memberById(v);
          setEd({ ...s, memberId: v, confirm: undefined, phone: m?.phone ? displayPhone(m.phone) : '' });
        }}
      />
      {phoneEditable ? phoneInput('op-phone', s.phone, (v) => setEd({ ...s, phone: v }), { label: 'Phone', required: phoneRequired }) : null}
      {confirmAlert(s)}
    </div>
  );

  const multiBody = (s: EditorState, rowsPhoneOk: boolean) => (
    <div className="space-y-4" role={canInvite(s.role) ? 'tabpanel' : undefined} id="op-panel">
      {companyField(s)}
      {s.rows.length > 0 ? (
        <ul className="max-h-64 divide-y divide-gray-200 overflow-y-auto rounded-lg border border-gray-200" aria-label="People">
          {s.rows.map((row) => {
            const m = memberById(row.memberId);
            const c = row.contactId ? view.contacts.find((x) => x.id === row.contactId) : undefined;
            const name = m?.name ?? c?.name ?? 'This person';
            return (
              <li key={row.memberId} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">{name}</span>
                    {c ? loginBadge(c) : m ? memberBadge(m) : null}
                  </div>
                  <p className="break-all text-xs text-gray-500">{m?.email ?? c?.email}</p>
                </div>
                {phoneEditable
                  ? phoneInput(
                      `op-row-phone-${row.memberId}`,
                      row.phone,
                      (v) => setEd({ ...s, rows: s.rows.map((x) => (x.memberId === row.memberId ? { ...x, phone: v } : x)) }),
                      { ariaLabel: `Phone for ${name}`, compact: true }
                    )
                  : null}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  disabled={busy}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  onClick={() =>
                    setEd({
                      ...s,
                      confirm: undefined,
                      rows: s.rows.filter((x) => x.memberId !== row.memberId),
                      removed: row.contactId ? [...s.removed, row.contactId] : s.removed,
                    })
                  }
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm italic text-gray-500">No one added</p>
      )}
      <div>
        <Dropdown
          label="Add a person"
          id="op-add"
          options={optionsFor(s.role, '', s.rows.map((r) => r.memberId))}
          value={null}
          presentation={pickerPresentation}
          placeholder="Search by name or email"
          searchPlaceholder="Search name or email"
          onChange={(v) => {
            const m = memberById(v);
            const p = m?.phone ? displayPhone(m.phone) : '';
            // Re-adding someone removed in this dialog keeps their saved contact.
            const old = byRole[s.role].find((c) => c.member_id === v && s.removed.includes(c.id));
            const saved = old?.phone ? displayPhone(old.phone) : '';
            setEd({
              ...s,
              confirm: undefined,
              rows: [...s.rows, old ? { memberId: v, contactId: old.id, phone: saved, savedPhone: saved, savedCompany: old.company_name ?? '' } : { memberId: v, phone: p, savedPhone: '', savedCompany: '' }],
              removed: old ? s.removed.filter((id) => id !== old.id) : s.removed,
            });
          }}
        />
        {s.role === 'office' ? <p className="mt-1 text-xs text-gray-500">Not listed? Invite them from Users first.</p> : null}
      </div>
      {!rowsPhoneOk ? (
        <p role="alert" className="text-sm text-red-600">
          {phone.error}
        </p>
      ) : null}
      {confirmAlert(s)}
    </div>
  );

  const dialogBody = (s: EditorState) => {
    const multi = isMultiRole(s.role);
    const inviting = s.tab === 'invite' && canInvite(s.role);
    const picked = multi ? undefined : memberById(s.memberId);
    // Billing needs a phone: typed now, or already on the person.
    const phoneRequired = s.role === 'billing' && !picked?.phone;
    const rowsPhoneOk = s.rows.every((r) => phoneFine(r.phone, false));
    const companyOk = s.role !== 'msp' || s.company.trim() !== '';

    let primaryLabel = s.confirm ? 'Make IT admin' : 'Save';
    let primaryDisabled = busy;
    let onPrimary: () => void;
    let body: ReactNode;
    if (inviting) {
      primaryLabel = 'Send invite';
      primaryDisabled = primaryDisabled || s.invite.email.trim() === '' || !phoneFine(s.invite.phone, s.role === 'billing') || !companyOk;
      onPrimary = () => void sendInvite(s);
      body = inviteBody(s);
    } else if (multi) {
      primaryDisabled = primaryDisabled || !rowsPhoneOk || (s.rows.length > 0 && !companyOk) || multiOps(s).length === 0;
      onPrimary = () => void saveMulti(s);
      body = multiBody(s, rowsPhoneOk);
    } else {
      primaryDisabled = primaryDisabled || !phoneFine(s.phone, phoneRequired) || !s.memberId;
      onPrimary = () => void saveSingle(s, !!s.confirm);
      body = singleBody(s, phoneRequired);
    }
    const canRemove = !inviting && !multi && s.role !== 'billing' && !!s.contactId;

    return (
      <DialogContent className={multi ? 'max-w-[520px] bg-white' : 'max-w-[480px] bg-white'}>
        <DialogHeader className="pr-8">
          <DialogTitle className="text-gray-900">{DIALOG[s.role].title}</DialogTitle>
          <DialogDescription className="text-gray-500">{DIALOG[s.role].sub}</DialogDescription>
        </DialogHeader>
        {tabs(s)}
        {error ? <Alert variant="error">{error}</Alert> : null}
        {body}
        <DialogFooter className="sm:items-center">
          {canRemove ? (
            <button
              type="button"
              disabled={busy}
              className="rounded-md px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 sm:mr-auto"
              onClick={() => void removeSingle(s)}
            >
              Remove
            </button>
          ) : null}
          <Button variant="secondary" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={primaryDisabled} onClick={onPrimary}>
            {busy ? 'Saving…' : primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  };

  return (
    <div className="space-y-4 text-left" data-testid="org-people">
      {notice ? <Alert variant="info">{notice}</Alert> : null}

      <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
        {ROLES.map((r) => {
          const people = byRole[r.key];
          const shown = expanded[r.key] ? people : people.slice(0, SHOW);
          const can = rowEditable(r.key) && !(r.key === 'billing' && waiting);
          return (
            <li key={r.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-6" data-role={r.key}>
              <div className="min-w-0 sm:w-1/3">
                <p className="text-sm font-semibold text-gray-900">{r.label}</p>
                <p className="text-xs text-gray-500">{r.key === 'billing' && waiting ? 'Set in the setup guide.' : r.sub}</p>
                {editable && !rowEditable(r.key) ? (
                  <p className="text-xs text-gray-500">
                    {r.key === 'billing' ? 'Only a broker or admin can change it.' : 'Only an admin or IT admin can change it.'}
                  </p>
                ) : null}
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                {people.length === 0 ? <p className="text-sm italic text-gray-500">No one added</p> : null}
                {r.key === 'msp'
                  ? mspGroups(shown).map((g) => (
                      <div key={g.company} className="space-y-2">
                        {g.company ? <p className="text-xs font-medium uppercase tracking-wide text-gray-700">{g.company}</p> : null}
                        {g.people.map(personLine)}
                      </div>
                    ))
                  : shown.map(personLine)}
                {people.length > SHOW && !expanded[r.key] ? (
                  <button type="button" className="text-sm text-primary-600" onClick={() => setExpanded({ ...expanded, [r.key]: true })}>
                    Show more ({people.length - SHOW})
                  </button>
                ) : null}
              </div>
              {can ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => openEditor(r.key)} aria-label={`Edit ${r.label}`}>
                  Edit
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={ed !== null}
        onOpenChange={(open) => {
          if (!open && !busy) close();
        }}
      >
        {ed ? dialogBody(ed) : null}
      </Dialog>
    </div>
  );
}
