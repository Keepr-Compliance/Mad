'use client';

/**
 * ProjectSprints -- Sprint creation and status summary for project detail page.
 *
 * Contains:
 * - InlineSprintCreate: "+ Create new sprint" form
 * - StatusSummary: Progress bar and status badges for the project
 * - TokenMetricCards: Token estimation/actual metric cards
 */

import { useState } from 'react';
import {
  Plus,
  Coins,
  TrendingUp,
  TrendingDown,
  Calendar,
  Info,
} from 'lucide-react';
import { assignToSprint } from '@/lib/pm-queries';
import type { PmProject, ItemStatus } from '@/lib/pm-types';
import { STATUS_LABELS, STATUS_COLORS } from '@/lib/pm-types';
import { DualProgressBar } from '../../../components/DualProgressBar';
import { formatTokens } from '@/lib/pm-utils';
import { CreateSprintDialog } from '../../../components/CreateSprintDialog';

const STATUS_ORDER: ItemStatus[] = [
  'pending',
  'in_progress',
  'testing',
  'waiting_for_user',
  'completed',
  'blocked',
  'deferred',
  'reopened',
  'obsolete',
];

// ---------------------------------------------------------------------------
// InlineSprintCreate (BACKLOG-1664)
//
// Renders a "+ Create new sprint" button that opens the global
// CreateSprintDialog. The created sprint is standalone (projectId is not
// passed — CreateSprintDialog already sends null). If any project tasks are
// currently multi-selected, those tasks are auto-assigned to the newly
// created sprint, so the user can scaffold a sprint + populate it in one
// flow from the project page.
// ---------------------------------------------------------------------------

interface InlineSprintCreateProps {
  /**
   * Retained for API-compatibility with earlier callers. No longer passed
   * to `createSprint` — sprints are standalone (BACKLOG-1664).
   */
  projectId: string;
  onCreated: () => void;
  /**
   * BACKLOG-1664: when provided, after a new sprint is created these items
   * are automatically assigned to it. Pass the set that's currently selected
   * on the project page (may be empty — the dialog just creates a sprint).
   */
  selectedItemIds?: string[];
  /**
   * BACKLOG-1664: called after auto-assign completes (or was skipped because
   * `selectedItemIds` was empty), so the page can clear its selection.
   */
  onAutoAssigned?: () => void;
}

export function InlineSprintCreate({
  projectId: _projectId,
  onCreated,
  selectedItemIds,
  onAutoAssigned,
}: InlineSprintCreateProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Snapshot the selected ids at the moment the user opens the dialog so
  // a stale selection doesn't cause surprise assignments if the user
  // deselects while the dialog is open.
  const [pendingItemIds, setPendingItemIds] = useState<string[]>([]);

  const openDialog = () => {
    setPendingItemIds(selectedItemIds ? [...selectedItemIds] : []);
    setDialogOpen(true);
  };

  // After CreateSprintDialog calls onCreated, it already closed itself.
  // We still need to (a) auto-assign the snapshot items to the new sprint
  // and (b) notify the parent page. As of BACKLOG-1668 the dialog passes
  // the newly-created sprint's id directly, so we no longer rely on the
  // "newest sprint by created_at" heuristic (which raced with concurrent
  // creates).
  async function handleAfterCreate(newSprintId: string) {
    if (pendingItemIds.length === 0) {
      onCreated();
      onAutoAssigned?.();
      return;
    }
    try {
      await assignToSprint(pendingItemIds, newSprintId);
    } catch (err) {
      // Non-fatal: the sprint still exists; user can assign manually.
      console.error('Failed to auto-assign items to new sprint:', err);
    } finally {
      setPendingItemIds([]);
      onCreated();
      onAutoAssigned?.();
    }
  }

  return (
    <>
      <button
        onClick={openDialog}
        className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 py-3 px-4"
      >
        <Plus className="h-4 w-4" />
        {selectedItemIds && selectedItemIds.length > 0
          ? `Create new sprint with ${selectedItemIds.length} selected`
          : 'Create new sprint'}
      </button>
      <CreateSprintDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={handleAfterCreate}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// StatusSummary -- Progress bar and status badges
// ---------------------------------------------------------------------------

interface StatusSummaryProps {
  itemsByStatus: Record<string, number>;
  tokenSums: { estTotal: number; actualTotal: number; variance: number };
  /** Active status filter (null = all). */
  activeFilter?: ItemStatus | null;
  /** Called when user clicks a segment / legend item. */
  onStatusFilter?: (status: ItemStatus | null) => void;
}

export function StatusSummary({
  itemsByStatus,
  tokenSums,
  activeFilter,
  onStatusFilter,
}: StatusSummaryProps) {
  const totalItems = Object.values(itemsByStatus).reduce((a, b) => a + b, 0);
  const completedItems = itemsByStatus['completed'] ?? 0;

  const handleBadgeClick = (status: ItemStatus) => {
    if (!onStatusFilter) return;
    onStatusFilter(activeFilter === status ? null : status);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Status Summary</h2>
        {activeFilter && onStatusFilter && (
          <button
            type="button"
            onClick={() => onStatusFilter(null)}
            className="text-xs text-primary-600 hover:text-primary-700"
          >
            Clear filter
          </button>
        )}
      </div>

      <DualProgressBar
        completed={completedItems}
        total={totalItems}
        byStatus={itemsByStatus}
        estTokens={tokenSums.estTotal}
        actualTokens={tokenSums.actualTotal}
        showLegend={false}
        onStatusFilter={onStatusFilter}
        activeFilter={activeFilter}
      />

      {totalItems > 0 ? (
        <div className="flex flex-wrap gap-3 mt-4">
          {STATUS_ORDER.filter((s) => (itemsByStatus[s] ?? 0) > 0).map(
            (status) => {
              const isActive = activeFilter === status;
              const isDimmed = activeFilter && !isActive;
              const clickable = !!onStatusFilter;
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => handleBadgeClick(status)}
                  disabled={!clickable}
                  className={`flex items-center gap-1.5 transition-opacity ${
                    clickable ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
                  } ${isDimmed ? 'opacity-40' : ''} ${
                    isActive ? 'ring-2 ring-offset-1 ring-gray-800 rounded-full' : ''
                  }`}
                  aria-pressed={isActive}
                >
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status]}`}
                  >
                    {STATUS_LABELS[status]}
                  </span>
                  <span className="text-sm font-medium text-gray-700">
                    {itemsByStatus[status]}
                  </span>
                </button>
              );
            }
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-400 mt-4">
          No items in this project yet.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TokenMetricCards -- Token estimation/actual metric cards
// ---------------------------------------------------------------------------

interface TokenMetricCardsProps {
  tokenSums: { estTotal: number; actualTotal: number; variance: number };
  project: PmProject;
}

export function TokenMetricCards({ tokenSums, project }: TokenMetricCardsProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-50">
            <Coins className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <p className="text-sm text-gray-500">Estimated Tokens</p>
            <p className="text-2xl font-bold text-gray-900">
              {formatTokens(tokenSums.estTotal)}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-purple-50">
            <Coins className="h-5 w-5 text-purple-600" />
          </div>
          <div>
            <p className="text-sm text-gray-500">Actual Tokens</p>
            <p className="text-2xl font-bold text-gray-900">
              {formatTokens(tokenSums.actualTotal)}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center gap-3">
          {(() => {
            const isOver = tokenSums.variance > 0;
            const Icon = isOver ? TrendingUp : TrendingDown;
            return (
              <>
                <div
                  className={`p-2 rounded-lg ${isOver ? 'bg-red-50' : 'bg-green-50'}`}
                >
                  <Icon
                    className={`h-5 w-5 ${isOver ? 'text-red-600' : 'text-green-600'}`}
                  />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Variance</p>
                  <p
                    className={`text-2xl font-bold ${isOver ? 'text-red-600' : 'text-green-600'}`}
                  >
                    {isOver ? '+' : ''}
                    {tokenSums.variance.toFixed(0)}%
                  </p>
                </div>
              </>
            );
          })()}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-50">
            <Calendar className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <div className="flex items-center gap-1">
              <p className="text-sm text-gray-500">Days Open</p>
              <span title="Days since project was created">
                <Info className="h-3.5 w-3.5 text-gray-400" />
              </span>
            </div>
            <p className="text-2xl font-bold text-gray-900">
              {Math.floor(
                (Date.now() - new Date(project.created_at).getTime()) /
                  (1000 * 60 * 60 * 24)
              )}{' '}
              days
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
