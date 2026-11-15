'use client';

/**
 * The signed-in user's access to one report key, for the sidebar (BACKLOG-4186, generalised in
 * BACKLOG-4219 for the AI section's second page).
 *
 * `report_my_access(key)` from the browser (signed-in session) client. Null until it has answered,
 * and null when it answers NULL or cannot be read, so a link never shows for someone the page would
 * turn away. Presentation only; the server functions are the access guard.
 */

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseReportAccess, type ReportAccess } from './report-access';

export function useReportAccess(reportKey: string, userId: string | null | undefined): ReportAccess | null {
  const [access, setAccess] = useState<ReportAccess | null>(null);

  useEffect(() => {
    let live = true;
    setAccess(null);
    if (!userId) return;
    (async () => {
      try {
        const { data, error } = await createClient().rpc('report_my_access', { p_key: reportKey });
        if (live) setAccess(error ? null : parseReportAccess(data));
      } catch {
        if (live) setAccess(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [reportKey, userId]);

  return access;
}
