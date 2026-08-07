/**
 * RemovedTransactionContactsSection (BACKLOG-2367)
 *
 * The "Show removed (N)" section under Key Contacts on the transaction Overview
 * tab: parties who were taken off THIS deal, and the button that puts them back.
 *
 * BACKLOG-2366 turned removing a party from a hard DELETE into a tombstone on
 * the `transaction_contacts` row, so the role survived — but nothing surfaced
 * it. From the user's seat a preserved row that no screen can reach is
 * indistinguishable from the delete it replaced. This is the surface that makes
 * the preservation real, and it is the surface `getRemovedTransactionContacts`
 * was written for (its docblock names this task).
 *
 * This is a THIN ADAPTER, deliberately. Every behaviour a user can observe here
 * — controlled open state, mount rehydrate, refreshKey silent re-fetch, restore
 * with in-place list update and a silent parent refresh, multi-select bulk
 * restore — already exists in `useRemovedSection` + `RemovedItemsSection` and is
 * shared with the Emails and Texts tabs. This file supplies only the four
 * contact-specific callbacks and the card. Founder standing rule: do not
 * reinvent the wheel; add a component only if we need to.
 */
import React, { useCallback } from "react";
import { getRoleDisplayName, type TransactionType } from "@/utils/transactionRoleUtils";
import { labelForTransactionContact } from "@/utils/contactDisplayLabel";
// TYPE-ONLY, fully erased at build time. The renderer may not VALUE-import from
// electron/ (Vite parses it as JavaScript); a type import carries no runtime
// dependency, which is how `src/types/contactProvenance.ts` already reads this
// same module.
import type { RemovedTransactionContact } from "@electron/types/ipc/window-api-transactions";
import { ContactTombstonePill } from "@/components/shared/ContactTombstonePill";
import { RemovedItemsSection } from "./RemovedItemsSection";
import { useRemovedSection, type RemovedRestoreResult } from "../hooks/useRemovedSection";

interface RemovedTransactionContactsSectionProps {
  transactionId: string;
  /** Drives the role badge wording, exactly as the live Key Contacts cards do. */
  transactionType: TransactionType;
  /**
   * SILENT parent refresh after a restore. MUST NOT set a loading flag — a
   * spinner here unmounts the Key Contacts list and collapses this section
   * mid-interaction (the BACKLOG-1780 failure, in its contacts form).
   */
  onRestoreComplete?: () => Promise<void>;
  onShowSuccess?: (message: string) => void;
  onShowError?: (message: string) => void;
  /** Lifted open state, so a refetch of the parent never collapses the section. */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Increment after a party is removed so the count updates without a spinner. */
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

// ---------------------------------------------------------------------------
// Adapter callbacks. Module-level so their identity is stable across renders —
// the hook memoises on them, and an inline arrow would re-group on every render.
// ---------------------------------------------------------------------------

/**
 * One row per removed party — no grouping. Emails group by thread because a
 * thread is one thing a user restores as a unit; a party is already atomic.
 */
const groupContactRows = (
  rows: RemovedTransactionContact[],
): RemovedTransactionContact[] => rows;

const computeContactCount = (rows: RemovedTransactionContact[]): number => rows.length;

/**
 * The junction row id — the identity of the row being displayed and restored.
 *
 * An earlier version of this comment justified the choice with "a contact can
 * hold more than one role on the same deal". THAT IS FALSE:
 * `transaction_contacts` declares `UNIQUE(transaction_id, contact_id)`
 * (schema.sql) and no migration drops it, so one contact has at most one row
 * per deal and `contact_id` is therefore unique within this list too.
 *
 * So `contact_id` would also work — today, and only because of that constraint.
 * Keying on the row's own primary key is preferred for the honest reason:
 * it does not borrow its correctness from a schema invariant this component has
 * no reason to know about, and `getRemovedTransactionContacts` returns `tc.*`
 * with `id` as the row identity anyway.
 *
 * The distinction is therefore NOT observable under the current schema, and the
 * test for it says so rather than inventing an unreachable fixture to make it
 * look observable. (Fixed in review of PR #2211 — the same "true by accident"
 * problem this PR removed from the `transactionContactDbService` header.)
 */
const contactRestoreKey = (group: RemovedTransactionContact): string => group.id;

const removeRestoredContactRows = (
  rows: RemovedTransactionContact[],
  group: RemovedTransactionContact,
): RemovedTransactionContact[] => rows.filter((r) => r.id !== group.id);

const contactSuccessMessage = (count: number): string =>
  count > 1 ? `${count} contacts restored` : "Contact restored";

const contactBulkSuccessMessage = (restoredTotal: number): string =>
  restoredTotal > 1 ? `${restoredTotal} contacts restored` : "Contact restored";

export function RemovedTransactionContactsSection({
  transactionId,
  transactionType,
  onRestoreComplete,
  onShowSuccess,
  onShowError,
  isOpen: externalIsOpen,
  onOpenChange,
  refreshKey,
}: RemovedTransactionContactsSectionProps): React.ReactElement {
  // Reject on failure so the shared hook applies the right spinner-vs-silent
  // failure behaviour (a resolved [] is authoritative and clears the list).
  const fetchRows = useCallback(
    async (txId: string): Promise<RemovedTransactionContact[]> => {
      if (!window.api?.transactions?.getRemovedContacts) {
        throw new Error("getRemovedContacts unavailable");
      }
      const result = await window.api.transactions.getRemovedContacts(txId);
      if (result.success) return result.removedContacts ?? [];
      throw new Error(result.error || "Failed to fetch removed contacts");
    },
    [],
  );

  const restoreGroup = useCallback(
    async (group: RemovedTransactionContact): Promise<RemovedRestoreResult> => {
      const result = await window.api.transactions.restoreContact(
        transactionId,
        group.contact_id,
      );
      if (!result.success) {
        return { success: false, error: result.error };
      }
      // `restored: false` means the assignment was already live — another
      // window restored it, or this list is stale. Dropping the row is the
      // correct repair either way, so it counts as success; the row leaves the
      // removed list and the silent parent refresh shows it back on the deal.
      return { success: true, restoredCount: 1 };
    },
    [transactionId],
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
  } = useRemovedSection<RemovedTransactionContact, RemovedTransactionContact>({
    scopeId: transactionId,
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
    logLabel: "removed transaction contacts",
  });

  const renderGroup = (group: RemovedTransactionContact): React.ReactNode => {
    const name = labelForTransactionContact(group);
    const role = group.specific_role || group.role || "Unknown Role";
    const isRestoring = restoringId === group.id;

    return (
      <div>
        {/* Card mirrors ContactSummaryCard's layout; the only visual difference
            is the gray avatar, exactly as removed emails differ from live ones. */}
        <div
          className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3"
          data-testid="removed-transaction-contact-card"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-gray-400 to-gray-500 rounded-full items-center justify-center text-white font-bold flex-shrink-0 hidden sm:flex">
              {name.charAt(0).toUpperCase()}
            </div>

            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                {/*
                  BACKLOG-2568 — the labels sit in a LEFT group beside the name,
                  mirroring ContactSummaryCard, and NOT in the right cluster
                  below: that cluster is `flex-shrink-0` and already carries the
                  role badge plus the Restore button, so two more pills would
                  crowd it off a narrow card. `flex-wrap` lets them drop to a
                  second line instead of squeezing the name.

                  PRECEDENCE, when a party was removed from this deal AND
                  deleted from the address book (both are reachable — the two
                  tombstones are independent): show BOTH, deal-removal FIRST.
                  The deal fact explains why this row is in this section; the
                  address-book fact must be seen BEFORE clicking Restore,
                  because restoring the role returns someone to the deal who is
                  still absent from Clients & Contacts and from the picker.
                  Asserted by name and by document order in
                  TransactionDetailsTab.tombstonePills-2568.test.tsx (C4).
                */}
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="font-semibold text-gray-900 truncate">{name}</span>
                  <ContactTombstonePill variant="deal-removed" className="flex-shrink-0" />
                  {/* Truthiness, not `!= null` — see the matching guard in
                      ContactSummaryCard: an empty string is not a timestamp. */}
                  {Boolean(group.contact_removed_at) && (
                    <ContactTombstonePill variant="contact-removed" className="flex-shrink-0" />
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="inline-block px-3 py-1 bg-gray-200 text-gray-700 text-xs font-semibold rounded-full">
                    {getRoleDisplayName(role, transactionType)}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRestore(group)}
                    disabled={isRestoring}
                    className="text-gray-400 hover:text-green-600 hover:bg-green-50 rounded p-1 transition-all disabled:opacity-50"
                    title="Restore to transaction"
                    data-testid="restore-transaction-contact-button"
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
                {group.contact_email && (
                  <span className="truncate">{group.contact_email}</span>
                )}
                {group.contact_email && group.contact_phone && (
                  <span className="text-gray-300 hidden sm:inline">|</span>
                )}
                {group.contact_phone && <span>{group.contact_phone}</span>}
              </div>
              {group.contact_company && (
                <span className="text-xs text-gray-500">{group.contact_company}</span>
              )}
            </div>
          </div>
        </div>

        {/*
          Removal DATE below the card — same placement as removed emails.

          BACKLOG-2501: the removal REASON line was dropped here too. This one
          printed `removed_reason` raw, so every row read "Removed from
          transaction by user" — the stored default from
          `DEFAULT_REMOVAL_REASON`, identical on every card and therefore
          carrying no information at all. The column is still written and still
          feeds the audit trail; it is just not on screen.
        */}
        <div
          className="flex items-center gap-3 mb-3 ml-1 mt-1 text-xs text-gray-400"
          data-testid="removed-transaction-contact-meta"
        >
          {group.removed_at && <span>Removed {formatRemovedDate(group.removed_at)}</span>}
        </div>
      </div>
    );
  };

  return (
    <RemovedItemsSection<RemovedTransactionContact>
      isOpen={isOpen}
      onToggle={handleToggle}
      loading={loading}
      groups={groups}
      totalCount={totalCount}
      // BACKLOG-2579 follow-up (founder QA of PR #2249): "can we move this
      // to be centred". Opt-in per section — the shared shell still
      // left-aligns the emails and conversations toggles.
      centerToggle
      emptyToggleLabel="Show removed contacts"
      loadingLabel="Loading removed contacts..."
      emptyMessage="No removed contacts found."
      toggleTestId="show-removed-transaction-contacts-toggle"
      sectionTestId="removed-transaction-contacts-section"
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
      selectEntryTestId="select-removed-transaction-contacts"
    />
  );
}
