'use client';

/**
 * CreateTaskDialog - PM Module
 *
 * Modal dialog for creating new backlog items.
 * Features: title, description, type, priority, area, parent search,
 * sprint/project dropdowns, est_tokens, start/due dates.
 *
 * Pattern: Adapted from support/CreateTicketDialog.tsx (simplified)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Loader2, Search } from 'lucide-react';
import { Modal, Button, Label } from '@keepr/design-system';
import {
  createItem,
  listSprints,
  listProjects,
  searchItemsForLink,
} from '@/lib/pm-queries';
import type {
  ItemType,
  ItemPriority,
  PmSprint,
  PmProject,
  PmItemSearchResult,
} from '@/lib/pm-types';
import {
  TYPE_LABELS,
  PRIORITY_LABELS,
} from '@/lib/pm-types';

interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  defaultParentId?: string;
  defaultSprintId?: string;
  defaultProjectId?: string;
}

const INPUT_CLASS =
  'w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

const AREA_OPTIONS = [
  'admin-portal',
  'electron',
  'broker-portal',
  'service',
  'schema',
  'ui',
];

export function CreateTaskDialog({
  open,
  onClose,
  onCreated,
  defaultParentId,
  defaultSprintId,
  defaultProjectId,
}: CreateTaskDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ItemType>('feature');
  const [priority, setPriority] = useState<ItemPriority>('medium');
  const [area, setArea] = useState<string>('');
  const [parentId, setParentId] = useState<string | null>(defaultParentId || null);
  const [sprintId, setSprintId] = useState<string>(defaultSprintId || '');
  const [projectId, setProjectId] = useState<string>(defaultProjectId || '');
  const [estTokens, setEstTokens] = useState<string>('');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');

  // Dropdown data
  const [sprints, setSprints] = useState<PmSprint[]>([]);
  const [projects, setProjects] = useState<PmProject[]>([]);

  // Parent search state
  const [showParentSearch, setShowParentSearch] = useState(false);
  const [parentQuery, setParentQuery] = useState('');
  const [parentResults, setParentResults] = useState<PmItemSearchResult[]>([]);
  const [searchingParent, setSearchingParent] = useState(false);
  const [selectedParent, setSelectedParent] = useState<PmItemSearchResult | null>(null);
  const [parentSearchError, setParentSearchError] = useState<string | null>(null);

  const parentSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parentSearchInputRef = useRef<HTMLInputElement>(null);

  // Load sprints and projects when dialog opens
  useEffect(() => {
    if (!open) return;

    listSprints()
      .then(setSprints)
      .catch(() => setSprints([]));

    listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [open]);

  // Debounced parent search
  useEffect(() => {
    if (!parentQuery || parentQuery.length < 1) {
      setParentResults([]);
      setSearchingParent(false);
      return;
    }

    let cancelled = false;

    if (parentSearchTimer.current) {
      clearTimeout(parentSearchTimer.current);
    }

    parentSearchTimer.current = setTimeout(async () => {
      setSearchingParent(true);
      setParentSearchError(null);
      try {
        const results = await searchItemsForLink(parentQuery);
        if (!cancelled) {
          setParentResults(results);
        }
      } catch (err: unknown) {
        console.error('[CreateTaskDialog] Parent search failed:', err);
        if (!cancelled) {
          setParentResults([]);
          const msg = err instanceof Error ? err.message : JSON.stringify(err);
          setParentSearchError(msg);
        }
      } finally {
        if (!cancelled) {
          setSearchingParent(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      if (parentSearchTimer.current) {
        clearTimeout(parentSearchTimer.current);
      }
    };
  }, [parentQuery]);

  // Focus search input when parent search is opened
  useEffect(() => {
    if (showParentSearch && parentSearchInputRef.current) {
      parentSearchInputRef.current.focus();
    }
  }, [showParentSearch]);

  const resetForm = useCallback(() => {
    setTitle('');
    setDescription('');
    setType('feature');
    setPriority('medium');
    setArea('');
    setParentId(defaultParentId || null);
    setSprintId(defaultSprintId || '');
    setProjectId(defaultProjectId || '');
    setEstTokens('');
    setStartDate('');
    setDueDate('');
    setError(null);
    setShowParentSearch(false);
    setParentQuery('');
    setParentResults([]);
    setSelectedParent(null);
  }, [defaultParentId, defaultSprintId, defaultProjectId]);

  function handleSelectParent(result: PmItemSearchResult) {
    setSelectedParent(result);
    setParentId(result.id);
    setShowParentSearch(false);
    setParentQuery('');
    setParentResults([]);
  }

  function handleClearParent() {
    setSelectedParent(null);
    setParentId(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await createItem({
        title,
        description: description || null,
        type,
        priority,
        area: area || null,
        parent_id: parentId || null,
        sprint_id: sprintId || null,
        project_id: projectId || null,
        est_tokens: estTokens ? parseInt(estTokens, 10) : null,
        start_date: startDate || null,
        due_date: dueDate || null,
      });
      resetForm();
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create item');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <Modal open size="lg" title="Create Backlog Item" onClose={onClose}>
      {/* Form */}
      <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Title */}
          <div>
            <Label required>Title</Label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={INPUT_CLASS}
              placeholder="Brief title for the item"
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <Label>Description</Label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={`${INPUT_CLASS} resize-none`}
              placeholder="Detailed description (optional)..."
            />
          </div>

          {/* Type + Priority row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Type</Label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ItemType)}
                className={INPUT_CLASS}
              >
                {(Object.entries(TYPE_LABELS) as [ItemType, string][]).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label>Priority</Label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as ItemPriority)}
                className={INPUT_CLASS}
              >
                {(Object.entries(PRIORITY_LABELS) as [ItemPriority, string][]).map(
                  ([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  )
                )}
              </select>
            </div>
          </div>

          {/* Area */}
          <div>
            <Label>Area</Label>
            <select
              value={area}
              onChange={(e) => setArea(e.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">Select area...</option>
              {AREA_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>

          {/* Parent item search */}
          <div>
            <Label>Parent Item</Label>
            {selectedParent || parentId ? (
              <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-md px-3 py-2">
                <span className="text-sm text-gray-900 truncate">
                  {selectedParent ? (
                    <>
                      {selectedParent.item_number != null && (
                        <span className="text-green-600 text-xs font-medium mr-1">
                          #{selectedParent.item_number}
                        </span>
                      )}
                      {selectedParent.title}
                    </>
                  ) : parentId}
                </span>
                <button
                  type="button"
                  onClick={handleClearParent}
                  className="ml-2 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : showParentSearch ? (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    ref={parentSearchInputRef}
                    type="text"
                    value={parentQuery}
                    onChange={(e) => setParentQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.preventDefault();
                    }}
                    className={`${INPUT_CLASS} pl-9`}
                    placeholder="Search by ID or title..."
                    autoFocus
                  />
                </div>

                {searchingParent && (
                  <div className="flex items-center gap-2 text-xs text-gray-400 py-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Searching...
                  </div>
                )}

                {!searchingParent && parentResults.length > 0 && (
                  <div className="space-y-1 max-h-32 overflow-y-auto border border-gray-200 rounded-md">
                    {parentResults.map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        onClick={() => handleSelectParent(result)}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <span className="text-gray-400 text-xs">
                          #{result.item_number ?? result.id.slice(0, 8)}
                        </span>{' '}
                        {result.title}
                      </button>
                    ))}
                  </div>
                )}

                {!searchingParent && parentQuery.length >= 1 && parentResults.length === 0 && (
                  <p className="text-xs text-gray-400 py-1">
                    {parentSearchError ? `Error: ${parentSearchError}` : 'No items found'}
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setShowParentSearch(false);
                    setParentQuery('');
                  }}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowParentSearch(true)}
                className="text-sm text-primary-600 hover:text-primary-700"
              >
                Select parent item...
              </button>
            )}
          </div>

          {/* Sprint + Project row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Sprint</Label>
              <select
                value={sprintId}
                onChange={(e) => setSprintId(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">No sprint</option>
                {sprints.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label>Project</Label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Est Tokens */}
          <div>
            <Label>Estimated Tokens</Label>
            <input
              type="number"
              value={estTokens}
              onChange={(e) => setEstTokens(e.target.value)}
              className={INPUT_CLASS}
              placeholder="e.g. 10000"
              min="0"
            />
          </div>

          {/* Start Date + Due Date row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start Date</Label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <Label>Due Date</Label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting || !title.trim()}>
              {submitting ? 'Creating...' : 'Create Item'}
            </Button>
          </div>
      </form>
    </Modal>
  );
}
