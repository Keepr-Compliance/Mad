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

/** BACKLOG-4045/4200/4209: detail.notified -> the email suffix; '' when the row has no key (older rows). */
function emailed(row: ActivityRow): string {
  return row.detail.notified === true ? '. Billing contact emailed.' : row.detail.notified === false ? '. Billing contact not emailed.' : '';
}

/** BACKLOG-3513: shared broker reports. */
const LEVEL_LABEL: Record<string, string> = { viewer: 'Can view', editor: 'Can edit' };

const ROLE_TARGET: Record<string, string> = {
  agent: 'all agents',
  broker: 'all brokers',
  admin: 'all admins',
  it_admin: 'all IT admins',
};

function level(v: unknown): string {
  const s = str(v);
  return s ? LEVEL_LABEL[s] ?? humanise(s) : 'no access';
}

function reportName(row: ActivityRow): string {
  const s = str(row.detail.report_name);
  return s ? `the report "${s}"` : 'a report';
}

/** A role grant names the role ("all agents"); a person grant names the person. */
function grantee(subject: string, row: ActivityRow): string {
  const r = str(row.detail.role);
  return r ? ROLE_TARGET[r] ?? `all ${humanise(r).toLowerCase()}s` : subject;
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
  reinstated: (who, _subject, row) => `${who} reinstated the organization${emailed(row)}`,
  auto_renew_off: (who, _subject, row) => `${who} turned off auto-renew${emailed(row)}`,
  auto_renew_on: (who, _subject, row) => `${who} turned auto-renew back on${emailed(row)}`,
  deal_ended: () => 'The deal ended',
  setup_completed: (who) => `${who} finished billing setup`,
  // shared broker reports (BACKLOG-3513)
  report_created: (who, _subject, row) => `${who} created ${reportName(row)}`,
  report_deleted: (who, _subject, row) => `${who} deleted ${reportName(row)}`,
  report_shared: (who, subject, row) =>
    `${who} shared ${reportName(row)} with ${grantee(subject, row)} (${level(row.detail.to)})`,
  report_share_changed: (who, subject, row) =>
    `${who} changed ${grantee(subject, row)}'s access to ${reportName(row)} from ${level(row.detail.from)} to ${level(row.detail.to)}`,
  report_unshared: (who, subject, row) =>
    !str(row.detail.role) && row.actor_is_subject
      ? `${subject} left ${reportName(row)} (was ${level(row.detail.from)})`
      : `${who} removed ${grantee(subject, row)} from ${reportName(row)} (was ${level(row.detail.from)})`,
  report_general_access_changed: (who, _subject, row) =>
    str(row.detail.to) === 'organization'
      ? `${who} shared ${reportName(row)} with everyone in the organization`
      : `${who} limited ${reportName(row)} to the people added`,
  report_row_scope_changed: (who, _subject, row) =>
    str(row.detail.to) === 'own'
      ? `${who} set ${reportName(row)} to show each person only their own rows`
      : `${who} set ${reportName(row)} to show all rows each person can already see`,
  report_owner_changed: (who, subject, row) =>
    row.detail.via === 'reassign'
      ? `${who} reassigned ${reportName(row)} from ${str(row.detail.from) ?? 'a removed account'} to ${str(row.detail.to) ?? subject}`
      : row.detail.via === 'take_over'
        ? `${who} took over ${reportName(row)}`
        : `${who} made ${subject} the owner of ${reportName(row)}`,
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
