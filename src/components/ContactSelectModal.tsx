import React, { useState, useRef, useEffect, useCallback } from "react";
import { ResponsiveModal, MODAL_PANEL } from "./common/ResponsiveModal";
import type { ExtendedContact } from "../types/components";
import { ImportContactsModal, ContactFormModal } from "./contact";
import { ContactPreview } from "./shared/ContactPreview";
import {
  assembleContacts,
  contactMatchesSearch,
  contactEmailKeys,
  contactPhoneKeys,
} from "../utils/contactPickerList";
import logger from '../utils/logger';

// Debounce delay for search (ms)
const SEARCH_DEBOUNCE_MS = 300;

// BACKLOG-2389: the two-pane (Available | Added) layout needs more horizontal room
// on desktop. Widen MODAL_PANEL.lg from max-w-4xl to max-w-5xl while preserving its
// height chain (sm:h-/sm:min-h-/sm:max-h-/sm:overflow-hidden) so ResponsiveModal's
// callerOwnsHeight detection stays true. max-w only affects sm+; mobile is
// full-screen (min-w-[100vw]) and therefore unaffected.
const TWO_PANE_PANEL_CLASS = MODAL_PANEL.lg.replace("max-w-4xl", "max-w-5xl");

interface ContactSelectModalProps {
  contacts: ExtendedContact[];
  excludeIds?: string[];
  multiple?: boolean;
  onSelect: (contacts: ExtendedContact[]) => void;
  onClose: () => void;
  propertyAddress?: string;
  /** Initial contact IDs to pre-select when modal opens */
  initialSelectedIds?: string[];
  /** User ID for importing contacts (optional - enables import button) */
  userId?: string;
  /** Callback to refresh contacts after import */
  onRefreshContacts?: () => void;
}

/**
 * Contact Select Modal
 * Reusable multi-select popup for choosing contacts
 *
 * Features:
 * - Single or multi-select mode
 * - Search by name, email, company or phone — via the shared `contactPickerList`
 *   engine, so every identity field and every stored number is covered and a
 *   phone number matches in the formats people actually type (BACKLOG-2467)
 * - Shows property address relevance badges
 * - Displays last communication date
 * - Two-pane add/remove selection (Available | Added) with visual feedback
 */
// LocalStorage key for toggle persistence
const SHOW_MESSAGE_CONTACTS_KEY = "contactModal.showMessageContacts";

/** Lowercased, trimmed display name (display_name -> name). "" when empty. */
function normalizedDisplayName(contact: ExtendedContact): string {
  return (contact.display_name || contact.name || "").trim().toLowerCase();
}

/**
 * BACKLOG-2467 — drop the message-derived search results that merely NAME a
 * contact already on screen.
 *
 * ## The row this exists for
 *
 * `searchContactsForSelection`'s message-derived half emits rows whose only
 * identity is a name. Its WHERE excludes `%@%`, so `email` is always NULL, and
 * the CASE puts the raw sender handle — a name on that path, since `+…` and
 * digit-leading handles are excluded too — into `phone`. `contactPhoneKeys`
 * reduces that to `""`, so the row claims no email key and no phone key, and
 * nothing upstream can collapse it. An imported contact and a message row
 * bearing their own name both render: the same person twice, on the screen where
 * you attach a party to a deal under audit.
 *
 * ## Why this is HERE and not in the shared engine
 *
 * The obvious fix is to let the engine claim every keeper's name. It was tried,
 * and SR measured what it costs: on `ContactSearchList`'s call the second
 * argument is `externalContacts` — macOS / Outlook / Android address-book cards.
 * A name-only card there has a source pill and an id the user can select and
 * assign, so dropping it hides a REACHABLE record. That is the BACKLOG-2316
 * failure mode.
 *
 * BACKLOG-2370 settled that open question in the other direction and by
 * subtraction: the founder removed the shared engine's identity matching
 * outright, so there is no engine name rule left to widen. This surface-scoped
 * rule is now the ONLY row-hiding the renderer does, and it survives review
 * precisely because of the narrowing below — it acts on rows that are search
 * OUTPUT, cannot be selected, and cannot be acted on.
 *
 * The narrowing that makes this safe is `is_message_derived`. These rows are
 * search OUTPUT, not address-book records: they are not selectable
 * (BACKLOG-2491), they carry no detail beyond the name, and they are already
 * hidden by default behind the "Include message contacts" toggle. Nothing the
 * user could act on is lost.
 *
 * ## The three predicates are not equally load-bearing — say so
 *
 * A row is dropped only when it is message-derived AND claims no email key and
 * no phone key of its own AND its name matches a kept contact. SR dropped each
 * in turn and measured what broke:
 *
 *  - `is_message_derived` — LOAD-BEARING, and pinned by
 *    `keeps a token-less IMPORTED contact that shares a name with a local one`.
 *    The IMPORTED half of the same query projects `ce_primary.email` and
 *    `cp_primary.phone_e164`, both NULL for a contact with no emails and no
 *    phones on file. That row is token-less exactly like a message row, but it
 *    is a genuine `contacts` record beyond the ~200-row prop and may simply be
 *    a DIFFERENT person with the same name. Without this predicate the rule
 *    hides them — the failure this surface-scoped fix exists to avoid.
 *  - the two token-key checks — INSURANCE, not narrowing, and deliberately
 *    untested. Given `is_message_derived = 1` the message SQL's WHERE already
 *    excludes `%@%`, `+%` and digit-leading handles, so no row the producer can
 *    emit reaches them. They guard a future change to that SQL; pinning them
 *    would mean fabricating a row the producer cannot emit.
 *  - the name match — pinned by
 *    `keeps a message-derived row that names someone NOT already on screen`.
 *
 * Anything with a stronger token is simply kept. Since BACKLOG-2370 the
 * renderer decides no identities at all — `assembleContacts` de-overlaps the
 * union on `id` and nothing else.
 */
function dropMessageDerivedNameEchoes(
  kept: ExtendedContact[],
  incoming: ExtendedContact[],
): ExtendedContact[] {
  const keptNames = new Set(kept.map(normalizedDisplayName).filter(Boolean));
  if (keptNames.size === 0) return incoming;

  return incoming.filter((contact) => {
    if (!(contact.is_message_derived === 1 || contact.is_message_derived === true)) return true;
    if (contactEmailKeys(contact).length > 0) return true;
    if (contactPhoneKeys(contact).length > 0) return true;
    const name = normalizedDisplayName(contact);
    return !(name && keptNames.has(name));
  });
}

function ContactSelectModal({
  contacts,
  excludeIds = [],
  multiple = false,
  onSelect,
  onClose,
  propertyAddress,
  initialSelectedIds = [],
  userId,
  onRefreshContacts,
}: ContactSelectModalProps) {
  const [searchQuery, setSearchQuery] = React.useState("");
  const [showImportModal, setShowImportModal] = useState(false);
  const [showAddContactModal, setShowAddContactModal] = useState(false);
  // Contact preview state
  const [previewContact, setPreviewContact] = useState<ExtendedContact | null>(null);
  // Track IDs to auto-select after import (cleared once contacts refresh)
  const [pendingAutoSelectIds, setPendingAutoSelectIds] = useState<string[]>([]);

  // Toggle for showing message-derived contacts (default: hide them)
  const [showMessageContacts, setShowMessageContacts] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(SHOW_MESSAGE_CONTACTS_KEY);
      return stored === "true";
    } catch {
      return false;
    }
  });

  // TASK-1954: Source filter for contact selection
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  // Persist toggle state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(SHOW_MESSAGE_CONTACTS_KEY, String(showMessageContacts));
    } catch {
      // Ignore localStorage errors
    }
  }, [showMessageContacts]);

  // Database search state
  const [searchResults, setSearchResults] = useState<ExtendedContact[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced database search
  const performDatabaseSearch = useCallback(async (query: string) => {
    if (!userId) {
      setSearchResults(null);
      return;
    }

    // For short queries, clear search results and use client-side filter
    if (query.length < 2) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    try {
      // Use the contacts:search IPC handler via the bridge
      // Type assertion needed because window.d.ts types may be out of sync with contactBridge
      const contactsApi = window.api.contacts as unknown as {
        searchContacts: (userId: string, query: string) => Promise<{
          success: boolean;
          contacts?: ExtendedContact[];
          error?: string;
        }>;
      };
      const result = await contactsApi.searchContacts(userId, query);
      if (result.success && result.contacts) {
        setSearchResults(result.contacts);
      } else {
        // On error, fall back to client-side filtering
        setSearchResults(null);
      }
    } catch (error) {
      logger.error("Database search failed:", error);
      setSearchResults(null);
    } finally {
      setIsSearching(false);
    }
  }, [userId]);

  // Handle search input change with debounce
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);

    // Clear existing timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // Set new debounced search
    searchTimeoutRef.current = setTimeout(() => {
      performDatabaseSearch(value);
    }, SEARCH_DEBOUNCE_MS);
  }, [performDatabaseSearch]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  // Create a set of valid contact IDs for O(1) lookup
  const validContactIds = React.useMemo(
    () => new Set(contacts.map((c) => c.id)),
    [contacts]
  );

  // Filter initialSelectedIds to only include valid contact IDs
  const validInitialIds = React.useMemo(
    () => initialSelectedIds.filter((id) => validContactIds.has(id)),
    [initialSelectedIds, validContactIds]
  );

  const [selectedIds, setSelectedIds] = React.useState<string[]>(validInitialIds);

  // Sync selectedIds when initialSelectedIds prop changes (e.g., modal reopened with different selections)
  // Use join() to create a stable string key - avoids infinite loop from default [] creating new reference each render
  // NOTE: We intentionally use initialIdsKey (stable string) instead of initialSelectedIds (unstable array reference)
  const initialIdsKey = validInitialIds.join(',');
  React.useEffect(() => {
    setSelectedIds(validInitialIds);
  }, [initialIdsKey]);

  // Auto-select imported contacts once they appear in the contacts list
  // This runs after import completes and contacts are refreshed
  React.useEffect(() => {
    if (pendingAutoSelectIds.length > 0) {
      // Check which pending IDs are now available in the contacts list
      const idsToSelect = pendingAutoSelectIds.filter((id) =>
        validContactIds.has(id)
      );

      if (idsToSelect.length > 0) {
        // Add the imported contacts to selected (using Set to avoid duplicates)
        setSelectedIds((prev) => [...new Set([...prev, ...idsToSelect])]);
        // Clear pending IDs that were successfully selected
        setPendingAutoSelectIds((prev) =>
          prev.filter((id) => !validContactIds.has(id))
        );
      }
    }
  }, [pendingAutoSelectIds, validContactIds]);

  const availableContacts = contacts.filter((c) => !excludeIds.includes(c.id));

  // Helper to check if a contact is message-derived
  const isMessageDerived = (contact: ExtendedContact): boolean => {
    // is_message_derived can be number (1) or boolean (true)
    return contact.is_message_derived === 1 || contact.is_message_derived === true;
  };

  /**
   * SEARCH — the shared `contactPickerList` engine, not a local matcher.
   *
   * ## BACKLOG-2467
   *
   * This used to be a hand-rolled three-field filter over `name`, `email` and
   * `company`. No `phone`, no `allPhones`, no `display_name`, no `allEmails` —
   * so typing a phone number here found NOBODY, in any format, and a contact
   * whose name lives only in `display_name` was unsearchable by name too.
   *
   * BACKLOG-2466 fixed phone search on the Clients & Contacts screen, which runs
   * `contactMatchesSearch`. This screen never used that engine, which is exactly
   * how the two diverged: two matchers, one of which nobody remembered to fix.
   * Rather than patch a third into agreement, this surface now CALLS the shared
   * one, so it inherits display_name / allEmails / allPhones coverage and the
   * digit normalisation ("+1 (415) 806-4356", "415-806-4356" and "4158064356"
   * all find the same contact) — and inherits every future fix to it.
   *
   * ## Why the DB results are UNIONED, not re-filtered
   *
   * At 2+ characters the modal also asks the main process
   * (`searchContactsForSelection`), whose job is the pool BEYOND the ~200
   * contacts the `contacts` prop carries. Those result rows project only the
   * PRIMARY email and phone, so running them back through `contactMatchesSearch`
   * would DROP a legitimate hit that matched on a secondary email. So DB rows
   * are taken as-is and merged with the locally-matched rows.
   *
   * Local rows are authoritative in the merge: they carry `allPhones`,
   * `allEmails` and `address_mention_count`, and their ids are the ones
   * `handleConfirm` resolves against. `assembleContacts` de-overlaps the union
   * on `id`, which is all this union needs: the imported half of
   * `searchContactsForSelection` projects real `contacts.id` values — the same
   * ids the prop carries — so a contact present in both arrives literally twice.
   *
   * ## BACKLOG-2370 — what this used to call, and why it no longer does
   *
   * This was `assembleDedupedContacts`, which additionally collapsed rows it
   * judged to be the same person: on email, then on a shared phone with a
   * compatible name, then on name alone. That rule is gone from the renderer
   * entirely — it was the second of two answers to "are these the same person?",
   * it stored nothing, and it hid a record the main process had just
   * deliberately released (see `contactPickerList.assembleContacts`).
   *
   * Nothing regresses on THIS surface, and that is measured rather than argued.
   * Both halves of the union are `contacts` rows, so the only collapses it could
   * make between distinct ids were between two SAVED contacts — which is the
   * same hiding defect, on the screen where you attach a party to a deal. The
   * one shape the removed rule did usefully collapse here — a message-derived
   * row echoing a saved contact's name — it never collapsed by email or phone
   * anyway: the message SQL's WHERE excludes `%@%`, `+%` and digit-leading
   * handles, so those rows claim no email key and no phone key and were only
   * ever reachable by its name-only branch. `dropMessageDerivedNameEchoes` above
   * is what removes them, and it is both narrower and better targeted than the
   * branch that is gone. Both halves are pinned by tests built from the real SQL
   * projection.
   *
   * Net effect: strictly ADDITIVE. No query that finds a contact today can stop
   * finding one.
   */
  const filteredContacts = React.useMemo(() => {
    let result: ExtendedContact[];
    const query = searchQuery.trim();

    if (!query) {
      // No search query - use all available contacts
      result = availableContacts;
    } else {
      const localMatches = availableContacts.filter((c) =>
        contactMatchesSearch(c, query),
      );

      if (searchResults === null) {
        result = localMatches;
      } else {
        const dbMatches = searchResults.filter((c) => !excludeIds.includes(c.id));
        result = assembleContacts(
          localMatches,
          // BACKLOG-2467 — surface-local, and only for the one shape the engine
          // provably cannot collapse. See dropMessageDerivedNameEchoes.
          dropMessageDerivedNameEchoes(localMatches, dbMatches),
        );
      }
    }

    // Apply message-derived filter if toggle is off
    if (!showMessageContacts) {
      result = result.filter((c) => !isMessageDerived(c));
    }

    // TASK-1954: Apply source filter
    if (sourceFilter !== "all") {
      result = result.filter((c) => {
        const contactSource = (c.source ?? "").toLowerCase();
        // Map "sms" filter to include both "sms" and "messages" sources
        if (sourceFilter === "sms") {
          return contactSource === "sms" || contactSource === "messages";
        }
        return contactSource === sourceFilter;
      });
    }

    return result;
  }, [searchResults, searchQuery, availableContacts, excludeIds, showMessageContacts, sourceFilter]);

  // BACKLOG-2389: resolve selected IDs to contact objects for the "Added" pane.
  // Merge the contacts prop with any DB search results so a chip renders even for a
  // contact surfaced only by search. Display-only — handleConfirm keeps its original
  // contacts-prop resolution so the onSelect payload contract is unchanged.
  const contactById = React.useMemo(() => {
    const map = new Map<string, ExtendedContact>();
    for (const c of contacts) map.set(c.id, c);
    if (searchResults) {
      for (const c of searchResults) {
        if (!map.has(c.id)) map.set(c.id, c);
      }
    }
    return map;
  }, [contacts, searchResults]);

  // Added pane content: selected contacts, in selection order.
  const addedContacts = React.useMemo(
    () =>
      selectedIds
        .map((id) => contactById.get(id))
        .filter((c): c is ExtendedContact => Boolean(c)),
    [selectedIds, contactById],
  );

  // Available (left) pane shows filtered contacts NOT yet added. Adding moves a
  // contact to the Added pane; removing (✕) returns it here.
  const availableForDisplay = React.useMemo(
    () => filteredContacts.filter((c) => !selectedIds.includes(c.id)),
    [filteredContacts, selectedIds],
  );

  const handleAddContact = (contactId: string) => {
    if (multiple) {
      setSelectedIds((prev) =>
        prev.includes(contactId) ? prev : [...prev, contactId],
      );
    } else {
      // Single-select: adding replaces the current selection (radio-like).
      setSelectedIds([contactId]);
    }
  };

  const handleRemoveContact = (contactId: string) => {
    setSelectedIds((prev) => prev.filter((id) => id !== contactId));
  };

  const handleConfirm = () => {
    const selectedContacts = contacts.filter((c) => selectedIds.includes(c.id));
    onSelect(selectedContacts);
  };

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[70]" panelClassName={TWO_PANE_PANEL_CLASS}>
        {/* Header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-purple-500 to-pink-600 px-6 py-4 flex items-center justify-between rounded-t-xl">
          <div>
            <h3 className="text-lg font-bold text-white">
              {multiple ? "Select Contacts" : "Select Contact"}
            </h3>
            <p className="text-purple-100 text-sm">
              {selectedIds.length > 0
                ? `${selectedIds.length} selected`
                : "Choose from your contacts"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Search Bar */}
        <div className="flex-shrink-0 p-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search contacts by name, email, or phone..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
                autoFocus
              />
              {/* Search icon - shows spinner when searching */}
              {isSearching ? (
                <svg
                  className="w-5 h-5 text-purple-500 absolute left-3 top-1/2 -translate-y-1/2 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
              ) : (
                <svg
                  className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              )}
            </div>
            {/* Toggle for message-derived contacts */}
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none flex-shrink-0 whitespace-nowrap">
              <input
                type="checkbox"
                checked={showMessageContacts}
                onChange={(e) => setShowMessageContacts(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500 cursor-pointer"
              />
              <span>Include message contacts</span>
            </label>
            {/* Import Contacts Button */}
            {userId && (
              <button
                onClick={() => setShowImportModal(true)}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-all flex items-center gap-2 flex-shrink-0"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
                Import
              </button>
            )}
          </div>
        </div>

        {/* TASK-1954: Source Filter Pills */}
        <div className="flex-shrink-0 px-4 py-2 border-b border-gray-100 flex items-center gap-2 flex-wrap">
          {[
            { value: "all", label: "All Sources" },
            { value: "contacts_app", label: "Contacts App" },
            { value: "outlook", label: "Outlook" },
            { value: "email", label: "Email" },
            { value: "sms", label: "Message" },
            { value: "manual", label: "Manual" },
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSourceFilter(opt.value)}
              className={`px-3 py-1 text-xs rounded-full font-medium transition-all ${
                sourceFilter === opt.value
                  ? "bg-purple-500 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Two-pane body — Available (left / mobile bottom) + Added (right / mobile top tray).
            flex-col-reverse on mobile puts the Added chips tray on top; sm:flex-row
            switches to Available | Added side-by-side on desktop. */}
        <div className="flex-1 min-h-0 flex flex-col-reverse sm:flex-row overflow-hidden">
          {/* Available pane */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="hidden sm:block flex-shrink-0 px-4 pt-3 pb-1">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Available
              </h4>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:pt-2">
              {availableForDisplay.length === 0 ? (
                <div className="text-center py-12">
                  <svg
                    className="w-16 h-16 text-gray-300 mx-auto mb-4"
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
                  <p className="text-gray-600">
                    {searchQuery
                      ? "No matching contacts found"
                      : selectedIds.length > 0
                        ? "All contacts added"
                        : "No contacts available"}
                  </p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {availableForDisplay.map((contact) => (
                    <button
                      key={contact.id}
                      type="button"
                      onClick={() => handleAddContact(contact.id)}
                      aria-label={`Add ${contact.name}`}
                      data-testid={`add-contact-${contact.id}`}
                      className="text-left p-4 rounded-lg border-2 border-gray-200 bg-white hover:border-purple-300 hover:bg-purple-50 transition-all"
                    >
                      <div className="flex items-center gap-3">
                        {/* Avatar */}
                        <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-600 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0">
                          {contact.name?.charAt(0).toUpperCase() || "?"}
                        </div>

                        {/* Contact Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold text-gray-900 truncate">
                              {contact.name}
                            </h4>
                            {propertyAddress &&
                              (contact.address_mention_count ?? 0) > 0 && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 flex-shrink-0">
                                  <svg
                                    className="w-3 h-3 mr-1"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                                    />
                                  </svg>
                                  {contact.address_mention_count} related email
                                  {(contact.address_mention_count ?? 0) > 1 ? "s" : ""}
                                </span>
                              )}
                          </div>
                          <div className="text-sm text-gray-600 space-y-0.5">
                            {contact.company && (
                              <p className="truncate">{contact.company}</p>
                            )}
                            {contact.last_communication_at && (
                              <p className="text-xs text-gray-500">
                                Last contact:{" "}
                                {new Date(
                                  contact.last_communication_at,
                                ).toLocaleDateString()}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* View Details Button */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewContact(contact);
                          }}
                          className="flex-shrink-0 p-1.5 text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded-full transition-colors"
                          aria-label={`View details for ${contact.name}`}
                          data-testid={`view-contact-${contact.id}`}
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                            />
                          </svg>
                        </button>

                        {/* Add affordance (presentational — the whole row is the button) */}
                        <span className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-100 text-purple-700">
                          <svg
                            className="w-3.5 h-3.5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2.5}
                              d="M12 4v16m8-8H4"
                            />
                          </svg>
                          Add
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Added pane — desktop: right column · mobile: chips tray pinned on top */}
          <div className="flex-shrink-0 flex flex-col border-b border-gray-200 sm:border-b-0 sm:border-l sm:w-72 bg-gray-50">
            <div className="flex-shrink-0 px-4 pt-3 pb-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Added ({addedContacts.length})
              </h4>
            </div>
            <div className="px-4 pb-3 sm:pb-4 sm:flex-1 min-h-0 overflow-y-auto max-h-28 sm:max-h-none flex flex-wrap sm:flex-col sm:flex-nowrap gap-2 content-start">
              {addedContacts.length === 0 ? (
                <p className="text-sm text-gray-400 w-full">
                  {multiple
                    ? "No contacts added yet"
                    : "No contact selected yet"}
                </p>
              ) : (
                addedContacts.map((contact) => (
                  <div
                    key={contact.id}
                    data-testid={`added-contact-${contact.id}`}
                    className="flex items-center gap-2 bg-purple-100 text-purple-800 rounded-full sm:rounded-lg py-1 pl-1 pr-1 sm:w-full max-w-full"
                  >
                    <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {contact.name?.charAt(0).toUpperCase() || "?"}
                    </div>
                    <span className="text-sm font-medium truncate min-w-0 max-w-[10rem] sm:max-w-none sm:flex-1">
                      {contact.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveContact(contact.id)}
                      aria-label={`Remove ${contact.name}`}
                      data-testid={`remove-contact-${contact.id}`}
                      className="flex-shrink-0 p-1 rounded-full text-purple-500 hover:text-purple-900 hover:bg-purple-200 transition-colors"
                    >
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2.5}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 bg-gray-50 rounded-b-xl flex items-center gap-3 justify-end border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={selectedIds.length === 0}
            data-testid="confirm-add-button"
            className={`px-6 py-2 rounded-lg font-semibold transition-all ${
              selectedIds.length === 0
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-gradient-to-r from-purple-500 to-pink-600 text-white hover:from-purple-600 hover:to-pink-700 shadow-md hover:shadow-lg"
            }`}
          >
            Add {selectedIds.length > 0 && `(${selectedIds.length})`}
          </button>
        </div>

      {/* Contact Preview Modal */}
      {previewContact && (
        <ContactPreview
          contact={previewContact}
          isExternal={
            previewContact.is_message_derived === 1 ||
            previewContact.is_message_derived === true
          }
          transactions={[]}
          onEdit={() => setPreviewContact(null)}
          onClose={() => setPreviewContact(null)}
        />
      )}

      {/* Import Contacts Modal */}
      {showImportModal && userId && (
        <ImportContactsModal
          userId={userId}
          onClose={() => setShowImportModal(false)}
          onSuccess={(importedContactIds) => {
            setShowImportModal(false);
            // Store imported IDs for auto-selection after refresh
            setPendingAutoSelectIds(importedContactIds);
            // Refresh contacts list to include newly imported contacts
            onRefreshContacts?.();
          }}
          onAddManually={() => {
            // Close import modal and open contact form modal
            setShowImportModal(false);
            setShowAddContactModal(true);
          }}
        />
      )}

      {/* Add Contact Form Modal */}
      {showAddContactModal && userId && (
        <ContactFormModal
          userId={userId}
          contact={undefined}
          onClose={() => setShowAddContactModal(false)}
          onSuccess={() => {
            setShowAddContactModal(false);
            // Refresh contacts list to include newly created contact
            onRefreshContacts?.();
          }}
        />
      )}
    </ResponsiveModal>
  );
}

export default ContactSelectModal;
