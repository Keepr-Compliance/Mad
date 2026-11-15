/**
 * Submissions report: multi-select Status and Agent — URL and stored-definition round trips.
 * BACKLOG-3513 PR-3h.
 *
 * The REAL parsers and writers in lib/reports/datasets/submissions-filters.ts. The 2.48 definition
 * fixture is the shape filtersToViewState wrote before this change (a plain string per filter,
 * migration 20261112200000 stores it verbatim in broker_report_definitions.definition).
 * Ids are invented.
 *
 * @jest-environment node
 */

import {
  DEFAULT_SUBMISSIONS_FILTERS,
  MAX_AGENT_FILTERS,
  SUBMISSIONS_STATUS_OPTIONS,
  buildSubmissionsReportUrl,
  definitionToFilters,
  filtersToViewState,
  parseAgentsParam,
  parseStatusesParam,
  parseSubmissionsReportParams,
  resolveDefinitionFilters,
  type SubmissionsReportFilters,
} from '@/lib/reports/datasets/submissions-filters';

// pii-allow-uuid: invented fixture ids below (whole block)
const A = '00000000-0000-4000-8000-0000003513a1'; // pii-allow-uuid: invented fixture id
const B = '00000000-0000-4000-8000-0000003513b2'; // pii-allow-uuid: invented fixture id

const F = (p: Partial<SubmissionsReportFilters>): SubmissionsReportFilters => ({ ...DEFAULT_SUBMISSIONS_FILTERS, ...p });
/** The pushed URL's query, decoded (a comma is sent as %2C). */
const query = (url: string) => Object.fromEntries(new URL(url, 'https://portal.example.test').searchParams);

describe('a. a 2.48 stored definition (one string per filter) still reads, and re-saves byte-identical', () => {
  const fx248 = { sort: null, filters: { status: 'approved', agent: A } };

  it('reads as one-item lists', () => {
    expect(definitionToFilters(fx248)).toMatchObject({ statuses: ['approved'], agents: [A] });
  });

  it('writing it back gives the same stored filters (a scalar, not a one-item list)', () => {
    expect(filtersToViewState(definitionToFilters(fx248)).filters).toEqual(fx248.filters);
    expect(filtersToViewState(definitionToFilters({ sort: null, filters: { status: 'approved' } })).filters).toEqual({ status: 'approved' });
  });

  it('two or more are stored as a list, and read back', () => {
    const stored = filtersToViewState(F({ statuses: ['approved', 'rejected'], agents: [A, B] }));
    expect(stored.filters).toEqual({ status: ['approved', 'rejected'], agent: [A, B] });
    expect(definitionToFilters({ filters: stored.filters, sort: null })).toMatchObject({ statuses: ['approved', 'rejected'], agents: [A, B] });
  });

  it('none is left out', () => {
    expect(filtersToViewState(F({})).filters).toEqual({});
  });
});

describe('b. URL round trip', () => {
  it('two statuses and two agents', () => {
    const url = buildSubmissionsReportUrl(F({ statuses: ['rejected', 'approved'], agents: [B, A] }));
    expect(url).toContain('status=approved%2Crejected');
    expect(query(url)).toEqual({ status: 'approved,rejected', agent: `${A},${B}` });
    expect(parseSubmissionsReportParams(query(url))).toMatchObject({ statuses: ['approved', 'rejected'], agents: [A, B] });
  });

  it('an old single-value URL reads as a one-item list', () => {
    expect(parseSubmissionsReportParams({ status: 'approved', agent: A })).toMatchObject({ statuses: ['approved'], agents: [A] });
  });

  it('status=all and status= are no filter', () => {
    expect(parseSubmissionsReportParams({ status: 'all' }).statuses).toEqual([]);
    expect(parseSubmissionsReportParams({ status: '' }).statuses).toEqual([]);
  });

  it('the writer emits statuses in option order', () => {
    expect(query(buildSubmissionsReportUrl(F({ statuses: ['rejected', 'new', 'approved'] }))).status).toBe('new,approved,rejected');
  });
});

describe('c. a shared report (explicit) with nothing picked keeps status=all, so the URL wins over the saved filters', () => {
  it('writes status=all', () => {
    const url = buildSubmissionsReportUrl(F({}), '/dashboard/reports/d/x', true);
    expect(query(url)).toEqual({ status: 'all' });
  });

  it('resolveDefinitionFilters then uses the URL (no filter), not the saved one', () => {
    const url = buildSubmissionsReportUrl(F({}), '/dashboard/reports/d/x', true);
    const saved = { filters: { status: 'approved', agent: A }, sort: null };
    expect(resolveDefinitionFilters(query(url), saved)).toMatchObject({ statuses: [], agents: [] });
  });

  it('a page link alone keeps the saved lists', () => {
    expect(resolveDefinitionFilters({ page: '2' }, { filters: { status: ['approved', 'rejected'] }, sort: null })).toMatchObject({
      statuses: ['approved', 'rejected'],
      page: 2,
    });
  });
});

describe('d/SR-5. junk is dropped item by item', () => {
  it('an unknown status is dropped, the rest kept', () => {
    expect(parseStatusesParam('approved,bogus')).toEqual(['approved']);
  });

  it("'all' anywhere is no filter", () => {
    expect(parseStatusesParam('all,approved')).toEqual([]);
    expect(parseStatusesParam(['approved', 'all'])).toEqual([]);
  });

  it('deduped', () => {
    expect(parseStatusesParam('approved,approved,rejected')).toEqual(['approved', 'rejected']);
    expect(parseAgentsParam(`${B},${A},${B.toUpperCase()}`)).toEqual([A, B]);
  });

  it('a non-uuid agent is dropped, the rest kept, sorted', () => {
    expect(parseAgentsParam(`${B},not-a-uuid,${A}`)).toEqual([A, B]);
  });

  it(`agents are capped at ${MAX_AGENT_FILTERS}`, () => {
    const many = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`); // pii-allow-uuid: invented fixture ids
    expect(parseAgentsParam(many.join(','))).toHaveLength(MAX_AGENT_FILTERS);
  });

  it('a stored definition with junk reads the same way', () => {
    expect(definitionToFilters({ filters: { status: ['approved', 7, 'bogus'], agent: ['x', A] }, sort: null })).toMatchObject({
      statuses: ['approved'],
      agents: [A],
    });
  });
});

describe('SR-4. every status picked is no filter', () => {
  it('reads as []', () => {
    expect(parseStatusesParam(SUBMISSIONS_STATUS_OPTIONS.map((o) => o.value))).toEqual([]);
    expect(buildSubmissionsReportUrl(F({ statuses: SUBMISSIONS_STATUS_OPTIONS.map((o) => o.value) }))).toBe('/dashboard/reports/submissions');
  });

  it("the status options have no 'all' entry (None picked = all)", () => {
    expect(SUBMISSIONS_STATUS_OPTIONS.map((o) => o.value)).not.toContain('all');
  });
});
