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
 * Digits-only form of a phone number, for SEARCH matching (BACKLOG-2466).
 *
 * Applied SYMMETRICALLY: the same function normalises the STORED value and the
 * TYPED query, and the two are compared as substrings. Do not make one side
 * differ from the other.
 *
 * ## Why no "+", on either side
 *
 * BACKLOG-2466 says to preserve a leading "+". Doing so is at best inert and at
 * worst a re-introduction of the bug, so this drops it:
 *
 *  - On the HAYSTACK it cannot matter. A digits-only needle never contains a
 *    "+", so it can never span one: `("+" + digits).includes(needle)` is
 *    identical to `digits.includes(needle)` for every possible needle. Keeping
 *    the "+" would be decoration that reads as if it were load-bearing.
 *  - On the NEEDLE it is actively harmful. `formatPhoneNumber` below ADDS "+1"
 *    to any 11-digit number starting with 1, so a value stored "14155550100" —
 *    no plus — is DISPLAYED as "+1 (415) 555-0100". A user typing what the
 *    screen shows would carry a "+" the stored value never had, and the row
 *    would be unfindable by its own label. That is exactly the defect
 *    BACKLOG-2466 is about, relocated rather than fixed.
 *
 * ## Why "@" yields ""
 *
 * Apple IDs and other non-numeric handles live in phone columns. Reducing
 * "chat123456789@icloud.com" to "123456789" would let a query of "456" match it
 * as though it were a phone number. Those values are still matched by the plain
 * substring pass in `contactMatchesSearch`, which is where they belong.
 */
export function normalizePhoneForSearch(value: string | null | undefined): string {
  if (!value) return "";
  if (value.includes("@")) return "";
  return value.replace(/\D/g, "");
}

/** The characters a person actually types when writing a phone number. */
const PHONE_QUERY_CHARS = /^[+()\-.\s\d]+$/;

/**
 * Does this query look like someone typing a phone number? (BACKLOG-2466)
 *
 * Gates the NORMALISED phone comparison only — the plain substring pass runs for
 * every query regardless, so this can never remove a match that works today.
 *
 * Requires no letters and at least 3 digits. The letter rule is what keeps a
 * company called "415 Realty" on the name path; the 3-digit floor rejects "+",
 * "()" and a bare "1", a needle that would substring-match nearly every number
 * on file.
 *
 * "#" is deliberately NOT accepted: "#302" is an apartment number far more often
 * than an extension, and admitting it would send that query down the phone path
 * to match every number containing "302". Extensions need no special case
 * either — "+14155550134 x203" normalises to "14155550134203", which the
 * ordinary query "415 555-0134" still finds.
 */
export function looksLikePhoneQuery(query: string | null | undefined): boolean {
  const trimmed = (query || "").trim();
  if (!trimmed) return false;
  if (!PHONE_QUERY_CHARS.test(trimmed)) return false;
  return normalizePhoneForSearch(trimmed).length >= 3;
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
