'use client';

/**
 * Does the signed-in user have any report? (BACKLOG-4144)
 *
 * For the sidebar's Reports link: `report_list_my_reports` from the browser client, Reports-registry
 * keys only (BACKLOG-4186: sender-rules is in the AI section). False until the
 * list has loaded, and false when it is empty or cannot be read, so the link never shows for someone
 * the Reports page would turn away. Presentation only; the server functions are the access guard.
 */

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseMyReports } from './report-access';
import { registeredReportsOnly } from './registry';

export function useHasReports(userId: string | null | undefined): boolean {
  const [hasReports, setHasReports] = useState(false);

  useEffect(() => {
    let live = true;
    if (!userId) {
      setHasReports(false);
      return;
    }
    (async () => {
      try {
        const { data, error } = await createClient().rpc('report_list_my_reports');
        if (live) setHasReports(!error && registeredReportsOnly(parseMyReports(data)).length > 0);
      } catch {
        if (live) setHasReports(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  return hasReports;
}
