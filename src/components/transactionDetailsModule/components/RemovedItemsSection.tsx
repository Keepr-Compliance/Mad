/**
 * RemovedItemsSection Component (BACKLOG-1793)
 *
 * Shared presentational shell for the collapsible "Show removed" section used by
 * BOTH the Emails tab (RemovedEmailsSection) and the Texts tab
 * (RemovedMessagesSection). Renders the toggle button with its live count label,
 * the collapsible container, the loading spinner, and the empty state, then
 * delegates per-group card rendering to a `renderGroup` render prop.
 *
 * All behaviour (fetch, controlled-open, mount-rehydrate, refreshKey, restore +
 * silent refresh) lives in the shared useRemovedSection hook. Labels and
 * data-testids are parameterised so each tab keeps its own copy for tests /
 * discoverability while sharing one implementation.
 */
import React from "react";
import { BulkSelectionBar } from "./BulkSelectionBar";

export interface RemovedItemsSectionProps<TGroup> {
  /** Whether the section is expanded. */
  isOpen: boolean;
  /** Toggle the section open/closed (fetches on open). */
  onToggle: () => void;
  /** Whether the list is currently loading. */
  loading: boolean;
  /** Display groups to render (one card each). */
  groups: TGroup[];
  /** Current count, or null before the first fetch. */
  totalCount: number | null;
  /** Toggle label shown before the first fetch (e.g. "Show removed emails"). */
  emptyToggleLabel: string;
  /** Spinner label (e.g. "Loading removed emails..."). */
  loadingLabel: string;
  /** Message shown when the list is empty (e.g. "No removed emails found."). */
  emptyMessage: string;
  /** data-testid for the toggle button. */
  toggleTestId: string;
  /** data-testid for the expanded section container. */
  sectionTestId: string;
  /** Stable React key for each group. */
  getGroupKey: (group: TGroup) => string;
  /** Render one group's card(s). */
  renderGroup: (group: TGroup) => React.ReactNode;

  // BACKLOG-1719: multi-select bulk restore. All optional — when the selection
  // handlers are omitted the section renders exactly as before.
  /** Whether the section is in selection mode (checkboxes visible). */
  selectionMode?: boolean;
  /** Enter selection mode (renders a "Select" affordance when provided). */
  onEnterSelectionMode?: () => void;
  /** Exit selection mode. */
  onExitSelectionMode?: () => void;
  /** Whether a given group is selected. */
  isGroupSelected?: (group: TGroup) => boolean;
  /** Toggle a given group's selection. */
  onToggleGroupSelect?: (group: TGroup) => void;
  /** Number of selected groups. */
  selectedCount?: number;
  /** Select every visible group. */
  onSelectAll?: () => void;
  /** Clear the selection. */
  onDeselectAll?: () => void;
  /** Perform the bulk restore. */
  onBulkRestore?: () => void;
  /** Whether a bulk restore is in progress. */
  isBulkRestoring?: boolean;
  /** Label for the bulk action button (default "Restore"). */
  bulkActionLabel?: string;
  /** data-testid for the "Select" entry button. */
  selectEntryTestId?: string;
}

export function RemovedItemsSection<TGroup>({
  isOpen,
  onToggle,
  loading,
  groups,
  totalCount,
  emptyToggleLabel,
  loadingLabel,
  emptyMessage,
  toggleTestId,
  sectionTestId,
  getGroupKey,
  renderGroup,
  selectionMode = false,
  onEnterSelectionMode,
  onExitSelectionMode,
  isGroupSelected,
  onToggleGroupSelect,
  selectedCount = 0,
  onSelectAll,
  onDeselectAll,
  onBulkRestore,
  isBulkRestoring = false,
  bulkActionLabel = "Restore",
  selectEntryTestId,
}: RemovedItemsSectionProps<TGroup>): React.ReactElement {
  // BACKLOG-1719: the "Select" affordance is only meaningful when bulk-restore
  // wiring is present AND there is at least one removed group to act on.
  const canSelect =
    !!onEnterSelectionMode && !loading && groups.length > 0;

  return (
    <div className="mt-4">
      {/* Toggle row: expand/collapse + optional "Select" entry */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors"
          data-testid={toggleTestId}
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
          {totalCount !== null ? `Show removed (${totalCount})` : emptyToggleLabel}
        </button>

        {isOpen && canSelect && (
          selectionMode ? (
            <button
              type="button"
              onClick={onExitSelectionMode}
              className="text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={onEnterSelectionMode}
              className="text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors"
              data-testid={selectEntryTestId}
            >
              Select
            </button>
          )
        )}
      </div>

      {/* Collapsible section */}
      {isOpen && (
        <div className="mt-3 space-y-3" data-testid={sectionTestId}>
          {loading && (
            <div className="flex items-center gap-2 py-4 justify-center">
              <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-gray-400">{loadingLabel}</span>
            </div>
          )}

          {!loading && groups.length === 0 && (
            <p className="text-sm text-gray-400 py-2">{emptyMessage}</p>
          )}

          {!loading &&
            groups.map((group) => {
              const card = (
                <React.Fragment key={getGroupKey(group)}>
                  {renderGroup(group)}
                </React.Fragment>
              );

              if (!selectionMode) return card;

              const selected = isGroupSelected?.(group) ?? false;
              return (
                <div
                  key={getGroupKey(group)}
                  className="flex items-start gap-2"
                  data-testid="removed-group-selectable"
                >
                  <button
                    type="button"
                    onClick={() => onToggleGroupSelect?.(group)}
                    className="flex-shrink-0 mt-3"
                    aria-pressed={selected}
                    data-testid="removed-group-select"
                  >
                    <div
                      className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                        selected ? "bg-blue-500 border-blue-500" : "border-gray-300 hover:border-blue-400"
                      }`}
                    >
                      {selected && (
                        <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  </button>
                  <div className="min-w-0 flex-1">{card}</div>
                </div>
              );
            })}
        </div>
      )}

      {/* BACKLOG-1719: floating bulk bar while selecting removed items */}
      {selectionMode && (
        <BulkSelectionBar
          selectedCount={selectedCount}
          totalCount={groups.length}
          onSelectAll={onSelectAll ?? (() => {})}
          onDeselectAll={onDeselectAll ?? (() => {})}
          onClose={onExitSelectionMode ?? (() => {})}
          actionLabel={bulkActionLabel}
          actionProcessingLabel={`${bulkActionLabel.replace(/e$/, "")}ing...`}
          onAction={onBulkRestore ?? (() => {})}
          isActionProcessing={isBulkRestoring}
          actionVariant="success"
          testId={`${sectionTestId}-bulk-bar`}
          actionTestId={`${sectionTestId}-bulk-restore`}
        />
      )}
    </div>
  );
}
