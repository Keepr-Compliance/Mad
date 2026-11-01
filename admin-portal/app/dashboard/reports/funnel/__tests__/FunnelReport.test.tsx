/**
 * Paywall Funnel report — render tests (BACKLOG-3722, T4 / R4)
 *
 * Static render, no router: `FunnelReport` takes navigation as a prop.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { computeFunnel } from '@/lib/funnel-analytics';
import { resolveFunnelPeriod } from '@/lib/reports/funnel-period';
import { ALL_TIME_ROWS, LAST_30_ROWS, NOW } from '@/lib/reports/__tests__/funnel.fixture';
import { EMPTY_TEXT, EXCEEDS_TEXT, FAILED_TEXT, FunnelReport, type FunnelReportProps } from '../FunnelReport';

const THIRTY = resolveFunnelPeriod({}, NOW);

function html(over: Partial<FunnelReportProps> = {}) {
  return renderToStaticMarkup(
    <FunnelReport funnel={computeFunnel(ALL_TIME_ROWS)} period={THIRTY} rowCap={20000} {...over} />
  );
}

const attr = (markup: string, name: string, id: string) =>
  markup.match(new RegExp(`${name}="${id}"[^>]*>([^<]+)<`))?.[1];

const EMPTY_START = EMPTY_TEXT.slice(0, 40);

describe('tiles', () => {
  it('each step tile shows its distinct-user count, in funnel order', () => {
    const markup = html();
    expect(attr(markup, 'data-tile-value', 'paywall-viewed')).toBe('14');
    expect(attr(markup, 'data-tile-value', 'unlock-clicked')).toBe('2');
    expect(attr(markup, 'data-tile-value', 'payment-succeeded')).toBe('2');
    expect(attr(markup, 'data-tile-value', 'export-completed')).toBe('14');
    const order = [...markup.matchAll(/data-tile="([a-z-]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['paywall-viewed', 'unlock-clicked', 'payment-succeeded', 'export-completed']);
  });

  it('the badges carry % of prev and % of top, including a raw value above 100', () => {
    const markup = html();
    expect(attr(markup, 'data-conv-prev', 'unlock-clicked')).toBe('14.3% of prev');
    expect(attr(markup, 'data-conv-top', 'unlock-clicked')).toBe('14.3% of top');
    expect(attr(markup, 'data-conv-prev', 'payment-succeeded')).toBe('100% of prev');
    expect(attr(markup, 'data-conv-prev', 'export-completed')).toBe('700% of prev');
    expect(attr(markup, 'data-conv-top', 'export-completed')).toBe('100% of top');
    expect(markup).not.toContain('data-conv-prev="paywall-viewed"');
  });

  it('the >100% note shows on the 30-day shape (6 exports > 0 payments)', () => {
    const markup = html({ funnel: computeFunnel(LAST_30_ROWS) });
    expect(markup).toContain('data-note="exceeds-previous"');
    expect(markup).toContain(EXCEEDS_TEXT.slice(0, 40));
    expect(attr(markup, 'data-conv-top', 'export-completed')).toBe('120% of top');
  });

  it('an all-zero result shows the empty state and no tiles', () => {
    const markup = html({ funnel: computeFunnel([]) });
    expect(markup).toContain(EMPTY_START);
    expect(markup).not.toContain('data-tile=');
  });

  it('the caption names the period', () => {
    expect(html()).toContain('Every card and bar follows the period: Last 30 days');
  });
});

describe('failure and truncation (R4)', () => {
  it('failed shows the banner and NOT the empty state, even when every count is zero', () => {
    expect(html()).not.toContain('data-banner="events-failed"');
    const markup = html({ funnel: computeFunnel([]), failed: true });
    expect(markup).toContain('data-banner="events-failed"');
    expect(markup).toContain(FAILED_TEXT.split(' — ')[0]);
    expect(markup).not.toContain(EMPTY_START);
    expect(markup).not.toContain('data-tile=');
  });

  it('truncated renders the notice with the cap; not truncated does not', () => {
    expect(html()).not.toContain('data-notice="truncated"');
    const markup = html({ truncated: true });
    expect(markup).toContain('data-notice="truncated"');
    expect(markup).toContain('at most 20000 events');
  });
});
