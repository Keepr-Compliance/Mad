/**
 * useAuditTransaction Hook
 * Composition root that combines focused sub-hooks for the audit transaction wizard.
 * Manages state and business logic for AuditTransactionModal.
 *
 * Decomposed in TASK-2261 from a 1,007-line god-hook into:
 * - useAuditAddressForm: Address form state, Google Places autocomplete, geocoding
 * - useAuditContactAssignment: Contact selection, role assignment, lazy loading
 * - useAuditSubmission: Transaction creation/update, change detection
 * - useAuditSteps: Step navigation with validation gates
 *
 * Contact Loading Optimization:
 * Contacts are loaded lazily when user reaches step 2, not on modal open.
 * This eliminates visible lag when opening the modal since contacts aren't
 * needed until step 2 (Contact Assignment). Contacts are loaded once and
 * shared between steps 2 and 3 to prevent repeated API calls when navigating.
 */
import { useEffect } from "react";
import type { Transaction, Contact } from "../../electron/types/models";
import { useAuditAddressForm } from "./audit/useAuditAddressForm";
import { useAuditContactAssignment } from "./audit/useAuditContactAssignment";
import { useAuditSubmission } from "./audit/useAuditSubmission";
import { useAuditSteps } from "./audit/useAuditSteps";

// Re-export types so existing consumers don't need to change their imports
export type {
  AddressData,
  Coordinates,
  AddressSuggestion,
  ContactAssignment,
  ContactAssignments,
} from "./audit/types";

export interface UseAuditTransactionProps {
  userId: string;
  editTransaction?: Transaction;
  onClose: () => void;
  onSuccess: (transaction: Transaction) => void;
}

export interface UseAuditTransactionReturn {
  // State
  step: number;
  loading: boolean;
  error: string | null;
  isEditing: boolean;
  addressData: import("./audit/types").AddressData;
  contactAssignments: import("./audit/types").ContactAssignments;
  selectedContactIds: string[];
  showAddressAutocomplete: boolean;
  addressSuggestions: import("./audit/types").AddressSuggestion[];

  // Auto-detect start date state (TASK-1974)
  startDateMode?: "auto" | "manual";
  autoDetectedDate: string | null | undefined;
  isAutoDetecting: boolean;

  // Contact loading state (lazy-loaded when reaching step 2)
  contacts: Contact[];
  contactsLoading: boolean;
  contactsError: string | null;
  refreshContacts: () => Promise<void>;
  /** BACKLOG-2631 — both halves, one commit. Was `silentRefreshContacts`, which
   *  re-read the saved half only. See `useAuditContactAssignment`. */
  refreshBothLists: () => Promise<void>;

  // External contacts (from macOS Contacts app, etc.)
  externalContacts: Contact[];
  externalContactsLoading: boolean;

  // Setters
  setAddressData: React.Dispatch<React.SetStateAction<import("./audit/types").AddressData>>;
  setSelectedContactIds: React.Dispatch<React.SetStateAction<string[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setStartDateMode: (mode: "auto" | "manual") => void;

  // Handlers
  handleAddressChange: (value: string) => Promise<void>;
  selectAddress: (suggestion: import("./audit/types").AddressSuggestion) => Promise<void>;
  assignContact: (role: string, contactId: string, isPrimary?: boolean, notes?: string) => void;
  removeContact: (role: string, contactId: string) => void;
  handleNextStep: () => void;
  handlePreviousStep: () => void;
}

export function useAuditTransaction({
  userId,
  editTransaction,
  onClose,
  onSuccess,
}: UseAuditTransactionProps): UseAuditTransactionReturn {
  const isEditing = !!editTransaction;

  // --- Sub-hooks ---
  const addressForm = useAuditAddressForm({ editTransaction, userId, isEditing });

  const contactAssignment = useAuditContactAssignment({
    userId,
    propertyAddress: addressForm.addressData.property_address,
    editTransaction,
  });

  const submission = useAuditSubmission({
    userId,
    editTransaction,
    isEditing,
    addressData: addressForm.addressData,
    originalAddressData: addressForm.originalAddressData,
    contactAssignments: contactAssignment.contactAssignments,
    onSuccess,
    onClose,
  });

  const steps = useAuditSteps({
    isEditing,
    addressData: addressForm.addressData,
    selectedContactIds: contactAssignment.selectedContactIds,
    contactAssignments: contactAssignment.contactAssignments,
    onSubmit: submission.handleCreateTransaction,
    setError: submission.setError,
  });

  // Lazy load contacts when step transitions to 2 (first contact step)
  useEffect(() => {
    if (steps.step === 2) {
      contactAssignment.triggerLazyLoad();
    }
  }, [steps.step, contactAssignment.triggerLazyLoad]);

  // Trigger auto-detect when selected contacts change and mode is "auto" (TASK-1974)
  useEffect(() => {
    if (addressForm.startDateMode === "auto" && contactAssignment.selectedContactIds.length > 0 && !isEditing) {
      addressForm.detectStartDate(contactAssignment.selectedContactIds);
    }
  }, [contactAssignment.selectedContactIds, addressForm.startDateMode, isEditing, addressForm.detectStartDate]);

  return {
    // State
    step: steps.step,
    loading: submission.loading,
    error: submission.error,
    isEditing,
    addressData: addressForm.addressData,
    contactAssignments: contactAssignment.contactAssignments,
    selectedContactIds: contactAssignment.selectedContactIds,
    showAddressAutocomplete: addressForm.showAddressAutocomplete,
    addressSuggestions: addressForm.addressSuggestions,

    // Auto-detect start date state (TASK-1974)
    startDateMode: addressForm.startDateMode,
    autoDetectedDate: addressForm.autoDetectedDate,
    isAutoDetecting: addressForm.isAutoDetecting,

    // Contact loading state (lazy-loaded when reaching step 2)
    contacts: contactAssignment.contacts,
    contactsLoading: contactAssignment.contactsLoading,
    contactsError: contactAssignment.contactsError,
    refreshContacts: contactAssignment.refreshContacts,
    refreshBothLists: contactAssignment.refreshBothLists,

    // External contacts (from macOS Contacts app, etc.)
    externalContacts: contactAssignment.externalContacts,
    externalContactsLoading: contactAssignment.externalContactsLoading,

    // Setters
    setAddressData: addressForm.setAddressData,
    setSelectedContactIds: contactAssignment.setSelectedContactIds,
    setError: submission.setError,
    setStartDateMode: addressForm.setStartDateMode,

    // Handlers
    handleAddressChange: addressForm.handleAddressChange,
    selectAddress: addressForm.selectAddress,
    assignContact: contactAssignment.assignContact,
    removeContact: contactAssignment.removeContact,
    handleNextStep: steps.handleNextStep,
    handlePreviousStep: steps.handlePreviousStep,
  };
}
