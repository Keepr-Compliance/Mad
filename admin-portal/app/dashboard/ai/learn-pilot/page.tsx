import { FlaskConical } from 'lucide-react';
import { requireReportAccess } from '@/lib/reports/report-gate';
import { ReportAccessProvider } from '@/lib/reports/report-access-context';
import { ReportShareButton } from '@/components/reports/ReportShareButton';
import { LEARN_PILOT_REPORT_KEY, LEARN_PILOT_SHARE_ROLE_DESCRIPTIONS } from '@/lib/learn-pilot/access';
import { parseAdminList } from '@/lib/learn-pilot/parse';
import { buildViewModel } from '@/lib/learn-pilot/group';
import { LearnPilotView } from './LearnPilotView';

export const dynamic = 'force-dynamic';

/**
 * Learn pilot — Admin Portal, AI section (BACKLOG-4219).
 *
 * Server component, in this order:
 *   1. requireReportAccess('learn-pilot'): no grant, or an unreadable answer, is notFound();
 *      nothing is read before it.
 *   2. learn_pilot_report_admin_list() through the signed-in session client the gate returns.
 *   3. Parse and group HERE, on the server: the view gets a model with no org ids and no
 *      canary-org ids (the props are serialised into the browser payload). The one id it carries
 *      is each pilot user's Keepr user id, which the page shows and links.
 * Every grant only reads. The server function is the enforcement (42501 for anyone else).
 */
export default async function LearnPilotPage() {
  const { supabase, access } = await requireReportAccess(LEARN_PILOT_REPORT_KEY);

  const { data, error } = await supabase.rpc('learn_pilot_report_admin_list');
  const model = buildViewModel(parseAdminList(data, error));

  return (
    <ReportAccessProvider reportKey={LEARN_PILOT_REPORT_KEY} title="Learn pilot" access={access}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <FlaskConical className="h-7 w-7 text-primary-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Learn pilot</h1>
              <p className="text-sm text-gray-500">
                Learn scores from pilot users, per sender-rules version.
              </p>
            </div>
          </div>
          <ReportShareButton roleDescriptions={LEARN_PILOT_SHARE_ROLE_DESCRIPTIONS} />
        </div>
        <LearnPilotView model={model} />
      </div>
    </ReportAccessProvider>
  );
}
