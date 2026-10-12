'use client';

/**
 * Broker Submissions search and filters — BACKLOG-3904.
 *
 * Desktop (md and up): a search box and a "Submitted by" select under the
 * status tabs. Phone (below md): a search field and two two-line filter
 * controls (Status / Agent), each opening its own bottom sheet, and "Clear filters".
 *
 * The URL is the only state (?status=&agent=&search=): every change navigates,
 * so back and refresh keep the filters. Everything shown here is passed in by
 * the server page; nothing is looked up from the client.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { BottomSheet, PhoneClearFilters, PhoneFilterBar, PhoneResultsRow, SearchField } from '@keepr/ui';
import { headMatchesFilter } from '@/lib/submissions/dealList';
import { buildListUrl, hasActiveFilters, parseSearchParam, type ListFilters } from '@/lib/submissions/listUrl';

export interface AgentOption {
  id: string;
  label: string;
}

/** Deals matching the current search, counted per (head status, submitter). */
export interface FacetCount {
  status: string;
  agent: string | null;
  count: number;
}

interface StatusOption {
  value: string;
  label: string;
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Search-as-you-type bound to the URL (BACKLOG-3904). Typed text navigates
 * (replace, so no history entry per key) after SEARCH_DEBOUNCE_MS; Enter and
 * clearing navigate at once. Text that normalises to what the URL already holds
 * (trailing space, doubled spaces) sends nothing. The URL only overwrites the
 * typed text when it changed for another reason (Clear filters, back button) -
 * never with its own echo, which would drop a space typed while the request was
 * in flight.
 */
function useSearchUrl(filters: ListFilters) {
  const router = useRouter();
  const [search, setSearch] = useState(filters.search);
  const typed = useRef(filters.search);
  const lastSent = useRef(filters.search);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    lastSent.current = filters.search;
    if (parseSearchParam(typed.current) !== filters.search) {
      typed.current = filters.search;
      setSearch(filters.search);
    }
  }, [filters.search]);

  function send(text: string) {
    const next = parseSearchParam(text);
    if (next === lastSent.current) return;
    lastSent.current = next;
    router.replace(buildListUrl({ ...filtersRef.current, search: next }));
  }

  useEffect(() => {
    const next = parseSearchParam(search);
    if (next === lastSent.current) return;
    if (next === '') {
      send(search);
      return;
    }
    const timer = setTimeout(() => send(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return {
    search,
    onChange(value: string) {
      typed.current = value;
      setSearch(value);
    },
    onSubmit(e?: FormEvent) {
      e?.preventDefault();
      send(search);
    },
  };
}

function countFacets(facets: FacetCount[], status: string, agent: string | null): number {
  const filter = status === 'all' ? null : status;
  let n = 0;
  for (const f of facets) {
    if (headMatchesFilter(f.status, filter) && (agent === null || f.agent === agent)) n += f.count;
  }
  return n;
}

function plural(n: number): string {
  return `${n} submission${n === 1 ? '' : 's'}`;
}

/** The options, plus the selected agent when it is not among them (R1: never looked up). */
function withSelected(agents: AgentOption[], selected: string | null): AgentOption[] {
  if (!selected || agents.some((a) => a.id === selected)) return agents;
  return [...agents, { id: selected, label: 'Unknown agent' }];
}

const inputClass =
  'block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500';

export function SubmissionDesktopFilters({
  filters,
  agents,
}: {
  filters: ListFilters;
  agents: AgentOption[];
}) {
  const router = useRouter();
  const { search, onChange, onSubmit } = useSearchUrl(filters);

  return (
    <form role="search" onSubmit={onSubmit} className="mt-4 flex flex-wrap gap-2">
      <label htmlFor="submissions-search-desktop" className="sr-only">
        Search submissions
      </label>
      <input
        id="submissions-search-desktop"
        type="search"
        value={search}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search address, city, agent name or email"
        className={`${inputClass} flex-1 min-w-[16rem]`}
      />
      <label htmlFor="submissions-agent-desktop" className="sr-only">
        Submitted by
      </label>
      <select
        id="submissions-agent-desktop"
        value={filters.agent ?? ''}
        onChange={(e) => router.push(buildListUrl({ ...filters, agent: e.target.value || null }))}
        className={`${inputClass} w-auto min-w-[12rem]`}
      >
        <option value="">All agents</option>
        {withSelected(agents, filters.agent).map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </form>
  );
}

export function SubmissionPhoneFilters({
  filters,
  statuses,
  agents,
  facets,
  selectedAgentLabel,
  matchingCount,
  scopeTotal,
}: {
  filters: ListFilters;
  statuses: StatusOption[];
  agents: AgentOption[];
  facets: FacetCount[];
  selectedAgentLabel: string;
  /** Deals matching the filters (X): the list's total, not this page's rows. */
  matchingCount: number;
  /** Every deal in the list's scope, unfiltered (Y): the dashboard Total card's set. */
  scopeTotal: number;
}) {
  const router = useRouter();
  const { search, onChange, onSubmit } = useSearchUrl(filters);

  // One sheet at a time, each for its own filter, applied by "Show N".
  const [sheet, setSheet] = useState<'status' | 'agent' | null>(null);
  const [pendingStatus, setPendingStatus] = useState(filters.status);
  const [pendingAgent, setPendingAgent] = useState<string | null>(filters.agent);
  const [agentQuery, setAgentQuery] = useState('');

  function openSheet(which: 'status' | 'agent') {
    setPendingStatus(filters.status);
    setPendingAgent(filters.agent);
    setAgentQuery('');
    setSheet(which);
  }

  function apply() {
    const which = sheet;
    setSheet(null);
    if (which === 'status') router.push(buildListUrl({ ...filters, status: pendingStatus }));
    if (which === 'agent') router.push(buildListUrl({ ...filters, agent: pendingAgent }));
  }

  const options = useMemo(() => withSelected(agents, filters.agent), [agents, filters.agent]);
  const visibleOptions = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    return q ? options.filter((a) => a.label.toLowerCase().includes(q)) : options;
  }, [options, agentQuery]);

  const statusLabel = statuses.find((s) => s.value === filters.status)?.label ?? filters.status;
  // Each sheet counts with the OTHER filter at its applied value.
  const shown =
    sheet === 'status'
      ? countFacets(facets, pendingStatus, filters.agent)
      : countFacets(facets, filters.status, pendingAgent);
  // BACKLOG-3904: "Showing X of Y submissions" + Clear filters, only while
  // a filter or the search is applied (the URL's, not the half-typed text).
  const filtered = hasActiveFilters(filters);

  return (
    <PhoneFilterBar
      className="md:hidden"
      search={{
        label: 'Search submissions',
        placeholder: 'Search address or agent',
        value: search,
        onChange,
        onClear: () => onChange(''),
        onSubmit: () => onSubmit(),
      }}
      filters={[
        {
          label: 'Status',
          value: statusLabel,
          active: filters.status !== 'all',
          expanded: sheet === 'status',
          onClick: () => openSheet('status'),
        },
        {
          label: 'Agent',
          value: selectedAgentLabel,
          active: filters.agent !== null,
          expanded: sheet === 'agent',
          onClick: () => openSheet('agent'),
        },
      ]}
      results={
        filtered ? (
          <PhoneResultsRow
            shown={matchingCount}
            total={scopeTotal}
            noun="submission"
            action={
              <PhoneClearFilters
                onClick={() => router.push(buildListUrl({ status: 'all', agent: null, search: '' }))}
              />
            }
          />
        ) : null
      }
    >
      <BottomSheet
        open={sheet !== null}
        onOpenChange={(o) => !o && setSheet(null)}
        title={sheet === 'agent' ? 'Agent' : 'Status'}
        headerAction={
          <button
            type="button"
            onClick={() => (sheet === 'agent' ? setPendingAgent(null) : setPendingStatus('all'))}
            className="min-h-11 px-2 text-sm font-semibold text-primary-700"
          >
            Clear
          </button>
        }
        primaryAction={
          <button
            type="button"
            onClick={apply}
            className="flex min-h-12 w-full items-center justify-center rounded-lg bg-primary-600 text-base font-semibold text-white"
          >
            Show {plural(shown)}
          </button>
        }
      >
        {sheet === 'status' ? (
          <div className="flex flex-wrap gap-2">
            {statuses.map((s) => {
              const on = pendingStatus === s.value;
              return (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPendingStatus(s.value)}
                  className={`min-h-9 rounded-full border px-3.5 text-sm font-semibold ${
                    on ? 'border-primary-600 bg-primary-50 text-primary-800' : 'border-gray-300 bg-white text-gray-700'
                  }`}
                >
                  {s.label} · {countFacets(facets, s.value, filters.agent)}
                </button>
              );
            })}
          </div>
        ) : null}
        {sheet === 'agent' ? (
          <fieldset className="space-y-2">
            <legend className="sr-only">Agent</legend>
            <SearchField label="Find an agent" placeholder="Find an agent" value={agentQuery} onChange={setAgentQuery} />
            <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200">
              {[{ id: '', label: 'All agents' }, ...visibleOptions].map((a) => {
                const value = a.id || null;
                const checked = pendingAgent === value;
                return (
                  <label
                    key={a.id || 'all'}
                    className={`flex min-h-12 items-center gap-3 px-3 text-base text-gray-900 ${checked ? 'bg-primary-50' : 'bg-white'}`}
                  >
                    <input
                      type="radio"
                      name="submissions-agent"
                      value={a.id}
                      checked={checked}
                      aria-label={a.label}
                      onChange={() => setPendingAgent(value)}
                      className="h-5 w-5 accent-primary-600"
                    />
                    <span className="flex-1 truncate">{a.label}</span>
                    <span className="text-sm text-gray-500">{countFacets(facets, filters.status, value)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}
      </BottomSheet>
    </PhoneFilterBar>
  );
}
