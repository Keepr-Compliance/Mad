'use client';

/**
 * InlineTicketEdit -- Inline edit components for support ticket table cells.
 *
 * Provides click-to-edit dropdowns for status, priority, assignee, and category
 * fields directly within the TicketTable rows. Follows the same pattern as
 * InlineStatusPicker and InlinePriorityPicker from the PM module.
 *
 * Key behaviors:
 * - Click a cell value to open a dropdown
 * - Selecting a value saves immediately (no Save button)
 * - Loading spinner while saving
 * - Error message with auto-revert on failure
 * - Click outside to cancel
 * - e.stopPropagation() prevents row navigation
 *
 * Task: TASK-2295
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { TicketStatus, TicketPriority, SupportCategory } from '@/lib/support-types';
import {
  STATUS_LABELS,
  STATUS_COLORS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  ALLOWED_TRANSITIONS,
} from '@/lib/support-types';
import {
  updateTicketStatus,
  updateTicketPriority,
  updateTicketCategory,
  assignTicket,
  getAssignableAgents,
  getCategories,
} from '@/lib/support-queries';
import type { AssignableAgent } from '@/lib/support-queries';

// ---------------------------------------------------------------------------
// Shared cache for agents and categories (fetched once, shared across cells)
// ---------------------------------------------------------------------------

let cachedAgents: AssignableAgent[] | null = null;
let agentsFetchPromise: Promise<AssignableAgent[]> | null = null;

async function fetchAgentsCached(): Promise<AssignableAgent[]> {
  if (cachedAgents) return cachedAgents;
  if (agentsFetchPromise) return agentsFetchPromise;
  agentsFetchPromise = getAssignableAgents().then((agents) => {
    cachedAgents = agents;
    return agents;
  });
  return agentsFetchPromise;
}

let cachedCategories: SupportCategory[] | null = null;
let categoriesFetchPromise: Promise<SupportCategory[]> | null = null;

async function fetchCategoriesCached(): Promise<SupportCategory[]> {
  if (cachedCategories) return cachedCategories;
  if (categoriesFetchPromise) return categoriesFetchPromise;
  categoriesFetchPromise = getCategories().then((cats) => {
    cachedCategories = cats;
    return cats;
  });
  return categoriesFetchPromise;
}

/** Clear caches (useful after data changes) */
export function clearInlineEditCaches() {
  cachedAgents = null;
  agentsFetchPromise = null;
  cachedCategories = null;
  categoriesFetchPromise = null;
}

// ---------------------------------------------------------------------------
// InlineStatusEdit
// ---------------------------------------------------------------------------

interface InlineStatusEditProps {
  ticketId: string;
  status: TicketStatus;
  onUpdated: () => void;
}

export function InlineStatusEdit({ ticketId, status, onUpdated }: InlineStatusEditProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  const validTransitions = ALLOWED_TRANSITIONS[status] || [];

  async function handleSelect(newStatus: TicketStatus) {
    setOpen(false);
    if (newStatus === status) return;
    setSaving(true);
    setError(null);
    try {
      await updateTicketStatus(ticketId, newStatus);
      onUpdated();
    } catch {
      setError('Failed');
      setTimeout(() => setError(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.preventDefault();
          if (validTransitions.length > 0 && !saving) setOpen(!open);
        }}
        disabled={saving}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status]} ${
          validTransitions.length > 0 && !saving
            ? 'hover:ring-2 hover:ring-offset-1 hover:ring-gray-300 cursor-pointer'
            : 'cursor-default'
        }`}
        title={
          saving
            ? 'Saving...'
            : validTransitions.length === 0
            ? 'No transitions available'
            : 'Click to change status'
        }
      >
        {saving && <Loader2 className="h-3 w-3 animate-spin" />}
        {STATUS_LABELS[status]}
      </button>
      {error && (
        <span className="absolute top-full left-0 mt-1 text-xs text-red-500 whitespace-nowrap z-30">
          {error}
        </span>
      )}
      {open && validTransitions.length > 0 && (
        <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-30 py-1 w-36">
          {validTransitions.map((s) => (
            <button
              key={s}
              onClick={() => handleSelect(s)}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center gap-2"
            >
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[s]}`}
              >
                {STATUS_LABELS[s]}
              </span>
              {s === status && <Check className="h-3 w-3 text-primary-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlinePriorityEdit
// ---------------------------------------------------------------------------

const ALL_PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

interface InlinePriorityEditProps {
  ticketId: string;
  priority: TicketPriority;
  onUpdated: () => void;
}

export function InlinePriorityEdit({ ticketId, priority, onUpdated }: InlinePriorityEditProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  async function handleSelect(newPriority: TicketPriority) {
    setOpen(false);
    if (newPriority === priority) return;
    setSaving(true);
    setError(null);
    try {
      await updateTicketPriority(ticketId, newPriority);
      onUpdated();
    } catch {
      setError('Failed');
      setTimeout(() => setError(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.preventDefault();
          if (!saving) setOpen(!open);
        }}
        disabled={saving}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-gray-300 ${PRIORITY_COLORS[priority]} ${
          saving ? 'cursor-default' : ''
        }`}
        title={saving ? 'Saving...' : 'Click to change priority'}
      >
        {saving && <Loader2 className="h-3 w-3 animate-spin" />}
        {PRIORITY_LABELS[priority]}
      </button>
      {error && (
        <span className="absolute top-full left-0 mt-1 text-xs text-red-500 whitespace-nowrap z-30">
          {error}
        </span>
      )}
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-30 py-1 w-28">
          {ALL_PRIORITIES.map((p) => (
            <button
              key={p}
              onClick={() => handleSelect(p)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center justify-between ${
                p === priority ? 'bg-primary-50' : ''
              }`}
            >
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${PRIORITY_COLORS[p]}`}
              >
                {PRIORITY_LABELS[p]}
              </span>
              {p === priority && <Check className="h-3 w-3 text-primary-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineAssigneeEdit
// ---------------------------------------------------------------------------

interface InlineAssigneeEditProps {
  ticketId: string;
  assigneeName: string | null | undefined;
  onUpdated: () => void;
}

export function InlineAssigneeEdit({ ticketId, assigneeName, onUpdated }: InlineAssigneeEditProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AssignableAgent[]>([]);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setSearch('');
  }, []);
  useClickOutside(ref, close, open);

  useEffect(() => {
    if (!open) return;
    fetchAgentsCached()
      .then(setAgents)
      .catch(() => {});
  }, [open]);

  const filteredAgents = agents.filter((a) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return a.display_name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q);
  });

  async function handleSelect(agentId: string) {
    setOpen(false);
    setSearch('');
    setSaving(true);
    setError(null);
    try {
      await assignTicket(ticketId, agentId);
      onUpdated();
    } catch {
      setError('Failed');
      setTimeout(() => setError(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.preventDefault();
          if (!saving) setOpen(!open);
        }}
        disabled={saving}
        className={`inline-flex items-center gap-1 text-sm hover:text-primary-600 transition-colors ${
          saving ? 'cursor-default text-gray-400' : 'cursor-pointer text-gray-500'
        }`}
        title={saving ? 'Saving...' : 'Click to assign'}
      >
        {saving && <Loader2 className="h-3 w-3 animate-spin" />}
        {assigneeName || <span className="text-gray-400 italic">Unassigned</span>}
      </button>
      {error && (
        <span className="absolute top-full left-0 mt-1 text-xs text-red-500 whitespace-nowrap z-30">
          {error}
        </span>
      )}
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-30 w-56">
          <div className="px-3 py-2 border-b border-gray-100">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents..."
              className="w-full px-2 py-1 text-sm text-gray-900 bg-white border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-y-auto py-1 flex flex-col whitespace-normal">
            {agents.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-400">Loading...</div>
            ) : filteredAgents.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-400">No agents found</div>
            ) : (
              filteredAgents.map((agent) => (
                <button
                  key={agent.user_id}
                  onClick={() => handleSelect(agent.user_id)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors"
                >
                  <div className="truncate font-medium text-gray-700">
                    {agent.display_name || agent.email}
                  </div>
                  {agent.display_name && (
                    <div className="truncate text-gray-400">{agent.email}</div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineCategoryEdit
// ---------------------------------------------------------------------------

interface InlineCategoryEditProps {
  ticketId: string;
  categoryName: string | null | undefined;
  categoryId: string | null | undefined;
  onUpdated: () => void;
}

export function InlineCategoryEdit({ ticketId, categoryName, categoryId, onUpdated }: InlineCategoryEditProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<SupportCategory[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  useEffect(() => {
    if (!open) return;
    fetchCategoriesCached()
      .then(setCategories)
      .catch(() => {});
  }, [open]);

  async function handleSelect(newCategoryId: string | null) {
    setOpen(false);
    if (newCategoryId === categoryId) return;
    setSaving(true);
    setError(null);
    try {
      await updateTicketCategory(ticketId, newCategoryId);
      onUpdated();
    } catch {
      setError('Failed');
      setTimeout(() => setError(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  // Only show top-level categories in the dropdown
  const topLevelCategories = categories.filter((c) => !c.parent_id);

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.preventDefault();
          if (!saving) setOpen(!open);
        }}
        disabled={saving}
        className={`inline-flex items-center gap-1 text-sm hover:text-primary-600 transition-colors ${
          saving ? 'cursor-default text-gray-400' : 'cursor-pointer text-gray-500'
        }`}
        title={saving ? 'Saving...' : 'Click to change category'}
      >
        {saving && <Loader2 className="h-3 w-3 animate-spin" />}
        {categoryName || '-'}
      </button>
      {error && (
        <span className="absolute top-full left-0 mt-1 text-xs text-red-500 whitespace-nowrap z-30">
          {error}
        </span>
      )}
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-30 w-44">
          <div className="max-h-48 overflow-y-auto py-1 flex flex-col whitespace-normal">
            {categories.length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-400">Loading...</div>
            ) : (
              <>
                {/* None option */}
                <button
                  onClick={() => handleSelect(null)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center justify-between ${
                    !categoryId ? 'bg-primary-50' : ''
                  }`}
                >
                  <span className="text-gray-400 italic">None</span>
                  {!categoryId && <Check className="h-3 w-3 text-primary-600" />}
                </button>
                {topLevelCategories.map((cat) => (
                  <button
                    key={cat.id}
                    onClick={() => handleSelect(cat.id)}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center justify-between ${
                      cat.id === categoryId ? 'bg-primary-50' : ''
                    }`}
                  >
                    <span className="text-gray-700 truncate">{cat.name}</span>
                    {cat.id === categoryId && <Check className="h-3 w-3 text-primary-600" />}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
