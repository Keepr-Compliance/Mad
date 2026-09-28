/**
 * The versions of one deal — BACKLOG-3597.
 *
 * Walks parent_submission_id up (older versions) and down (newer versions)
 * from the version being viewed, bounded like the page's history walk. A newer
 * version still uploading is not a version yet (lib/submissions/dealList.ts
 * uses the same rule for the list's head), and a version the viewer cannot read
 * simply ends the walk.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const VERSION_COLUMNS = 'id, version, status, created_at, parent_submission_id';

const MAX_DEPTH = 10;

export interface VersionRow {
  id: string;
  version: number | null;
  status: string | null;
  created_at: string | null;
  parent_submission_id: string | null;
}

export interface VersionLink {
  id: string;
  /** The stored version number, or the position in the chain when it is null. */
  number: number;
  status: string | null;
  createdAt: string | null;
}

export interface VersionChain {
  /** Older versions, oldest first. */
  previous: VersionLink[];
  /** The newest version when the one viewed is not it; otherwise null. */
  newest: VersionLink | null;
}

export async function loadVersionChain(
  client: SupabaseClient,
  current: VersionRow,
): Promise<VersionChain> {
  const older: VersionRow[] = [];
  let parentId = current.parent_submission_id;
  const seen = new Set<string>([current.id]);
  while (parentId && older.length < MAX_DEPTH && !seen.has(parentId)) {
    const { data } = await client
      .from('transaction_submissions')
      .select(VERSION_COLUMNS)
      .eq('id', parentId)
      .maybeSingle();
    const row = data as VersionRow | null;
    if (!row) break;
    seen.add(row.id);
    older.unshift(row);
    parentId = row.parent_submission_id;
  }

  const newer: VersionRow[] = [];
  let tipId = current.id;
  while (newer.length < MAX_DEPTH) {
    const { data } = await client
      .from('transaction_submissions')
      .select(VERSION_COLUMNS)
      .eq('parent_submission_id', tipId)
      .neq('status', 'uploading')
      .order('created_at', { ascending: false })
      .limit(1);
    const row = ((data ?? []) as VersionRow[])[0];
    if (!row || seen.has(row.id)) break;
    seen.add(row.id);
    newer.push(row);
    tipId = row.id;
  }

  const chain = [...older, current, ...newer];
  const links = chain.map((r, i) => ({
    id: r.id,
    number: r.version ?? i + 1,
    status: r.status,
    createdAt: r.created_at,
  }));
  const at = older.length;
  return {
    previous: links.slice(0, at),
    newest: newer.length > 0 ? links[links.length - 1] : null,
  };
}
