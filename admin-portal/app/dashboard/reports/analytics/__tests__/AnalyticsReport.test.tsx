/**
 * Analytics report — render tests (BACKLOG-3723, PLAN T5, SR R4 / R5)
 *
 * Static render, no router. The data comes from the REAL read path
 * (getAnalyticsData over the behaving stub and the synthetic fixture), so the
 * numbers on screen are the numbers the queries produce.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getAnalyticsData, type AnalyticsData } from '@/lib/reports/analytics-queries';
import { resolveAnalyticsPeriod } from '@/lib/reports/analytics-period';
import { stubClient } from '@/lib/reports/__tests__/postgrest-stub';
import { NOW, TABLES } from '@/lib/reports/__tests__/analytics.fixture';
import { AnalyticsReport, FAILED_VALUE, PERIOD_DRIVEN_SECTIONS, type AnalyticsReportProps } from '../AnalyticsReport';
import { VERSIONS_EMPTY_TEXT } from '../components/VersionDistribution';
import { PLATFORM_EMPTY_TEXT } from '../components/PlatformBreakdown';
import { PHONE_EMPTY_TEXT } from '../components/PhoneTypeBreakdown';
import { LICENSE_EMPTY_TEXT } from '../components/LicenseUtilization';

vi.mock('../components/VersionChart', () => ({ VersionChart: () => <div data-chart="versions" /> }));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const THIRTY = resolveAnalyticsPeriod({}, NOW);
let DATA: AnalyticsData;

beforeAll(async () => {
  DATA = await getAnalyticsData(stubClient(TABLES).client, THIRTY.fromIso);
});

function html(over: Partial<AnalyticsReportProps> = {}) {
  return renderToStaticMarkup(<AnalyticsReport data={DATA} period={THIRTY} rowCap={20000} {...over} />);
}

const tile = (markup: string, key: string) => markup.match(new RegExp(`data-tile-value="${key}"[^>]*>([^<]+)<`))?.[1];

/** The markup of one element group, from its marker to the next marker of the same kind. */
function block(markup: string, attr: string, key: string): string {
  const start = markup.indexOf(`${attr}="${key}"`);
  if (start < 0) return '';
  const next = markup.indexOf(`${attr}="`, start + 1);
  return markup.slice(start, next < 0 ? undefined : next);
}

const failedCount = (v: number | null = null) => ({ value: v, failed: true });

describe('tiles', () => {
  it('show the 30-day numbers; the period-driven tiles carry the period label', () => {
    const m = html();
    expect(tile(m, 'active_users')).toBe('6');
    expect(tile(m, 'active_devices')).toBe('9');
    expect(tile(m, 'total_users')).toBe('9');
    expect(tile(m, 'total_orgs')).toBe('5');
    expect(block(m, 'data-tile', 'active_users')).toContain('Last 30 days');
    expect(block(m, 'data-tile', 'active_devices')).toContain('Last 30 days');
    expect(block(m, 'data-tile', 'total_users')).toContain('All time');
  });

  it('a failed count shows an em dash and the counts banner, never a 0', () => {
    const m = html({ data: { ...DATA, counts: { ...DATA.counts, total_orgs: failedCount(), active_devices: failedCount() } } });
    expect(tile(m, 'total_orgs')).toBe(FAILED_VALUE);
    expect(tile(m, 'active_devices')).toBe(FAILED_VALUE);
    expect(tile(m, 'active_users')).toBe('6');
    expect(m).toContain('data-banner="counts-failed"');
  });

  it('no counts banner when every count read', () => {
    expect(html()).not.toContain('data-banner="counts-failed"');
  });
});

describe('sections', () => {
  it('version rows: count and adoption, beta versions after numeric ones (pinned)', () => {
    const m = html();
    const rows = [...m.matchAll(/font-mono[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)<\/span><span[^>]*>(\d+)<\/span>[\s\S]*?(\d+)%/g)].map(
      (r) => [r[1], r[2], r[3]]
    );
    expect(rows).toEqual([
      ['2.41.0', '3', '50'],
      ['2.44.0', '2', '33'],
      ['2.40.0-beta.3', '1', '17'],
      ['2.44.0-pre.2', '1', '17'],
      ['Unknown', '1', '17'],
    ]);
    expect(m).toContain('seen in the last 30 days');
  });

  it('platform: the bar uses pct, the legend recomputes over the sum — both pinned as they are', () => {
    const m = html();
    // bar (pct, distinct-user denominator 8): 75 / 38 / 13 / 13
    expect(block(m, 'data-platform-bar', 'windows')).toContain('width:75%');
    expect(block(m, 'data-platform-bar', 'macos')).toContain('width:38%');
    // legend (sum 6+3+1+1 = 11): 55 / 27 / 9 / 9
    expect(block(m, 'data-platform-row', 'windows')).toMatch(/>55%/);
    expect(block(m, 'data-platform-row', 'macos')).toMatch(/>27%/);
    expect(block(m, 'data-platform-row', 'linux')).toMatch(/>9%/);
  });

  it('R4: macos shows macOS in blue and windows shows Windows in purple; counts unchanged', () => {
    const m = html();
    expect(block(m, 'data-platform-row', 'macos')).toContain('>macOS<');
    expect(block(m, 'data-platform-row', 'macos')).toContain('background-color:#0ea5e9');
    expect(block(m, 'data-platform-bar', 'macos')).toContain('background-color:#0ea5e9');
    expect(block(m, 'data-platform-row', 'windows')).toContain('>Windows<');
    expect(block(m, 'data-platform-row', 'windows')).toContain('background-color:#8b5cf6');
    expect(block(m, 'data-platform-row', 'macos')).toContain('>3 users<');
    expect(block(m, 'data-platform-row', 'windows')).toContain('>6 users<');
  });

  it('R4: darwin and win32 still map to macOS and Windows', () => {
    const platform = {
      data: [
        { platform: 'win32', user_count: 2, pct: 67 },
        { platform: 'darwin', user_count: 1, pct: 33 },
      ],
      failed: false,
      truncated: false,
    };
    const m = html({ data: { ...DATA, platform } });
    expect(block(m, 'data-platform-row', 'darwin')).toContain('>macOS<');
    expect(block(m, 'data-platform-row', 'darwin')).toContain('background-color:#0ea5e9');
    expect(block(m, 'data-platform-row', 'win32')).toContain('>Windows<');
    expect(block(m, 'data-platform-row', 'win32')).toContain('background-color:#8b5cf6');
  });

  it('phone type and licence numbers', () => {
    const m = html();
    expect(block(m, 'data-phone-row', 'iphone')).toMatch(/>50%/);
    expect(block(m, 'data-phone-row', 'Not set')).toMatch(/>33%/);
    expect(block(m, 'data-plan-row', 'trial')).toContain('3 / 8 seats (38%)');
    expect(block(m, 'data-plan-row', 'enterprise')).toContain('3 / 50 seats (6%)');
  });
});

describe('failed beats empty (every section)', () => {
  const empty = { data: [], failed: true, truncated: false };
  it.each([
    ['versions', VERSIONS_EMPTY_TEXT, { versions: { ...empty, namesFailed: false } }],
    ['platform', PLATFORM_EMPTY_TEXT, { platform: empty }],
    ['phone', PHONE_EMPTY_TEXT, { phone: empty }],
    ['license', LICENSE_EMPTY_TEXT, { license: empty }],
  ] as const)('%s: banner, not the empty text', (section, emptyText, patch) => {
    const m = html({ data: { ...DATA, ...patch } as AnalyticsData });
    expect(m).toContain(`data-banner="${section}-failed"`);
    expect(m).not.toContain(emptyText.slice(0, 30));
  });

  it('empty and not failed: the empty text, no banner', () => {
    const none = { data: [], failed: false, truncated: false };
    const m = html({ data: { ...DATA, platform: none, phone: none, license: none, versions: { ...none, namesFailed: false } } });
    expect(m).toContain(PLATFORM_EMPTY_TEXT);
    expect(m).toContain(PHONE_EMPTY_TEXT);
    expect(m).toContain(LICENSE_EMPTY_TEXT);
    expect(m).toContain(VERSIONS_EMPTY_TEXT.slice(0, 30));
    expect(m).not.toContain('-failed"');
  });

  it('truncated shows the notice', () => {
    expect(html()).not.toContain('data-notice="truncated"');
    expect(html({ data: { ...DATA, platform: { ...DATA.platform, truncated: true } } })).toContain('data-notice="truncated"');
  });
});

describe('R5 / R3 period controls', () => {
  it('the caption names exactly the three period-driven sections', () => {
    expect([...PERIOD_DRIVEN_SECTIONS]).toEqual(['Active Users', 'Active Devices', 'Active Users by App Version']);
    expect(html()).toContain(
      'The period drives Active Users, Active Devices, Active Users by App Version only; every other number is all-time: Last 30 days'
    );
  });

  it('the picker shows the period and no custom range', () => {
    const m = html();
    // Closed dropdown: only the current value renders; the option list is pinned in analytics-period.test.ts.
    expect(m).toMatch(/-value" class="truncate">30d</);
    expect(m).not.toMatch(/Custom/i);
    expect(m).not.toContain('type="date"');
  });
});
