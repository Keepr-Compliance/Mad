/**
 * ContactAssignmentStep Component
 * Steps 2-3 of the AuditTransactionModal - Contact assignment using search-first pattern
 *
 * Step flow controlled by parent:
 * - Step 2: Search and select contacts (ContactSearchList)
 * - Step 3: Assign roles to selected contacts (ContactRoleRow)
 *
 * Contact Loading Optimization:
 * Contacts are now loaded at the parent level (useAuditTransaction hook)
 * and passed as props to prevent duplicate API calls when switching
 * between steps 2 and 3.
 */
import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { AUDIT_WORKFLOW_STEPS } from "../../constants/contactRoles";
import {
  filterRolesByTransactionType,
  flipRoleForTransactionType,
  getRoleDisplayName,
  type TransactionType,
} from "../../utils/transactionRoleUtils";
import { ContactSearchList } from "../shared/ContactSearchList";
import { ContactRoleRow } from "../shared/ContactRoleRow";
import { ContactPreview } from "../shared/ContactPreview";
import { ContactFormModal } from "../contact";
import type { RoleOption } from "../shared/ContactRoleRow";
import type { ContactAssignments } from "../../hooks/useAuditTransaction";
import type { Contact } from "../../../electron/types/models";
import type { ExtendedContact } from "../../types/components";
import { contactService, settingsService } from "../../services";
import logger from '../../utils/logger';

interface ContactAssignmentStepProps {
  /** Current step (2 = select contacts, 3 = assign roles) */
  step: number;
  contactAssignments: ContactAssignments;
  /** Selected contact IDs managed by parent */
  selectedContactIds: string[];
  onSelectedContactIdsChange: (ids: string[]) => void;
  onAssignContact: (
    role: string,
    contactId: string,
    isPrimary: boolean,
    notes: string
  ) => void;
  onRemoveContact: (role: string, contactId: string) => void;
  userId: string;
  transactionType: string;
  propertyAddress: string;
  // Contacts loaded at parent level (useAuditTransaction hook)
  contacts: Contact[];
  contactsLoading: boolean;
  contactsError: string | null;
  onRefreshContacts: () => Promise<void>;
  onSilentRefreshContacts: () => Promise<void>;
  // External contacts (from macOS Contacts app, etc.)
  externalContacts: Contact[];
  externalContactsLoading: boolean;
  /** Callback when contact form modal opens/closes (BACKLOG-1654: hide parent nav buttons) */
  onModalStateChange?: (isOpen: boolean) => void;
}

/**
 * Role configuration from workflow steps
 */
interface RoleConfig {
  role: string;
  required: boolean;
  multiple: boolean;
}

/**
 * Converts Contact to ExtendedContact format for ContactSearchList/ContactRoleRow
 */
function toExtendedContact(contact: Contact): ExtendedContact {
  return {
    id: contact.id,
    name: contact.name,
    display_name: contact.display_name || contact.name,
    email: contact.email,
    phone: contact.phone,
    company: contact.company,
    source: contact.source,
    is_message_derived: contact.is_message_derived,
    user_id: contact.user_id,
    created_at: contact.created_at,
    updated_at: contact.updated_at,
    // BACKLOG-1270: Preserve all emails/phones through the selection flow
    allEmails: (contact as unknown as { allEmails?: string[] }).allEmails,
    allPhones: (contact as unknown as { allPhones?: string[] }).allPhones,
    // BACKLOG-1355: Preserve default_role for auto-fill
    default_role: contact.default_role,
    // BACKLOG-1727 follow-up: preserve last_communication_at so the frontend
    // sort in ContactSearchList can order all contacts by recency regardless
    // of imported/external origin. Same fix landed Jan 30 2026 (commit 5d6799e2)
    // for EditContactsModal but was never applied here.
    last_communication_at: (contact as unknown as { last_communication_at?: string | null }).last_communication_at,
  };
}

function ContactAssignmentStep({
  step,
  contactAssignments,
  selectedContactIds,
  onSelectedContactIdsChange,
  onAssignContact,
  onRemoveContact,
  userId,
  transactionType,
  propertyAddress,
  // Contacts loaded at parent level
  contacts,
  contactsLoading,
  contactsError,
  onRefreshContacts,
  onSilentRefreshContacts,
  // External contacts (from macOS Contacts app, etc.)
  externalContacts,
  externalContactsLoading,
  // BACKLOG-1654: Notify parent when contact form modal opens/closes
  onModalStateChange,
}: ContactAssignmentStepProps): React.ReactElement {
  // Contact preview/edit modal state
  const [previewContact, setPreviewContact] = useState<ExtendedContact | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editContact, setEditContact] = useState<ExtendedContact | undefined>(undefined);

  // Track imported contact IDs for visual feedback
  const [addedContactIds, setAddedContactIds] = useState<Set<string>>(new Set());

  // Track contact IDs to auto-select after manual add via ContactFormModal
  const [pendingAutoSelectIds, setPendingAutoSelectIds] = useState<string[]>([]);

  // BACKLOG-1355: Auto-fill role state
  const [autoRoleEnabled, setAutoRoleEnabled] = useState(false);
  const [autoFilledContactIds, setAutoFilledContactIds] = useState<Set<string>>(new Set());
  const autoFillAppliedRef = useRef(false);

  // BACKLOG-1654: Notify parent when contact form modal opens/closes
  // so parent can hide navigation buttons that overlap the form
  useEffect(() => {
    onModalStateChange?.(showEditModal);
  }, [showEditModal, onModalStateChange]);

  // Load auto-role setting on mount
  useEffect(() => {
    let cancelled = false;
    settingsService.getContactAutoRoleEnabled(userId).then((enabled) => {
      if (!cancelled) setAutoRoleEnabled(enabled);
    }).catch((err) => {
      logger.error("Failed to load auto-role setting:", err);
    });
    return () => { cancelled = true; };
  }, [userId]);

  // Convert contacts to ExtendedContact format for components
  const extendedContacts = useMemo(
    () => contacts.map(toExtendedContact),
    [contacts]
  );

  // Convert external contacts to ExtendedContact format
  const extendedExternalContacts = useMemo(
    () => (externalContacts ?? []).map(toExtendedContact),
    [externalContacts]
  );

  // Helper to check if a contact is external
  const isExternal = (contact: ExtendedContact): boolean => {
    return contact.is_message_derived === 1 || contact.is_message_derived === true;
  };

  // Handle clicking on a contact to view details (used in Step 3 only)
  const handleContactClick = useCallback((contact: ExtendedContact) => {
    setPreviewContact(contact);
  }, []);

  // Handle selection change from ContactSearchList (Step 2 toggle behavior)
  // Cleans up addedContactIds when contacts are deselected
  const handleSelectionChange = useCallback((newIds: string[]) => {
    // Find contacts that were removed (deselected)
    const removedIds = selectedContactIds.filter((id) => !newIds.includes(id));
    if (removedIds.length > 0) {
      setAddedContactIds((prev) => {
        const next = new Set(prev);
        removedIds.forEach((id) => next.delete(id));
        return next;
      });
    }
    onSelectedContactIdsChange(newIds);
  }, [selectedContactIds, onSelectedContactIdsChange]);

  // Handle editing a contact from preview
  const handlePreviewEdit = useCallback(() => {
    if (previewContact) {
      setPreviewContact(null);
      setEditContact(previewContact);
      setShowEditModal(true);
    }
  }, [previewContact]);

  // Handle adding a new contact manually
  const handleAddManually = useCallback(() => {
    setEditContact(undefined);
    setShowEditModal(true);
  }, []);

  // Build role options from all workflow steps
  const roleOptions = useMemo((): RoleOption[] => {
    const allRoles: RoleOption[] = [];
    const txnType = transactionType as TransactionType;

    AUDIT_WORKFLOW_STEPS.forEach((step) => {
      const filteredRoles = filterRolesByTransactionType(
        step.roles as RoleConfig[],
        txnType,
        step.title
      );

      filteredRoles.forEach((roleConfig) => {
        allRoles.push({
          value: roleConfig.role,
          label: getRoleDisplayName(roleConfig.role, txnType),
        });
      });
    });

    return allRoles;
  }, [transactionType]);

  // BACKLOG-1355: Auto-fill roles when entering step 3
  useEffect(() => {
    if (step !== 3 || !autoRoleEnabled || autoFillAppliedRef.current) return;

    // Mark as applied so we don't re-run on re-renders
    autoFillAppliedRef.current = true;

    const newAutoFilled = new Set<string>();
    extendedContacts
      .filter((c) => selectedContactIds.includes(c.id))
      .forEach((contact) => {
        // Only auto-fill if contact has a default_role and no role assigned yet
        if (!contact.default_role) return;
        const hasRole = Object.values(contactAssignments).some(
          (assignments) => assignments.some((a) => a.contactId === contact.id)
        );
        if (hasRole) return;

        // Check if the default_role is a valid option for this transaction type
        const isValidRole = roleOptions.some((opt) => opt.value === contact.default_role);
        const effectiveRole = isValidRole
          ? contact.default_role
          : flipRoleForTransactionType(contact.default_role, transactionType as TransactionType);
        if (!effectiveRole) return;

        onAssignContact(effectiveRole, contact.id, false, "");
        newAutoFilled.add(contact.id);
      });

    if (newAutoFilled.size > 0) {
      setAutoFilledContactIds(newAutoFilled);
    }
  }, [step, autoRoleEnabled, extendedContacts, selectedContactIds, contactAssignments, roleOptions, onAssignContact]);

  // Reset auto-fill tracking when going back from step 3
  useEffect(() => {
    if (step !== 3) {
      autoFillAppliedRef.current = false;
      setAutoFilledContactIds(new Set());
    }
  }, [step]);

  // Auto-select contacts added via ContactFormModal once they appear in the contacts list
  // Pattern from ContactSelectModal: wait for refresh, then select
  useEffect(() => {
    if (pendingAutoSelectIds.length === 0) return;

    const contactIdSet = new Set(contacts.map((c) => c.id));
    const idsToSelect = pendingAutoSelectIds.filter((id) => contactIdSet.has(id));

    if (idsToSelect.length > 0) {
      // Add to selectedContactIds (avoid duplicates)
      const newIds = idsToSelect.filter((id) => !selectedContactIds.includes(id));
      if (newIds.length > 0) {
        onSelectedContactIdsChange([...selectedContactIds, ...newIds]);
      }
      // Clear pending IDs that were successfully selected
      setPendingAutoSelectIds((prev) =>
        prev.filter((id) => !contactIdSet.has(id))
      );
    }
  }, [pendingAutoSelectIds, contacts, selectedContactIds, onSelectedContactIdsChange]);

  // Get selected contacts for step 2
  const selectedContacts = useMemo(() => {
    return extendedContacts.filter((c) => selectedContactIds.includes(c.id));
  }, [extendedContacts, selectedContactIds]);

  // Get the current role for a contact from contactAssignments
  const getContactRole = useCallback(
    (contactId: string): string => {
      for (const [role, assignments] of Object.entries(contactAssignments)) {
        if (assignments.some((a) => a.contactId === contactId)) {
          return role;
        }
      }
      return ""; // No role assigned
    },
    [contactAssignments]
  );

  // Count how many contacts have roles assigned
  const assignedCount = useMemo(() => {
    return selectedContacts.filter((c) => getContactRole(c.id) !== "").length;
  }, [selectedContacts, getContactRole]);

  // Handle removing a contact from Step 3 (deselects and removes role assignment)
  const handleRemoveFromStep3 = useCallback(
    (contactId: string) => {
      // Remove from selectedContactIds (propagates back to Step 2 checkbox state)
      onSelectedContactIdsChange(
        selectedContactIds.filter((id) => id !== contactId)
      );

      // Remove from addedContactIds so Step 2 no longer shows "added" badge
      setAddedContactIds((prev) => {
        const next = new Set(prev);
        next.delete(contactId);
        return next;
      });

      // Remove any role assignment for this contact
      for (const [role, assignments] of Object.entries(contactAssignments)) {
        if (assignments.some((a) => a.contactId === contactId)) {
          onRemoveContact(role, contactId);
          break;
        }
      }
    },
    [selectedContactIds, onSelectedContactIdsChange, contactAssignments, onRemoveContact]
  );

  // Handle role change for a contact
  const handleRoleChange = useCallback(
    (contactId: string, newRole: string) => {
      // First, remove contact from any existing role
      for (const [role, assignments] of Object.entries(contactAssignments)) {
        if (assignments.some((a) => a.contactId === contactId)) {
          onRemoveContact(role, contactId);
          break;
        }
      }

      // Then assign to new role (if not empty)
      if (newRole) {
        onAssignContact(newRole, contactId, false, "");
      }

      // BACKLOG-1355: Clear auto-filled status when user manually changes role
      setAutoFilledContactIds((prev) => {
        if (!prev.has(contactId)) return prev;
        const next = new Set(prev);
        next.delete(contactId);
        return next;
      });
    },
    [contactAssignments, onAssignContact, onRemoveContact]
  );

  // Handle adding a contact (import if external, or just select if already imported)
  const handleImportContact = useCallback(
    async (contact: ExtendedContact): Promise<ExtendedContact> => {
      // Check if contact is already in our DB by matching against the contacts list
      const isInDatabase = contacts.some(c => c.id === contact.id);
      const isExternalContact = !isInDatabase;

      if (isExternalContact) {
        // External contact: import first, then add to selection.
        // BACKLOG-1745 Part 2: pass through the external row's engagement
        // timestamps so the new contact inherits its recency. Without this,
        // the unified sort in getContactsSortedByActivity (Part 1 fix) sinks
        // the newly imported row to the bottom of the picker list, producing
        // the observed "list reorders after import" bug. With timestamps copied,
        // the new contact sorts to the same position the external row occupied.
        const result = await contactService.create(userId, {
          name: contact.display_name || contact.name || "",
          email: contact.email,
          phone: contact.phone,
          company: contact.company,
          source: contact.source || "contacts_app",
          allEmails: contact.allEmails || [],
          allPhones: contact.allPhones || [],
          last_inbound_at: contact.last_inbound_at ?? null,
          last_outbound_at: contact.last_outbound_at ?? null,
          last_communication_at: contact.last_communication_at ?? null,
        });

        if (result.success && result.data) {
          const newContact = result.data as ExtendedContact;
          // Mark as added for visual feedback (use original contact ID, not new DB ID)
          setAddedContactIds((prev) => new Set(prev).add(contact.id));
          // Auto-select the newly imported contact
          onSelectedContactIdsChange([...selectedContactIds, newContact.id]);
          // Silent refresh to pick up newly imported contact in DB
          await onSilentRefreshContacts();
          return newContact;
        }

        throw new Error(result.error || "Failed to import contact");
      } else {
        // Already imported contact: just add to selection
        setAddedContactIds((prev) => new Set(prev).add(contact.id));
        onSelectedContactIdsChange([...selectedContactIds, contact.id]);
        return contact;
      }
    },
    [userId, onSilentRefreshContacts, selectedContactIds, onSelectedContactIdsChange, contacts]
  );

  // Handle importing from preview (needs to be after handleImportContact)
  const handlePreviewImportAction = useCallback(async () => {
    if (!previewContact) return;
    try {
      await handleImportContact(previewContact);
      setPreviewContact(null);
    } catch (err) {
      logger.error("Failed to import contact:", err);
    }
  }, [previewContact, handleImportContact]);

  return (
    // BACKLOG-1727 follow-up: was h-full; switched to flex-1 min-h-0 so the
    // flex chain from <ResponsiveModal panelClassName={MODAL_PANEL.lg}> →
    // content wrapper → here → step-2 wrapper → ContactSearchList resolves
    // a definite height for the inner overflow-y-auto. h-full is
    // height:100% which only resolves when the parent has an explicit height;
    // inside a flex chain with min-h-0 ancestors the parent has a *computed*
    // height, not an explicit one, so h-full collapsed and scroll broke.
    <div className="flex flex-col flex-1 min-h-0 relative">
      {/* Error display */}
      {contactsError && (
        <div className="flex-shrink-0 mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{contactsError}</p>
        </div>
      )}

      {/* Step 2: Contact Selection */}
      {step === 2 && (
        <div
          className="flex flex-col flex-1 min-h-0"
          data-testid="contact-assignment-step-2"
        >
          {/* Contact Search List - no header since parent modal shows "Step 2: Select Contacts" */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <ContactSearchList
              contacts={extendedContacts}
              externalContacts={extendedExternalContacts}
              selectedIds={selectedContactIds}
              onSelectionChange={handleSelectionChange}
              onImportContact={handleImportContact}
              onAddManually={handleAddManually}
              addedContactIds={addedContactIds}
              isLoading={contactsLoading || externalContactsLoading}
              error={contactsError}
              searchPlaceholder="Search contacts by name, email, or phone..."
              className="h-full"
            />
          </div>
        </div>
      )}

      {/* Step 3: Role Assignment */}
      {step === 3 && (
        <div
          className="flex flex-col flex-1 min-h-0"
          data-testid="contact-assignment-step-3"
        >
          {/* Status line showing assignment progress */}
          <div className="flex-shrink-0 px-4 pt-4 pb-2">
            <p className="text-sm text-gray-600">
              {assignedCount} of {selectedContacts.length} contact
              {selectedContacts.length !== 1 ? "s" : ""} have roles assigned
            </p>
          </div>

          {/* Contact Role Rows */}
          <div className="flex-1 overflow-y-auto px-4 py-2">
            {selectedContacts.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                <p>No contacts selected.</p>
                <p className="mt-2 text-sm">Go back to select contacts.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {selectedContacts.map((contact) => (
                  <ContactRoleRow
                    key={contact.id}
                    contact={contact}
                    currentRole={getContactRole(contact.id)}
                    roleOptions={roleOptions}
                    onRoleChange={(role) => handleRoleChange(contact.id, role)}
                    onRemove={() => handleRemoveFromStep3(contact.id)}
                    onClick={() => handleContactClick(contact)}
                    isAutoFilled={autoFilledContactIds.has(contact.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Contact Preview Modal */}
      {previewContact && (
        <ContactPreview
          contact={previewContact}
          isExternal={isExternal(previewContact)}
          transactions={[]}
          onEdit={handlePreviewEdit}
          onImport={handlePreviewImportAction}
          onClose={() => setPreviewContact(null)}
        />
      )}

      {/* Add/Edit Contact Modal */}
      {showEditModal && (
        <ContactFormModal
          userId={userId}
          contact={editContact}
          onClose={() => {
            setShowEditModal(false);
            setEditContact(undefined);
          }}
          onSuccess={(savedContact) => {
            setShowEditModal(false);
            setEditContact(undefined);
            // If a new contact was created (not editing), queue it for auto-select
            if (savedContact?.id && !editContact) {
              setPendingAutoSelectIds((prev) => [...prev, savedContact.id]);
            }
            onRefreshContacts();
          }}
        />
      )}
    </div>
  );
}

export default ContactAssignmentStep;
