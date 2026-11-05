/**
 * Test helper (BACKLOG-4144): a render wrapper that puts the open report's access in context, as
 * the server page does. 'owner' keeps the 4087 sharing tests on the path they were written for.
 */

import type { ReactNode } from 'react';
import { ReportAccessProvider } from '../report-access-context';
import type { ReportAccess } from '../report-access';

export function withReportAccess(access: ReportAccess, reportKey = 'test-report', title = 'Test report') {
  return function ReportAccessWrapper({ children }: { children: ReactNode }) {
    return (
      <ReportAccessProvider reportKey={reportKey} title={title} access={access}>
        {children}
      </ReportAccessProvider>
    );
  };
}
