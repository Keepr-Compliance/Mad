/**
 * BACKLOG-3860 PR-3 — rules for the admin "Free trial" setting card.
 *
 * The database function admin_set_solo_trial_setting (migration
 * 20261031140000_backlog_3860_solo_trial.sql) checks the caller and the 1-90 range again;
 * these rules let the card and the server action refuse before any call.
 */

export const TRIAL_DAYS_MIN = 1;
export const TRIAL_DAYS_MAX = 90;
export const TRIAL_AUDIT_ACTION = 'billing.solo_trial_updated';
export const TRIAL_NEW_ONLY_NOTE = 'A change applies to new trials only; running trials keep their end date.';

/** Shape returned by admin_get_solo_trial_setting(). An absent setting row reads enabled false, days null. */
export interface SoloTrialSetting {
  enabled: boolean;
  days: number | null;
  updated_at: string | null;
  can_edit: boolean;
}

/** One row of admin_get_audit_logs() for action billing.solo_trial_updated. */
export interface SoloTrialAuditEntry {
  created_at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  metadata: Record<string, unknown> | null;
}

export type TrialDaysCheck = { ok: true; days: number } | { ok: false; error: string };

export const DAYS_ERROR = `Enter a whole number of days from ${TRIAL_DAYS_MIN} to ${TRIAL_DAYS_MAX}.`;

/** Accepts a whole number 1-90, as typed text or a number. Everything else is refused. */
export function checkTrialDays(raw: string | number | null | undefined): TrialDaysCheck {
  const text = typeof raw === 'number' ? String(raw) : (raw ?? '').trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: DAYS_ERROR };
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days < TRIAL_DAYS_MIN || days > TRIAL_DAYS_MAX) {
    return { ok: false, error: DAYS_ERROR };
  }
  return { ok: true, days };
}

/** "Off" or "On, 14 days". An absent row (enabled false) reads Off. */
export function trialStateLabel(setting: Pick<SoloTrialSetting, 'enabled' | 'days'> | null): string {
  if (!setting || setting.enabled !== true) return 'Off';
  const days = setting.days;
  return days == null ? 'On' : `On, ${days} day${days === 1 ? '' : 's'}`;
}

/** Plain-words message for an error from admin_set_solo_trial_setting. */
export function trialErrorMessage(code: string | undefined | null): string {
  switch (code) {
    case '42501':
      return 'Only a Super Admin can change the free trial.';
    case '22023':
    case '22004':
      return DAYS_ERROR;
    case 'P0002':
      return 'The free trial setting is missing from the database. Nothing was changed.';
    default:
      return 'The free trial setting could not be saved. Nothing was changed.';
  }
}

function sideLabel(side: unknown): string | null {
  if (!side || typeof side !== 'object') return null;
  const s = side as { enabled?: unknown; days?: unknown };
  if (typeof s.enabled !== 'boolean') return null;
  return trialStateLabel({ enabled: s.enabled, days: typeof s.days === 'number' ? s.days : null });
}

/** "Off → On, 14 days" from the audit row's metadata {old, new}; null when the shape is not there. */
export function trialChangeLabel(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const from = sideLabel(metadata.old);
  const to = sideLabel(metadata.new);
  if (!to) return null;
  return from ? `${from} → ${to}` : to;
}
