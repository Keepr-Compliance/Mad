import React, { useState, useCallback } from "react";
import type { SourceCoverageGap } from "../../electron/types/auditCoverage";
import { ResponsiveModal, MODAL_PANEL } from "./common/ResponsiveModal";
import {
  FloatingActionBar,
  FLOATING_ACTION_BAR_CONTENT_PADDING,
} from "./common/FloatingActionBar";
import AddressVerificationStep from "./audit/AddressVerificationStep";
import ContactAssignmentStep from "./audit/ContactAssignmentStep";
import type { Transaction } from "../../electron/types/models";
import { useAppStateMachine } from "../appCore";
import { useAuditTransaction } from "../hooks/useAuditTransaction";
import { OfflineNotice } from "./common/OfflineNotice";
import { useAuditCoverageCheck } from "../hooks/useAuditCoverageCheck";
import { AuditCoveragePrompt, sourceLinesFromCoverage } from "./transactionDetailsModule/components/AuditCoveragePrompt";
import { dialogTextSource } from "./transactionDetailsModule/components/TextCoverageNotice";
import { useImportSource } from "../hooks/useImportSource";
import { usePlatform } from "../contexts/PlatformContext";
import { parseMoney } from "./transactionDates/commission";

// Type definitions
interface AuditTransactionModalProps {
  userId: string;
  provider?: string; // Optional - not currently used
  onClose: () => void;
  onSuccess: (transaction: Transaction) => void;
  editTransaction?: Transaction; // For edit mode - pre-fill from existing transaction
}

/**
 * Audit Transaction Modal
 * Comprehensive transaction creation with address verification and contact assignment
 *
 * TASK-1766: Updated to 2-step flow:
 * - Step 1: Transaction Details (address, type, dates)
 * - Step 2: Contact Assignment (search-first pattern with internal substeps)
 */
function AuditTransactionModal({
  userId,
  provider: _provider,
  onClose,
  onSuccess,
  editTransaction,
}: AuditTransactionModalProps): React.ReactElement {
  // Database initialization guard (belt-and-suspenders defense)
  const { isDatabaseInitialized } = useAppStateMachine();

  // BACKLOG-1654: Track when ContactFormModal is open to hide nav buttons
  const [isContactFormOpen, setIsContactFormOpen] = useState(false);
  const handleModalStateChange = useCallback((isOpen: boolean) => {
    setIsContactFormOpen(isOpen);
  }, []);

  // BACKLOG-2292 (Layer 1): audit-window completeness prompt at date selection.
  const { checkCoverage, runMessagesImport, importing, progress, indeterminate } =
    useAuditCoverageCheck(userId);
  // Live (founder): the dialog names only the user's own text source.
  const { isMacOS } = usePlatform();
  const importSource = useImportSource(userId, false);
  const [coveragePrompt, setCoveragePrompt] = useState<{
    hasGap: boolean;
    importerAvailable: boolean;
    // BACKLOG-2305: failsafe/error notice; when present the prompt stays open with
    // re-enabled actions so the user can retry or skip (never trapped).
    notice?: string | null;
    // BACKLOG-3663: other sources that do not reach this range (soft lines).
    sourceGaps?: SourceCoverageGap[];
    // BACKLOG-3837: the per-source floors are still being read (not "no gaps").
    sourceCoveragePending?: boolean;
    proposedStartISO?: string | null;
  } | null>(null);
  const originalStartedAt = editTransaction?.started_at ?? null;

  // Use the extracted hook for all state and handlers
  const {
    step,
    loading,
    error,
    isEditing,
    addressData,
    contactAssignments,
    selectedContactIds,
    showAddressAutocomplete,
    addressSuggestions,
    // Contact loading (lifted to parent level to prevent duplicate API calls)
    contacts,
    contactsLoading,
    contactsError,
    refreshContacts,
    refreshBothLists,
    // External contacts (from macOS Contacts app, etc.)
    externalContacts,
    externalContactsLoading,
    setAddressData,
    setSelectedContactIds,
    handleAddressChange,
    selectAddress,
    assignContact,
    removeContact,
    handleNextStep,
    handlePreviousStep,
  } = useAuditTransaction({
    userId,
    editTransaction,
    onClose,
    onSuccess,
  });

  // BACKLOG-2292: gate step-1 advancement (create) / save (edit) on an
  // audit-window coverage check. Only intercepts when the date fields are valid
  // enough that handleNextStep would proceed — otherwise defer to handleNextStep
  // so it surfaces the usual validation error. Never blocks on a detection
  // failure (checkCoverage returns null → proceed).
  const handleGatedNext = useCallback(async (): Promise<void> => {
    const proposed = addressData.started_at;
    const basicValid =
      step === 1 &&
      !!proposed &&
      addressData.property_address.trim().length > 0 &&
      !(addressData.closed_at && proposed > addressData.closed_at) &&
      // BACKLOG-3614: an unparseable Listing Price defers to handleNextStep,
      // which shows the error.
      parseMoney(addressData.listing_price_text ?? "").ok;
    if (!basicValid) {
      handleNextStep();
      return;
    }

    const coverage = await checkCoverage(proposed);
    const hasGap = !!coverage && (coverage.needsMessagesImport || coverage.needsEmailBackfill);
    // Compare date-parts to avoid a spurious "changed" from ISO-vs-YYYY-MM-DD
    // formatting differences. Require a KNOWN original start — otherwise a
    // defaulted date on a transaction that never had one isn't a real "change".
    const dateChanged =
      isEditing &&
      !!originalStartedAt &&
      (proposed || "").slice(0, 10) !== originalStartedAt.slice(0, 10);

    // CREATE: prompt only on a real data gap. EDIT: also show the Layer-1
    // re-crop reassurance whenever the start date changed (pure crop included).
    const shouldPrompt = hasGap || (isEditing && dateChanged);
    if (!shouldPrompt) {
      handleNextStep();
      return;
    }
    setCoveragePrompt({
      hasGap,
      importerAvailable: !!coverage?.messagesImporterAvailable,
      ...sourceLinesFromCoverage(coverage),
      proposedStartISO: proposed ?? null,
    });
  }, [
    step,
    addressData.started_at,
    addressData.property_address,
    addressData.closed_at,
    isEditing,
    originalStartedAt,
    checkCoverage,
    handleNextStep,
  ]);

  const proceedAfterPrompt = useCallback((): void => {
    setCoveragePrompt(null);
    handleNextStep();
  }, [handleNextStep]);

  const handleUpdateNow = useCallback(async (): Promise<void> => {
    // Best-effort targeted import for the proposed (possibly unsaved) start; the
    // save/create still proceeds regardless of the import outcome (export gate is
    // the backstop). The subsequent save's background trigger coalesces onto the
    // already-covered floor, so there is no second device scan.
    const outcome = await runMessagesImport(addressData.started_at, editTransaction?.id);
    // BACKLOG-2305: if the failsafe fired (resolution never arrived) or the IPC
    // errored, DON'T silently advance as if the import completed — re-enable the
    // prompt with a notice so the user can wait, retry, or skip. `importing` is
    // already false (the hook's watchdog cleared it), so the buttons are live.
    if (outcome.timedOut || outcome.error) {
      setCoveragePrompt((prev) =>
        prev
          ? {
              ...prev,
              notice: outcome.timedOut
                ? "This is taking longer than expected — messages are still updating in the background. You can keep waiting, try again, or skip for now."
                : `Couldn't finish updating messages: ${outcome.error}. Try again or skip for now.`,
            }
          : prev,
      );
      return;
    }
    proceedAfterPrompt();
  }, [runMessagesImport, addressData.started_at, editTransaction?.id, proceedAfterPrompt]);

  // DEFENSIVE CHECK: Return loading state if database not initialized
  // Should never trigger if AppShell gate works, but prevents errors if bypassed
  if (!isDatabaseInitialized) {
    return (
      <ResponsiveModal panelClassName="max-w-md p-8">
          <div className="text-center">
            <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
            <p className="text-gray-500 text-sm">Waiting for database...</p>
          </div>
      </ResponsiveModal>
    );
  }

  // Determine total steps and current step for display
  // In edit mode: single step (just address/dates)
  // In create mode: 3 steps (details + select contacts + assign roles)
  const totalSteps = isEditing ? 1 : 3;
  const displayStep = isEditing ? 1 : Math.min(step, 3);

  return (
    <ResponsiveModal onClose={onClose} panelClassName={`${MODAL_PANEL.lg} relative`}>
        {/* Header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-indigo-500 to-purple-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg">
          {/* Mobile layout */}
          <div className="sm:hidden flex items-center justify-between">
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
            <div className="text-right">
              <h2 className="text-lg font-bold text-white">
                {isEditing ? "Edit Details" : "New Transaction"}
              </h2>
              {!isEditing && (
                <p className="text-indigo-100 text-xs">
                  Step {displayStep} of {totalSteps}
                </p>
              )}
            </div>
          </div>
          {/* Desktop layout */}
          <div className="hidden sm:flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-white">
                {isEditing ? "Edit Transaction Details" : "New Transaction"}
              </h2>
              <p className="text-indigo-100 text-sm">
                {isEditing ? (
                  "Update property address and transaction dates"
                ) : (
                  <>
                    {step === 1 && "Step 1: Transaction Details"}
                    {step === 2 && "Step 2: Select Contacts"}
                    {step === 3 && "Step 3: Assign Roles"}
                  </>
                )}
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Progress Bar - Only show for new transactions */}
        {!isEditing && (
          <div className="flex-shrink-0 bg-gray-100 px-3 sm:px-6 py-3">
            <div className="flex items-center justify-center gap-1 sm:gap-2 max-w-md mx-auto">
              {[1, 2, 3].map((s: number) => (
                <React.Fragment key={s}>
                  <div
                    className={`w-7 h-7 sm:w-8 sm:h-8 md:w-10 md:h-10 rounded-full flex items-center justify-center text-sm sm:text-base font-semibold transition-all ${
                      s < displayStep
                        ? "bg-green-500 text-white"
                        : s === displayStep
                          ? "bg-indigo-500 text-white"
                          : "bg-gray-300 text-gray-600"
                    }`}
                  >
                    {s < displayStep ? "\u2713" : s}
                  </div>
                  {s < totalSteps && (
                    <div
                      className={`flex-1 h-1 transition-all ${s < displayStep ? "bg-green-500" : "bg-gray-300"}`}
                    ></div>
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        <OfflineNotice />

        {/* Error Message */}
        {error && (
          <div className="flex-shrink-0 mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {/* Content */}
        {/* BACKLOG-3614: bottom padding keeps the last field clear of the floating
            action group. Steps 2/3 scroll inside nested lists, so the padding sits
            on this outer container and the group floats over the padding band. */}
        <div
          className={`flex-1 min-h-0 ${FLOATING_ACTION_BAR_CONTENT_PADDING} ${step === 1 ? "overflow-y-auto px-6 pt-6" : "flex flex-col overflow-hidden pt-0 px-2"}`}
          data-testid="audit-modal-content"
        >
          {step === 1 && (
            <AddressVerificationStep
              addressData={addressData}
              onAddressChange={handleAddressChange}
              onTransactionTypeChange={(type) =>
                setAddressData(prev => ({ ...prev, transaction_type: type }))
              }
              onStartDateChange={(date) =>
                setAddressData(prev => ({ ...prev, started_at: date }))
              }
              onClosingDateChange={(date) =>
                setAddressData(prev => ({ ...prev, closing_deadline: date }))
              }
              onEndDateChange={(date) =>
                setAddressData(prev => ({ ...prev, closed_at: date }))
              }
              onListingPriceChange={(text) =>
                setAddressData(prev => ({ ...prev, listing_price_text: text }))
              }
              showAutocomplete={showAddressAutocomplete}
              suggestions={addressSuggestions}
              onSelectSuggestion={selectAddress}
              startDateMode="manual"
              // BACKLOG-3613: End Date is on the Edit screen only. A new deal
              // starts ongoing (no end date); it is entered at Submit / Export.
              showEndDate={isEditing}
            />
          )}

          {/* Step 2: Select Contacts, Step 3: Assign Roles */}
          {step >= 2 && (
            <ContactAssignmentStep
              step={step}
              // BACKLOG-2354: surface the Source/Role filter in the new-transaction
              // (audit-wizard) flow too, matching Screen2Overlay/EditContactsModal.
              // Ephemeral show-all (filterMode="ephemeral") — never persists and
              // never reads/writes the Clients & Contacts screen's saved filter.
              // Only affects step 2 (the filter lives in the step===2 branch).
              showCategoryFilter={true}
              contactAssignments={contactAssignments}
              selectedContactIds={selectedContactIds}
              onSelectedContactIdsChange={setSelectedContactIds}
              onAssignContact={assignContact}
              onRemoveContact={removeContact}
              userId={userId}
              transactionType={addressData.transaction_type}
              propertyAddress={addressData.property_address}
              // Contacts loaded at parent level to prevent duplicate API calls
              contacts={contacts}
              contactsLoading={contactsLoading}
              contactsError={contactsError}
              onRefreshContacts={refreshContacts}
              // BACKLOG-2631 — the ONE refresh path. Answering a duplicate question
              // inside this wizard now re-reads the address-book half too, so the
              // record just merged away leaves the list without closing the modal.
              onRefreshBothLists={refreshBothLists}
              // External contacts (from macOS Contacts app, etc.)
              externalContacts={externalContacts}
              externalContactsLoading={externalContactsLoading}
              // BACKLOG-1654: Hide parent nav buttons when contact form is open
              onModalStateChange={handleModalStateChange}
            />
          )}
        </div>

        {/* BACKLOG-3614: one floating action group at every width (was a pinned
            desktop bar plus a separate <640px pill that had no Cancel and skipped
            the coverage gate). BACKLOG-1654: hidden while the contact form is open. */}
        {!isContactFormOpen && (
          <FloatingActionBar
            testId="audit-floating-actions"
            actions={[
              { key: "cancel", label: "Cancel", onClick: onClose, variant: "secondary" },
              // Below 640px the labels shorten (as the old narrow pill's did) so
              // Cancel + Back + Create fit a ~360px-wide window without clipping.
              step > 1 && {
                key: "back",
                label: (
                  <>
                    {"\u2190"}
                    <span className="hidden sm:inline"> Back</span>
                  </>
                ),
                onClick: handlePreviousStep,
                variant: "secondary",
                disabled: loading,
                testId: "create-audit-back",
              },
              {
                key: "primary",
                label: isEditing ? (
                  <ResponsiveLabel short="Save" full="Save Changes" />
                ) : step === 3 ? (
                  <ResponsiveLabel short="Create" full="Create Transaction" />
                ) : (
                  "Continue \u2192"
                ),
                onClick: handleGatedNext,
                variant: "primary",
                loading,
                loadingLabel: isEditing ? "Saving..." : "Creating...",
                testId: "create-audit-submit",
              },
            ]}
          />
        )}

        {/* BACKLOG-2292 (Layer 1): audit-window coverage prompt. */}
        {coveragePrompt && (
          <AuditCoveragePrompt
            hasGap={coveragePrompt.hasGap}
            importerAvailable={coveragePrompt.importerAvailable}
            importing={importing}
            progress={progress}
            indeterminate={indeterminate}
            notice={coveragePrompt.notice}
            onUpdateNow={handleUpdateNow}
            onSkip={proceedAfterPrompt}
            onCancel={() => setCoveragePrompt(null)}
            sourceGaps={coveragePrompt.sourceGaps}
            sourceCoveragePending={coveragePrompt.sourceCoveragePending}
            proposedStartISO={coveragePrompt.proposedStartISO}
            chosenSource={dialogTextSource(importSource, isMacOS)}
          />
        )}
    </ResponsiveModal>
  );
}

/** A short label below 640px, the full one from 640px up (BACKLOG-3614). */
function ResponsiveLabel({ short, full }: { short: string; full: string }): React.ReactElement {
  return (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{full}</span>
    </>
  );
}

export default AuditTransactionModal;
