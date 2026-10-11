'use client';

/**
 * Broker Submissions search and filters — BACKLOG-3904.
 *
 * Desktop (md and up): a search box and a "Submitted by" select under the
 * status tabs. Phone (below md): a search field, two two-line filter controls
 * (Status / Agent) that open one bottom sheet, a count and "Clear filters".
 *
 * The URL is the only state (?status=&agent=&search=): every change navigates,
 * so back and refresh keep the filters. Everything shown here is passed in by
 * the server page; nothing is looked up from the client.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { BottomSheet, FilterSelectButton, SearchField } from '@keepr/ui';
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

const SEARCH_DEBOUNCE_MS = 300;

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
  const [search, setSearch] = useState(filters.search);
  useEffect(() => setSearch(filters.search), [filters.search]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    router.push(buildListUrl({ ...filters, search: parseSearchParam(search) }));
  }

  return (
    <form role="search" onSubmit={onSubmit} className="mt-4 flex flex-wrap gap-2">
      <label htmlFor="submissions-search-desktop" className="sr-only">
        Search submissions
      </label>
      <input
        id="submissions-search-desktop"
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
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
  total,
  selectedAgentLabel,
}: {
  filters: ListFilters;
  statuses: StatusOption[];
  agents: AgentOption[];
  facets: FacetCount[];
  total: number;
  selectedAgentLabel: string;
}) {
  const router = useRouter();

  // Search: typed text replaces the URL after a pause (no history entry per key).
  const [search, setSearch] = useState(filters.search);
  const lastSent = useRef(filters.search);
  useEffect(() => {
    lastSent.current = filters.search;
    setSearch(filters.search);
  }, [filters.search]);
  useEffect(() => {
    const next = parseSearchParam(search);
    if (next === lastSent.current) return;
    const timer = setTimeout(() => {
      lastSent.current = next;
      router.replace(buildListUrl({ ...filters, search: next }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, filters, router]);

  // Sheet: a pending selection, applied by "Show N".
  const [open, setOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(filters.status);
  const [pendingAgent, setPendingAgent] = useState<string | null>(filters.agent);
  const [agentQuery, setAgentQuery] = useState('');

  function openSheet() {
    setPendingStatus(filters.status);
    setPendingAgent(filters.agent);
    setAgentQuery('');
    setOpen(true);
  }

  function apply() {
    setOpen(false);
    router.push(buildListUrl({ ...filters, status: pendingStatus, agent: pendingAgent }));
  }

  const options = useMemo(() => withSelected(agents, filters.agent), [agents, filters.agent]);
  const visibleOptions = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    return q ? options.filter((a) => a.label.toLowerCase().includes(q)) : options;
  }, [options, agentQuery]);

  const statusLabel = statuses.find((s) => s.value === filters.status)?.label ?? filters.status;
  const shown = countFacets(facets, pendingStatus, pendingAgent);
  const filtered = hasActiveFilters(filters);

  return (
    <div className="space-y-2.5 md:hidden">
      <SearchField
        label="Search submissions"
        placeholder="Search address or agent"
        value={search}
        onChange={setSearch}
      />
      <div className="grid grid-cols-2 gap-2">
        <FilterSelectButton
          label="Status"
          value={statusLabel}
          active={filters.status !== 'all'}
          expanded={open}
          onClick={openSheet}
        />
        <FilterSelectButton
          label="Agent"
          value={selectedAgentLabel}
          active={filters.agent !== null}
          expanded={open}
          onClick={openSheet}
        />
      </div>
      <div className="flex min-h-9 items-center justify-between text-sm text-gray-600">
        <span>{plural(total)}</span>
        {filtered ? (
          <button
            type="button"
            onClick={() => router.push(buildListUrl({ status: 'all', agent: null, search: '' }))}
            className="min-h-9 px-1 font-semibold text-primary-700"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title="Filters"
        headerAction={
          <button
            type="button"
            onClick={() => {
              setPendingStatus('all');
              setPendingAgent(null);
            }}
            className="min-h-11 px-2 text-sm font-semibold text-primary-700"
          >
            Clear all
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
        <div className="space-y-5">
          <section aria-labelledby="sheet-status-heading" className="space-y-2">
            <h3 id="sheet-status-heading" className="text-xs font-bold uppercase tracking-wide text-gray-600">
              Status
            </h3>
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
                    {s.label} · {countFacets(facets, s.value, pendingAgent)}
                  </button>
                );
              })}
            </div>
          </section>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-600">Submitted by</legend>
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
                    <span className="text-sm text-gray-500">{countFacets(facets, pendingStatus, value)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
      </BottomSheet>
    </div>
  );
}
