'use client';

/**
 * The signed-in user's access to the sender rules, for the sidebar's AI section (BACKLOG-4186).
 *
 * `report_my_access('sender-rules')` from the browser (signed-in session) client. Null until it
 * has answered, and null when it answers NULL or cannot be read, so the link never shows for
 * someone the page would turn away. Presentation only; the server functions are the access guard.
 */

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { parseReportAccess, type ReportAccess } from '@/lib/reports/report-access';
import { SENDER_RULES_REPORT_KEY } from './access';

export function useSenderRulesAccess(userId: string | null | undefined): ReportAccess | null {
  const [access, setAccess] = useState<ReportAccess | null>(null);

  useEffect(() => {
    let live = true;
    setAccess(null);
    if (!userId) return;
    (async () => {
      try {
        const { data, error } = await createClient().rpc('report_my_access', { p_key: SENDER_RULES_REPORT_KEY });
        if (live) setAccess(error ? null : parseReportAccess(data));
      } catch {
        if (live) setAccess(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [userId]);

  return access;
}
