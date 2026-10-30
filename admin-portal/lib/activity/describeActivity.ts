/**
 * BACKLOG-4036: one sentence per organization activity row (admin_get_org_activity).
 *
 * Every action any writer puts in billing_change_log, plus the two staff rows the reader takes
 * from admin_audit_logs, has a template here; an unknown action still renders (humanised).
 * The exhaustiveness test reads the actions from the migrations, so a new writer without a
 * sentence goes red.
 */

export interface ActivityRow {
  created_at: string;
  action: string;
  actor_name: string | null;
  actor_is_staff: boolean;
  actor_is_subject: boolean;
  subject_name: string | null;
  detail: Record<string, unknown>;
}

const ROLE_LABEL: Record<string, string> = {
  agent: 'Agent',
  broker: 'Broker',
  admin: 'Admin',
  it_admin: 'IT Admin',
};

const CONTACT_LABEL: Record<string, string> = {
  billing: 'billing contact',
  it: 'IT contact',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function role(v: unknown): string {
  const s = str(v);
  return s ? ROLE_LABEL[s] ?? humanise(s) : 'a new role';
}

/** "some_new_action" or "org.thing_done" -> "Some new action" / "Org thing done". */
export function humanise(action: string): string {
  const words = action.replace(/[._]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Activity';
}

type Template = (who: string, subject: string, row: ActivityRow) => string;

function license(who: string, subject: string, row: ActivityRow): string {
  const from = str(row.detail.from);
  const to = str(row.detail.to);
  if (to === 'suspended' || to === 'deactivated') return `${who} deactivated ${subject}`;
  if (to === 'active' && from === 'unassigned') return `${who} gave ${subject} a license`;
  if (to === 'active') return `${who} reactivated ${subject}`;
  if (to === 'unassigned') return `${who} took ${subject}'s license`;
  return `${who} changed ${subject}'s license to ${to ? humanise(to).toLowerCase() : 'a new status'}`;
}

function phone(who: string, subject: string, row: ActivityRow): string {
  const cleared = row.detail.cleared === true;
  if (row.actor_is_subject) return `${subject} ${cleared ? 'removed' : 'changed'} their phone`;
  return `${who} ${cleared ? 'removed' : 'changed'} ${subject}'s phone`;
}

export const ACTIVITY_TEMPLATES: Record<string, Template> = {
  // member and phone changes (database triggers)
  member_invited: (who, subject) => `${who} invited ${subject}`,
  member_added: (who, subject, row) =>
    row.detail.via === 'sign_in' ? `${subject} joined by signing in` : `${who} added ${subject}`,
  invite_accepted: (_who, subject) => `${subject} accepted the invite`,
  member_role_changed: (who, subject, row) => `${who} changed ${subject}'s role to ${role(row.detail.to)}`,
  member_license_changed: license,
  invite_resent: (who, subject) => `${who} resent ${subject}'s invite`,
  invite_cancelled: (who, subject) => `${who} cancelled ${subject}'s invite`,
  member_removed: (who, subject) => `${who} removed ${subject}`,
  phone_changed: phone,
  // People and billing contact
  phone_set: phone,
  role_changed: (who, subject, row) => `${who} changed ${subject}'s role to ${role(row.detail.to)}`,
  contact_saved: (who, _subject, row) => `${who} saved the ${CONTACT_LABEL[str(row.detail.role) ?? ''] ?? 'contact'}`,
  contact_removed: (who, _subject, row) => `${who} removed the ${CONTACT_LABEL[str(row.detail.role) ?? ''] ?? 'contact'}`,
  billing_login_added: (who, subject) => `${who} gave ${subject} a billing login`,
  billing_login_removed: (who, subject) => `${who} removed ${subject}'s billing login`,
  billing_login_replaced: (_who, subject) => `${subject} took over the billing login`,
  billing_contact_reassigned: (who, subject) => `${who} made ${subject} the billing contact`,
  billing_contact_lost: () => 'The billing contact left',
  sync_change_skipped_last_admin: (_who, subject) => `Directory sync skipped a change to ${subject}, the last admin`,
  // deal and billing (billing.view only)
  deal_saved: (who) => `${who} saved the deal`,
  seats_changed: (who, _subject, row) => `${who} changed seats from ${row.detail.from ?? '?'} to ${row.detail.to ?? '?'}`,
  suspended: (who) => `${who} suspended the organization`,
  reinstated: (who) => `${who} reinstated the organization`,
  auto_renew_off: (who) => `${who} turned off auto-renew`,
  auto_renew_on: (who) => `${who} turned auto-renew back on`,
  deal_ended: () => 'The deal ended',
  setup_completed: (who) => `${who} finished billing setup`,
  // staff rows (admin_audit_logs)
  'organization.created': (who) => `${who} created the organization`,
  'org_plan.assigned': (who, _subject, row) => `${who} set the plan${str(row.detail.plan) ? ` to ${row.detail.plan}` : ''}`,
};

/** "<who> <did what>". Never throws. */
export function describeActivity(row: ActivityRow): string {
  const who = str(row.actor_name) ?? 'Keepr';
  const subject = str(row.subject_name) ?? 'a member';
  const template = ACTIVITY_TEMPLATES[row.action];
  if (template) return template(who, subject, row);
  return `${who}: ${humanise(row.action)}`;
}

/** The staff note or reason saved with a deal / suspension / auto-renew row, if any. */
export function activityNote(row: ActivityRow): string | null {
  return str(row.detail.note) ?? (row.action === 'deal_saved' ? str(row.detail.reason) : null);
}
