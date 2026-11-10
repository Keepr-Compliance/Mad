import { MailX } from 'lucide-react';
import { requireReportAccess } from '@/lib/reports/report-gate';
import { ReportAccessProvider } from '@/lib/reports/report-access-context';
import { ReportShareButton } from '@/components/reports/ReportShareButton';
import { createSenderRulesApi } from '@/lib/sender-rules/api';
import { canEditSenderRules, SENDER_RULES_REPORT_KEY } from '@/lib/sender-rules/access';
import { loadSenderRules } from '@/lib/sender-rules/load';
import { parseOrgList, type OrgListResult } from '@/lib/sender-rules/orgs';
import { SenderRulesView } from './SenderRulesView';

export const dynamic = 'force-dynamic';

/**
 * Sender rules — Admin Portal, AI section (BACKLOG-4186).
 *
 * Server component, in this order:
 *   1. requireReportAccess('sender-rules'): no grant, or an unreadable answer, is notFound();
 *      nothing is read before it.
 *   2. The state and the released content, through the signed-in session client the gate returns
 *      (never the service key: the RPCs gate on auth.uid()).
 *   3. The org list, for the owner only (the only one who can publish to a test org).
 * Any grant reads; only the owner (a Super Admin) gets write controls. The server functions are
 * the enforcement.
 */
export default async function SenderRulesPage() {
  const { supabase, access } = await requireReportAccess(SENDER_RULES_REPORT_KEY);

  const load = await loadSenderRules(createSenderRulesApi(supabase));

  let orgs: OrgListResult | null = null;
  if (canEditSenderRules(access) && load.ok) {
    const { data, error } = await supabase.rpc('admin_list_organizations');
    orgs = parseOrgList(data, error);
  }

  return (
    <ReportAccessProvider reportKey={SENDER_RULES_REPORT_KEY} title="Sender rules" access={access}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <MailX className="h-7 w-7 text-primary-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Sender rules</h1>
              <p className="text-sm text-gray-500">
                Which senders the desktop app hides or keeps, and where each rule is live.
              </p>
            </div>
          </div>
          <ReportShareButton />
        </div>
        <SenderRulesView
          key={load.ok ? load.state.released_version : 'unreadable'}
          access={access}
          load={load}
          orgs={orgs}
        />
      </div>
    </ReportAccessProvider>
  );
}
