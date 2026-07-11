import React, { useState, useCallback } from "react";
import { ResponsiveModal, MODAL_PANEL } from "./common/ResponsiveModal";
import AddressVerificationStep from "./audit/AddressVerificationStep";
import ContactAssignmentStep from "./audit/ContactAssignmentStep";
import type { Transaction } from "../../electron/types/models";
import { useAppStateMachine } from "../appCore";
import { useAuditTransaction } from "../hooks/useAuditTransaction";
import { OfflineNotice } from "./common/OfflineNotice";

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
    silentRefreshContacts,
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
    <ResponsiveModal onClose={onClose} panelClassName={MODAL_PANEL.lg}>
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
                {isEditing ? "Edit Transaction Details" : "Audit New Transaction"}
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
        <div className={`flex-1 min-h-0 ${step === 1 ? "overflow-y-auto p-6" : "flex flex-col overflow-hidden pt-0 px-2 pb-2"}`}>
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
              showAutocomplete={showAddressAutocomplete}
              suggestions={addressSuggestions}
              onSelectSuggestion={selectAddress}
              startDateMode="manual"
            />
          )}

          {/* Step 2: Select Contacts, Step 3: Assign Roles */}
          {step >= 2 && (
            <ContactAssignmentStep
              step={step}
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
              onSilentRefreshContacts={silentRefreshContacts}
              // External contacts (from macOS Contacts app, etc.)
              externalContacts={externalContacts}
              externalContactsLoading={externalContactsLoading}
              // BACKLOG-1654: Hide parent nav buttons when contact form is open
              onModalStateChange={handleModalStateChange}
            />
          )}
        </div>

        {/* Footer — desktop: sticky bar, mobile: floating button */}
        {/* BACKLOG-1654: Hide nav buttons when contact form modal is open to prevent overlap */}
        {/* Desktop footer */}
        {!isContactFormOpen && <div className="hidden sm:flex flex-shrink-0 px-6 py-4 bg-gray-50 rounded-b-xl items-center gap-3 justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all"
          >
            Cancel
          </button>
          <div className="flex items-center gap-3">
            {step > 1 && (
              <button
                onClick={handlePreviousStep}
                disabled={loading}
                className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all"
                data-testid="create-audit-back"
              >
                &larr; Back
              </button>
            )}
            <button
              onClick={handleNextStep}
              disabled={loading}
              className={`px-6 py-2 rounded-lg font-semibold transition-all ${
                loading
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-600 hover:to-purple-700 shadow-md hover:shadow-lg"
              }`}
              data-testid="create-audit-submit"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  {isEditing ? "Saving..." : "Creating..."}
                </span>
              ) : isEditing ? (
                "Save Changes"
              ) : step === 3 ? (
                "Create Transaction"
              ) : (
                "Continue \u2192"
              )}
            </button>
          </div>
        </div>}
        {/* Mobile floating button */}
        {!isContactFormOpen && <div className="sm:hidden fixed bottom-4 right-4 z-[71] flex items-center gap-2">
          {step > 1 && (
            <button
              onClick={handlePreviousStep}
              disabled={loading}
              className="px-4 py-3 rounded-full font-medium text-sm bg-white text-gray-700 shadow-lg hover:shadow-xl transition-all"
              data-testid="create-audit-back"
            >
              &larr;
            </button>
          )}
          <button
            onClick={handleNextStep}
            disabled={loading}
            className={`px-6 py-3 rounded-full font-semibold text-sm shadow-lg transition-all ${
              loading
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-600 hover:to-purple-700 hover:shadow-xl"
            }`}
            data-testid="create-audit-submit"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                {isEditing ? "Saving..." : "Creating..."}
              </span>
            ) : isEditing ? (
              "Save"
            ) : step === 3 ? (
              "Create"
            ) : (
              "Continue →"
            )}
          </button>
        </div>}
    </ResponsiveModal>
  );
}

export default AuditTransactionModal;
