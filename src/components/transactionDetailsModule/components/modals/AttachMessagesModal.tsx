/**
 * AttachMessagesModal Component
 * Modal for browsing and attaching unlinked message threads to a transaction
 * Uses a contact-first approach for better performance with large message databases
 */
import React, { useState, useEffect, useMemo } from "react";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import {
  groupMessagesByThread,
  sortThreadsByRecent,
  type MessageLike,
} from "../MessageThreadCard";
import {
  mergeThreadsByContact,
  getContactMergeKey,
  getHandleMergeKey,
  mergeItemsByKey,
  type MergedThreadEntry,
} from "../../../../utils/threadMergeUtils";
import { formatDate } from "../../../../utils/formatUtils";

interface AttachMessagesModalProps {
  /** User ID to fetch unlinked messages for */
  userId: string;
  /** Transaction ID to attach messages to */
  transactionId: string;
  /** Optional property address for display */
  propertyAddress?: string;
  /** Callback when modal is closed */
  onClose: () => void;
  /**
   * Callback when messages are successfully attached.
   * BACKLOG-2390: receives the exact message ids that were linked so the caller
   * can offer an Undo that reverses precisely those ids.
   */
  onAttached: (attachedMessageIds: string[]) => void;
}

interface ContactInfo {
  contact: string;
  contactName: string | null;
  messageCount: number;
  lastMessageAt: string;
}

/**
 * BACKLOG-2263: a contact-merged roster entry. The raw contacts endpoint groups
 * by raw handle, so one person's +1/bare-phone/email handles arrive as separate
 * rows. We merge them by the SAME identity rule the attached list uses so the
 * picker shows ONE entry per contact; selecting it loads + attaches every handle.
 */
interface MergedContact {
  /** Contact-identity merge key (contact:/phone:/handle:). */
  key: string;
  /** Resolved contact name, or a formatted handle when unknown. */
  displayName: string;
  /** First raw handle — used for the header label and a stable test id. */
  primaryContact: string;
  /** Every raw handle that maps to this identity. */
  handles: string[];
  messageCount: number;
  lastMessageAt: string;
}

/**
 * Normalize phone number to digits only for comparison
 */
function normalizePhone(phone: string): string {
  if (phone.includes("@")) return phone.toLowerCase();
  const digits = phone.replace(/\D/g, "");
  // Remove leading 1 for US numbers to normalize 10 and 11 digit formats
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

/**
 * Format phone number for display
 */
function formatPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

/**
 * Get thread date range from messages
 */
function getThreadDateRange(messages: MessageLike[]): string {
  if (messages.length === 0) return "";

  const dates = messages
    .map(m => new Date(m.sent_at || m.received_at || 0).getTime())
    .filter(d => d > 0)
    .sort((a, b) => a - b);

  if (dates.length === 0) return "";

  const firstDate = new Date(dates[0]);
  const lastDate = new Date(dates[dates.length - 1]);

  const formatOpts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  const first = firstDate.toLocaleDateString(undefined, formatOpts);
  const last = lastDate.toLocaleDateString(undefined, formatOpts);

  // If same day, just show one date
  if (first === last) {
    return first;
  }
  return `${first} - ${last}`;
}

/**
 * Get all unique participants in a thread
 * Uses chat_members (actual group membership) when available,
 * falls back to collecting from/to from individual messages
 */
function getThreadParticipants(messages: MessageLike[], selectedContact: string): string[] {
  // First, try to get chat_members from any message (they all share the same chat)
  for (const msg of messages) {
    try {
      if (msg.participants) {
        const parsed = typeof msg.participants === 'string'
          ? JSON.parse(msg.participants)
          : msg.participants;

        // If chat_members exists, use it (authoritative group membership)
        if (parsed.chat_members && Array.isArray(parsed.chat_members)) {
          const members = new Set<string>(parsed.chat_members);
          members.delete(selectedContact);
          members.delete('me');
          // Normalize selected contact for comparison (handle +1 prefix)
          const selectedNormalized = normalizePhone(selectedContact);
          for (const m of members) {
            if (normalizePhone(m) === selectedNormalized) {
              members.delete(m);
            }
          }
          return Array.from(members);
        }
      }
    } catch {
      // Continue to next message
    }
  }

  // Fallback: use message direction to identify the OTHER person
  // For 1:1 chats, we need to identify who is NOT the user
  // - Inbound messages: `from` is the other person
  // - Outbound messages: `to` is the other person
  const participants = new Set<string>();

  for (const msg of messages) {
    try {
      if (msg.participants) {
        const parsed = typeof msg.participants === 'string'
          ? JSON.parse(msg.participants)
          : msg.participants;

        // Use message direction to identify the OTHER person
        if (msg.direction === 'inbound' && parsed.from) {
          const from = parsed.from;
          if (from !== 'me' && from !== 'unknown') {
            participants.add(from);
          }
        }
        if (msg.direction === 'outbound' && parsed.to) {
          const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
          toList.forEach((p: string) => {
            if (p && p !== 'me' && p !== 'unknown') {
              participants.add(p);
            }
          });
        }
      }
    } catch {
      // Skip malformed participants
    }
  }

  // Remove the selected contact from the list
  participants.delete(selectedContact);
  // Also try normalized phone comparison
  const selectedNormalized = normalizePhone(selectedContact);
  for (const p of participants) {
    if (normalizePhone(p) === selectedNormalized) {
      participants.delete(p);
    }
  }

  return Array.from(participants);
}

export function AttachMessagesModal({
  userId,
  transactionId,
  propertyAddress,
  onClose,
  onAttached,
}: AttachMessagesModalProps): React.ReactElement {
  // View state: "contacts" or "threads"
  const [view, setView] = useState<"contacts" | "threads">("contacts");

  // Contacts list state
  const [contacts, setContacts] = useState<ContactInfo[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  // All contacts for name resolution (includes contacts without unlinked messages)
  const [allContacts, setAllContacts] = useState<Array<{ phone: string; name: string }>>([]);
  // BACKLOG-2263: names resolved for the message handles themselves (phones AND
  // emails/Apple IDs) via the shared resolveHandles service — same source the
  // attached list uses — so cross-handle contacts merge into one roster entry.
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>({});

  // Selected contact state
  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [selectedContactName, setSelectedContactName] = useState<string | null>(null);
  // BACKLOG-2263: every raw handle of the selected (merged) contact — messages
  // are loaded across ALL of them so one picker entry covers all their threads.
  const [selectedHandles, setSelectedHandles] = useState<string[]>([]);

  // Threads state (for selected contact)
  const [threads, setThreads] = useState<Map<string, MessageLike[]>>(new Map());
  const [loadingThreads, setLoadingThreads] = useState(false);

  // Selection state
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());

  // Viewing thread messages state
  const [viewingThreadId, setViewingThreadId] = useState<string | null>(null);

  // UI state
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);

  // Load contacts on mount
  // PERF FIX (TASK-1112): Defer data load to allow loading UI to render first
  // This prevents UI freeze by ensuring the spinner is visible before any heavy operations
  useEffect(() => {
    // Ensure loading state is set synchronously before any async work
    setLoadingContacts(true);
    setError(null);

    // Use setTimeout to defer the actual data fetch
    // This allows the loading spinner to render before the main thread is blocked
    const timeoutId = setTimeout(() => {
      async function loadContacts() {
        try {
          // Load both message contacts and all contacts in parallel
          const [messageContactsResult, allContactsResult] = await Promise.all([
            window.api.transactions.getMessageContacts(userId) as Promise<{
              success: boolean;
              contacts?: ContactInfo[];
              error?: string;
            }>,
            // Get all contacts for name resolution
            window.api.contacts.getAll(userId) as Promise<{
              success: boolean;
              contacts?: Array<{ id: string; name?: string; phone?: string }>;
              error?: string;
            }>,
          ]);

          if (messageContactsResult.success && messageContactsResult.contacts) {
            setContacts(messageContactsResult.contacts);

            // BACKLOG-2263: resolve the message handles to contact names (same
            // shared resolver the attached list uses — handles phones AND emails)
            // so cross-handle rows collapse into one roster entry. Guarded: older
            // API shims / test harnesses may not expose resolveHandles.
            const resolveHandlesFn = window.api?.contacts?.resolveHandles;
            if (resolveHandlesFn) {
              const handles = messageContactsResult.contacts
                .map((c) => c.contact)
                .filter((h): h is string => !!h);
              if (handles.length > 0) {
                try {
                  const namesResult = await resolveHandlesFn(handles, userId);
                  if (namesResult.success && namesResult.names) {
                    setResolvedNames(namesResult.names);
                  }
                } catch {
                  // Non-fatal: fall back to phone-normalized / getAll resolution.
                }
              }
            }
          } else {
            setError(messageContactsResult.error || "Failed to load contacts");
          }

          // Build phone-to-name lookup from all contacts
          // BACKLOG-1547: Include allPhones (not just primary phone) for complete resolution
          if (allContactsResult.success && allContactsResult.contacts) {
            const phoneLookup: Array<{ phone: string; name: string }> = [];
            for (const c of allContactsResult.contacts) {
              if (!c.name) continue;
              // Add primary phone
              if (c.phone) {
                phoneLookup.push({ phone: c.phone, name: c.name });
              }
              // Add all additional phones from contact_phones table
              const allPhones = (c as { allPhones?: string[] }).allPhones;
              if (allPhones && Array.isArray(allPhones)) {
                for (const phone of allPhones) {
                  if (phone && phone !== c.phone) {
                    phoneLookup.push({ phone, name: c.name });
                  }
                }
              }
            }
            setAllContacts(phoneLookup);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load contacts");
        } finally {
          setLoadingContacts(false);
        }
      }
      loadContacts();
    }, 0);

    // Cleanup on unmount
    return () => clearTimeout(timeoutId);
  }, [userId]);

  // Load threads when contact is selected
  // PERF FIX (TASK-1112): Defer data load to allow loading UI to render first
  // BACKLOG-2263: a merged contact can have several raw handles; load messages
  // for EACH and union them (dedup by id) so one picker entry shows the whole
  // conversation — then mergeThreadsByContact collapses it to a single card.
  const selectedHandlesKey = selectedHandles.join("|");
  useEffect(() => {
    if (!selectedContact || selectedHandles.length === 0) return;

    // Ensure loading state is set synchronously
    setLoadingThreads(true);
    setError(null);

    // Use setTimeout to defer the fetch and allow loading UI to render
    const timeoutId = setTimeout(() => {
      async function loadContactMessages() {
        try {
          const results = await Promise.all(
            selectedHandles.map(
              (handle) =>
                window.api.transactions.getMessagesByContact(userId, handle) as Promise<{
                  success: boolean;
                  messages?: MessageLike[];
                  error?: string;
                }>
            )
          );

          const failure = results.find((r) => !r.success);
          if (failure) {
            setError(failure.error || "Failed to load messages");
            return;
          }

          // Union across handles, de-duplicating by message id (a group chat can
          // surface under more than one handle query).
          const byId = new Map<string, MessageLike>();
          for (const r of results) {
            for (const m of r.messages ?? []) {
              if (!byId.has(m.id)) byId.set(m.id, m);
            }
          }

          const grouped = groupMessagesByThread(Array.from(byId.values()));
          setThreads(grouped);
          setView("threads");
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load messages");
        } finally {
          setLoadingThreads(false);
        }
      }
      loadContactMessages();
    }, 0);

    // Cleanup on unmount or contact change
    return () => clearTimeout(timeoutId);
    // selectedHandlesKey collapses the selectedHandles array dep to a primitive.
  }, [userId, selectedContact, selectedHandlesKey]);

  // BACKLOG-2263: build the handle -> contact-name record consumed by the shared
  // identity helpers (getHandleMergeKey / mergeThreadsByContact). Mirrors the
  // attached list's map: original + normalized-phone + lowercased-email keys.
  const contactNamesRecord = useMemo(() => {
    const rec: Record<string, string> = {};
    const add = (handle: string | undefined | null, name: string | undefined | null) => {
      if (!handle || !name) return;
      rec[handle] = name;
      const isPhone = handle.startsWith("+") || /^\d[\d\s\-()]{6,}$/.test(handle);
      if (isPhone) {
        const normalized = handle.replace(/\D/g, "").slice(-10);
        if (normalized.length >= 7) rec[normalized] = name;
      }
      if (handle.includes("@")) rec[handle.toLowerCase()] = name;
    };
    // getAll contacts (phones only) + resolveHandles result (phones AND emails) +
    // any name carried on the message-contact rows themselves.
    for (const c of allContacts) add(c.phone, c.name);
    for (const [handle, name] of Object.entries(resolvedNames)) add(handle, name);
    for (const c of contacts) add(c.contact, c.contactName);
    return rec;
  }, [allContacts, resolvedNames, contacts]);

  // Resolve a raw handle to its display name (falls back to a formatted handle).
  const resolveDisplayName = (handle: string): string => {
    const direct = contactNamesRecord[handle];
    if (direct) return direct;
    const normalized = handle.replace(/\D/g, "").slice(-10);
    if (normalized && contactNamesRecord[normalized]) return contactNamesRecord[normalized];
    if (handle.includes("@")) {
      const lower = contactNamesRecord[handle.toLowerCase()];
      if (lower) return lower;
    }
    return formatPhoneNumber(handle);
  };

  // BACKLOG-2263: contact-merge the raw handle rows into one entry per identity.
  const mergedContacts = useMemo(() => {
    const seeded: MergedContact[] = contacts.map((c) => ({
      key: getHandleMergeKey(c.contact, contactNamesRecord),
      displayName: resolveDisplayName(c.contact),
      primaryContact: c.contact,
      handles: [c.contact],
      messageCount: c.messageCount,
      lastMessageAt: c.lastMessageAt,
    }));
    return mergeItemsByKey(
      seeded,
      (m) => m.key,
      (existing, incoming) => ({
        ...existing,
        handles: [...existing.handles, ...incoming.handles],
        messageCount: existing.messageCount + incoming.messageCount,
        lastMessageAt:
          existing.lastMessageAt >= incoming.lastMessageAt
            ? existing.lastMessageAt
            : incoming.lastMessageAt,
      })
    );
    // Depends on contacts + contactNamesRecord (resolveDisplayName closes over both).
  }, [contacts, contactNamesRecord]);

  // Filter merged contacts by search (name or any handle)
  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return mergedContacts;
    const query = searchQuery.toLowerCase();
    return mergedContacts.filter(
      (c) =>
        c.displayName.toLowerCase().includes(query) ||
        c.handles.some(
          (h) =>
            h.toLowerCase().includes(query) ||
            formatPhoneNumber(h).toLowerCase().includes(query)
        )
    );
  }, [mergedContacts, searchQuery]);

  // Sort threads by recent
  const sortedThreads = useMemo(() => {
    return sortThreadsByRecent(threads);
  }, [threads]);

  // BACKLOG-2263: collapse the selected contact's threads into one entry per
  // conversation — the SAME merge the attached list performs (surface-of-truth).
  const mergedThreads: MergedThreadEntry[] = useMemo(
    () => mergeThreadsByContact(sortedThreads, contactNamesRecord),
    [sortedThreads, contactNamesRecord]
  );

  // BACKLOG-2263: the read-only viewer targets a merged entry (its displayKey),
  // so pull the merged entry's FULL message set — not a single raw thread.
  const viewingMessages = useMemo(
    () =>
      viewingThreadId
        ? mergedThreads.find(([key]) => key === viewingThreadId)?.[1] ?? null
        : null,
    [viewingThreadId, mergedThreads]
  );

  // Create a phone-to-name lookup map for resolving participant names
  const phoneToNameMap = useMemo(() => {
    const map = new Map<string, string>();
    // First add from all contacts (comprehensive list)
    for (const c of allContacts) {
      map.set(normalizePhone(c.phone), c.name);
    }
    // Then add from message contacts (may have more accurate names)
    for (const c of contacts) {
      if (c.contactName) {
        map.set(normalizePhone(c.contact), c.contactName);
      }
    }
    return map;
  }, [contacts, allContacts]);

  // Resolve phone number to name if available
  const resolveParticipantName = (phone: string): string => {
    const normalized = normalizePhone(phone);
    const name = phoneToNameMap.get(normalized);
    return name || formatPhoneNumber(phone);
  };

  const handleSelectContact = (merged: MergedContact) => {
    setSelectedContact(merged.primaryContact);
    setSelectedContactName(merged.displayName);
    setSelectedHandles(merged.handles);
    setSelectedThreadIds(new Set());
  };

  const handleBackToContacts = () => {
    setView("contacts");
    setSelectedContact(null);
    setSelectedContactName(null);
    setSelectedHandles([]);
    setThreads(new Map());
    setSelectedThreadIds(new Set());
  };

  const handleToggleThread = (threadId: string) => {
    setSelectedThreadIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedThreadIds.size === mergedThreads.length) {
      setSelectedThreadIds(new Set());
    } else {
      setSelectedThreadIds(new Set(mergedThreads.map(([id]) => id)));
    }
  };

  const handleAttach = async () => {
    if (selectedThreadIds.size === 0) return;

    setAttaching(true);
    setError(null);
    try {
      // BACKLOG-2263: attach EVERY constituent thread's messages for each selected
      // (merged) conversation. The merged entry already carries the union of its
      // threads' messages, so one selected card links all its raw threads.
      const messageIds: string[] = [];
      const seen = new Set<string>();
      for (const [displayKey, messages] of mergedThreads) {
        if (!selectedThreadIds.has(displayKey)) continue;
        for (const m of messages) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            messageIds.push(m.id);
          }
        }
      }

      const result = await window.api.transactions.linkMessages(
        messageIds,
        transactionId,
      );

      if (result.success) {
        onAttached(messageIds);
        onClose();
      } else {
        setError(result.error || "Failed to attach messages");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to attach messages");
    } finally {
      setAttaching(false);
    }
  };

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[70]" testId="attach-messages-modal" panelClassName="max-w-3xl sm:max-h-[80vh]">
        {/* Header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-green-500 to-teal-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg">
          {/* Mobile */}
          <div className="sm:hidden flex items-center justify-between">
            <button
              onClick={view === "threads" ? handleBackToContacts : onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
              data-testid={view === "threads" ? "back-button" : "close-modal-button"}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
            <h3 className="text-lg font-bold text-white">
              {view === "contacts"
                ? "Select Contact"
                : selectedContactName || formatPhoneNumber(selectedContact || "")}
            </h3>
          </div>
          {/* Desktop */}
          <div className="hidden sm:flex items-center justify-between">
            <div className="flex items-center gap-3">
              {view === "threads" && (
                <button
                  onClick={handleBackToContacts}
                  className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
                  data-testid="back-button"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}
              <div>
                <h3 className="text-lg font-bold text-white">
                  {view === "contacts"
                    ? "Select Contact"
                    : selectedContactName || formatPhoneNumber(selectedContact || "")}
                </h3>
                <p className="text-green-100 text-sm">
                  {propertyAddress
                    ? `Link chats to ${propertyAddress}`
                    : view === "contacts"
                    ? "Choose a contact to view their chats"
                    : "Select chats to attach to this transaction"}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
              data-testid="close-modal-button"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Search Bar (contacts view only) */}
        {view === "contacts" && (
          <div className="flex-shrink-0 p-2 sm:p-4 border-b border-gray-200">
            <div className="relative">
              <input
                type="text"
                placeholder="Search by name or phone number..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 text-gray-900 bg-white min-h-[44px]"
                data-testid="search-input"
              />
              <svg
                className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            {filteredContacts.length > 0 && (
              <p className="text-sm text-gray-600 mt-2">
                {filteredContacts.length} contact{filteredContacts.length !== 1 ? "s" : ""} with unlinked messages
              </p>
            )}
          </div>
        )}

        {/* Threads view controls */}
        {view === "threads" && mergedThreads.length > 0 && (
          <div className="flex-shrink-0 p-4 border-b border-gray-200 flex items-center justify-between">
            <span className="text-sm text-gray-600">
              {mergedThreads.length} chat{mergedThreads.length !== 1 ? "s" : ""} found
            </span>
            <button
              onClick={handleSelectAll}
              className="text-sm text-green-600 hover:text-green-700 font-medium"
              data-testid="select-all-button"
            >
              {selectedThreadIds.size === mergedThreads.length ? "Deselect All" : "Select All"}
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-2 sm:p-4">
          {/* Loading */}
          {(loadingContacts || loadingThreads) && (
            <div className="text-center py-12">
              <div className="w-8 h-8 border-4 border-green-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
              <p className="text-gray-500 mt-4">
                {loadingContacts ? "Loading contacts..." : "Loading chats..."}
              </p>
            </div>
          )}

          {/* Error */}
          {error && !loadingContacts && !loadingThreads && (
            <div className="text-center py-12">
              <svg className="w-16 h-16 text-red-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-red-600 mb-2">{error}</p>
            </div>
          )}

          {/* Contacts List */}
          {view === "contacts" && !loadingContacts && !error && (
            <>
              {filteredContacts.length === 0 ? (
                <div className="text-center py-12">
                  <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                  <p className="text-gray-600 mb-2">
                    {searchQuery ? "No matching contacts found" : "No contacts with unlinked messages"}
                  </p>
                </div>
              ) : (
                <div className="grid gap-2">
                  {filteredContacts.map((contact) => {
                    // Whether the display name is a resolved contact name (vs a
                    // formatted handle) — decides if we show a handle subtitle.
                    const hasName =
                      contact.displayName !== formatPhoneNumber(contact.primaryContact);
                    return (
                    <button
                      key={contact.key}
                      onClick={() => handleSelectContact(contact)}
                      className="text-left w-full max-w-full min-w-0 overflow-hidden p-3 sm:p-4 rounded-lg border border-gray-200 bg-white hover:border-green-300 hover:bg-green-50 transition-all"
                      data-testid={`contact-${contact.primaryContact}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gradient-to-br from-green-500 to-teal-600 rounded-full items-center justify-center text-white font-bold flex-shrink-0 hidden sm:flex">
                          {hasName ? contact.displayName.charAt(0).toUpperCase() : "#"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold text-gray-900 truncate">
                              {contact.displayName}
                            </h4>
                            <span className="inline-block px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full flex-shrink-0">
                              {contact.messageCount} {contact.messageCount === 1 ? "msg" : "msgs"}
                            </span>
                          </div>
                          <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-0 text-xs text-gray-500 mt-1">
                            {hasName && (
                              <span className="sm:mr-2">
                                {formatPhoneNumber(contact.primaryContact)}
                                {contact.handles.length > 1 && ` +${contact.handles.length - 1} more`}
                              </span>
                            )}
                            <span>Last: {formatDate(contact.lastMessageAt)}</span>
                          </div>
                        </div>
                        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Threads List */}
          {view === "threads" && !loadingThreads && !error && (
            <>
              {mergedThreads.length === 0 ? (
                <div className="text-center py-12">
                  <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <p className="text-gray-600 mb-2">No chats found with this contact</p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {mergedThreads.map(([threadId, messages]) => {
                    const isSelected = selectedThreadIds.has(threadId);
                    const otherParticipants = getThreadParticipants(messages, selectedContact || "");
                    const dateRange = getThreadDateRange(messages);

                    // Resolve names and deduplicate (same person may have multiple phones)
                    const uniqueParticipantNames = [...new Set(
                      otherParticipants.map(p => resolveParticipantName(p))
                    )];
                    // BACKLOG-2263: decide group-vs-1:1 with the SAME rule as the
                    // attached list — a null merge key means a real group chat.
                    // (A merged 1:1 spanning several handles must NOT be mislabeled
                    // a group just because it has multiple raw participant handles.)
                    const isGroup = getContactMergeKey(messages, contactNamesRecord) === null;

                    return (
                      <div
                        key={threadId}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleToggleThread(threadId)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleToggleThread(threadId); } }}
                        className={`text-left w-full max-w-full min-w-0 overflow-hidden p-3 sm:p-4 rounded-lg border sm:border-2 transition-all cursor-pointer ${
                          isSelected
                            ? "border-green-500 bg-green-50"
                            : "border-gray-200 bg-white hover:border-green-300 hover:bg-green-50"
                        }`}
                        data-testid={`thread-${threadId}`}
                      >
                        <div className="flex items-start gap-2 sm:gap-3">
                          {/* Checkbox */}
                          <div
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                              isSelected ? "bg-green-500 border-green-500" : "border-gray-300 bg-white"
                            }`}
                          >
                            {isSelected && (
                              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </div>

                          {/* Chat Icon — hidden on mobile */}
                          <div className={`w-10 h-10 rounded-full items-center justify-center flex-shrink-0 hidden sm:flex ${
                            isGroup ? "bg-purple-100" : "bg-blue-100"
                          }`}>
                            {isGroup ? (
                              <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                              </svg>
                            ) : (
                              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                              </svg>
                            )}
                          </div>

                          {/* Thread Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <h4 className="font-semibold text-gray-900 text-sm truncate">
                                {isGroup ? "Group Chat" : `Chat with ${selectedContactName || formatPhoneNumber(selectedContact || "")}`}
                              </h4>
                              {isGroup && (
                                <span className="inline-block px-2 py-0.5 bg-purple-100 text-purple-700 text-xs font-medium rounded-full flex-shrink-0">
                                  {uniqueParticipantNames.length + 1}
                                </span>
                              )}
                            </div>

                            {/* Other participants in group */}
                            {isGroup && uniqueParticipantNames.length > 0 && (
                              <p className="text-xs text-gray-500 mt-0.5 truncate">
                                {uniqueParticipantNames.slice(0, 3).join(", ")}
                                {uniqueParticipantNames.length > 3 && ` +${uniqueParticipantNames.length - 3} more`}
                              </p>
                            )}

                            {/* Metadata row */}
                            <div className="flex items-center justify-between mt-1.5 text-xs text-gray-500">
                              <div className="flex items-center gap-2">
                                <span>{messages.length} {messages.length === 1 ? "msg" : "msgs"}</span>
                                <span className="text-gray-400">•</span>
                                <span>{dateRange}</span>
                              </div>
                              {/* View button */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setViewingThreadId(threadId);
                                }}
                                className="text-blue-600 hover:text-blue-800 font-medium flex-shrink-0"
                                data-testid={`view-thread-${threadId}`}
                              >
                                View
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-3 sm:px-6 py-3 sm:py-4 bg-gray-50 rounded-b-xl flex items-center gap-3 justify-end sm:justify-between border-t border-gray-200">
          <span className="text-sm text-gray-600 hidden sm:inline">
            {view === "contacts" ? "Select a contact to view their chats" : selectedThreadIds.size > 0 ? `${selectedThreadIds.size} selected` : "Select chats to attach"}
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              disabled={attaching}
              className="hidden sm:block px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all disabled:opacity-50"
              data-testid="cancel-button"
            >
              Cancel
            </button>
            {view === "threads" && (
              <button
                onClick={handleAttach}
                disabled={selectedThreadIds.size === 0 || attaching}
                className={`px-6 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 ${
                  selectedThreadIds.size === 0 || attaching
                    ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                    : "bg-gradient-to-r from-green-500 to-teal-600 text-white hover:from-green-600 hover:to-teal-700 shadow-md hover:shadow-lg"
                }`}
                data-testid="attach-button"
              >
                {attaching ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Attaching...
                  </>
                ) : (
                  <>Attach {selectedThreadIds.size > 0 && `(${selectedThreadIds.size})`}</>
                )}
              </button>
            )}
          </div>
        </div>

      {/* Message Viewer Panel */}
      {viewingThreadId && viewingMessages && (
        <ResponsiveModal onClose={() => setViewingThreadId(null)} zIndex="z-[80]" overlayClassName="bg-black bg-opacity-50" panelBg="bg-gray-100" panelClassName="max-w-md sm:h-[600px] sm:rounded-2xl sm:overflow-hidden">
            {/* Phone-style header */}
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-3 flex items-center gap-3">
              <button
                onClick={() => setViewingThreadId(null)}
                className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div className="flex-1">
                <h4 className="text-white font-semibold">
                  {selectedContactName || formatPhoneNumber(selectedContact || "")}
                </h4>
                <p className="text-blue-100 text-xs">
                  {viewingMessages.length} messages
                </p>
              </div>
            </div>

            {/* Messages list - phone style */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {viewingMessages
                .slice()
                .sort((a, b) => new Date(a.sent_at || 0).getTime() - new Date(b.sent_at || 0).getTime())
                .map((msg) => {
                  const isOutbound = msg.direction === "outbound";
                  const msgText = msg.body_text || ("body" in msg ? (msg as { body?: string }).body : "") || "";
                  const msgTime = new Date(msg.sent_at || msg.received_at || 0);

                  return (
                    <div
                      key={msg.id}
                      className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                          isOutbound
                            ? "bg-blue-500 text-white rounded-br-md"
                            : "bg-white text-gray-900 rounded-bl-md shadow-sm"
                        }`}
                      >
                        <p className="text-sm whitespace-pre-wrap break-words">{msgText || "(No content)"}</p>
                        <p className={`text-xs mt-1 ${isOutbound ? "text-blue-100" : "text-gray-400"}`}>
                          {msgTime.toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* Footer */}
            <div className="bg-white border-t px-4 py-3 flex justify-center">
              <button
                onClick={() => setViewingThreadId(null)}
                className="px-6 py-2 bg-gray-200 hover:bg-gray-300 rounded-full text-sm font-medium text-gray-700 transition-all"
              >
                Close
              </button>
            </div>
        </ResponsiveModal>
      )}
    </ResponsiveModal>
  );
}
