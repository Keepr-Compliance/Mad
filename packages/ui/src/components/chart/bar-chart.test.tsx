/**
 * BarChart (BACKLOG-4208): controls 1, 2, 3 and 5 of PLAN v1.
 */
import * as React from 'react';
import { renderToStaticMarkup } from './test-ssr';
import { render, screen, within } from '@testing-library/react';
import { BarChart } from './bar-chart';
import { NO_DATA_TEXT } from './chart-data-table';
import type { ChartDatum, ChartSeries } from './types';
import { durationData, DURATION_SERIES, EXPORT_SERIES, failureData, FAILURE_SERIES, minuteTick } from './chart-fixtures';

const ONE: ChartSeries[] = [{ key: 'n', label: 'Count' }];

function days(values: Array<number | null>): ChartDatum[] {
  return values.map((v, i) => ({ key: `2026-09-${String(10 + i)}`, label: `Sep ${10 + i}`, values: { n: v } }));
}

function svgOf(html: string): string {
  return html.split('</svg>')[0];
}

const paths = (html: string) => [...svgOf(html).matchAll(/<path [^>]*\bd="([^"]*)"/g)].map((m) => m[1]);
const pathWidth = (d: string) => {
  const nums = d.match(/-?[\d.]+/g)!.map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  return Math.max(...xs) - Math.min(...xs);
};
const pathHeight = (d: string) => {
  const ys = d.match(/-?[\d.]+/g)!.map(Number).filter((_, i) => i % 2 === 1);
  return Math.max(...ys) - Math.min(...ys);
};

describe('control 1: no duplicate React keys', () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  const keyWarnings = () =>
    spy.mock.calls.filter((args) => args.some((a: unknown) => typeof a === 'string' && /same key|unique "key"/.test(a)));

  it.each([
    ['all zero', days([0, 0, 0])],
    ['all null', days([null, null, null])],
    ['no categories', [] as ChartDatum[]],
  ])('renders %s without a key warning', (_name, data) => {
    render(<BarChart title="Zero" data={data} series={ONE} />);
    render(<BarChart title="Zero stacked" mode="stacked" data={failureData('DAYS_EMPTY')} series={FAILURE_SERIES} />);
    expect(keyWarnings()).toEqual([]);
  });
});

describe('control 2: static render', () => {
  it('renders the whole chart with renderToStaticMarkup', () => {
    const html = renderToStaticMarkup(
      <BarChart title="Failed syncs" mode="stacked" chartId="failures" data={failureData('DAYS_7')} series={FAILURE_SERIES} />
    );
    expect(html).toContain('viewBox="0 0 600 200"');
    expect(html).toContain('width="100%"');
    expect(html).toContain('data-chart="failures"');
    expect(html.match(/data-day="/g)).toHaveLength(7);
    // 5 failure days; Sep 16 and Sep 17 have one series, the other three have two.
    expect(paths(html)).toHaveLength(8);
  });

  it('renders a single-mode chart: one path per non-null day', () => {
    const html = renderToStaticMarkup(
      <BarChart title="Duration" data={durationData('DAYS_30')} series={DURATION_SERIES} formatTick={minuteTick} />
    );
    expect(html.match(/data-day="/g)).toHaveLength(30);
    expect(paths(html)).toHaveLength(5);
    expect([...html.matchAll(/data-value="([^"]+)"/g)].map((m) => Number(m[1]))).toEqual([16.2, 17.1, 181.7, 1, 19]);
  });

  it('carries no tooltip in static markup', () => {
    const html = renderToStaticMarkup(<BarChart title="t" data={days([1, 2])} series={ONE} />);
    expect(html).not.toContain('role="tooltip"');
  });
});

describe('control 3: axis boundaries', () => {
  const noBadNumbers = (html: string) => {
    expect(html).not.toMatch(/NaN/);
    expect(html).not.toMatch(/Infinity/);
  };

  it.each([
    ['single', days([0, 0, 0]), ONE],
    ['stacked', failureData('DAYS_EMPTY'), FAILURE_SERIES],
    [
      'nested',
      days([0, 0]).map((d) => ({ ...d, values: { exports: 0, unique: 0 } })),
      EXPORT_SERIES,
    ],
  ] as const)('max 0 in %s mode: no bars, no NaN or Infinity', (mode, data, series) => {
    const html = renderToStaticMarkup(
      <BarChart title="t" mode={mode} data={[...data]} series={[...series]} />
    );
    expect(paths(html)).toEqual([]);
    expect(html).not.toContain('data-value');
    noBadNumbers(html);
    expect(html.match(/<line /g)).toHaveLength(3);
  });

  it('caps a single category bar at 28px', () => {
    const html = renderToStaticMarkup(<BarChart title="t" data={days([5])} series={ONE} />);
    const [d] = paths(html);
    expect(pathWidth(d)).toBe(28);
    expect(pathHeight(d)).toBe(160);
    noBadNumbers(html);
  });

  it('gives all-equal values equal full height', () => {
    const html = renderToStaticMarkup(<BarChart title="t" data={days([3, 3, 3, 3])} series={ONE} />);
    const heights = paths(html).map(pathHeight);
    expect(heights).toEqual([160, 160, 160, 160]);
  });

  it('draws no bar for null, but keeps the column', () => {
    const html = renderToStaticMarkup(<BarChart title="t" data={days([4, null, 2])} series={ONE} />);
    expect(paths(html)).toHaveLength(2);
    expect(html.match(/data-day="/g)).toHaveLength(3);
    expect([...html.matchAll(/data-value="([^"]+)"/g)].map((m) => m[1])).toEqual(['4', '2']);
  });

  it('hides value labels when asked', () => {
    const html = renderToStaticMarkup(<BarChart title="t" data={days([4])} series={ONE} showValueLabels={false} />);
    expect(html).not.toMatch(/font-size="11"/);
  });
});

describe('modes', () => {
  it('nested: inner bar is half width, carries its own data-series and data-value', () => {
    const data = days([10, 8]).map((d, i) => ({ ...d, values: { exports: i === 0 ? 10 : 8, unique: i === 0 ? 4 : 0 } }));
    const html = renderToStaticMarkup(<BarChart title="t" mode="nested" chartId="exports" data={data} series={EXPORT_SERIES} />);
    const ds = paths(html);
    expect(ds).toHaveLength(3);
    expect(pathWidth(ds[1])).toBe(14);
    expect(html.match(/data-series="unique"/g)).toHaveLength(1);
    expect(html.match(/data-series="exports"/g)).toHaveLength(2);
  });

  it('stacked: segments carry data-series but no data-value', () => {
    const html = renderToStaticMarkup(
      <BarChart title="t" mode="stacked" data={failureData('DAYS_7')} series={FAILURE_SERIES} />
    );
    expect(html).not.toContain('data-value');
    expect(html.match(/data-series="errors"/g)).toHaveLength(4);
    expect(html.match(/data-series="cancelled"/g)).toHaveLength(4);
  });
});

describe('control 5: accessibility', () => {
  it('names the svg from its <title> and <desc>', () => {
    render(
      <BarChart
        title="Failed syncs per day"
        desc="Errors and cancels, stacked."
        mode="stacked"
        data={failureData('DAYS_7')}
        series={FAILURE_SERIES}
      />
    );
    const svg = screen.getByRole('img');
    const ids = svg.getAttribute('aria-labelledby')!.split(' ');
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0])!.tagName.toLowerCase()).toBe('title');
    expect(document.getElementById(ids[0])!.textContent).toBe('Failed syncs per day');
    expect(document.getElementById(ids[1])!.tagName.toLowerCase()).toBe('desc');
    expect(document.getElementById(ids[1])!.textContent).toBe('Errors and cancels, stacked.');
  });

  it('gives two charts on one page different title ids', () => {
    render(
      <>
        <BarChart title="A" data={days([1])} series={ONE} />
        <BarChart title="B" data={days([1])} series={ONE} />
      </>
    );
    const [a, b] = screen.getAllByRole('img').map((el) => el.getAttribute('aria-labelledby'));
    expect(a).not.toBe(b);
  });

  it('has a screen-reader table whose rows match the data', () => {
    render(
      <BarChart
        title="Duration"
        data={durationData('DAYS_7')}
        series={DURATION_SERIES}
        formatValue={(v) => v.toFixed(1)}
        categoryHeader="Day"
      />
    );
    const table = screen.getByRole('table', { name: 'Duration' });
    expect(table).toHaveClass('sr-only');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(8);
    expect(within(rows[0]).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Day', 'Average minutes']);
    expect(rows.slice(1).map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ['Sep 13', NO_DATA_TEXT],
      ['Sep 14', '16.2'],
      ['Sep 15', '17.1'],
      ['Sep 16', '181.7'],
      ['Sep 17', '1.0'],
      ['Sep 18', '19.0'],
      ['Sep 19', NO_DATA_TEXT],
    ]);
  });
});
