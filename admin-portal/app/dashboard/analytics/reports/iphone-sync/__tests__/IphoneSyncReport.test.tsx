/**
 * iPhone Sync Performance — render tests (BACKLOG-3441, BACKLOG-3450)
 *
 * DESIGN REVERSAL, recorded deliberately. Round 1's suite asserted
 * `not.toContain('<details')` and `not.toContain('<button')` under the name
 * "hides nothing behind a click", because the founder's round-1 brief was a
 * page that answers its question with no interaction. Round 2 replaces that
 * with filters, a collapsed "How to use this report", sortable headers and a
 * five-row table — every one of them a click. That test is RETIRED, not
 * broken; the authorising feedback is on BACKLOG-3441 (founder comments
 * 15291af5 / 36b6af59 / 35a49f82 / 2bfe9f4a) and BACKLOG-3450's item body.
 *
 * What replaces it is the control the whole page rests on: THE TILES, BOTH
 * CHARTS AND THE TABLE MOVE TOGETHER. `report.counts` still exists and is
 * still correct for the whole period, so wiring the tiles to it is the
 * shortest path to a page that looks finished and lies. That is asserted in
 * ONE test across all three consumers, so no future edit can satisfy it by
 * fixing one of them.
 *
 * These render with no App Router context: `IphoneSyncReport` takes navigation
 * as a prop, and only the six-line `IphoneSyncReportClient` wrapper calls
 * `useRouter`.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildIphoneSyncReport, type SyncOutcomeRow } from '@/lib/reports/iphone-sync';
import { resolvePeriod } from '@/lib/reports/period';
import { DEFAULT_CLIENT_STATE, type ClientState } from '@/lib/reports/report-url';
import {
  derivedRunRows,
  DERIVED_ROWS,
  FIXTURE_ROWS_24,
  FIXTURE_USERS_24,
} from '@/lib/reports/__tests__/iphone-sync.fixture';
import { IphoneSyncReport } from '../IphoneSyncReport';

const NOW = new Date('2026-09-19T22:07:00.000Z');
const THIS_WEEK = resolvePeriod({}, NOW);

function render(
  rows: SyncOutcomeRow[] = FIXTURE_ROWS_24,
  state: Partial<ClientState> = {},
  options: { period?: typeof THIS_WEEK; truncated?: boolean } = {}
): string {
  return renderToStaticMarkup(
    <IphoneSyncReport
      report={buildIphoneSyncReport(rows, FIXTURE_USERS_24)}
      period={options.period ?? THIS_WEEK}
      truncated={options.truncated ?? false}
      rowCap={200}
      initialState={{ ...DEFAULT_CLIENT_STATE, ...state }}
    />
  );
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
  '&#x2F;': '/',
};

/** Strip tags so assertions read against what a person actually sees. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#x27|#39|#x2F);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Identity, not a substring match: which runs the table actually rendered. */
function tableRunIds(html: string): string[] {
  return [...html.matchAll(/data-run-id="([^"]+)"/g)].map((m) => m[1]);
}

/** Which days the duration chart drew a bar for. */
function durationBarValues(html: string): number[] {
  return [...html.matchAll(/data-value="([^"]+)"/g)].map((m) => Number(m[1]));
}

/** Which days either chart put a hit rect on — the x axis, in other words. */
function chartDays(html: string): string[] {
  return [...new Set([...html.matchAll(/data-day="([^"]+)"/g)].map((m) => m[1]))];
}

/** The five tile values, in order: Finished, Completed, Cancelled, Errored, Stalled. */
function tileValues(html: string): number[] {
  return [...html.matchAll(/text-2xl font-semibold tabular-nums[^"]*">(\d+)</g)].map((m) =>
    Number(m[1])
  );
}

describe('the tiles, both charts and the table move TOGETHER under a filter', () => {
  const unfiltered = render();
  const filtered = render(FIXTURE_ROWS_24, { filters: { types: [], outcomes: [], platforms: ['darwin'], search: '' } });

  it('shows the whole period when nothing is filtered', () => {
    expect(tileValues(unfiltered)).toEqual([24, 4, 7, 13, 5]);
    // Five rows by default, out of 24.
    expect(tableRunIds(unfiltered)).toHaveLength(5);
    expect(text(unfiltered)).toContain('Showing 5 of 24 finished runs, newest first');
    // One bar per day that has runs; 2026-09-19 has none.
    expect(durationBarValues(unfiltered)).toHaveLength(5);
    expect(chartDays(unfiltered)).toHaveLength(6);
  });

  it('moves ALL THREE when a platform filter is applied — not just the table', () => {
    // TILES
    expect(tileValues(filtered)).toEqual([2, 0, 0, 2, 0]);
    expect(tileValues(filtered)).not.toEqual(tileValues(unfiltered));

    // TABLE
    const ids = tableRunIds(filtered);
    expect(ids).toHaveLength(2);
    expect(text(filtered)).toContain('Showing 2 of 2 finished runs');

    // CHARTS — only the one day those two runs fall on draws a bar.
    expect(durationBarValues(filtered)).toHaveLength(1);
    expect(durationBarValues(filtered)).not.toEqual(durationBarValues(unfiltered));
    // The x axis still spans the whole period; it is the BARS that moved.
    expect(chartDays(filtered)).toEqual(chartDays(unfiltered));
  });

  it('names the period and the active filters above the tiles', () => {
    expect(text(unfiltered)).toContain(
      'Every card, chart and row below follows the filters: This week · no other filters'
    );
    expect(text(filtered)).toContain('platform: darwin');
  });

  it('follows a search on the user, across all three', () => {
    const searched = render(FIXTURE_ROWS_24, {
      filters: { types: [], outcomes: [], platforms: [], search: 'sync user h' },
    });
    expect(tileValues(searched)[0]).toBe(1);
    expect(tableRunIds(searched)).toHaveLength(1);
    expect(durationBarValues(searched)).toHaveLength(1);
  });
});

describe('the stalled tile filters the TABLE and leaves the tiles and charts alone', () => {
  const off = render();
  const on = render(FIXTURE_ROWS_24, { stalledOnly: true });

  it('narrows the table to the stalled runs', () => {
    expect(tableRunIds(on)).toHaveLength(5);
    expect(text(on)).toContain('Showing 5 of 5 finished runs');
    expect(tableRunIds(on)).not.toEqual(tableRunIds(off));
  });

  it('leaves every tile value EXACTLY as it was — same before and after', () => {
    expect(tileValues(on)).toEqual(tileValues(off));
    expect(tileValues(on)).toEqual([24, 4, 7, 13, 5]);
  });

  it('leaves both charts EXACTLY as they were', () => {
    expect(durationBarValues(on)).toEqual(durationBarValues(off));
    expect(chartDays(on)).toEqual(chartDays(off));
  });

  it('counts stalled over the FILTERED set, not the whole period', () => {
    const darwin = render(FIXTURE_ROWS_24, {
      filters: { types: [], outcomes: [], platforms: ['darwin'], search: '' },
    });
    expect(tileValues(darwin)[4]).toBe(0);
    expect(tileValues(off)[4]).toBe(5);
  });
});

describe('an empty period renders an axis, not a collapse', () => {
  // Three of the seven period options are EMPTY against today's corpus (last
  // 24 h, last week, last month). The server returns no rows for them — the
  // client deliberately does NOT re-filter by period, because a second filter
  // there would make a period that never reached the query look correct.
  const lastWeek = resolvePeriod({ period: 'last-week' }, NOW);
  const html = render([], {}, { period: lastWeek });
  const body = text(html);

  it('shows all five tiles at zero', () => {
    expect(tileValues(html)).toEqual([0, 0, 0, 0, 0]);
  });

  it('keeps the charts day axis, with no bars on it', () => {
    expect(chartDays(html)).toHaveLength(7);
    expect(chartDays(html)[0]).toBe('2026-09-07');
    expect(chartDays(html)[6]).toBe('2026-09-13');
    expect(durationBarValues(html)).toEqual([]);
  });

  it('says the zero is real rather than rendering a blank table', () => {
    expect(body).toContain('No finished runs in this period');
    expect(body).toContain('That is a real zero, not a failure to read');
    expect(tableRunIds(html)).toEqual([]);
  });

  it('does not crash, NaN or Infinity its way through the empty case', () => {
    expect(body).not.toMatch(/NaN|Infinity|undefined/);
  });
});

describe('a truncated window says so', () => {
  it('names the CAP, not the number of rows it happens to be showing', () => {
    // 60 rows rendered under a cap of 200: the notice must say 200. Printing
    // the filtered row count instead reads "at most 60 rows", which is both
    // wrong and unactionable — and it changes every time a filter is touched.
    const body = text(render(derivedRunRows(60), {}, { truncated: true }));
    expect(body).toContain('This period holds more runs than are shown');
    expect(body).toContain('The query returns at most 200 rows');
    expect(body).toContain('a floor, not a total');
    expect(body).not.toContain('at most 60 rows');
  });

  it('says nothing when it did not', () => {
    expect(text(render())).not.toContain('This period holds more runs than are shown');
  });
});

describe('the table', () => {
  it('renders all ten columns, every one a sortable button', () => {
    const html = render();
    for (const label of [
      'When', 'User', 'Platform', 'Version', 'Outcome',
      'Duration', 'Backup', 'Rate', 'Messages', 'Type',
    ]) {
      expect(text(html)).toContain(label);
    }
    expect(html).toContain('aria-sort="descending"');
  });

  it('renders the rate on the four runs that have one, and an em dash elsewhere', () => {
    const html = render(FIXTURE_ROWS_24, {
      filters: { types: [], outcomes: ['complete'], platforms: [], search: '' },
    });
    const body = text(html);
    expect(body).toContain('22.8 MB/s');
    expect(body).not.toContain('0.0 MB/s');
  });

  it('calls an unrecorded sync type "not recorded", never "unknown"', () => {
    const body = text(render());
    expect(body).toContain('not recorded');
  });

  it('opens no row detail until one is asked for', () => {
    expect(render()).not.toContain('data-run-detail');
  });
});

describe('how to use this report', () => {
  const body = text(render());

  it('is behind a details, which round 1 deliberately forbade and round 2 requires', () => {
    expect(render()).toContain('<details');
    expect(body).toContain('How to use this report');
  });

  it('carries the founder s stall, filter, chart and rate wording', () => {
    expect(body).toContain('counts finished runs in the period that ran 30 minutes or more and extracted nothing');
    expect(body).toContain('narrow the tiles, both charts and the table together');
    expect(body).toContain('Average duration per day shows when syncs started taking longer');
    expect(body).toContain('the backup size divided by the transfer phase, in MB per second');
  });

  it('states the Monday/UTC convention and the created_at meaning flip', () => {
    expect(body).toContain('Weeks start Monday, and every time on this page is UTC');
    expect(body).toContain('counted on the day it ended');
    expect(body).toContain('counted on the day they began');
  });

  it('carries the Views paragraph PR 1 had to drop', () => {
    // PR 1 removed it because it described a feature that was not on the page.
    // PR 2 puts the feature there, so the prose goes back — verbatim from the
    // founder's wording in the PM answers (BACKLOG-3450 Q7).
    expect(body).toContain('Your own cards come from Views');
    expect(body).toContain('pick a column and a function (count, average, sum, min, max)');
    expect(body).toContain('a dashed card that follows whichever period is selected');
    expect(body).toContain('Click a card to apply its filters; up to five pinned');
  });

  it('keeps the runs-in-progress exclusion verbatim', () => {
    expect(body).toContain(
      'They are excluded rather than counted as though they had resolved'
    );
  });
});

describe('degenerate renders', () => {
  it('renders with no rows at all', () => {
    const body = text(render([]));
    expect(body).toContain('No finished runs in this period');
    expect(body).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('renders a single bare error row without a NaN or an empty cell', () => {
    // The 2.2-second error with no phases and no device size: index 17 of the
    // 19 transcribed rows, which the five newer ones push to 22.
    const bare = FIXTURE_ROWS_24[22];
    const body = text(render([bare]));
    expect(body).not.toMatch(/NaN|Infinity|undefined/);
    expect(body).toContain('Sync user F');
  });

  it('renders the 2.38.1 evidence fields only when a row carries them', () => {
    const withEvidence = render([DERIVED_ROWS.bytesTransferredOnly], { });
    expect(text(withEvidence)).not.toContain('Bytes moved');
    // They live on the row DETAIL, which is closed until a row is clicked —
    // the interaction suite opens it.
  });
});

/**
 * The rendered counterpart of `runs still in flight are not runs`. The
 * derivation test proves the model drops them; this proves the page a person
 * reads says the same numbers it said before a live sync existed.
 */
describe('a sync still running does not change what the page says', () => {
  it('keeps every tile and the table identical', () => {
    const live: SyncOutcomeRow = {
      ...FIXTURE_ROWS_24[0],
      // Not a UUID on purpose: nothing reads it as one, and a public repo does
      // not need another invented id in it.
      id: 'live-run-under-test',
      created_at: '2026-09-19T17:05:11.000000Z',
      outcome: 'running',
      messages_extracted: null,
    };
    const withLive = render([live, ...FIXTURE_ROWS_24]);
    expect(tileValues(withLive)).toEqual([24, 4, 7, 13, 5]);
    expect(tableRunIds(withLive)).toEqual(tableRunIds(render()));
    expect(withLive).not.toContain('live-run-under-test');
  });
});
