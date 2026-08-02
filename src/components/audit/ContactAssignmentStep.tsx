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
  resolveDefaultContactRole,
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
  /**
   * BACKLOG-2341: show the Source/Role grouped filter above the contact list
   * (like the Clients & Contacts screen). Opt-in per consumer — the
   * EditContactsModal "Add Contacts" flow (existing transaction) turns this ON;
   * the audit/new-transaction flow leaves it OFF (unchanged). When ON, the
   * filter defaults to showing EVERY contact (see `categoryFilterDefaultsToAll`
   * on ContactSearchList) so it can only ever NARROW, never pre-hide. Default:
   * `false`.
   */
  showCategoryFilter?: boolean;
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
 * BACKLOG-2400: link between an external/address-book contact the user added and
 * the DB contact its import produced. Lets the two-pane hide the external twin
 * from "Available" whenever its imported twin is selected, even when the two
 * cannot be bridged by identity dedup (message-derived / phone-only contacts).
 */
interface ImportedTwin {
  /** Original id of the external row the user clicked "+ Add" on. */
  externalId: string;
  /** The imported DB contact (its id is what lands in `selectedContactIds`). */
  imported: ExtendedContact;
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
  // BACKLOG-2341: opt-in Source/Role filter (existing-transaction Add Contacts flow)
  showCategoryFilter = false,
}: ContactAssignmentStepProps): React.ReactElement {
  // Contact preview/edit modal state
  const [previewContact, setPreviewContact] = useState<ExtendedContact | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editContact, setEditContact] = useState<ExtendedContact | undefined>(undefined);

  // BACKLOG-2400: bookkeeping for external (not-yet-imported) contacts added via
  // "+ Add". Adding one imports it, which mints a NEW DB id — that new id is what
  // lands in `selectedContactIds`, but the row still on screen is the EXTERNAL
  // twin carrying its ORIGINAL id. Excluding "Available" by selected id alone
  // therefore can't hide the twin (its id isn't selected), and identity-dedup
  // (assembleDedupedContacts) only bridges the two when they share an
  // email/phone — which message-derived / phone-only externals often don't. So
  // we record the link {externalId -> imported DB contact} explicitly and hide
  // the external twin whenever its imported twin is selected — independent of
  // dedup. NOT a selection source: `selectedContactIds` remains the single
  // source of truth for WHAT is added; this only supplies (a) row DATA for the
  // Added chip before the silent refresh lands, and (b) the external id to hide.
  const [importedTwins, setImportedTwins] = useState<ImportedTwin[]>([]);

  // Track contact IDs to auto-select after manual add via ContactFormModal
  const [pendingAutoSelectIds, setPendingAutoSelectIds] = useState<string[]>([]);

  // BACKLOG-1355: Auto-fill role state
  const [autoRoleEnabled, setAutoRoleEnabled] = useState(false);
  // BACKLOG-2358: gate the step-3 default-fill until the auto-role setting has
  // loaded, so the default_role override (when the setting is ON) isn't
  // pre-empted by the Client baseline running against the initial `false`.
  const [autoRoleLoaded, setAutoRoleLoaded] = useState(false);
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
    }).finally(() => {
      if (!cancelled) setAutoRoleLoaded(true);
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

  // Handle selection change from ContactSearchList (Step 2 "+ Add" adds to
  // selection). BACKLOG-2400: `selectedContactIds` is the single source of
  // truth — there is no longer a parallel "added" set to reconcile, so this is a
  // straight pass-through.
  const handleSelectionChange = useCallback((newIds: string[]) => {
    onSelectedContactIdsChange(newIds);
  }, [onSelectedContactIdsChange]);

  // BACKLOG-2400: remove a contact from the Added column (its ✕). Deselecting
  // returns its row to "Available" at its frozen position.
  const handleDeselect = useCallback((contactId: string) => {
    onSelectedContactIdsChange(selectedContactIds.filter((id) => id !== contactId));
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

  // BACKLOG-1355 / BACKLOG-2358: Fill roles when entering step 3.
  // Every selected contact without a role gets a default so none are left empty:
  // the Client baseline always applies (renders as Buyer/Seller (Client) by
  // type), and the smart default_role auto-fill overrides it when enabled.
  useEffect(() => {
    if (step !== 3 || !autoRoleLoaded || autoFillAppliedRef.current) return;

    // Mark as applied so we don't re-run on re-renders
    autoFillAppliedRef.current = true;

    const newAutoFilled = new Set<string>();
    extendedContacts
      .filter((c) => selectedContactIds.includes(c.id))
      .forEach((contact) => {
        // Skip contacts that already have a role assigned.
        const hasRole = Object.values(contactAssignments).some(
          (assignments) => assignments.some((a) => a.contactId === contact.id)
        );
        if (hasRole) return;

        const role = resolveDefaultContactRole(
          autoRoleEnabled,
          contact.default_role,
          transactionType as TransactionType,
          (r) => roleOptions.some((opt) => opt.value === r),
        );

        onAssignContact(role, contact.id, false, "");
        newAutoFilled.add(contact.id);
      });

    if (newAutoFilled.size > 0) {
      setAutoFilledContactIds(newAutoFilled);
    }
  }, [step, autoRoleLoaded, autoRoleEnabled, extendedContacts, selectedContactIds, contactAssignments, roleOptions, transactionType, onAssignContact]);

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

  // Get selected contacts (Step 3 role assignment + auto-fill). Kept exactly as
  // before — Step 3 reads from `extendedContacts` only, unchanged by BACKLOG-2400.
  const selectedContacts = useMemo(() => {
    return extendedContacts.filter((c) => selectedContactIds.includes(c.id));
  }, [extendedContacts, selectedContactIds]);

  // BACKLOG-2400: contacts augmented with SELECTED imported-twin rows not yet
  // folded into `contacts` by the silent refresh. Supplies the imported contact's
  // DATA (for the Added chip) during that brief window. Only selected twins are
  // added — a deselected twin must not linger in Available.
  const augmentedContacts = useMemo(() => {
    if (importedTwins.length === 0) return extendedContacts;
    const known = new Set(extendedContacts.map((c) => c.id));
    const sel = new Set(selectedContactIds);
    const extra = importedTwins
      .filter((t) => sel.has(t.imported.id) && !known.has(t.imported.id))
      .map((t) => t.imported);
    return extra.length > 0 ? [...extendedContacts, ...extra] : extendedContacts;
  }, [extendedContacts, importedTwins, selectedContactIds]);

  // BACKLOG-2400: external-twin ids to HIDE from Available — the original id of
  // every external contact whose imported twin is currently selected. This is
  // the fix for the founder-QA "shows in both places" bug: it hides the twin by
  // its own id, so it works even when dedup can't match imported<->external
  // (message-derived / phone-only). Deselecting the imported twin (chip ✕) drops
  // its externalId from this set, so the external row returns to Available.
  const excludedExternalIds = useMemo(() => {
    const sel = new Set(selectedContactIds);
    const out = new Set<string>();
    for (const t of importedTwins) {
      if (sel.has(t.imported.id)) out.add(t.externalId);
    }
    return out;
  }, [importedTwins, selectedContactIds]);

  // External contacts actually shown in "Available": the raw address-book list
  // minus twins whose imported copy is already added.
  const visibleExternalContacts = useMemo(() => {
    if (excludedExternalIds.size === 0) return extendedExternalContacts;
    return extendedExternalContacts.filter((c) => !excludedExternalIds.has(c.id));
  }, [extendedExternalContacts, excludedExternalIds]);

  // Prune twin bookkeeping once its imported contact is deselected — we no longer
  // need to hide its external twin or supply its chip data. Kept while selected
  // (even after the refresh folds it into `contacts`) so the external twin stays
  // hidden for as long as the contact is added, regardless of dedup.
  useEffect(() => {
    if (importedTwins.length === 0) return;
    const sel = new Set(selectedContactIds);
    setImportedTwins((prev) => {
      const next = prev.filter((t) => sel.has(t.imported.id));
      return next.length === prev.length ? prev : next;
    });
  }, [selectedContactIds, importedTwins.length]);

  // BACKLOG-2400: the "Added" column, driven SOLELY by `selectedContactIds`
  // (single source of truth), projected (in selection order, de-duplicated) onto
  // the augmented contact data. No parallel "added" set can drift against this.
  const addedContacts = useMemo(() => {
    const byId = new Map(augmentedContacts.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const out: ExtendedContact[] = [];
    for (const id of selectedContactIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const contact = byId.get(id);
      if (contact) out.push(contact);
    }
    return out;
  }, [augmentedContacts, selectedContactIds]);

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
      // Remove from selectedContactIds (propagates back to Step 2 Available list)
      onSelectedContactIdsChange(
        selectedContactIds.filter((id) => id !== contactId)
      );

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
        // External contact: import first, then add to selection
        const result = await contactService.create(userId, {
          name: contact.display_name || contact.name || "",
          email: contact.email,
          phone: contact.phone,
          company: contact.company,
          source: contact.source || "contacts_app",
          allEmails: contact.allEmails || [],
          allPhones: contact.allPhones || [],
        });

        if (result.success && result.data) {
          const newContact = result.data as ExtendedContact;
          // BACKLOG-2400: record the external-original -> imported-DB link so the
          // external twin (`contact.id`) is hidden from Available while its
          // imported twin (`newContact.id`) is selected — independent of whether
          // dedup can bridge them. Also supplies the Added chip's row DATA before
          // the silent refresh folds newContact into `contacts`. selectedContactIds
          // (single source of truth) gets the new DB id.
          setImportedTwins((prev) =>
            prev.some((t) => t.imported.id === newContact.id)
              ? prev
              : [...prev, { externalId: contact.id, imported: newContact }]
          );
          onSelectedContactIdsChange([...selectedContactIds, newContact.id]);
          // Silent refresh to pick up newly imported contact in DB
          await onSilentRefreshContacts();
          return newContact;
        }

        throw new Error(result.error || "Failed to import contact");
      } else {
        // Already imported contact: just add to selection
        if (!selectedContactIds.includes(contact.id)) {
          onSelectedContactIdsChange([...selectedContactIds, contact.id]);
        }
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

      {/* Step 2: Contact Selection — BACKLOG-2400 two-pane.
          LEFT = "Available" (ContactSearchList in "add" mode: + Add per row).
          RIGHT = "Added (N)" chips, driven SOLELY by selectedContactIds.
          Responsive: side-by-side at ≥640px (sm); the Added column collapses to a
          chips tray ABOVE the list at <640px (order-1 on mobile, order-2 on sm+). */}
      {step === 2 && (
        <div
          className="flex flex-col flex-1 min-h-0"
          data-testid="contact-assignment-step-2"
        >
          <div className="flex flex-col sm:flex-row flex-1 min-h-0 overflow-hidden">
            {/* Added column / mobile chips tray */}
            <div
              className="order-1 sm:order-2 flex flex-col flex-shrink-0 min-h-0 max-h-[38%] sm:max-h-none sm:w-64 sm:min-w-[16rem] border-b sm:border-b-0 sm:border-l border-gray-200 bg-gray-50"
              data-testid="contact-assignment-added-pane"
            >
              <div className="flex-shrink-0 px-3 pt-3 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Added (<span data-testid="added-count">{addedContacts.length}</span>)
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
                {addedContacts.length === 0 ? (
                  <p className="text-sm text-gray-400 py-1" data-testid="added-empty">
                    No contacts added yet. Use{" "}
                    <span className="font-medium text-gray-500">+ Add</span> on the left.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {addedContacts.map((contact) => {
                      const name = contact.display_name || contact.name || "Unknown Contact";
                      return (
                        <span
                          key={contact.id}
                          className="inline-flex items-center gap-1 max-w-full pl-3 pr-1 py-1 bg-purple-100 text-purple-800 rounded-full text-sm"
                          data-testid={`added-chip-${contact.id}`}
                        >
                          <span className="truncate max-w-[10rem]">{name}</span>
                          <button
                            type="button"
                            onClick={() => handleDeselect(contact.id)}
                            aria-label={`Remove ${name}`}
                            data-testid={`remove-added-${contact.id}`}
                            className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full hover:bg-purple-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Available column (search + list). No header — the parent modal
                shows "Step 2: Select Contacts". */}
            <div className="order-2 sm:order-1 flex flex-col flex-1 min-h-0 overflow-hidden">
              <ContactSearchList
                contacts={augmentedContacts}
                // BACKLOG-2400: external twins already added (imported) are removed
                // here so they never linger in Available alongside their chip.
                externalContacts={visibleExternalContacts}
                selectedIds={selectedContactIds}
                onSelectionChange={handleSelectionChange}
                onImportContact={handleImportContact}
                onAddManually={handleAddManually}
                // BACKLOG-2400: "+ Add" affordance; selected contacts drop out of
                // Available (they live in the Added column). Single source of truth.
                selectionMode="add"
                isLoading={contactsLoading || externalContactsLoading}
                error={contactsError}
                searchPlaceholder="Search contacts by name, email, or phone..."
                // BACKLOG-2341/2352: transaction flows must never PRE-hide contacts.
                // When the filter is surfaced it runs in EPHEMERAL mode — opens on
                // "show everything", persists nothing, and neither inherits nor
                // clobbers the Clients & Contacts screen's saved filter selection.
                // When not surfaced it is fully off (show everyone).
                filterMode={showCategoryFilter ? "ephemeral" : "off"}
                className="h-full"
              />
            </div>
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
