/**
 * BarChart SVG-structure snapshots (BACKLOG-4208, control 4).
 *
 * Inputs are transcribed from the admin iPhone Sync report (see
 * chart-fixtures.ts). These snapshots were written only after the same inputs
 * rendered identically through the admin <SyncCharts>; a change to the
 * geometry reds them.
 */
import * as React from 'react';
import { renderToStaticMarkup } from './test-ssr';
import { BarChart } from './bar-chart';
import { durationData, DURATION_SERIES, failureData, FAILURE_SERIES, FIXTURE_NAMES, minuteTick } from './chart-fixtures';

/** The <svg> only, with useId's generated ids made stable, one element per line. */
function structure(html: string): string {
  const svg = html.split('</svg>')[0] + '</svg>';
  const ids = new Map<string, string>();
  return svg
    .replace(/(:[rR][0-9a-zA-Z]+:)/g, (id) => {
      if (!ids.has(id)) ids.set(id, `:id${ids.size}:`);
      return ids.get(id)!;
    })
    .replace(/></g, '>\n<');
}

describe.each(FIXTURE_NAMES)('%s', (name) => {
  it('duration (single) structure', () => {
    const html = renderToStaticMarkup(
      <BarChart title="Average duration" data={durationData(name)} series={DURATION_SERIES} formatTick={minuteTick} />
    );
    expect(structure(html)).toMatchSnapshot();
  });

  it('failures (stacked) structure', () => {
    const html = renderToStaticMarkup(
      <BarChart title="Failed syncs" mode="stacked" data={failureData(name)} series={FAILURE_SERIES} />
    );
    expect(structure(html)).toMatchSnapshot();
  });
});
