'use client';

/**
 * Activity on the organization page — BACKLOG-4036. Who changed what, newest first: members,
 * roles, licenses, invites, phones and contacts for everyone with organizations.view; deal,
 * seat and suspension rows only with billing.view (admin_get_org_activity filters them).
 * Rows come from the page (server) as props.
 */

import { useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, EmptyState } from '@keepr/design-system';
import { formatTimestamp } from '@/lib/format';
import { activityNote, describeActivity, type ActivityRow } from '@/lib/activity/describeActivity';

/** Rows shown before "Show more". */
export const ACTIVITY_PAGE = 5;

/** `failed`: the reader errored, so say so instead of claiming there is no activity. */
export function OrgActivityCard({ rows, failed = false }: { rows: ActivityRow[]; failed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, ACTIVITY_PAGE);

  return (
    <Card>
      <CardTitle>Activity</CardTitle>
      {failed ? (
        <Alert className="mt-2">Couldn&apos;t load activity.</Alert>
      ) : rows.length === 0 ? (
        <EmptyState card={false} title="No activity yet." />
      ) : (
        <>
          <ul className="mt-2 divide-y divide-gray-100 text-sm">
            {visible.map((row, i) => {
              const note = activityNote(row);
              return (
                <li key={`${row.created_at}-${i}`} className="flex flex-wrap justify-between gap-2 py-2">
                  <span className="flex flex-wrap items-center gap-2 text-gray-900">
                    {describeActivity(row)}
                    {row.actor_is_staff && <Badge hue="primary">Keepr</Badge>}
                    {note && <span className="text-gray-500">— {note}</span>}
                  </span>
                  <span className="text-gray-500">{formatTimestamp(row.created_at)}</span>
                </li>
              );
            })}
          </ul>
          {rows.length > ACTIVITY_PAGE && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-sm text-gray-500">Showing {visible.length} of {rows.length}</p>
              <Button variant="secondary" size="xs" onClick={() => setExpanded(!expanded)}>
                {expanded ? 'Show fewer' : 'Show more'}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
