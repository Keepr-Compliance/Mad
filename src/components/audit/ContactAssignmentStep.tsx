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
  buildRoleOptions,
  resolveDefaultContactRole,
  getRoleDisplayName,
  type TransactionType,
} from "../../utils/transactionRoleUtils";
import { ContactSearchList } from "../shared/ContactSearchList";
import { ContactRoleRow } from "../shared/ContactRoleRow";
import { ContactPreview } from "../shared/ContactPreview";
import { ContactFormModal } from "../contact";
// BACKLOG-2603: the SHIPPED review screen, reused with a filter. See its mount
// at the foot of this component for why it is not a wizard-specific copy.
import { ReviewDuplicatesModal } from "../contact/components";
import type { RoleOption } from "../shared/ContactRoleRow";
import type { ContactAssignments } from "../../hooks/useAuditTransaction";
import type { Contact } from "../../../electron/types/models";
import type { ExtendedContact } from "../../types/components";
// BACKLOG-2638: `contactService` is gone from this file with the `create` call
// it existed for. The import now goes through `window.api.contacts.import`
// directly, as Clients & Contacts has since BACKLOG-2510 — `contactService.import`
// flattens the response to `{ imported: number }` and discards the contact rows,
// which are exactly what this caller needs back.
import { settingsService } from "../../services";
import logger from '../../utils/logger';
import { labelForContact } from "../../utils/contactDisplayLabel";

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
  /**
   * BACKLOG-2631 — ONE REFRESH, BOTH HALVES, FROM EVERY CONTAINER.
   *
   * This prop was `onSilentRefreshContacts`, and both containers wired it to a
   * reload of the SAVED half only. Every action that reaches it — importing a
   * record, answering "yes, same person" — writes a `contact_source_links` row,
   * and that table is precisely what `contacts:get-available` suppresses on. So
   * the half that MOVED was the half nobody re-read, and the merged-away record
   * stayed on screen as a selectable row for the life of the modal.
   *
   * Both containers now pass `useContactDirectory`'s `refreshBothLists`: both
   * halves fetched in parallel, committed in one render, never raising the
   * external loading flag (which would replace the list with a spinner and cost
   * the user their place mid-selection).
   *
   * The name says which lists move. The old one said only that it was quiet.
   */
  onRefreshBothLists: () => Promise<void>;
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
 *
 * =========================================================================
 * BACKLOG-2603 — CARRY EVERYTHING, WITHHOLD ON PURPOSE. IT USED TO BE THE
 * OTHER WAY ROUND, AND THAT COST FOUR FIELDS.
 * =========================================================================
 * This was a FIELD-BY-FIELD ALLOWLIST: fourteen names copied across, and
 * everything else silently gone. A projection like that does not fail loudly —
 * the object still typechecks, the screen still renders, and one feature is
 * quietly missing on this surface only. The record:
 *
 *   - BACKLOG-1270 — `allEmails` / `allPhones` lost, restored
 *   - BACKLOG-1355 — `default_role` lost, restored
 *   - BACKLOG-1727 follow-up — `last_communication_at` lost, and its own note
 *     below records that the fix *"landed Jan 30 2026 for EditContactsModal but
 *     was never applied here"*
 *   - BACKLOG-2603 — `review_state` lost. THE FOUNDER FOUND THIS ONE: he
 *     searched a contact with four outstanding questions in the transaction
 *     wizard and the row said nothing, while the same contact in Clients &
 *     Contacts carries a badge. Both surfaces render the SAME `ContactRow`
 *     through the SAME `ContactSearchList`; only this function stood between
 *     them.
 *
 * Adding a fifteenth line would have bought the fifth loss. So the default is
 * inverted: the contact is spread, and anything withheld must now be an
 * explicit, commented deletion that a reviewer can see.
 *
 * SAFE BECAUSE THE CONSUMERS WERE ENUMERATED, not because a spread feels
 * harmless. Every `contact.<field>` read downstream: `ContactRow` reads
 * `allEmails, allPhones, company, email, id, is_message_derived, phone,
 * review_state, source`; `ContactSearchList` reads `disabled, id, review_state`.
 * `review_state` is the ONLY field they read that the allowlist withheld — so
 * this turns the badge on and changes nothing else. Neither reads `source_types`,
 * so no source pill appears and BACKLOG-2356's name-only row is untouched.
 *
 * The two overrides below are the only things this function now decides.
 */
function toExtendedContact(contact: Contact): ExtendedContact {
  return {
    ...contact,
    // The one genuine transformation: the list sorts and searches on
    // `display_name`, and a contact with only `name` must not sort as blank.
    display_name: contact.display_name || contact.name,
    // BACKLOG-1270: Preserve all emails/phones through the selection flow.
    // Kept as explicit casts rather than left to the spread because `Contact`
    // does not declare them — they are attached by `parseContactAddressAggregates`
    // at read time, and naming them here is what tells the compiler they exist.
    allEmails: (contact as unknown as { allEmails?: string[] }).allEmails,
    allPhones: (contact as unknown as { allPhones?: string[] }).allPhones,
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
  onRefreshBothLists,
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
  // therefore can't hide the twin (its id isn't selected). This was already
  // documented as working "independent of dedup", because the renderer's
  // identity pass only ever bridged the two when they shared an email/phone —
  // which message-derived / phone-only externals often don't. BACKLOG-2370
  // deleted that pass outright, so this explicit link is now the ONLY thing that
  // hides the twin, which is the right shape: it hides a row because of a
  // recorded import the user just performed, not because of a resemblance
  // recomputed on every render. NOT a selection source: `selectedContactIds` remains the single
  // source of truth for WHAT is added; this only supplies (a) row DATA for the
  // Added chip before the silent refresh lands, and (b) the external id to hide.
  const [importedTwins, setImportedTwins] = useState<ImportedTwin[]>([]);

  // Track contact IDs to auto-select after manual add via ContactFormModal
  const [pendingAutoSelectIds, setPendingAutoSelectIds] = useState<string[]>([]);

  /**
   * BACKLOG-2603 — whose open questions are on screen, if anyone's.
   *
   * The founder's framing was *"if we were to reuse the search from the Clients
   * & Contacts it shouldn't [need building], should it?"* — and it did not. This
   * is a contact id handed to the SHIPPED `ReviewDuplicatesModal` as
   * `filterContactId`, the same parameter Clients & Contacts passes at
   * `Contacts.tsx`. One component, now four entry points: the full queue, the
   * post-import filtered view, the contact click in Clients & Contacts, and
   * this. Not a fourth screen.
   */
  const [questionsForContactId, setQuestionsForContactId] = useState<string | null>(null);

  // BACKLOG-1355: Auto-fill role state
  const [autoRoleEnabled, setAutoRoleEnabled] = useState(false);
  // BACKLOG-2358: gate the step-3 default-fill until the auto-role setting has
  // loaded, so the default_role override (when the setting is ON) isn't
  // pre-empted by the Client baseline running against the initial `false`.
  const [autoRoleLoaded, setAutoRoleLoaded] = useState(false);
  // BACKLOG-2567: `autoFilledContactIds` is gone. It existed ONLY to drive
  // ContactRoleRow's "(Auto)" badge, so with the badge removed it became state
  // that is written and never read — which eslint does not flag. The auto-fill
  // itself (the `onAssignContact` call below) is untouched.
  //
  // BACKLOG-2677: this was a BOOLEAN — "has the step-3 fill run yet" — and that
  // was the bug. It latched on the first pass, so any contact the pass did not
  // cover was never defaulted, no matter what changed afterwards. It is now the
  // SET OF CONTACT IDS the fill has already decided about, which answers the
  // question the fill actually needs to ask ("have I defaulted THIS person?")
  // and lets the effect re-run safely as the selection and the contact list
  // change. See the effect below for why a boolean could not work.
  const defaultedContactIdsRef = useRef<Set<string>>(new Set());

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

  // The roles this picker offers. One shared definition (BACKLOG-2859) — the
  // same three party roles on every transaction type, with `client` and `agent`
  // labelled for THIS type. Notably absent: the user's own role, and the other
  // side's principal.
  const roleOptions = useMemo(
    (): RoleOption[] => buildRoleOptions(transactionType as TransactionType),
    [transactionType]
  );

  // Auto-select contacts added via ContactFormModal once they appear in the contacts list
  // Wait for the refresh, then select. (The pattern originated in the picker
  // BACKLOG-2515 deleted; it is documented here because this is now its only home.)
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

  /**
   * BACKLOG-1355 / BACKLOG-2358 / BACKLOG-2677 — every selected contact leaves
   * step 3 holding a role.
   *
   * =========================================================================
   * BACKLOG-2677 — THE FOUNDER ADDED ONE CONTACT AND THE SAVE REFUSED IT.
   * =========================================================================
   * "At least one contact must be assigned the Buyer (Client) role", at save
   * time, after the work was done. The default was NOT missing — it is the same
   * `resolveDefaultContactRole` call it has always been. What was missing was
   * COVERAGE, in two independent ways, and both had to go:
   *
   *   1. `autoFillAppliedRef` was a BOOLEAN set BEFORE the loop, so the fill ran
   *      exactly once per visit to step 3. Anything the selection gained
   *      afterwards was never defaulted.
   *   2. The loop iterated `extendedContacts` — `contacts`, the LOCAL SAVED
   *      LIST. A selected id absent from it at that instant was skipped, and
   *      because of (1), skipped permanently.
   *
   * Together they make a live sequence, and it is the founder's:
   *
   *      step 2  add an address-book record → it is imported → its NEW id is
   *              selected at once, while the silent refresh is still in flight
   *      step 3  the fill runs against a `contacts` that does not contain it →
   *              nothing assigned → the boolean latches
   *      then    the refresh lands, the row appears with an EMPTY role select,
   *              and the fill never runs again
   *      save    refused.
   *
   * The component ALREADY KNEW that window exists: `augmentedContacts` directly
   * above is built for it, so the Added chip can show an imported contact's data
   * before the refresh folds it in. The chip was taught about the window. This
   * fill was not. It reads `augmentedContacts` now, for the same reason.
   *
   * THE FIX IS ID-DRIVEN, NOT RECORD-DRIVEN. It iterates `selectedContactIds` —
   * the single source of truth for who is on this deal — instead of a contact
   * array that may lag it. **A contact record is not needed to assign the Client
   * baseline**; only the `default_role` smart override needs one, so a
   * record-less id falls back to plain Client. Under the founder's decision of
   * 12 Aug that fallback is the CORRECT answer, not a degraded one.
   *
   * FOUNDER DECISION, 12 Aug, binding: *"any should default to client. until we
   * have an algorithm that can infer that"* — EVERY contact added defaults to
   * Client, not just the first, and not only the ones with no Buyer yet. The
   * item body proposed first-only; he rejected it. When role inference exists
   * (BACKLOG-2630) the default becomes a prediction and this is reopened.
   *
   * WHY THE REF IS A SET AND NOT A BOOLEAN — and why `hasRole` alone is not
   * enough. The fill must fire for a contact it has not decided about yet, and
   * must NOT fire for one it has. `hasRole` answers "does this contact have a
   * role RIGHT NOW", which is a different question: a user who CLEARS a role
   * (ContactRoleRow's blank option is a reachable state) would have Client
   * handed straight back on the next render, and the role they just cleared
   * would be un-clearable. The Set records the decision, so a cleared role stays
   * cleared. Ids that arrive already holding a role are recorded too — the fill
   * has decided about them, by deciding not to touch them.
   *
   * The Set is reset on leaving step 3, so stepping back to 2 and returning
   * re-defaults anyone still without a role.
   */
  useEffect(() => {
    if (step !== 3 || !autoRoleLoaded) return;

    const byId = new Map(augmentedContacts.map((c) => [c.id, c]));

    for (const contactId of selectedContactIds) {
      // Already decided about this person on an earlier pass.
      if (defaultedContactIdsRef.current.has(contactId)) continue;

      const hasRole = Object.values(contactAssignments).some((assignments) =>
        assignments.some((a) => a.contactId === contactId),
      );
      if (hasRole) {
        // Decided: leave it alone, now and on every later pass.
        defaultedContactIdsRef.current.add(contactId);
        continue;
      }

      // `contact` is undefined for an id whose record has not landed yet. That
      // is fine and is the point — `resolveDefaultContactRole` returns the
      // Client baseline for a missing `default_role`.
      const contact = byId.get(contactId);
      const role = resolveDefaultContactRole(
        autoRoleEnabled,
        contact?.default_role,
        transactionType as TransactionType,
        (r) => roleOptions.some((opt) => opt.value === r),
      );

      defaultedContactIdsRef.current.add(contactId);
      // BACKLOG-2567: the assignment. The badge bookkeeping that used to
      // follow this line is gone; the auto-assignment is not.
      onAssignContact(role, contactId, false, "");
    }
  }, [step, autoRoleLoaded, autoRoleEnabled, augmentedContacts, selectedContactIds, contactAssignments, roleOptions, transactionType, onAssignContact]);

  // Reset the fill's bookkeeping when leaving step 3, so a user who steps back
  // to pick more people gets them defaulted on the way forward again.
  useEffect(() => {
    if (step !== 3) {
      defaultedContactIdsRef.current = new Set();
    }
  }, [step]);

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
      // BACKLOG-2567: this is the LIVE half of this handler. The
      // clear-the-badge block that used to follow it is gone with the badge;
      // the reassignment above must not go with it.
      if (newRole) {
        onAssignContact(newRole, contactId, false, "");
      }
    },
    [contactAssignments, onAssignContact, onRemoveContact]
  );

  /**
   * "+ Add" on the wizard's Available list: import the record if it is an
   * address-book row, or just select it if it is already a saved contact.
   *
   * =========================================================================
   * BACKLOG-2638 — THE CONTACT MUST CLAIM THE RECORD IT WAS MADE FROM. IT DID
   * NOT, AND THE APP THEN ASKED WHETHER SHE WAS THE SAME PERSON AS HER CARD.
   * =========================================================================
   * The precise defect is NOT that this button "created instead of imported".
   * It created a contact and the person did appear in Clients & Contacts
   * afterwards; from the user's side it imported. What it never did was write
   * a `(source_type, source_record_id)` crosswalk row for the address-book
   * record the user picked.
   *
   * Observed on the founder's clean database, 2026-08-11. Dana Whitlock, added
   * here, held ONE crosswalk row: the synthetic `origin:<contactId>`. Priya
   * Raman, imported from Clients & Contacts, held `origin` AND `source_id`,
   * written in the same second.
   *
   * Three consequences, in the order he met them:
   *
   *   1. `contacts:get-available` suppresses a record only when some contact
   *      claims its `(source_type, external_record_id)` pair
   *      (`contactHandlers.ts:1636-1641`). `origin:<contactId>` matches no real
   *      record, so the card he had just added from was still on the list —
   *      four rows for "Dana": one contact and three records, one of which he
   *      had already used and could not tell apart from the two he had not.
   *   2. `importedTwins` below hid it for the life of the component. Reopen the
   *      wizard, or open a different transaction, and that state is gone. A
   *      second press then made a SECOND Dana, and the two competed for the
   *      same records.
   *   3. THE ONE THAT NAMES THE BUG. The linker matched the unclaimed record to
   *      the contact on content and filed a `pending` duplicate proposal — so
   *      the app asked him whether Dana Whitlock is the same person as the card
   *      Dana Whitlock was made out of. A question with no meaningful answer.
   *
   * WHY THE REBUILD WAS THE CAUSE. This called `contactService.create` with a
   * payload assembled from seven named fields: name, email, phone, company,
   * source, allEmails, allPhones. `toSourceIdentities` reads
   * `externalRecordId`, `externalSourceType` and `externalUuid`
   * (`contactHandlers.ts:342-360`) — none of which were named, and all three of
   * which `contacts:get-available` puts on every row it emits. A payload that
   * does not carry the record's identity cannot produce a link to it, whatever
   * the handler on the other end does.
   *
   * THE FIX IS THE DOOR, NOT A NEW RULE. `contacts:import` already answers
   * this: `toSourceIdentities` reads the identity, `linkImportedContact` writes
   * the `source_id` row INSIDE `createContactsBatch`'s transaction
   * (BACKLOG-2496), the BACKLOG-2525 guard returns the incumbent when the
   * record is already claimed — by the RECORD, never by the name — and
   * `runContactLinkingNow` runs the duplicate pass while the user waits.
   * BACKLOG-2510 routed Clients & Contacts through the same door for the same
   * reason; read the comment block on `Contacts.tsx:639-706`, which states the
   * rule and names the fields a rebuild silently drops. This is that call, not
   * a copy of that rule.
   *
   * HANDING THE ROW OVER WHOLE IS THE LOAD-BEARING DETAIL. Any rebuild here
   * reintroduces the same defect for whichever field the next person forgets.
   *
   * DO NOT ADD A NAME COMPARISON. BACKLOG-2617 deleted one from
   * `contacts:create` because it attached the WRONG same-named person to a
   * deal on this very screen. Two different clients called "Chris Nguyen" are
   * two contacts because they are two records; the same record pressed twice is
   * one contact because it is one record.
   */
  const handleImportContact = useCallback(
    async (contact: ExtendedContact): Promise<ExtendedContact> => {
      // Check if contact is already in our DB by matching against the contacts list
      const isInDatabase = contacts.some(c => c.id === contact.id);
      const isExternalContact = !isInDatabase;

      if (isExternalContact) {
        /**
         * `is_message_derived` is a RENDERER BADGE, not part of the record.
         * `useContactDirectory` stamps it on every address-book row (:255-259)
         * purely so `ContactRow` can draw an "External" pill. Dropped here, at
         * the boundary, rather than by rebuilding the object — the same
         * destructure Clients & Contacts uses (`Contacts.tsx:721`), so the two
         * screens hand `contacts:import` the same shape.
         */
        const { is_message_derived: _listBadge, ...record } = contact;
        const result = await window.api.contacts.import(userId, [record]);
        const importedContact = result.contacts?.[0];

        if (result.success && importedContact) {
          const newContact = importedContact as ExtendedContact;
          // BACKLOG-2400: record the external-original -> imported-DB link so the
          // external twin (`contact.id`) is hidden from Available while its
          // imported twin (`newContact.id`) is selected — independent of whether
          // dedup can bridge them. Also supplies the Added chip's row DATA before
          // the silent refresh folds newContact into `contacts`. selectedContactIds
          // (single source of truth) gets the new DB id.
          //
          // BACKLOG-2638 KEPT THIS DELIBERATELY. The item body suggested it
          // "can probably go" once a real crosswalk row exists, and for the
          // suppression it is now redundant — `contacts:get-available` stops
          // offering the record the moment the link lands. It is NOT redundant
          // for the chip: the selection add below happens BEFORE
          // `onRefreshBothLists()` returns, and `addedContacts` resolves the
          // chip's row data through `augmentedContacts`, which reads exactly
          // this. Deleting it would leave the Added column blank for the width
          // of two IPC round trips.
          setImportedTwins((prev) =>
            prev.some((t) => t.imported.id === newContact.id)
              ? prev
              : [...prev, { externalId: contact.id, imported: newContact }]
          );
          /**
           * BACKLOG-2638 — GUARDED, BECAUSE A SECOND PRESS NOW RETURNS THE
           * CONTACT THAT ALREADY EXISTS.
           *
           * This was an unconditional append, which was safe only while every
           * press minted a new id. `contacts:import` returns the INCUMBENT when
           * the record is already claimed (BACKLOG-2525), and that id may
           * already be selected — appending it again would put the same contact
           * in `selectedContactIds` twice. The `addedContacts` projection
           * de-duplicates for display, so the chip column would look right
           * while the array underneath carried a phantom, which is the kind of
           * disagreement this two-pane was rebuilt to remove. Mirrors the
           * already-imported branch below.
           */
          if (!selectedContactIds.includes(newContact.id)) {
            onSelectedContactIdsChange([...selectedContactIds, newContact.id]);
          }
          /*
            BACKLOG-2631 — BOTH halves, because an import changes both.

            This awaited a saved-half-only reload. The import writes a crosswalk
            row for the record it saved, so the address-book half stops offering
            that record — and it was never re-read here. `importedTwins` above
            hid the twin by hand instead, per-action, which is the workaround
            this replaces the need for rather than removes: it still supplies the
            Added chip's row data in the window before the refresh lands.

            Clients & Contacts' import path has refreshed both halves since
            BACKLOG-2526; this is the same call.

            BACKLOG-2638: only true from this commit onwards. Until the call
            above became `contacts:import`, no crosswalk row was written and the
            address-book half had nothing to stop offering — the refresh
            re-fetched the record and put it straight back on the list.
          */
          await onRefreshBothLists();
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
    [userId, onRefreshBothLists, selectedContactIds, onSelectedContactIdsChange, contacts]
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
                      // BACKLOG-2461: see src/utils/contactDisplayLabel.ts.
                      const name = labelForContact(contact);
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
                /*
                  BACKLOG-2603 — the badge is the way into this contact's open
                  questions, and NOT the row click.

                  The row click here ADDS THE CONTACT TO THE TRANSACTION, which
                  is what this surface is for; `ContactSearchList` also derives
                  `isSelectionMode` from the absence of `onContactClick`, so
                  routing the questions through that prop would take add-mode
                  away with it. The badge — already the only thing on the row
                  that says a question exists — carries the click instead.

                  `showDetailLine` is deliberately still absent. The founder's
                  BACKLOG-2591 ruling (*"ON for linking, OFF for the transaction
                  picker"*) was about a per-row DETAIL LINE on every row; this is
                  a conditional badge on the minority of rows that owe an answer,
                  and it is the thing he asked for on this exact surface.
                */
                onOpenContactQuestions={(contact) => setQuestionsForContactId(contact.id)}
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

      {/*
        BACKLOG-2603 — THE SAME REVIEW SCREEN, FILTERED TO ONE CONTACT.

        The founder searched a contact with four outstanding questions in this
        wizard and had no way to reach them; in Clients & Contacts the same
        contact carries a badge that leads to this screen. So it is mounted here
        with the same `filterContactId` that surface uses — not a wizard-shaped
        copy of it. Answering here writes through the same path and is the same
        answer; that is `onResolved`'s whole job below.

        It renders at `z-[60]`, above this wizard's `z-50` shell, which is the
        same stacking it already relies on over the contact card.
      */}
      {questionsForContactId && (
        <ReviewDuplicatesModal
          userId={userId}
          filterContactId={questionsForContactId}
          onClose={() => setQuestionsForContactId(null)}
          /*
            SILENT, so answering does not blank the list the user is part-way
            through choosing from. The refresh is what moves the badge: the
            count lives on `review_state`, which is stamped by the same producer
            this re-reads, so an answered question leaves the row on its own
            rather than by a second rule kept in step by hand.

            BACKLOG-2631 — AND IT IS BOTH HALVES, WHICH IS THE REPORTED DEFECT.

            This called a saved-half-only reload. Answering "yes, same person"
            writes a `contact_source_links` row (`confirmProposal` ->
            `createLink`), and `contacts:get-available` suppresses on exactly
            that table — so the record the user just merged away should stop
            being offered. It did not: the address-book half was never asked
            again, and the merged-away record sat in the list AS A SELECTABLE ROW
            for the life of this modal. Madison could add, as a second party on
            the same deal, the person she had just said was the first one.
          */
          onResolved={() => {
            void onRefreshBothLists();
          }}
        />
      )}
    </div>
  );
}

export default ContactAssignmentStep;
