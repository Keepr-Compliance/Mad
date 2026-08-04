/**
 * Phone Normalization Utilities (Renderer-side)
 *
 * Pure functions for normalizing phone numbers and email handles
 * for contact lookup in the renderer process.
 *
 * TASK-2027: Extracted from MessageThreadCard.tsx, ConversationViewModal.tsx,
 * and TransactionMessagesTab.tsx to eliminate duplication.
 */

import type { Communication } from "../components/transactionDetailsModule/types";

/**
 * Union type for messages - can be from messages table or communications table.
 * Re-exported here so consumers don't need to import from MessageThreadCard.
 */
type MessageLike = Communication | {
  direction?: string;
  participants?: string | Record<string, unknown>;
  sender?: string;
  sent_at?: string | Date | null;
  received_at?: string | Date | null;
};

/**
 * Normalize phone for lookup (last 10 digits).
 * For email handles, returns lowercase as-is (don't strip non-digit chars).
 *
 * TASK-2026: Handles both phone numbers and email handles correctly.
 */
export function normalizePhoneForLookup(phone: string): string {
  // If it looks like an email, don't strip non-digits
  if (phone.includes("@")) return phone.toLowerCase();
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Format a phone number for human display — RENDERER MIRROR.
 *
 * ===========================================================================
 * MIRROR. CANONICAL COPY: `electron/utils/phoneNormalization.ts`
 * ===========================================================================
 * BACKLOG-2461. `tsconfig.electron.json` sets `rootDir: "./electron"`, so the
 * renderer cannot import the main-process copy (see
 * `electron/utils/contactDisplayLabel.ts` for the full reasoning). The two are
 * held together by `src/utils/__tests__/contactDisplayLabel.parity.test.ts`,
 * which loads both and asserts an identical string for every case.
 *
 * Read the canonical file for why international numbers keep "+" but are not
 * regrouped.
 *
 * NOTE: this is a DISPLAY formatter. For matching, use
 * `normalizePhoneForLookup` above — the two must never be swapped.
 */
export function formatPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return "";
  if (phone.includes("@")) return phone;

  const cleaned = phone.replace(/\D/g, "");

  if (cleaned.length === 11 && cleaned[0] === "1") {
    return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
  } else if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  } else if (cleaned.length === 7) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3)}`;
  }
  if (cleaned && phone.trim().startsWith("+")) {
    return `+${cleaned}`;
  }
  return cleaned || phone;
}

/**
 * Extract sender phone/handle from a message's participants.
 * Returns null for outbound messages (user sent it).
 */
export function getSenderPhone(msg: MessageLike): string | null {
  if (msg.direction === "outbound") return null; // Outbound = user sent it

  try {
    if (msg.participants) {
      const parsed =
        typeof msg.participants === "string"
          ? JSON.parse(msg.participants)
          : msg.participants;
      if (parsed.from) return parsed.from;
    }
  } catch {
    // Fall through
  }

  // Fallback to sender field if available
  if ("sender" in msg && msg.sender) {
    return msg.sender;
  }

  return null;
}

/**
 * Extract all unique participant handles from messages for contact lookup.
 * Collects phone numbers, email handles, and Apple IDs from:
 * - chat_members (authoritative for group chats)
 * - from/to fields
 * - sender field
 *
 * TASK-2026: Replaces the old extractAllPhones() which only collected phone-like handles.
 * TASK-2027: Extracted from TransactionMessagesTab.tsx.
 */
export function extractAllHandles(messages: MessageLike[]): string[] {
  const handles = new Set<string>();

  for (const msg of messages) {
    try {
      if (msg.participants) {
        const parsed =
          typeof msg.participants === "string"
            ? JSON.parse(msg.participants)
            : msg.participants;

        // chat_members (authoritative for group chats -- includes email handles)
        if (parsed.chat_members && Array.isArray(parsed.chat_members)) {
          for (const member of parsed.chat_members) {
            if (
              member &&
              member !== "me" &&
              member !== "unknown" &&
              member.trim() !== ""
            ) {
              handles.add(member);
            }
          }
        }

        if (parsed.from && parsed.from !== "me" && parsed.from !== "unknown") {
          handles.add(parsed.from);
        }
        if (parsed.to) {
          const toList = Array.isArray(parsed.to)
            ? parsed.to
            : [parsed.to];
          toList.forEach((p: string) => {
            if (p && p !== "me" && p !== "unknown") handles.add(p);
          });
        }
      }
    } catch {
      // Skip invalid JSON
    }

    // Also check sender field
    if (
      "sender" in msg &&
      msg.sender &&
      msg.sender !== "me" &&
      msg.sender !== "unknown"
    ) {
      handles.add(msg.sender);
    }
  }

  return Array.from(handles);
}
