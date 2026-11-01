'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, FileBarChart2 } from 'lucide-react';
import { SegmentedTabs } from '@keepr/ui';
import { reportHref, type ReportEntry } from '@/lib/reports/registry';
import {
  REPORTS_INDEX_PANEL_ID,
  REPORTS_VIEW_PARAM,
  parseReportsIndexView,
  reportsViewCookie,
  type ReportsIndexView,
} from './reportsIndexView';

const VIEW_ITEMS = [
  { value: 'cards', label: 'Cards' },
  { value: 'list', label: 'List' },
];

/**
 * Reports index body (BACKLOG-4091): header, Cards | List toggle and the one
 * panel. The page resolves the starting layout on the server (?view, then the
 * cookie, then Cards), so the first paint is already the chosen layout.
 * Switching writes the cookie and updates `view` in the URL in place; it never
 * navigates. Both layouts render the same `reports` array, in its order.
 */
export function ReportsIndex({
  reports,
  initialView,
}: {
  reports: ReportEntry[];
  initialView: ReportsIndexView;
}) {
  const [view, setView] = useState<ReportsIndexView>(initialView);

  const onViewChange = (value: string) => {
    const next = parseReportsIndexView(value);
    if (!next) return;
    setView(next);
    document.cookie = reportsViewCookie(next);
    const url = new URL(window.location.href);
    url.searchParams.set(REPORTS_VIEW_PARAM, next);
    window.history.replaceState(null, '', url);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start gap-3 md:justify-between">
        <div className="flex items-center gap-3">
          <FileBarChart2 className="h-7 w-7 shrink-0 text-primary-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
            <p className="text-sm text-gray-500">
              Focused views over production data, built to answer one question each.
            </p>
          </div>
        </div>
        <div className="w-full md:w-auto">
          <SegmentedTabs
            items={VIEW_ITEMS}
            value={view}
            onValueChange={onViewChange}
            ariaLabel="Report layout"
            panelId={REPORTS_INDEX_PANEL_ID}
            className="inline-flex"
          />
        </div>
      </div>

      <div
        role="tabpanel"
        id={REPORTS_INDEX_PANEL_ID}
        aria-label={view === 'list' ? 'Reports, list view' : 'Reports, card view'}
      >
        {view === 'list' ? (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left font-semibold text-gray-700">
                    Report
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold text-gray-700">
                    What it answers
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-semibold text-gray-700 max-md:hidden">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {reports.map((report) => (
                  <tr key={report.slug} className="align-top">
                    <td className="px-4 py-3 font-medium">
                      <Link
                        href={reportHref(report.slug)}
                        className="text-primary-700 hover:text-primary-900 hover:underline"
                      >
                        {report.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{report.description}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 max-md:hidden">
                      <code className="text-xs">{report.source}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div data-view="cards" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {reports.map((report) => (
              <Link
                key={report.slug}
                href={reportHref(report.slug)}
                className="group rounded-lg border border-gray-200 bg-white p-6 shadow-sm transition-all hover:border-gray-300 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-lg font-semibold text-gray-900">{report.title}</h2>
                  <ChevronRight className="h-5 w-5 shrink-0 text-gray-400 group-hover:text-gray-900" />
                </div>
                <p className="mt-2 text-sm text-gray-600">{report.description}</p>
                <p className="mt-3 text-xs text-gray-400">
                  Source: <code className="text-xs">{report.source}</code>
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
