/**
 * Support SLA attainment fixture (BACKLOG-4086)
 *
 * SYNTHETIC rows in the transcribed shape of support-sla.fixture.ts (same
 * columns, same PostgREST ISO form, all-zero ids). Each row isolates one rule
 * of the attainment measure; the transcribed TICKETS fixture is untouched.
 *
 * TEST_SETTINGS = the migration's seeded defaults
 * (supabase/migrations/20261031000000_backlog_4086_support_sla_settings.sql).
 */

import type { SupportSlaSettings, SupportTicketRow } from '../support-sla';

export const TEST_SETTINGS: SupportSlaSettings = {
  firstResponseTargetMinutes: 480,
  resolutionTargetBusinessDays: 3,
  businessDayStartMinute: 540,
  businessDayEndMinute: 1020,
  businessDays: [1, 2, 3, 4, 5],
  timeZone: 'America/Los_Angeles',
};

const id = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

export function synthetic(
  n: number,
  status: string,
  created_at: string,
  first_response_at: string | null,
  resolved_at: string | null = null,
  closed_at: string | null = null
): SupportTicketRow {
  return { id: id(n), status, assignee_id: null, created_at, first_response_at, resolved_at, closed_at };
}

/** A week holding every synthetic row: [Mon 2026-10-19, Mon 2026-11-09) UTC. */
export const WEEKS = { fromIso: '2026-10-19T00:00:00.000Z', toIso: '2026-11-09T00:00:00.000Z' };

/** A12: one answered on time (53 business min), one unanswered long past target. */
export const A12_ROWS = [
  synthetic(60, 'in_progress', '2026-10-22T10:00:00-07:00', '2026-10-22T10:53:00-07:00'),
  synthetic(61, 'new', '2026-10-20T10:00:00-07:00', null),
];
export const A12_NOW = new Date('2026-10-28T12:00:00-07:00');

/** A13: unanswered, created Fri 15:30 PDT; now Fri 20:30 PDT = 90 business min old. */
export const A13_ROWS = [synthetic(62, 'new', '2026-10-23T15:30:00-07:00', null)];
export const A13_NOW = new Date('2026-10-23T20:30:00-07:00');

/**
 * A21 (SR R3): unanswered, created Fri 16:00 PDT; now Sat 02:00 PDT. 60
 * business minutes but 600 calendar minutes: awaiting, not missed.
 */
export const A21_ROWS = [synthetic(63, 'new', '2026-10-30T16:00:00-07:00', null)];
export const A21_NOW = new Date('2026-10-31T02:00:00-07:00');

/**
 * A22 (SR R4): resolution at 1441 business minutes is missed; at exactly 1440
 * (3 business days across the fall-back weekend) it is met. A `days x 1440`
 * target would also give 1440, so the 9-18 window case (target 1620) is the
 * one that tells them apart.
 */
export const A22_ROWS = [
  synthetic(64, 'resolved', '2026-10-30T16:00:00-07:00', '2026-10-30T16:10:00-07:00', '2026-11-04T16:01:00-08:00'),
  synthetic(65, 'resolved', '2026-10-30T16:00:00-07:00', '2026-10-30T16:10:00-07:00', '2026-11-04T16:00:00-08:00'),
];
export const A22_NOW = new Date('2026-11-06T12:00:00-08:00');

/**
 * R8: created inside the period, answered AFTER the period ends, still within
 * target (Fri 16:30 PDT -> Mon 09:30 PDT = 60 business minutes).
 */
export const R8_ROWS = [synthetic(66, 'in_progress', '2026-10-23T16:30:00-07:00', '2026-10-26T09:30:00-07:00')];
export const R8_PERIOD = { fromIso: '2026-10-19T00:00:00.000Z', toIso: '2026-10-24T00:00:00.000Z' };
export const R8_NOW = new Date('2026-10-28T12:00:00-07:00');

/**
 * C1: closed with no reply at 30 business minutes (inside the 480 target) is
 * missed at once; a reopened ticket (stale resolved_at, status in_progress)
 * with no reply at 60 business minutes stays awaiting.
 */
export const C1_ROWS = [
  synthetic(67, 'closed', '2026-10-26T09:00:00-07:00', null, null, '2026-10-26T09:30:00-07:00'),
  synthetic(68, 'resolved', '2026-10-26T09:00:00-07:00', null, '2026-10-26T09:30:00-07:00'),
  synthetic(69, 'in_progress', '2026-10-26T09:00:00-07:00', null, '2026-10-26T09:30:00-07:00'),
];
export const C1_NOW = new Date('2026-10-26T10:00:00-07:00');
