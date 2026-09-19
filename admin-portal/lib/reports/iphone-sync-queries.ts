/**
 * iPhone Sync Performance — data access (BACKLOG-3441)
 *
 * Follows the pattern in `lib/analytics-queries.ts`: minimal select, then a
 * second lookup for user display fields. Cross-org read access to
 * `sync_outcomes` comes from the "Internal roles can read sync outcomes" RLS
 * policy, so this needs the authenticated server client, not the service role.
 *
 * Kept separate from `analytics-queries.ts` on purpose — that file has an open
 * PR against it (#2572) and this change should not touch it.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { IN_PROGRESS_OUTCOME } from './iphone-sync';
import type { ReportUser, SyncOutcomeRow } from './iphone-sync';

/** Columns this report reads. Adding a column is additive — nothing breaks. */
const RUN_COLUMNS = [
  'id',
  'user_id',
  'created_at',
  'source',
  'outcome',
  'elapsed_ms',
  'phases',
  'prior_backup',
  'incremental',
  'was_encrypted',
  'device_model',
  'device_ios_version',
  'device_used_bytes',
  'backup_bytes',
  'backup_bytes_unmeasured',
  'messages_extracted',
  'conversations_extracted',
  'contacts_extracted',
  'app_version',
  'platform',
  'is_packaged',
].join(', ');

/**
 * The table is tiny today (19 rows). The cap exists so this page cannot become
 * a full-table scan now that BACKLOG-3440 writes a row per run start.
 */
export const RUN_LIMIT = 200;

export interface IphoneSyncData {
  rows: SyncOutcomeRow[];
  users: ReportUser[];
  /** True when the query itself failed — distinct from "there are no runs". */
  failed: boolean;
}

export async function getIphoneSyncRuns(
  supabase: SupabaseClient,
  limit = RUN_LIMIT
): Promise<IphoneSyncData> {
  // The `running` exclusion is here as well as in `buildIphoneSyncReport`, and
  // the two filters do different jobs. This one keeps the RUN_LIMIT window
  // meaningful: rows are ordered newest-first, and runs in flight are the
  // newest rows there are, so without it a burst of live syncs would fill the
  // window and push finished runs off the page entirely. The one in the
  // derivation makes the model correct for whatever rows it is handed, and is
  // the layer the unit tests exercise.
  const { data: rows, error } = await supabase
    .from('sync_outcomes')
    .select(RUN_COLUMNS)
    .eq('source', 'iphone-backup')
    .neq('outcome', IN_PROGRESS_OUTCOME)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !rows) {
    console.error('getIphoneSyncRuns error:', error?.message);
    return { rows: [], users: [], failed: true };
  }

  const runs = rows as unknown as SyncOutcomeRow[];

  const userIds = [...new Set(runs.map((r) => r.user_id).filter((id): id is string => !!id))];
  if (userIds.length === 0) {
    return { rows: runs, users: [], failed: false };
  }

  const { data: usersData, error: usersError } = await supabase
    .from('users')
    .select('id, email, display_name')
    .in('id', userIds);

  if (usersError) {
    // Runs still render; they just say "Unknown user".
    console.error('getIphoneSyncRuns users error:', usersError.message);
    return { rows: runs, users: [], failed: false };
  }

  return { rows: runs, users: (usersData ?? []) as ReportUser[], failed: false };
}
