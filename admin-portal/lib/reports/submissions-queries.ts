/**
 * Submissions report — data access (BACKLOG-3715)
 *
 * The authenticated server client only. Cross-org read of
 * `submission_attempts`, `users` and `organizations` comes from each table's
 * internal-role SELECT policy. No service-role client anywhere in this report.
 *
 * Two queries, kept as two functions so each can be asserted on its own:
 *
 * - The PERIOD query applies the period on the database and does NOT filter on
 *   outcome. In-progress rows are attempts and are counted.
 * - The OPEN query reads every in_progress row with NO period, so a stall that
 *   began before the period still shows. Oldest first, so the cap keeps the
 *   longest-open rows rather than pushing them off the end.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  IN_PROGRESS,
  type SubmissionAttemptRow,
  type SubmissionOrg,
  type SubmissionUser,
} from './submissions';
import type { PeriodRange } from './period';

const ATTEMPT_COLUMNS = [
  'id',
  'submission_id',
  'user_id',
  'organization_id',
  'is_resubmit',
  'outcome',
  'stage',
  'reason_code',
  'retry_count',
  'counts',
  'app_version',
  'platform',
  'started_at',
  'updated_at',
  'ended_at',
].join(', ');

/** Row cap for the period query. Reaching it shows the "truncated" notice. */
export const SUBMISSION_LIMIT = 500;

/** Row cap for the open-attempts panel. */
export const OPEN_ATTEMPT_LIMIT = 200;

export interface AttemptQueryResult {
  rows: SubmissionAttemptRow[];
  /** The query itself failed — not the same as "no rows". */
  failed: boolean;
  /** The cap was reached, so there are more rows than are shown. */
  truncated: boolean;
}

export async function getSubmissionAttempts(
  supabase: SupabaseClient,
  range: PeriodRange,
  limit = SUBMISSION_LIMIT
): Promise<AttemptQueryResult> {
  const { data, error } = await supabase
    .from('submission_attempts')
    .select(ATTEMPT_COLUMNS)
    .gte('started_at', range.fromIso)
    .lt('started_at', range.toIso)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error || !data) {
    console.error('getSubmissionAttempts error:', error?.message);
    return { rows: [], failed: true, truncated: false };
  }
  const rows = data as unknown as SubmissionAttemptRow[];
  return { rows, failed: false, truncated: rows.length >= limit };
}

export async function getOpenAttempts(
  supabase: SupabaseClient,
  limit = OPEN_ATTEMPT_LIMIT
): Promise<AttemptQueryResult> {
  const { data, error } = await supabase
    .from('submission_attempts')
    .select(ATTEMPT_COLUMNS)
    .eq('outcome', IN_PROGRESS)
    .order('started_at', { ascending: true })
    .limit(limit);

  if (error || !data) {
    console.error('getOpenAttempts error:', error?.message);
    return { rows: [], failed: true, truncated: false };
  }
  const rows = data as unknown as SubmissionAttemptRow[];
  return { rows, failed: false, truncated: rows.length >= limit };
}

export interface SubmissionLookups {
  users: SubmissionUser[];
  orgs: SubmissionOrg[];
}

/** Agent and organization names. A failed lookup leaves the rows readable as "Unknown". */
export async function getSubmissionLookups(
  supabase: SupabaseClient,
  rows: SubmissionAttemptRow[]
): Promise<SubmissionLookups> {
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((v): v is string => !!v))];
  const orgIds = [...new Set(rows.map((r) => r.organization_id).filter((v): v is string => !!v))];

  let users: SubmissionUser[] = [];
  let orgs: SubmissionOrg[] = [];

  if (userIds.length > 0) {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, display_name')
      .in('id', userIds);
    if (error) console.error('getSubmissionLookups users error:', error.message);
    else users = (data ?? []) as SubmissionUser[];
  }
  if (orgIds.length > 0) {
    const { data, error } = await supabase.from('organizations').select('id, name').in('id', orgIds);
    if (error) console.error('getSubmissionLookups organizations error:', error.message);
    else orgs = (data ?? []) as SubmissionOrg[];
  }
  return { users, orgs };
}
