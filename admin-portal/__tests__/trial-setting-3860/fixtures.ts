/**
 * BACKLOG-3860 PR-3 fixtures, transcribed from the producers.
 *
 * PRESENT_OFF: admin_get_solo_trial_setting() on keepr-test, 2026-10-31, called as a staff user inside a
 * DO block that raised its result (kt-sql -c "do $$ ... set_config('request.jwt.claims', ...);
 * r := public.admin_get_solo_trial_setting(); raise exception 'RESULT %', r; end $$;"), so nothing was kept:
 *   {"days": 14, "enabled": false, "can_edit": true, "updated_at": "2026-10-31T04:31:36.267109+00:00"}
 * PRESENT_ON: the same shape with enabled true. The switch stays off everywhere (SR condition C6), so this
 * state is not observable; it is the function's own return for an enabled row
 * (migration 20261031140000_backlog_3860_solo_trial.sql:378-382).
 * ABSENT: the function body for a missing row: coalesce(enabled, false), days null, updated_at null.
 *
 * AUDIT_ROW: the columns admin_get_audit_logs() returns (keepr-test prosrc, 2026-10-31: id, action,
 * target_type, target_id, metadata, ip_address, user_agent, created_at, actor_id, actor_email, actor_name,
 * target_email, target_name) with the metadata admin_set_solo_trial_setting writes through
 * log_admin_action (migration :429-436): {old: {enabled, days}, new: {enabled, days}}. No such row
 * exists on keepr-test yet (nothing has been changed there).
 */

export const PRESENT_OFF = { days: 14, enabled: false, can_edit: true, updated_at: '2026-10-31T04:31:36.267109+00:00' };
export const PRESENT_ON = { ...PRESENT_OFF, enabled: true };
export const ABSENT = { days: null, enabled: false, can_edit: true, updated_at: null };

export const AUDIT_ROW = {
  id: '00000000-0000-0000-0000-000000000001', // pii-allow-uuid: invented all-zero fixture id
  action: 'billing.solo_trial_updated',
  target_type: 'billing_setting',
  target_id: 'solo_trial',
  metadata: { old: { enabled: false, days: 14 }, new: { enabled: true, days: 14 } },
  ip_address: null,
  user_agent: null,
  created_at: '2026-11-02T15:00:00.000000+00:00',
  actor_id: '00000000-0000-0000-0000-000000000002', // pii-allow-uuid: invented all-zero fixture id
  actor_email: 'staff@example.test',
  actor_name: 'Staff Admin',
  target_email: null,
  target_name: null,
};
