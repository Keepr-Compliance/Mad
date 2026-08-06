/**
 * Thread Merge Utilities
 *
 * Merges duplicate 1:1 message threads from the same contact at the display layer.
 * When the same person texts via SMS, iMessage, or iCloud email, macOS creates
 * separate chats. This utility groups them into a single visual thread.
 *
 * TASK-2025: Display-layer only -- no database schema changes.
 *
 * @see BACKLOG-542, BACKLOG-748
 */

import type { MessageLike } from "../components/transactionDetailsModule/components/MessageThreadCard";

/**
 * A merged thread entry: [displayKey, messages[], originalThreadIds[]]
 * The displayKey is used for React keys and display.
 * originalThreadIds tracks which thread_ids were merged (needed for unlink).
 */
export type MergedThreadEntry = [string, MessageLike[], string[]];

/**
 * Get all unique non-"me" participants from a thread's messages.
 * Used to determine if a thread is 1:1 or group.
 */
function getExternalParticipants(messages: MessageLike[]): Set<string> {
  const participants = new Set<string>();

  for (const msg of messages) {
    try {
      if (msg.participants) {
        const parsed =
          typeof msg.participants === "string"
            ? JSON.parse(msg.participants)
            : msg.participants;

        // Collect from chat_members (authoritative for group chats)
        if (parsed.chat_members && Array.isArray(parsed.chat_members)) {
          parsed.chat_members.forEach((m: string) => {
            if (m && m !== "unknown") participants.add(m);
          });
        }

        // Also collect from from/to fields
        if (msg.direction === "inbound" && parsed.from) {
          if (parsed.from !== "me" && parsed.from !== "unknown") {
            participants.add(parsed.from);
          }
        }
        if (msg.direction === "outbound" && parsed.to) {
          const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
          toList.forEach((p: string) => {
            if (p && p !== "me" && p !== "unknown") participants.add(p);
          });
        }
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return participants;
}

/**
 * Normalize a phone number to last 10 digits for comparison.
 */
function normalizePhone(phone: string): string {
  if (phone.includes("@")) return phone.toLowerCase();
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Check if a string looks like a phone number.
 */
function isPhoneNumber(s: string): boolean {
  return s.startsWith("+") || /^\d[\d\s\-()]{6,}$/.test(s);
}

/**
 * Resolve a participant to a contact name using the contactNames map.
 * Returns the contact name or null if not found.
 * TASK-2026: Also handles email handles (e.g., quincypoe@example.com).
 */
function resolveContactName(
  participant: string,
  contactNames: Record<string, string>,
): string | null {
  // Direct lookup
  if (contactNames[participant]) {
    return contactNames[participant];
  }

  // Normalized phone lookup
  if (isPhoneNumber(participant)) {
    const normalized = normalizePhone(participant);
    for (const [phone, name] of Object.entries(contactNames)) {
      if (isPhoneNumber(phone) && normalizePhone(phone) === normalized) {
        return name;
      }
    }
  }

  // TASK-2026: Email handle lookup (case-insensitive)
  if (participant.includes("@")) {
    const lowerParticipant = participant.toLowerCase();
    if (contactNames[lowerParticipant]) {
      return contactNames[lowerParticipant];
    }
    for (const [handle, name] of Object.entries(contactNames)) {
      if (handle.toLowerCase() === lowerParticipant) {
        return name;
      }
    }
  }

  return null;
}

/**
 * Determine if a thread is a group chat based on unique resolved participants.
 * A thread with more than 1 unique external participant (after contact name dedup)
 * is a group chat.
 */
function isGroupThread(
  messages: MessageLike[],
  contactNames: Record<string, string>,
): boolean {
  const participants = getExternalParticipants(messages);

  // Resolve participants to contact names and deduplicate
  const resolvedNames = new Set<string>();
  for (const p of participants) {
    const name = resolveContactName(p, contactNames);
    if (name) {
      resolvedNames.add(name);
    } else {
      // No contact name found -- use the raw participant as identity
      resolvedNames.add(isPhoneNumber(p) ? normalizePhone(p) : p.toLowerCase().trim());
    }
  }

  return resolvedNames.size > 1;
}

/**
 * Resolve a SINGLE handle (phone number, email, or Apple ID) to its stable
 * contact-identity merge key. This is the atomic identity function shared by
 * every "group conversations by contact" surface (attached list, attach modal,
 * removed section) so they all bucket the same way.
 *
 * Key namespaces (mutually exclusive):
 *   - `contact:<name>`  when the handle resolves to a known contact name
 *   - `phone:<10digits>` for an unresolved phone number (format-insensitive)
 *   - `handle:<lower>`   for an unresolved email / Apple ID / other identifier
 *
 * Never returns null — a lone handle always has an identity. Group-vs-1:1 is
 * decided one level up (see getContactMergeKey / isGroupThread).
 *
 * BACKLOG-2263: extracted so AttachMessagesModal's contact roster and
 * RemovedMessagesSection reuse EXACTLY this bucketing instead of inventing
 * their own.
 */
export function getHandleMergeKey(
  handle: string,
  contactNames: Record<string, string>,
): string {
  const name = resolveContactName(handle, contactNames);
  if (name) {
    return `contact:${name.toLowerCase().trim()}`;
  }
  if (isPhoneNumber(handle)) {
    return `phone:${normalizePhone(handle)}`;
  }
  return `handle:${handle.toLowerCase().trim()}`;
}

/**
 * Get the merge key for a 1:1 thread.
 * Returns the resolved contact name, or a normalized phone/identifier if no contact found.
 * Returns null for group chats (should not be merged).
 *
 * BACKLOG-2263: exported so other conversation surfaces (removed section, attach
 * modal) can decide "same contact?" using the identical rule as the attached list.
 */
export function getContactMergeKey(
  messages: MessageLike[],
  contactNames: Record<string, string>,
): string | null {
  if (isGroupThread(messages, contactNames)) {
    return null; // Group chats are never merged
  }

  const participants = getExternalParticipants(messages);

  // For 1:1 threads, resolve the single external participant
  for (const p of participants) {
    return getHandleMergeKey(p, contactNames);
  }

  return null; // No participants found -- do not merge
}

/**
 * Merge a list of arbitrary items by a contact-identity key.
 *
 * Items whose key is `null` (group chats / unresolvable) are NEVER merged and
 * pass through unchanged, preserving their relative order after the merged
 * groups. Identical to the accumulation strategy inside mergeThreadsByContact,
 * generalised so the removed section (RemovedThread) and the attach modal's
 * contact roster (ContactInfo) reuse ONE code path.
 *
 * BACKLOG-2263.
 *
 * @param items - items to bucket
 * @param keyOf - returns the merge key for an item, or null to keep it separate
 * @param merge - folds an incoming item into the existing accumulator for a key
 * @returns merged items (merged groups first in first-seen order, then unmergeables)
 */
export function mergeItemsByKey<T>(
  items: T[],
  keyOf: (item: T) => string | null,
  merge: (existing: T, incoming: T) => T,
): T[] {
  const map = new Map<string, T>();
  const order: string[] = [];
  const unmergeable: T[] = [];

  for (const item of items) {
    const key = keyOf(item);
    if (key === null) {
      unmergeable.push(item);
      continue;
    }
    const existing = map.get(key);
    if (existing) {
      map.set(key, merge(existing, item));
    } else {
      map.set(key, item);
      order.push(key);
    }
  }

  return [...order.map((k) => map.get(k)!), ...unmergeable];
}

/**
 * Merge threads that belong to the same contact.
 *
 * Takes the sorted thread list (from sortThreadsByRecent) and a contactNames map,
 * and returns a new list where threads from the same contact are combined into one.
 *
 * Group chats are never merged.
 * Threads where the contact cannot be resolved are left as-is.
 *
 * Messages within merged threads are sorted chronologically (newest first,
 * matching the existing sort order from groupMessagesByThread).
 *
 * @param threads - Sorted thread entries from sortThreadsByRecent: [threadId, messages[]][]
 * @param contactNames - Map of phone/handle -> contact name (from getNamesByPhones)
 * @returns Merged thread entries with original thread IDs tracked
 */
export function mergeThreadsByContact(
  threads: [string, MessageLike[]][],
  contactNames: Record<string, string>,
): MergedThreadEntry[] {
  // Map from merge key -> accumulated merged thread data
  const mergeMap = new Map<
    string,
    {
      displayKey: string;
      messages: MessageLike[];
      threadIds: string[];
    }
  >();

  // Track insertion order for stable output
  const mergeOrder: string[] = [];

  // Result for threads that should not be merged (group chats, unresolvable)
  const unmergeable: MergedThreadEntry[] = [];

  for (const [threadId, messages] of threads) {
    const mergeKey = getContactMergeKey(messages, contactNames);

    if (mergeKey === null) {
      // Group chat or no participants -- leave as-is
      unmergeable.push([threadId, messages, [threadId]]);
      continue;
    }

    const existing = mergeMap.get(mergeKey);
    if (existing) {
      // Merge into existing entry
      existing.messages.push(...messages);
      existing.threadIds.push(threadId);
    } else {
      // New merge group
      mergeMap.set(mergeKey, {
        displayKey: threadId, // Use first thread's ID as display key
        messages: [...messages],
        threadIds: [threadId],
      });
      mergeOrder.push(mergeKey);
    }
  }

  // Build result: merged threads first (in original order), then unmergeable
  const result: MergedThreadEntry[] = [];

  for (const key of mergeOrder) {
    const entry = mergeMap.get(key)!;

    // Re-sort merged messages chronologically (newest first)
    entry.messages.sort((a, b) => {
      const dateA = new Date(a.sent_at || a.received_at || 0).getTime();
      const dateB = new Date(b.sent_at || b.received_at || 0).getTime();
      return dateB - dateA; // Newest first (matches existing sort order)
    });

    result.push([entry.displayKey, entry.messages, entry.threadIds]);
  }

  // Add unmergeable threads
  result.push(...unmergeable);

  // Re-sort all threads by most recent message (preserving the overall sort)
  result.sort(([, msgsA], [, msgsB]) => {
    const lastA = msgsA[0]; // Newest first within thread
    const lastB = msgsB[0];
    const dateA = new Date(lastA?.sent_at || lastA?.received_at || 0).getTime();
    const dateB = new Date(lastB?.sent_at || lastB?.received_at || 0).getTime();
    return dateB - dateA;
  });

  return result;
}
