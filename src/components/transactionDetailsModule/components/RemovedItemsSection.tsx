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
}: RemovedItemsSectionProps<TGroup>): React.ReactElement {
  return (
    <div className="mt-4">
      {/* Toggle button */}
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
            groups.map((group) => (
              <React.Fragment key={getGroupKey(group)}>
                {renderGroup(group)}
              </React.Fragment>
            ))}
        </div>
      )}
    </div>
  );
}
