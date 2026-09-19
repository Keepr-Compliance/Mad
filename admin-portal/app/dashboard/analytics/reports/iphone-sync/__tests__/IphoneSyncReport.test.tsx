/**
 * iPhone Sync Performance — render tests (BACKLOG-3441)
 *
 * The question this report exists to answer is "would it have shown the
 * 2026-09-16 failure at a glance?". These tests answer it mechanically:
 * render the component to static markup — no click, no hover, no filter, no
 * JavaScript — and assert the failing run is in the banner, above the run list.
 *
 * They also render the two shapes that break naive report code: zero rows and
 * one row with nothing populated.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import {
  FIXTURE_ROWS,
  FIXTURE_USERS,
  ROWS_WITH_IN_PROGRESS,
} from '@/lib/reports/__tests__/iphone-sync.fixture';
import { IphoneSyncReport } from '../IphoneSyncReport';

function render(rows = FIXTURE_ROWS, users = FIXTURE_USERS): string {
  return renderToStaticMarkup(
    <IphoneSyncReport report={buildIphoneSyncReport(rows, users)} />
  );
}

/**
 * The entities `renderToStaticMarkup` produces, decoded back to the character.
 *
 * ONE pass over the string, not a chain of replacements. A chain decodes
 * `&amp;` to `&` and then keeps going, so `&amp;quot;` — the escaped form of
 * the literal text `&quot;` — comes out as `"`, a character that was never in
 * the markup. CodeQL's `js/double-escaping` flagged exactly that here. With a
 * single regex and a lookup, each entity is consumed once and whatever it
 * leaves behind is not re-scanned.
 */
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

describe('the 2026-09-16 failure is visible without interaction', () => {
  const html = render();
  const body = text(html);

  it('names the failure count in the banner', () => {
    expect(body).toContain('3 runs burned 30 minutes or more and extracted nothing');
  });

  it('states the duration, the size and the comparison in one sentence', () => {
    expect(body).toContain('181.7 minutes for 57.9 GB on the phone');
    expect(body).toContain('3.1 min/GB');
    expect(body).toContain('2.0× the 1.6 min/GB median of the 3 completed runs');
  });

  it('names the phase the run stopped in and the phase that ate the time', () => {
    expect(body).toContain('Last phase reached: Transferring backup from device');
    expect(body).toContain('Longest phase: Transferring backup from device at 2h 49m');
  });

  it('puts all of that ABOVE the run list, not buried in it', () => {
    const bannerIndex = html.indexOf('burned');
    const listIndex = html.indexOf('Every finished run, newest first');
    expect(bannerIndex).toBeGreaterThanOrEqual(0);
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(bannerIndex).toBeLessThan(listIndex);
  });

  it('hides nothing behind a click: no details/summary, no button, no hidden class', () => {
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<button');
    // `aria-hidden` on decorative icons is fine; a `hidden` utility class or
    // attribute on content is not.
    const classAttributes = html.match(/class="[^"]*"/g) ?? [];
    expect(classAttributes.length).toBeGreaterThan(0);
    const concealing = classAttributes.filter((attr) =>
      /(^|[\s"])(hidden|invisible|sr-only|collapse)([\s"]|$)/.test(attr)
    );
    expect(concealing).toEqual([]);
    expect(html).not.toMatch(/(^|\s)hidden(=|\s|>)/);
  });
});

describe('the phase breakdown is rendered for every run that has one', () => {
  const html = render();
  const body = text(html);

  it('renders a labelled row per phase of the successful reference run', () => {
    for (const label of [
      'Starting backup',
      'Waiting for device',
      'Transferring backup from device',
      'Parsing contacts',
      'Parsing messages',
      'Resolving contacts',
      'Cleanup',
      'Storing messages',
      'Storing contacts',
      'Storing attachments',
    ]) {
      expect(body).toContain(label);
    }
  });

  it('draws one bar per phase across the whole page', () => {
    const expectedBars = buildIphoneSyncReport(FIXTURE_ROWS, FIXTURE_USERS).runs.reduce(
      (sum, run) => sum + run.phases.length,
      0
    );
    const bars = html.match(/background-color:/g) ?? [];
    expect(expectedBars).toBeGreaterThan(0);
    expect(bars).toHaveLength(expectedBars);
  });

  it('says so explicitly when a run recorded no phases at all', () => {
    expect(body).toContain('it ended before the first phase reported');
  });
});

describe('the limits are on the page, not in a doc somewhere', () => {
  const body = text(render());

  it('says which runs are missing from the page and why', () => {
    expect(body).toContain('Only runs that reached an end are shown');
    expect(body).toContain('Runs in flight are excluded here rather than counted');
  });

  it('says 19 runs is too few for averages', () => {
    expect(body).toContain('19 runs in total is too few for averages or percentiles');
  });

  it('shows the min/GB spread rather than only the median', () => {
    expect(body).toContain('0.7–1.9 min/GB');
  });
});

describe('degenerate renders', () => {
  it('renders with no rows at all and says why that might be', () => {
    const body = text(render([], []));
    expect(body).toContain('No stalled runs on record');
    expect(body).toContain('No iPhone syncs have reported yet');
    expect(body).toContain('every attempt died before it could report');
    expect(body).toContain('0 runs in total is too few for averages');
    expect(body).toContain('No completed run has both numbers yet');
  });

  it('renders a single bare error row without a NaN, an Infinity or an empty cell', () => {
    const bare = FIXTURE_ROWS[17]; // error, 2.2s, no phases, no device size
    const body = text(render([bare], FIXTURE_USERS));
    expect(body).not.toMatch(/NaN|Infinity|undefined|null/);
    expect(body).toContain('No stalled runs on record');
    expect(body).toContain('it ended before the first phase reported');
    expect(body).toContain('Sync user F');
    expect(body).toContain('2s');
  });

  it('renders a single stalled row and flags it', () => {
    const body = text(render([FIXTURE_ROWS[2]], FIXTURE_USERS));
    expect(body).toContain('1 run burned 30 minutes or more and extracted nothing');
    // No completed run in this slice, so there is no baseline to compare with
    // and the sentence must not invent one.
    expect(body).not.toContain('median of the');
    expect(body).toContain('No completed run has both numbers yet');
  });
});

/**
 * The rendered counterpart of `runs still in flight are not runs` in
 * `lib/reports/__tests__/iphone-sync.test.ts`. The derivation test proves the
 * model drops them; this proves the page a person reads says the same numbers
 * it said before a live sync existed — including the banner sentence, which is
 * the one line this report is for.
 */
describe('a sync still running does not change what the page says', () => {
  const withLive = text(render(ROWS_WITH_IN_PROGRESS));

  it('keeps the flagged-run count at the three finished runs', () => {
    expect(withLive).toContain('3 runs burned 30 minutes or more and extracted nothing');
  });

  it('keeps the totals, and never renders a live run as a row', () => {
    expect(withLive).toContain('Finished runs 19');
    // Both live runs started on 2026-09-19; no finished run in the fixture did,
    // so their timestamps appearing anywhere would mean a card was rendered.
    expect(withLive).not.toContain('2026-09-19');
    expect(withLive).toBe(text(render()));
  });
});
