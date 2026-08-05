/**
 * RemovedContactsSection (BACKLOG-2367)
 *
 * The "Show removed contacts (N)" section at the foot of the Clients & Contacts
 * list: people removed from the database, and the button that brings them back.
 *
 * BACKLOG-2365 changed removal from `DELETE FROM contacts` — whose FK cascade
 * destroyed the person's ROLES on audited transactions — into a tombstone that
 * destroys nothing. But a preserved row that no screen can reach is, from the
 * user's seat, the same as the delete it replaced. This is the screen that
 * makes the preservation real.
 *
 * ## Why this imports from `transactionDetailsModule`
 *
 * Deliberate reuse, not a layering accident. `useRemovedSection` +
 * `RemovedItemsSection` are the generic, already-proven pair behind the removed
 * EMAILS and removed TEXTS sections; every behaviour this section needs is
 * already in them. Founder standing rule: "do not reinvent the wheel, add a
 * component only if we need to."
 *
 * They were left in place rather than moved to a shared folder because moving
 * them is not free: `RemovedItemsSection` depends on `BulkSelectionBar`, which
 * has five importers inside that module. Moving the pair means touching those
 * five files for zero behavioural change; moving only `RemovedItemsSection`
 * leaves a `shared/ -> feature/` import edge, which is worse than the
 * `feature/ -> feature/` edge it would replace. Flagged in the PR for review.
 */
import React, { useCallback } from "react";
import type { RemovedContactRow } from "@electron/types/ipc/window-api-contacts";
import { RemovedItemsSection } from "../../transactionDetailsModule/components/RemovedItemsSection";
import {
  useRemovedSection,
  type RemovedRestoreResult,
} from "../../transactionDetailsModule/hooks/useRemovedSection";

interface RemovedContactsSectionProps {
  userId: string;
  /**
   * SILENT parent refresh after a restore — reloads the main contact list so
   * the restored person reappears in it. Must NOT set a loading flag: a
   * spinner unmounts the list and collapses this section mid-interaction.
   */
  onRestoreComplete?: () => Promise<void>;
  onShowSuccess?: (message: string) => void;
  onShowError?: (message: string) => void;
  /** Lifted open state, so a parent refetch never collapses the section. */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Increment after a removal so the count updates in place, with no spinner. */
  refreshKey?: number;
}

/** Format a timestamp for the "Removed <date>" line. Matches RemovedEmailsSection. */
function formatRemovedDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

/**
 * Human wording for `contacts.removed_reason`.
 *
 * The stored values are a closed union (`ContactRemovalReason`) and they are
 * NOT interchangeable to a user: "user_deleted" is the Delete action,
 * "user_unimported" is the Clients & Contacts remove button. Falling through to
 * the raw value keeps a pre-v56 or future row readable rather than blank.
 */
function removalReasonLabel(reason: string | null): string | null {
  switch (reason) {
    case "user_deleted":
      return "Deleted";
    case "user_unimported":
      return "Removed from Keepr";
    default:
      return reason;
  }
}

// ---------------------------------------------------------------------------
// Adapter callbacks. Module-level so their identity is stable across renders.
// ---------------------------------------------------------------------------

/** One row per removed contact — a person is already atomic, nothing to group. */
const groupContactRows = (rows: RemovedContactRow[]): RemovedContactRow[] => rows;

const computeContactCount = (rows: RemovedContactRow[]): number => rows.length;

const contactRestoreKey = (group: RemovedContactRow): string => group.id;

const removeRestoredContactRows = (
  rows: RemovedContactRow[],
  group: RemovedContactRow,
): RemovedContactRow[] => rows.filter((r) => r.id !== group.id);

const contactSuccessMessage = (count: number): string =>
  count > 1 ? `${count} contacts restored` : "Contact restored";

const contactBulkSuccessMessage = (restoredTotal: number): string =>
  restoredTotal > 1 ? `${restoredTotal} contacts restored` : "Contact restored";

export function RemovedContactsSection({
  userId,
  onRestoreComplete,
  onShowSuccess,
  onShowError,
  isOpen: externalIsOpen,
  onOpenChange,
  refreshKey,
}: RemovedContactsSectionProps): React.ReactElement {
  const fetchRows = useCallback(
    async (scopedUserId: string): Promise<RemovedContactRow[]> => {
      if (!window.api?.contacts?.getRemoved) {
        throw new Error("getRemoved unavailable");
      }
      const result = await window.api.contacts.getRemoved(scopedUserId);
      if (result.success) return result.contacts ?? [];
      throw new Error(result.error || "Failed to fetch removed contacts");
    },
    [],
  );

  const restoreGroup = useCallback(
    async (group: RemovedContactRow): Promise<RemovedRestoreResult> => {
      const result = await window.api.contacts.restore(group.id);
      if (!result.success) {
        return { success: false, error: result.error };
      }
      // `restored: false` means the contact was already active — a stale list.
      // Dropping the row is the correct repair either way.
      return { success: true, restoredCount: 1 };
    },
    [],
  );

  const {
    isOpen,
    loading,
    groups,
    totalCount,
    restoringId,
    handleToggle,
    handleRestore,
    selectionMode,
    enterSelectionMode,
    exitSelectionMode,
    selectedCount,
    isGroupSelected,
    toggleGroupSelection,
    selectAllGroups,
    deselectAllGroups,
    bulkRestore,
    isBulkRestoring,
  } = useRemovedSection<RemovedContactRow, RemovedContactRow>({
    scopeId: userId,
    isOpen: externalIsOpen,
    onOpenChange,
    refreshKey,
    fetchRows,
    groupRows: groupContactRows,
    computeCount: computeContactCount,
    restoreGroup,
    removeRestoredRows: removeRestoredContactRows,
    getRestoreKey: contactRestoreKey,
    onRestoreComplete,
    onShowSuccess,
    onShowError,
    successMessage: contactSuccessMessage,
    bulkSuccessMessage: contactBulkSuccessMessage,
    errorMessage: "Failed to restore contact",
    logLabel: "removed contacts",
  });

  const renderGroup = (group: RemovedContactRow): React.ReactNode => {
    const name = group.display_name || "Unknown";
    const isRestoring = restoringId === group.id;
    const reason = removalReasonLabel(group.removed_reason);

    return (
      <div>
        <div
          className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3"
          data-testid="removed-contact-card"
        >
          <div className="flex items-center gap-3">
            {/* Gray avatar — the one visual difference from a live contact card. */}
            <div className="w-10 h-10 bg-gradient-to-br from-gray-400 to-gray-500 rounded-full items-center justify-center text-white font-bold flex-shrink-0 hidden sm:flex">
              {name.charAt(0).toUpperCase()}
            </div>

            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-gray-900 truncate">{name}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/*
                    The roles that SURVIVED the removal. This is the entire point
                    of the epic made visible: under the old cascading delete this
                    number was always zero, because the roles were destroyed.
                  */}
                  {group.active_role_count > 0 && (
                    <span
                      className="inline-block px-2 py-0.5 bg-gray-200 text-gray-700 text-xs font-medium rounded-full"
                      data-testid="removed-contact-role-count"
                    >
                      {group.active_role_count === 1
                        ? "1 transaction role"
                        : `${group.active_role_count} transaction roles`}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRestore(group)}
                    disabled={isRestoring}
                    className="text-gray-400 hover:text-green-600 hover:bg-green-50 rounded p-1 transition-all disabled:opacity-50"
                    title="Restore contact"
                    data-testid="restore-contact-button"
                  >
                    {isRestoring ? (
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        {/* Arrow-uturn-left: the restore semantic used by removed emails */}
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-2 text-sm text-gray-600">
                {group.email && <span className="truncate">{group.email}</span>}
                {group.email && group.phone && (
                  <span className="text-gray-300 hidden sm:inline">|</span>
                )}
                {group.phone && <span>{group.phone}</span>}
              </div>
              {group.company && <span className="text-xs text-gray-500">{group.company}</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 mb-3 ml-1 mt-1 text-xs text-gray-400">
          {group.removed_at && <span>Removed {formatRemovedDate(group.removed_at)}</span>}
          {reason && (
            <span className="truncate max-w-[200px]" title={reason}>
              {reason}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <RemovedItemsSection<RemovedContactRow>
      isOpen={isOpen}
      onToggle={handleToggle}
      loading={loading}
      groups={groups}
      totalCount={totalCount}
      emptyToggleLabel="Show removed contacts"
      loadingLabel="Loading removed contacts..."
      emptyMessage="No removed contacts found."
      toggleTestId="show-removed-contacts-toggle"
      sectionTestId="removed-contacts-section"
      getGroupKey={contactRestoreKey}
      renderGroup={renderGroup}
      selectionMode={selectionMode}
      onEnterSelectionMode={enterSelectionMode}
      onExitSelectionMode={exitSelectionMode}
      isGroupSelected={isGroupSelected}
      onToggleGroupSelect={toggleGroupSelection}
      selectedCount={selectedCount}
      onSelectAll={selectAllGroups}
      onDeselectAll={deselectAllGroups}
      onBulkRestore={bulkRestore}
      isBulkRestoring={isBulkRestoring}
      bulkActionLabel="Restore"
      selectEntryTestId="select-removed-contacts"
    />
  );
}
