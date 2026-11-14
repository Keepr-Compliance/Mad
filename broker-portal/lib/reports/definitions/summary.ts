/**
 * Reports index: the one-line row summaries — BACKLOG-3513 PR-3g.
 *
 * PURE (no Supabase, no React). Inputs are what lib/reports/definitions/server.ts
 * already parsed: broker_report_share_list (parseShareState) for the caller's
 * own reports, and broker_report_def_list / _orphans for the rest.
 */

import type { ReportLevel, ShareState } from '@/lib/reports/definitions/parse';

export const ONLY_YOU = 'Only you';
/** Index subtitles: full roles see every deal, an agent only their own. */
export const FULL_SUBTITLE = 'Reports you made and reports shared with you.';
export const AGENT_SUBTITLE = 'You see only your own deals in every report.';
export const EACH_SEES_OWN = 'Each sees their own';
const SEP = ' · ';

/** "A", "A and B", "A, B and C". */
function joinParts(parts: readonly string[]): string {
  return parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * A report the caller owns. null when its sharing could not be read: the row
 * then shows no summary, never "Only you".
 *
 * Row scope "own" narrows only the people it is shared with, so "Each sees
 * their own" is said only when the report is actually shared.
 */
export function myReportSummary(
  sharing: Pick<ShareState, 'generalAccess' | 'rowScope' | 'entries'> | null,
  orgName: string
): string | null {
  if (!sharing) return null;
  let text: string;
  if (sharing.generalAccess === 'organization') {
    text = `Shared with everyone in ${orgName}`;
  } else if (sharing.entries.length === 0) {
    return ONLY_YOU;
  } else {
    const roles = sharing.entries.filter((e) => e.kind === 'role').map((e) => e.name);
    const people = sharing.entries.filter((e) => e.kind === 'person').length;
    const parts = people > 0 ? [...roles, people === 1 ? '1 person' : `${people} people`] : roles;
    text = `Shared with ${joinParts(parts)}`;
  }
  return sharing.rowScope === 'own' ? `${text}${SEP}${EACH_SEES_OWN}` : text;
}

const LEVEL_TEXT: Record<Exclude<ReportLevel, 'owner'>, string> = { editor: 'Can edit', viewer: 'Can view' };
const OWNER_STATE_TEXT = { gone: "Owner's account removed", deactivated: 'Owner deactivated' } as const;

/** A report someone else owns and shared with the caller. */
export function sharedWithMeSummary(item: {
  ownerName: string;
  level: 'editor' | 'viewer';
  ownerState: keyof typeof OWNER_STATE_TEXT | null;
}): string {
  const parts = [`From ${item.ownerName.trim() || 'a former member'}`, LEVEL_TEXT[item.level]];
  if (item.ownerState) parts.push(OWNER_STATE_TEXT[item.ownerState]);
  return parts.join(SEP);
}

function parseTime(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * "Updated today" / "Updated Nov 10" (the year is added when it is not the
 * current one). Dates are UTC: the page renders on the server. null when the
 * time is missing or unreadable: the row then shows no date.
 */
export function formatUpdated(iso: unknown, now: Date): string | null {
  const t = parseTime(iso);
  if (t === null) return null;
  const d = new Date(t);
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  if (sameYear && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate()) return 'Updated today';
  const label = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
  return `Updated ${label}`;
}

/** Newest-updated first; rows with no readable time go last, in their original order. */
export function sortByUpdated<T extends { updatedAt?: string }>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i, t: parseTime(row.updatedAt) }))
    .sort((a, b) => {
      if (a.t === null || b.t === null) return a.t === b.t ? a.i - b.i : a.t === null ? 1 : -1;
      return b.t - a.t || a.i - b.i;
    })
    .map((x) => x.row);
}
