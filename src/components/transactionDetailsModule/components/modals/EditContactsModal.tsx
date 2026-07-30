/**
 * EditContactsModal Component
 *
 * Modal for editing contact assignments on a transaction using a 2-screen workflow:
 * - Screen 1: View/edit assigned contacts with inline role dropdowns
 * - Screen 2: Add contacts overlay reusing ContactAssignmentStep
 *
 * @see TASK-1765: EditContactsModal 2-Screen Flow Redesign
 * @see BACKLOG-418: Redesign Contact Selection UX (Select First, Assign Roles Second)
 */
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { ResponsiveModal, MODAL_PANEL } from "../../../common/ResponsiveModal";
import type { Transaction } from "@/types";
import type { ExtendedContact } from "../../../../types/components";
import { ROLE_TO_CATEGORY, AUDIT_WORKFLOW_STEPS } from "../../../../constants/contactRoles";
import {
  ContactsProvider,
  useContacts,
} from "../../../../contexts/ContactsContext";
import { ContactRoleRow } from "../../../shared/ContactRoleRow";
import { ContactPreview } from "../../../shared/ContactPreview";
import { ContactFormModal } from "../../../contact";
import type { RoleOption } from "../../../shared/ContactRoleRow";
import ContactAssignmentStep from "../../../audit/ContactAssignmentStep";
import {
  filterRolesByTransactionType,
  resolveDefaultContactRole,
  getRoleDisplayName,
} from "../../../../utils/transactionRoleUtils";
import { settingsService } from "../../../../services";
import logger from '../../../../utils/logger';
import { OfflineNotice } from '../../../common/OfflineNotice';

// ============================================
// TYPES
// ============================================

interface ContactAssignment {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_email?: string;
  contact_phone?: string;
  contact_company?: string;
  role?: string;
  specific_role?: string;
  is_primary: number;
  notes?: string;
}

/**
 * Role assignments mapping: role -> array of contact IDs
 * Kept for compatibility with existing save logic
 */
export interface RoleAssignments {
  [role: string]: string[];
}

/**
 * Auto-link results returned when contacts are added
 * TASK-1126: Communications are auto-linked when contacts are added
 */
export interface AutoLinkResult {
  contactId: string;
  emailsLinked: number;
  messagesLinked: number;
  alreadyLinked: number;
  errors: number;
}

export interface EditContactsModalProps {
  transaction: Transaction;
  /** Current logged-in user's ID — used for loading contacts from ContactsProvider.
   *  Must NOT use transaction.user_id which may be stale after DB reset / re-login.
   *  @see BACKLOG-1611 */
  userId: string;
  onClose: () => void;
  onSave: (autoLinkResults?: AutoLinkResult[]) => void;
}

/**
 * Role configuration from workflow steps
 */
interface RoleConfig {
  role: string;
  required: boolean;
  multiple: boolean;
}

// ============================================
// EDIT CONTACTS MODAL COMPONENT
// ============================================

/**
 * Edit Contacts Modal
 * 2-screen workflow for editing contact assignments.
 * Screen 1: View assigned contacts with role dropdowns
 * Screen 2: Add contacts overlay
 */
export function EditContactsModal({
  transaction,
  userId,
  onClose,
  onSave,
}: EditContactsModalProps): React.ReactElement {
  // Screen 2 (Add Contacts) overlay state
  const [showAddModal, setShowAddModal] = useState(false);

  // Assigned contact IDs (those shown in Screen 1)
  const [assignedContactIds, setAssignedContactIds] = useState<string[]>([]);

  // Role assignments state - using {role: contactIds[]} format
  const [roleAssignments, setRoleAssignments] = useState<RoleAssignments>({});

  // UI state
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Contacts without roles (for validation highlighting)
  const [contactsWithoutRoles, setContactsWithoutRoles] = useState<Set<string>>(new Set());

  // Edit contact state (Screen 1 → ContactFormModal)
  const [editContact, setEditContact] = useState<ExtendedContact | undefined>(undefined);
  const [showEditModal, setShowEditModal] = useState(false);

  // Store original assignments for save diffing
  const [originalAssignments, setOriginalAssignments] = useState<
    ContactAssignment[]
  >([]);

  // BACKLOG-1355: Auto-fill role state
  const [autoRoleEnabled, setAutoRoleEnabled] = useState(false);
  const [autoFilledContactIds, setAutoFilledContactIds] = useState<Set<string>>(new Set());

  // Load auto-role setting on mount
  useEffect(() => {
    let cancelled = false;
    settingsService.getContactAutoRoleEnabled(transaction.user_id).then((enabled) => {
      if (!cancelled) setAutoRoleEnabled(enabled);
    }).catch((err) => {
      logger.error("Failed to load auto-role setting:", err);
    });
    return () => { cancelled = true; };
  }, [transaction.user_id]);

  // Load existing contact assignments on mount
  useEffect(() => {
    loadContactAssignments();
  }, [transaction.id]);

  const loadContactAssignments = async () => {
    try {
      const result = await window.api.transactions.getDetails(transaction.id);
      const txn = result.transaction as {
        contact_assignments?: ContactAssignment[];
      };
      if (result.success && txn.contact_assignments) {
        setOriginalAssignments(txn.contact_assignments);

        // Extract unique contact IDs for assigned contacts
        const contactIds = [
          ...new Set(
            txn.contact_assignments.map((a: ContactAssignment) => a.contact_id)
          ),
        ];
        setAssignedContactIds(contactIds);

        // Build role assignments map: {role: contactIds[]}
        const assignments: RoleAssignments = {};
        txn.contact_assignments.forEach((a: ContactAssignment) => {
          const role = a.role || a.specific_role;
          if (!role) return;
          if (!assignments[role]) {
            assignments[role] = [];
          }
          if (!assignments[role].includes(a.contact_id)) {
            assignments[role].push(a.contact_id);
          }
        });
        setRoleAssignments(assignments);
      }
    } catch (err) {
      logger.error("Failed to load contact assignments:", err);
      setError("Failed to load contacts");
    } finally {
      setLoading(false);
    }
  };

  // BACKLOG-1355: Build role options at parent level for auto-fill validation
  const transactionType = (transaction.transaction_type as "purchase" | "sale" | "other") || "purchase";
  const validRoles = useMemo((): Set<string> => {
    const roles = new Set<string>();
    AUDIT_WORKFLOW_STEPS.forEach((wfStep) => {
      const filteredRoles = filterRolesByTransactionType(
        wfStep.roles as RoleConfig[],
        transactionType,
        wfStep.title
      );
      filteredRoles.forEach((rc) => roles.add(rc.role));
    });
    return roles;
  }, [transactionType]);

  // BACKLOG-1355 / BACKLOG-2358: Assign a default role to a newly added contact
  // so it is never left empty. The Client baseline always applies (renders as
  // Buyer/Seller (Client) by transaction type); the smart default_role auto-fill
  // overrides it when enabled.
  const handleAutoFillForContact = useCallback((contactId: string, contact?: ExtendedContact) => {
    const role = resolveDefaultContactRole(
      autoRoleEnabled,
      contact?.default_role,
      transactionType,
      (r) => validRoles.has(r),
    );

    setRoleAssignments((prev) => {
      // Never override a role this contact already has.
      const alreadyAssigned = Object.values(prev).some((ids) => ids.includes(contactId));
      if (alreadyAssigned) return prev;
      const updated = { ...prev };
      updated[role] = [...(updated[role] || []), contactId];
      return updated;
    });
    setAutoFilledContactIds((prev) => new Set(prev).add(contactId));
  }, [autoRoleEnabled, validRoles, transactionType]);

  // BACKLOG-1355: Clear auto-filled status when user manually changes role
  const handleClearAutoFilled = useCallback((contactId: string) => {
    setAutoFilledContactIds((prev) => {
      if (!prev.has(contactId)) return prev;
      const next = new Set(prev);
      next.delete(contactId);
      return next;
    });
  }, []);

  // Remove a contact from the transaction
  const handleRemoveContact = useCallback((contactId: string) => {
    // Remove from assignedContactIds
    setAssignedContactIds((prev) => prev.filter((id) => id !== contactId));

    // Remove from all role assignments
    setRoleAssignments((prev) => {
      const updated: RoleAssignments = {};
      for (const [role, ids] of Object.entries(prev)) {
        const filteredIds = ids.filter((id) => id !== contactId);
        if (filteredIds.length > 0) {
          updated[role] = filteredIds;
        }
      }
      return updated;
    });

    // BACKLOG-1355: Clear auto-filled status
    setAutoFilledContactIds((prev) => {
      if (!prev.has(contactId)) return prev;
      const next = new Set(prev);
      next.delete(contactId);
      return next;
    });
  }, []);

  const handleSave = async () => {
    // First, validate that all assigned contacts have roles
    const contactsInRoles = new Set<string>();
    for (const contactIds of Object.values(roleAssignments)) {
      for (const contactId of contactIds) {
        contactsInRoles.add(contactId);
      }
    }

    const missingRoles = assignedContactIds.filter((id) => !contactsInRoles.has(id));
    if (missingRoles.length > 0) {
      setContactsWithoutRoles(new Set(missingRoles));
      setError(`Please assign a role to all contacts (${missingRoles.length} contact${missingRoles.length !== 1 ? "s" : ""} missing roles)`);
      return;
    }

    // Clear any previous validation errors
    setContactsWithoutRoles(new Set());
    setSaving(true);
    setError(null);

    try {
      // Build batch operations by comparing current vs original
      const operations: Array<{
        action: "add" | "remove";
        contactId: string;
        role?: string;
        roleCategory?: string;
        specificRole?: string;
        isPrimary?: boolean;
        notes?: string;
      }> = [];

      // Build set of current assignments from roleAssignments state
      const currentSet = new Set<string>();
      for (const [role, contactIds] of Object.entries(roleAssignments)) {
        for (const contactId of contactIds) {
          currentSet.add(`${role}:${contactId}`);
        }
      }

      // Build set of original assignments
      const originalSet = new Set<string>();
      for (const assignment of originalAssignments) {
        const role = assignment.role || assignment.specific_role;
        if (role) {
          originalSet.add(`${role}:${assignment.contact_id}`);
        }
      }

      // Remove operations: in original but not in current
      for (const assignment of originalAssignments) {
        const role = assignment.role || assignment.specific_role;
        if (!role) continue;
        const key = `${role}:${assignment.contact_id}`;
        if (!currentSet.has(key)) {
          operations.push({
            action: "remove",
            contactId: assignment.contact_id,
            role: role,
            specificRole: role,
          });
        }
      }

      // Add operations: in current but not in original
      for (const [role, contactIds] of Object.entries(roleAssignments)) {
        for (const contactId of contactIds) {
          const key = `${role}:${contactId}`;
          if (!originalSet.has(key)) {
            const roleCategory = ROLE_TO_CATEGORY[role] || "support";
            operations.push({
              action: "add",
              contactId: contactId,
              role: role,
              roleCategory: roleCategory,
              specificRole: role,
              isPrimary: false,
              notes: undefined,
            });
          }
        }
      }

      // Execute all operations in a single batch call
      // TASK-1126: batchUpdateContacts now returns autoLinkResults
      let autoLinkResults: AutoLinkResult[] | undefined;
      if (operations.length > 0) {
        const batchResult = await window.api.transactions.batchUpdateContacts(
          transaction.id,
          operations
        );
        if (!batchResult.success) {
          throw new Error(batchResult.error || "Failed to update contacts");
        }
        autoLinkResults = batchResult.autoLinkResults;
      }

      onSave(autoLinkResults);
      onClose();
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to update contacts";
      setError(errorMessage);
      setSaving(false);
    }
  };

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[70]" panelClassName={`${MODAL_PANEL.lg} relative`}>
        {/* Header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-blue-500 to-indigo-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 flex items-center justify-between sm:rounded-t-xl shadow-lg">
          {/* Mobile: back button + title right */}
          <button
            onClick={onClose}
            className="sm:hidden text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
            data-testid="edit-contacts-modal-close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back
          </button>
          {/* Desktop: title left */}
          <h3 className="hidden sm:block text-xl font-bold text-white">Edit Transaction Contacts</h3>
          {/* Mobile: title right */}
          <h3 className="sm:hidden text-lg font-bold text-white">Edit Contacts</h3>
          {/* Desktop: X close */}
          <button
            onClick={onClose}
            className="hidden sm:block text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <OfflineNotice />

        {/* Shared ContactsProvider for both Screen1 and Screen2 */}
        <ContactsProvider
          userId={userId}
          propertyAddress={transaction.property_address || ""}
        >
          {/* Content */}
          <div className="flex-1 overflow-y-auto p-3 sm:p-6">
            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            {loading ? (
              <div className="text-center py-12">
                <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
                <p className="text-gray-600 mt-4">Loading contacts...</p>
              </div>
            ) : (
              <Screen1Content
                transactionType={transactionType}
                assignedContactIds={assignedContactIds}
                roleAssignments={roleAssignments}
                onRoleAssignmentsChange={(assignments) => {
                  setRoleAssignments(assignments);
                  // Clear validation errors when user assigns a role
                  setContactsWithoutRoles(new Set());
                  setError(null);
                }}
                onOpenAddModal={() => setShowAddModal(true)}
                onRemoveContact={handleRemoveContact}
                onEditContact={(contact) => {
                  setEditContact(contact);
                  setShowEditModal(true);
                }}
                contactsWithoutRoles={contactsWithoutRoles}
                autoFilledContactIds={autoFilledContactIds}
                onClearAutoFilled={handleClearAutoFilled}
              />
            )}

            {/* Edit Contact Modal (from Screen 1 preview) */}
            {showEditModal && transaction.user_id && (
              <ContactFormModal
                userId={transaction.user_id}
                contact={editContact}
                onClose={() => {
                  setEditContact(undefined);
                  setShowEditModal(false);
                }}
                onSuccess={() => {
                  setEditContact(undefined);
                  setShowEditModal(false);
                }}
              />
            )}
          </div>

          {/* Footer */}
          <div className="flex-shrink-0 px-6 py-4 bg-gray-50 rounded-b-xl flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all"
              data-testid="edit-contacts-modal-cancel"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || loading}
              className={`px-6 py-2 rounded-lg font-semibold transition-all ${
                saving || loading
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-gradient-to-r from-blue-500 to-indigo-600 text-white hover:from-blue-600 hover:to-indigo-700 shadow-md hover:shadow-lg"
              }`}
              data-testid="edit-contacts-modal-save"
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>

          {/* Screen 2: Add Contacts Overlay */}
          {showAddModal && !loading && (
            <Screen2Overlay
              assignedContactIds={assignedContactIds}
              transactionType={transactionType}
              propertyAddress={transaction.property_address || ""}
              onClose={() => setShowAddModal(false)}
              onAddContact={(contactId, contact) => {
                // Add the contact to assigned list
                setAssignedContactIds((prev) =>
                  prev.includes(contactId) ? prev : [...prev, contactId]
                );
                // BACKLOG-1355 / BACKLOG-2358: assign a default role (Client
                // baseline; default_role auto-fill overrides) so the newly
                // added contact is never left with an empty role.
                handleAutoFillForContact(contactId, contact);
              }}
            />
          )}
        </ContactsProvider>
    </ResponsiveModal>
  );
}

// ============================================
// SCREEN 1: ASSIGNED CONTACTS VIEW
// ============================================

interface Screen1ContentProps {
  transactionType: "purchase" | "sale" | "other";
  assignedContactIds: string[];
  roleAssignments: RoleAssignments;
  onRoleAssignmentsChange: (assignments: RoleAssignments) => void;
  onOpenAddModal: () => void;
  onRemoveContact: (contactId: string) => void;
  onEditContact?: (contact: ExtendedContact) => void;
  /** Contacts that are missing roles (for validation highlighting) */
  contactsWithoutRoles?: Set<string>;
  /** BACKLOG-1355: Set of contact IDs whose roles were auto-filled */
  autoFilledContactIds?: Set<string>;
  /** BACKLOG-1355: Callback to clear auto-filled status when user manually changes role */
  onClearAutoFilled?: (contactId: string) => void;
}

/**
 * Screen 1: Displays assigned contacts with role dropdowns
 */
function Screen1Content({
  transactionType,
  assignedContactIds,
  roleAssignments,
  onRoleAssignmentsChange,
  onOpenAddModal,
  onRemoveContact,
  onEditContact,
  contactsWithoutRoles = new Set(),
  autoFilledContactIds = new Set(),
  onClearAutoFilled,
}: Screen1ContentProps): React.ReactElement {
  const { contacts, loading: contactsLoading, error: contactsError } = useContacts();

  // Contact preview state for viewing details when clicking a contact row
  const [previewContact, setPreviewContact] = useState<ExtendedContact | null>(null);

  // Helper to check if a contact is external
  const isExternal = useCallback((contact: ExtendedContact): boolean => {
    return contact.is_message_derived === 1 || contact.is_message_derived === true;
  }, []);

  // Get assigned contacts from the contacts list
  const assignedContacts = useMemo(() => {
    return contacts.filter((c) => assignedContactIds.includes(c.id));
  }, [contacts, assignedContactIds]);

  // Build role options from workflow steps
  const roleOptions = useMemo((): RoleOption[] => {
    const allRoles: RoleOption[] = [];

    AUDIT_WORKFLOW_STEPS.forEach((step) => {
      const filteredRoles = filterRolesByTransactionType(
        step.roles as RoleConfig[],
        transactionType,
        step.title
      );

      filteredRoles.forEach((roleConfig) => {
        allRoles.push({
          value: roleConfig.role,
          label: getRoleDisplayName(roleConfig.role, transactionType),
        });
      });
    });

    return allRoles;
  }, [transactionType]);

  // Get the current role for a contact (helper from RoleAssigner pattern)
  const getContactRole = useCallback(
    (contactId: string): string => {
      for (const [role, ids] of Object.entries(roleAssignments)) {
        if (ids.includes(contactId)) {
          return role;
        }
      }
      return ""; // No role assigned
    },
    [roleAssignments]
  );

  // Handle role change for a contact (helper from RoleAssigner pattern)
  const handleRoleChange = useCallback(
    (contactId: string, newRole: string) => {
      // Build new assignments object
      const newAssignments: RoleAssignments = {};

      // First, copy all existing assignments except this contact
      Object.entries(roleAssignments).forEach(([role, ids]) => {
        newAssignments[role] = ids.filter((id) => id !== contactId);
      });

      // Then add contact to new role (if not empty)
      if (newRole) {
        newAssignments[newRole] = [
          ...(newAssignments[newRole] || []),
          contactId,
        ];
      }

      // Clean up empty arrays
      Object.keys(newAssignments).forEach((role) => {
        if (newAssignments[role].length === 0) {
          delete newAssignments[role];
        }
      });

      onRoleAssignmentsChange(newAssignments);

      // BACKLOG-1355: Clear auto-filled status when user manually changes role
      if (onClearAutoFilled) {
        onClearAutoFilled(contactId);
      }
    },
    [roleAssignments, onRoleAssignmentsChange, onClearAutoFilled]
  );

  if (contactsLoading) {
    return (
      <div className="text-center py-12">
        <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
        <p className="text-gray-600 mt-4">Loading contacts...</p>
      </div>
    );
  }

  if (contactsError) {
    return (
      <div className="text-center py-12">
        <svg
          className="w-16 h-16 text-red-400 mx-auto mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <p className="text-red-600">{contactsError}</p>
      </div>
    );
  }

  // Empty state
  if (assignedContacts.length === 0) {
    return (
      <div
        className="text-center py-16 text-gray-500"
        data-testid="empty-assigned-state"
      >
        <svg
          className="w-20 h-20 text-gray-300 mx-auto mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
        <p className="text-lg font-medium mb-2">No contacts assigned</p>
        <p className="text-sm mb-6">Click &quot;Add Contacts&quot; to get started.</p>
        <button
          onClick={onOpenAddModal}
          className="px-6 py-3 bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-lg font-semibold hover:from-blue-600 hover:to-indigo-700 shadow-md hover:shadow-lg transition-all"
          data-testid="empty-state-add-button"
        >
          + Add Contacts
        </button>
      </div>
    );
  }

  // Assigned contacts list
  return (
    <div data-testid="assigned-contacts-list">
      {/* Header info with Add Contacts button */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          {assignedContacts.length} contact{assignedContacts.length !== 1 ? "s" : ""} assigned
        </p>
        <button
          onClick={onOpenAddModal}
          className="px-4 py-2 text-blue-600 hover:bg-blue-50 rounded-lg font-medium transition-all flex items-center gap-2"
          data-testid="add-contacts-button"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Contacts
        </button>
      </div>

      {/* Contact rows */}
      <div className="space-y-2">
        {assignedContacts.map((contact) => (
          <ContactRoleRow
            key={contact.id}
            contact={contact}
            currentRole={getContactRole(contact.id)}
            roleOptions={roleOptions}
            onRoleChange={(role) => handleRoleChange(contact.id, role)}
            onRemove={() => onRemoveContact(contact.id)}
            onClick={() => setPreviewContact(contact)}
            hasError={contactsWithoutRoles.has(contact.id)}
            isAutoFilled={autoFilledContactIds.has(contact.id)}
          />
        ))}
      </div>

      {/* Contact Preview Modal */}
      {previewContact && (
        <ContactPreview
          contact={previewContact}
          isExternal={isExternal(previewContact)}
          transactions={[]}
          onEdit={() => {
            const contact = previewContact;
            setPreviewContact(null);
            if (contact && onEditContact) onEditContact(contact);
          }}
          onClose={() => setPreviewContact(null)}
        />
      )}
    </div>
  );
}

// ============================================
// SCREEN 2: ADD CONTACTS OVERLAY
// Reuses ContactAssignmentStep (step 2) for unified contact selection UX.
// Only the overlay chrome (header, footer with "Add Selected") is custom.
// ============================================

interface Screen2OverlayProps {
  assignedContactIds: string[];
  transactionType: string;
  propertyAddress: string;
  onClose: () => void;
  onAddContact: (contactId: string, contact?: ExtendedContact) => void;
}

/**
 * Screen 2: Add Contacts overlay
 * Reuses ContactAssignmentStep at step=2 for contact search/selection/import,
 * wrapping it with the overlay header and "Add Selected" footer.
 *
 * @see BACKLOG-1590: Reuse ContactAssignmentStep for unified UX
 */
function Screen2Overlay({
  assignedContactIds,
  transactionType,
  propertyAddress,
  onClose,
  onAddContact,
}: Screen2OverlayProps): React.ReactElement {
  const { contacts, loading, error, refreshContacts, silentRefresh } = useContacts();

  // External contacts from macOS Contacts app (lazy-loaded)
  const [externalContacts, setExternalContacts] = useState<ExtendedContact[]>([]);
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalLoaded, setExternalLoaded] = useState(false);

  // Selected contact IDs — managed here, passed to ContactAssignmentStep
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);

  // Track adding state to disable button during batch add
  const [isAddingSelected, setIsAddingSelected] = useState(false);

  // Get userId from contacts context
  const userId = contacts.length > 0 ? contacts[0].user_id : "";

  // Load external contacts from Contacts app when component mounts
  useEffect(() => {
    const loadExternalContacts = async () => {
      if (!userId || externalLoaded) return;

      setExternalLoading(true);
      try {
        const result = await window.api.contacts.getAvailable(userId);
        if (result.success && result.contacts) {
          const external: ExtendedContact[] = result.contacts.map((c: ExtendedContact) => ({
            ...c,
            is_message_derived: true,
          }));
          setExternalContacts(external);
        }
      } catch (err) {
        logger.error("Failed to load external contacts:", err);
      } finally {
        setExternalLoading(false);
        setExternalLoaded(true);
      }
    };

    loadExternalContacts();
  }, [userId, externalLoaded]);

  // Filter out already assigned contacts so they don't appear in the selection list
  const availableContacts = useMemo(() => {
    return contacts.filter((c) => !assignedContactIds.includes(c.id));
  }, [contacts, assignedContactIds]);

  // Filter external contacts — exclude those already in database or already assigned
  const filteredExternalContacts = useMemo(() => {
    const existingIds = new Set(contacts.map((c) => c.id));
    const assignedIds = new Set(assignedContactIds);
    return externalContacts.filter(
      (c) => !existingIds.has(c.id) && !assignedIds.has(c.id)
    );
  }, [externalContacts, contacts, assignedContactIds]);

  // Handle "Add Selected" button — batch add all selected contacts to the transaction
  const handleAddSelected = useCallback(async () => {
    if (selectedContactIds.length === 0) return;

    setIsAddingSelected(true);
    try {
      // Build lookup map of all available contacts (imported + external)
      const allContacts = new Map<string, ExtendedContact>();
      availableContacts.forEach((c) => allContacts.set(c.id, c));
      filteredExternalContacts.forEach((c) => allContacts.set(c.id, c));

      for (const contactId of selectedContactIds) {
        const contact = allContacts.get(contactId);
        if (contact) {
          onAddContact(contactId, contact);
        } else {
          // Contact might have been imported (external -> new DB ID), just add by ID
          onAddContact(contactId);
        }
      }
    } finally {
      setIsAddingSelected(false);
    }
    onClose();
  }, [selectedContactIds, availableContacts, filteredExternalContacts, onAddContact, onClose]);

  // No-op callbacks for ContactAssignmentStep props we don't use in step 2
  const noopAssignContact = useCallback(() => {}, []);
  const noopRemoveContact = useCallback(() => {}, []);

  return (
    <div
      className="absolute inset-0 bg-white rounded-xl flex flex-col z-10 overflow-hidden"
      data-testid="add-contacts-overlay"
    >
      {/* Header */}
      <div className="flex-shrink-0 bg-gradient-to-r from-purple-500 to-pink-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg">
        {/* Mobile */}
        <div className="sm:hidden flex items-center justify-between">
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
            data-testid="add-contacts-overlay-close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back
          </button>
          <h3 className="text-lg font-bold text-white">Add Contacts</h3>
        </div>
        {/* Desktop */}
        <div className="hidden sm:flex items-center justify-between">
          <h3 className="text-xl font-bold text-white">Add Contacts</h3>
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

      {/* Reuse ContactAssignmentStep at step 2 for contact search/select/import */}
      {/*
        BACKLOG-2341 (scroll fix): this wrapper MUST be a flex COLUMN, not a
        plain block. ContactAssignmentStep's root is `flex flex-col flex-1
        min-h-0`; its `flex-1 min-h-0` only resolves a bounded height when its
        DIRECT parent is itself a flex column. Previously this wrapper was just
        `flex-1 min-h-0 overflow-hidden` (block), so `flex-1` on the child was
        inert, the step grew to its full content height, and the inner
        `overflow-y-auto` list in ContactSearchList never got a bounded height —
        the list expanded past the modal instead of scrolling (support #89 /
        hundreds of Outlook/Mac contacts). Adding `flex flex-col` mirrors the
        working audit-modal wrapper (AuditTransactionModal step>=2 branch).
      */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <ContactAssignmentStep
          step={2}
          showCategoryFilter={true}
          contactAssignments={{}}
          selectedContactIds={selectedContactIds}
          onSelectedContactIdsChange={setSelectedContactIds}
          onAssignContact={noopAssignContact}
          onRemoveContact={noopRemoveContact}
          userId={userId}
          transactionType={transactionType}
          propertyAddress={propertyAddress}
          contacts={availableContacts}
          contactsLoading={loading}
          contactsError={error}
          onRefreshContacts={refreshContacts}
          onSilentRefreshContacts={silentRefresh}
          externalContacts={filteredExternalContacts}
          externalContactsLoading={externalLoading}
        />
      </div>

      {/* Desktop footer */}
      <div className="hidden sm:flex flex-shrink-0 px-6 py-4 bg-gray-50 rounded-b-xl items-center justify-between">
        <p className="text-sm text-gray-600">
          {selectedContactIds.length > 0
            ? `${selectedContactIds.length} contact${selectedContactIds.length !== 1 ? "s" : ""} selected`
            : "Select contacts to add"}
        </p>
        <button
          onClick={handleAddSelected}
          disabled={selectedContactIds.length === 0 || isAddingSelected}
          className={`px-6 py-2 rounded-lg font-semibold transition-all ${
            selectedContactIds.length === 0 || isAddingSelected
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : "bg-gradient-to-r from-purple-500 to-pink-600 text-white hover:from-purple-600 hover:to-pink-700 shadow-md hover:shadow-lg"
          }`}
          data-testid="add-selected-button"
        >
          {isAddingSelected
            ? "Adding..."
            : selectedContactIds.length > 0
              ? `Add Selected (${selectedContactIds.length})`
              : "Add Selected"}
        </button>
      </div>
      {/* Mobile floating button */}
      <div className="sm:hidden fixed bottom-4 right-4 z-[71]">
        <button
          onClick={handleAddSelected}
          disabled={selectedContactIds.length === 0 || isAddingSelected}
          className={`px-6 py-3 rounded-full font-semibold text-sm shadow-lg transition-all ${
            selectedContactIds.length === 0 || isAddingSelected
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : "bg-gradient-to-r from-purple-500 to-pink-600 text-white hover:from-purple-600 hover:to-pink-700 shadow-lg hover:shadow-xl"
          }`}
          data-testid="add-selected-button-mobile"
        >
          {isAddingSelected
            ? "Adding..."
            : selectedContactIds.length > 0
              ? `Add Selected (${selectedContactIds.length})`
              : "Add Selected"}
        </button>
      </div>
    </div>
  );
}

export default EditContactsModal;
