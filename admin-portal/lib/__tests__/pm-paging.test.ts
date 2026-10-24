/**
 * Paged fetch-all tests (BACKLOG-2786).
 *
 * The live defect: the project page asked `pm_list_items` for
 * `page_size: 500`, the RPC clamped it with
 * `LEAST(COALESCE(p_page_size, 50), 200)`, and 27 of Field Reliability's 227
 * items vanished with no error and no "showing 200 of 227".
 *
 * The fake server below reproduces the RPC's contract as transcribed from the
 * live function definition (`pg_get_functiondef('pm_list_items')`, read
 * 2026-08-22):
 *   - clamps the page size to 200 and ECHOES the clamped value as `page_size`
 *   - returns `total_count` for the whole filtered set, ignoring pagination
 *   - orders by `sort_order ASC, created_at DESC`
 *
 * The fixture mirrors the shape of the real project rather than "any 227
 * rows". Per the SR note on BACKLOG-2786, the rows the cap drops are the
 * HIGHEST-`sort_order` rows — the deliberately sequenced tail, including 4 of
 * the project's epics. A fixture of 201 low-`sort_order` rows would pass while
 * still hiding exactly the rows a person sequencing a project came to see, so
 * positions 201-227 here are the sequenced tail, the highest-`sort_order` row
 * is an epic, and a tie group straddles the 200-row page boundary.
 */

import { describe, it, expect } from 'vitest';
import {
  fetchAllPages,
  fetchAllRows,
  SERVER_MAX_PAGE_SIZE,
  type PagedResponse,
} from '../pm-paging';

// ---------------------------------------------------------------------------
// Fixture: 227 rows shaped like project "Field Reliability"
// ---------------------------------------------------------------------------

interface FixtureItem {
  id: string;
  sort_order: number;
  created_at: string;
  type: 'epic' | 'task';
}

/** Every row shares this timestamp, so (sort_order, created_at) is not unique. */
const TIE_CREATED_AT = '2026-07-28T18:10:01.401Z';

/** Ids are position-numbered so a failure names exactly which rows were lost. */
function id(position: number): string {
  return `FR-${String(position).padStart(3, '0')}`;
}

/**
 * Builds the canonical order the RPC would serve:
 *   positions 1-196   sort_order 0, distinct descending created_at
 *   positions 197-204 sort_order 5, IDENTICAL created_at (tie group of 8 that
 *                     straddles the 200-row page boundary)
 *   positions 205-227 sort_order 6..100, the sequenced tail (4 epics, the
 *                     highest sort_order of all is an epic)
 */
function buildFixture(): FixtureItem[] {
  const rows: FixtureItem[] = [];

  for (let position = 1; position <= 196; position++) {
    // Newest first: position 1 is the most recent, so created_at DESC
    // reproduces ascending position.
    const createdAt = new Date(Date.UTC(2026, 6, 1) - position * 60_000).toISOString();
    rows.push({ id: id(position), sort_order: 0, created_at: createdAt, type: 'task' });
  }

  for (let position = 197; position <= 204; position++) {
    rows.push({ id: id(position), sort_order: 5, created_at: TIE_CREATED_AT, type: 'task' });
  }

  const tailSortOrders = [
    6, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48,
    52, 56, 60, 64, 68, 72, 76, 80, 84, 92, 100,
  ];
  const epicPositions = new Set([205, 209, 216, 227]);
  tailSortOrders.forEach((sortOrder, index) => {
    const position = 205 + index;
    rows.push({
      id: id(position),
      sort_order: sortOrder,
      created_at: new Date(Date.UTC(2026, 7, 1) + index * 60_000).toISOString(),
      type: epicPositions.has(position) ? 'epic' : 'task',
    });
  });

  return rows;
}

const ALL_ROWS = buildFixture();
const ALL_IDS = ALL_ROWS.map((r) => r.id);

/** Positions 201-227: the 27 rows a single clamped page drops. */
const TAIL_IDS = ALL_IDS.slice(SERVER_MAX_PAGE_SIZE);
const EPIC_IDS = ALL_ROWS.filter((r) => r.type === 'epic').map((r) => r.id);

// ---------------------------------------------------------------------------
// Fake server reproducing pm_list_items' pagination contract
// ---------------------------------------------------------------------------

function orderRows(rows: FixtureItem[], tieBreak: 'stable' | 'reversed'): FixtureItem[] {
  return [...rows].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    // Postgres gives no guarantee here; 'reversed' models the ordering
    // changing between two separate queries.
    return tieBreak === 'stable' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
  });
}

interface FakeServerOptions {
  /** LEAST(p_page_size, 200) in the live RPC. */
  maxPageSize?: number;
  /** Re-order tie groups from the second query on (non-total-order hazard). */
  unstableTies?: boolean;
  /** Ignore OFFSET entirely — a server that never advances. */
  ignoreOffset?: boolean;
}

function makeFakeServer(rows: FixtureItem[], options: FakeServerOptions = {}) {
  const maxPageSize = options.maxPageSize ?? SERVER_MAX_PAGE_SIZE;
  const requestedSizes: number[] = [];

  const fetchPage = async (
    page: number,
    pageSize: number
  ): Promise<PagedResponse<FixtureItem>> => {
    requestedSizes.push(pageSize);
    const effective = Math.min(pageSize ?? 50, maxPageSize);
    const offset = options.ignoreOffset ? 0 : (Math.max(page, 1) - 1) * effective;
    const tieBreak =
      options.unstableTies && requestedSizes.length > 1 ? 'reversed' : 'stable';
    const ordered = orderRows(rows, tieBreak);
    return {
      items: ordered.slice(offset, offset + effective),
      total_count: rows.length,
      page_size: effective,
    };
  };

  return { fetchPage, requestedSizes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchAllPages against the pm_list_items page-size clamp', () => {
  it('the fixture is the shape that matters: the clamp drops the sequenced tail', () => {
    // Guards the fixture itself. If this drifts, the tests below stop proving
    // the thing the SR note asked them to prove.
    expect(ALL_ROWS).toHaveLength(227);
    expect(TAIL_IDS).toHaveLength(27);
    // Every row the cap drops has a higher sort_order than every row it keeps.
    const keptMax = Math.max(...ALL_ROWS.slice(0, SERVER_MAX_PAGE_SIZE).map((r) => r.sort_order));
    const droppedMin = Math.min(...ALL_ROWS.slice(SERVER_MAX_PAGE_SIZE).map((r) => r.sort_order));
    expect(droppedMin).toBeGreaterThanOrEqual(keptMax);
    // The 4 epics are all in the dropped tail, and the highest sort_order of
    // the whole project belongs to an epic.
    expect(EPIC_IDS.every((epicId) => TAIL_IDS.includes(epicId))).toBe(true);
    expect(ALL_ROWS[ALL_ROWS.length - 1].type).toBe('epic');
  });

  it('reaches every one of the 227 items, not the first 200', async () => {
    const server = makeFakeServer(ALL_ROWS);

    const result = await fetchAllPages(server.fetchPage);

    const got = result.items.map((r) => r.id);
    const missing = ALL_IDS.filter((expected) => !got.includes(expected));
    expect(missing).toEqual([]);
    expect(got).toEqual(ALL_IDS);
    expect(result.total_count).toBe(227);
    expect(result.complete).toBe(true);
  });

  it('returns the sequenced tail — the 4 epics the cap hid', async () => {
    const server = makeFakeServer(ALL_ROWS);

    const result = await fetchAllPages(server.fetchPage);

    const got = new Set(result.items.map((r) => r.id));
    expect(EPIC_IDS.filter((epicId) => !got.has(epicId))).toEqual([]);
    expect(result.items.filter((r) => r.type === 'epic').map((r) => r.id)).toEqual(EPIC_IDS);
  });

  it('never returns a row twice', async () => {
    const server = makeFakeServer(ALL_ROWS);

    const result = await fetchAllPages(server.fetchPage);

    expect(result.items).toHaveLength(new Set(result.items.map((r) => r.id)).size);
  });

  it('adopts the page size the server echoes, not the one it was asked for', async () => {
    // The old call site asked for 500. If the helper kept using 500 to compute
    // OFFSET, page 2 would start at row 500 and the tail would stay invisible.
    const server = makeFakeServer(ALL_ROWS);

    const result = await fetchAllPages(server.fetchPage, { pageSize: 500 });

    expect(server.requestedSizes[0]).toBe(500);
    expect(server.requestedSizes.slice(1).every((size) => size === SERVER_MAX_PAGE_SIZE)).toBe(true);
    expect(result.items.map((r) => r.id)).toEqual(ALL_IDS);
    expect(result.complete).toBe(true);
  });

  it('stops after one page when everything fits', async () => {
    const under = ALL_ROWS.slice(0, 119); // Stable Ground is under the cap
    const server = makeFakeServer(under);

    const result = await fetchAllPages(server.fetchPage);

    expect(server.requestedSizes).toHaveLength(1);
    expect(result.items.map((r) => r.id)).toEqual(under.map((r) => r.id));
    expect(result.complete).toBe(true);
  });

  it('handles an empty result without reporting truncation', async () => {
    const server = makeFakeServer([]);

    const result = await fetchAllPages(server.fetchPage);

    expect(result.items).toEqual([]);
    expect(result.total_count).toBe(0);
    expect(result.complete).toBe(true);
  });
});

describe('fetchAllPages when the server ordering is not a total order', () => {
  it('de-duplicates and reports the shortfall instead of hiding it', async () => {
    // Live data has 16 tie groups on (sort_order, created_at) in the Field
    // Reliability project, the largest 8 rows wide, so LIMIT/OFFSET can
    // re-serve one row and drop another across the boundary.
    const server = makeFakeServer(ALL_ROWS, { unstableTies: true });

    const result = await fetchAllPages(server.fetchPage);

    const got = result.items.map((r) => r.id);
    // No duplicates leak out...
    expect(got).toHaveLength(new Set(got).size);
    // ...the rows the re-ordering skipped are exactly the straddling tie group...
    const missing = ALL_IDS.filter((expected) => !got.includes(expected));
    expect(missing).toEqual(['FR-201', 'FR-202', 'FR-203', 'FR-204']);
    // ...and the shortfall is REPORTED, which is what the UI renders as
    // "showing 223 of 227" rather than a silently short list.
    expect(result.complete).toBe(false);
    expect(result.total_count).toBe(227);
    expect(result.items.length).toBeLessThan(result.total_count);
  });

  it('terminates against a server that never advances', async () => {
    const server = makeFakeServer(ALL_ROWS, { ignoreOffset: true });

    const result = await fetchAllPages(server.fetchPage, { maxPages: 5 });

    expect(server.requestedSizes).toHaveLength(5);
    expect(result.complete).toBe(false);
    expect(result.items).toHaveLength(SERVER_MAX_PAGE_SIZE);
  });
});

// ---------------------------------------------------------------------------
// fetchAllRows -- plain PostgREST table queries (BACKLOG-3778)
// ---------------------------------------------------------------------------

describe('fetchAllRows against a plain .range() query', () => {
  /** Shaped after SPRINT-174: 1,064 pm_token_metrics rows, past PostgREST's own 1000-row cap. */
  const SPRINT_174_ROW_COUNT = 1064;

  interface MetricRow {
    id: string;
    recorded_at: string;
  }

  function buildRows(count: number): MetricRow[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `m-${String(i).padStart(5, '0')}`,
      recorded_at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
    }));
  }

  /** A fake PostgREST `.range()` responder, capped like the real server at `hardCap`. */
  function makeRangeServer(rows: MetricRow[], hardCap = 1000) {
    const requestedRanges: Array<[number, number]> = [];
    const fetchPage = async (from: number, to: number) => {
      requestedRanges.push([from, to]);
      // PostgREST enforces its own cap independent of the requested range --
      // asking for rows 0-999 when more exist still returns at most hardCap.
      const clampedTo = Math.min(to, from + hardCap - 1);
      return { data: rows.slice(from, clampedTo + 1), error: null as unknown };
    };
    return { fetchPage, requestedRanges };
  }

  it('reaches all 1,064 rows of a sprint past the 1000-row provider cap', async () => {
    const rows = buildRows(SPRINT_174_ROW_COUNT);
    const server = makeRangeServer(rows);

    const result = await fetchAllRows(server.fetchPage, { pageSize: SERVER_MAX_PAGE_SIZE });

    expect(result).toHaveLength(SPRINT_174_ROW_COUNT);
    expect(result.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('a single un-paged request (no fetchAllRows) proves the cap is real: only 1000 of 1064 come back', async () => {
    // Guards the fixture: calls the fake server directly, the way the old
    // unpaged `getSprintMetrics` effectively did, and shows it returns a
    // short, silently-truncated set -- so the test above is not vacuous.
    const rows = buildRows(SPRINT_174_ROW_COUNT);
    const server = makeRangeServer(rows);
    const { data } = await server.fetchPage(0, SPRINT_174_ROW_COUNT - 1);
    expect(data).toHaveLength(1000);
    expect(data).not.toHaveLength(SPRINT_174_ROW_COUNT);
  });

  it('stops after one short page when the sprint has fewer rows than the page size', async () => {
    const rows = buildRows(119);
    const server = makeRangeServer(rows);

    const result = await fetchAllRows(server.fetchPage, { pageSize: SERVER_MAX_PAGE_SIZE });

    expect(server.requestedRanges).toHaveLength(1);
    expect(result).toHaveLength(119);
  });

  it('stops exactly at a page-size multiple without an extra empty request', async () => {
    const rows = buildRows(SERVER_MAX_PAGE_SIZE * 2);
    const server = makeRangeServer(rows, /* hardCap */ 10_000);

    const result = await fetchAllRows(server.fetchPage, { pageSize: SERVER_MAX_PAGE_SIZE });

    expect(result).toHaveLength(SERVER_MAX_PAGE_SIZE * 2);
    expect(server.requestedRanges).toHaveLength(3); // 2 full pages + 1 short (empty) page
  });

  it('propagates a query error instead of returning a partial result silently', async () => {
    const failingFetch = async () => ({ data: null, error: { message: 'boom' } });
    await expect(fetchAllRows(failingFetch)).rejects.toEqual({ message: 'boom' });
  });

  it('respects maxPages as a hard safety bound against a server that never shortens', async () => {
    const rows = buildRows(10_000);
    const server = makeRangeServer(rows, /* hardCap */ 10_000);

    const result = await fetchAllRows(server.fetchPage, { pageSize: 200, maxPages: 3 });

    expect(result).toHaveLength(600);
  });
});
