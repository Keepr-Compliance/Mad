/**
 * Contact Resolution Service
 *
 * Shared service for resolving phone numbers, emails, and Apple IDs to contact names.
 * Extracted from folderExportService.ts (battle-tested export logic) to provide
 * unified resolution for both export and UI layers.
 *
 * Resolution sources (in priority order):
 * 1. App's imported contacts (contact_phones / contact_emails tables)
 * 2. External contacts (external_contacts table — iPhone, macOS, Outlook, Google)
 * 3. macOS Contacts database (AddressBook via contactsService)
 *
 * TASK-2026: Extract from export, share with UI, add email handle resolution.
 */

import databaseService from "./databaseService";
import { getContactNames } from "./contactsService";
import * as externalContactDb from "./db/externalContactDbService";
import logService from "./logService";
import { toLookupKey } from "../utils/phoneNormalization";
import type { Communication } from "../types/models";
// BACKLOG-2393: scoped support-access tracing. Both calls are no-ops unless a
// user has granted a support window covering the scope.
import { supportTrace } from "./supportAccess/trace";

/**
 * Resolved participant entry with handle, resolved name, and type classification.
 */
export interface ResolvedParticipant {
  handle: string;
  name: string | null;
  type: "phone" | "email" | "appleid";
}

/**
 * Normalize phone number to last 10 digits for matching.
 * For email handles, returns lowercase as-is (don't strip non-digit chars).
 *
 * TASK-2027: Fixed to handle email handles correctly. The old version
 * stripped all non-digits, turning "quincypoe@example.com" into "" (empty string),
 * causing duplicate conversation PDFs and unresolved email participants in exports.
 *
 * BACKLOG-1729: Phone branch now delegates to the canonical `toLookupKey`
 * from `phoneNormalization`. The email branch keeps the existing lowercase
 * behaviour (toLookupKey is a phone-only helper; emails reach this function
 * via the export-resolution path and require case-insensitive matching).
 */
export function normalizePhone(phone: string): string {
  // If it looks like an email, don't strip non-digits
  if (phone.includes("@")) return phone.toLowerCase();
  return toLookupKey(phone);
}

/**
 * Check if a string looks like a phone number.
 */
function isPhoneLike(s: string): boolean {
  return s.startsWith("+") || /^\d[\d\s\-()]{6,}$/.test(s);
}

/**
 * Check if a string looks like an email address.
 */
function isEmailLike(s: string): boolean {
  return s.includes("@");
}

/**
 * Classify a handle as phone, email, or Apple ID.
 */
function classifyHandle(handle: string): "phone" | "email" | "appleid" {
  if (isEmailLike(handle)) return "email";
  if (isPhoneLike(handle)) return "phone";
  // Has digits but doesn't look like phone or email -- could be Apple ID
  return "appleid";
}

/**
 * Resolve phone numbers to contact names.
 * Two-source lookup: imported contacts DB + macOS Contacts fallback.
 *
 * Extracted from folderExportService.getContactNamesByPhonesAsync().
 */
export async function resolvePhoneNames(
  phones: string[],
  userId?: string
): Promise<Record<string, string>> {
  if (phones.length === 0) return {};

  const result: Record<string, string> = {};

  // BACKLOG-2393: the "phone numbers not resolved to names" tickets could not be
  // answered because nothing recorded which source resolved what. Counting how
  // many of the *inputs* now have a name (rather than how many keys the map
  // holds — each hit writes several alias keys) is the only figure that means
  // anything to a reader.
  const countResolved = (): number =>
    phones.filter((p) => result[normalizePhone(p)] || result[p]).length;
  let afterImported = 0;
  let afterExternal = 0;

  // Source 1: App's imported contacts (contact_phones table)
  try {
    const normalizedPhones = phones.map((p) => normalizePhone(p));

    const rows = databaseService.getContactNamesByPhoneDigits(normalizedPhones);

    for (const row of rows) {
      if (row.display_name) {
        // Store under multiple key formats to handle E.164 vs raw digit mismatches
        // (BACKLOG-1083): Some paths store +1234567890, others 1234567890
        if (row.phone_e164) {
          const norm = normalizePhone(row.phone_e164);
          result[norm] = row.display_name;
          result[row.phone_e164] = row.display_name;
        }
        if (row.phone_display) {
          const norm = normalizePhone(row.phone_display);
          result[norm] = row.display_name;
          result[row.phone_display] = row.display_name;
        }
      }
    }
  } catch (error) {
    logService.warn(
      "[ContactResolution] Failed to look up phone names from imported contacts",
      "ContactResolution",
      { error }
    );
  }

  afterImported = countResolved();

  // Source 2: External contacts (iPhone, macOS, Outlook, Google)
  if (userId) {
    try {
      const normalizedPhones = phones.map((p) => normalizePhone(p));
      const rows = externalContactDb.getNamesByPhoneDigits(userId, normalizedPhones);

      for (const row of rows) {
        if (row.name && row.phone) {
          const norm = normalizePhone(row.phone);
          // Only set if not already resolved by a higher-priority source
          if (!result[norm]) {
            result[norm] = row.name;
          }
          if (!result[row.phone]) {
            result[row.phone] = row.name;
          }
        }
      }
    } catch (error) {
      logService.warn(
        "[ContactResolution] Failed to look up phone names from external contacts",
        "ContactResolution",
        { error }
      );
    }
  }

  afterExternal = countResolved();

  // Source 3: macOS Contacts database (AddressBook)
  try {
    const { contactMap } = await getContactNames();

    for (const phone of phones) {
      const normalized = normalizePhone(phone);
      const digitsOnly = phone.replace(/\D/g, "");

      // Skip if we already have a name
      if (result[normalized] || result[phone]) continue;

      // Try multiple key formats to match macOS contacts
      // (BACKLOG-1083): Also try E.164 format to handle +1 prefix variations
      const possibleKeys = [
        phone,
        normalized,
        digitsOnly,
        `+${digitsOnly}`,
        `+1${normalized}`,
        `1${normalized}`,
        normalized.slice(-10),
        digitsOnly.slice(-10),
        digitsOnly.slice(-11),
      ];

      for (const key of possibleKeys) {
        if (key && contactMap[key]) {
          result[normalized] = contactMap[key];
          result[phone] = contactMap[key];
          // Also store under E.164 format for callers that look up with + prefix
          if (!phone.includes("@")) {
            const e164 = `+${digitsOnly.length === 10 ? "1" + digitsOnly : digitsOnly}`;
            result[e164] = contactMap[key];
          }
          break;
        }
      }
    }
  } catch (error) {
    logService.warn(
      "[ContactResolution] Failed to look up phone names from macOS Contacts",
      "ContactResolution",
      { error }
    );
  }

  // BACKLOG-2393: in -> out (reason for the difference), the same shape as the
  // contacts funnel. A no-op outside a granted support window.
  const resolved = countResolved();
  supportTrace("contact-resolution", "resolve-phone-names", {
    attempted: phones.length,
    resolved,
    unresolved: phones.length - resolved,
    by_imported_contacts: afterImported,
    by_external_contacts: afterExternal - afterImported,
    by_macos_contacts: resolved - afterExternal,
    had_user_id: Boolean(userId),
  });

  // BACKLOG-2428: a second trace used to run here under a "contact-trace"
  // scope, dumping up to 200 raw unresolved handles. It was removed rather
  // than repaired. It claimed to follow one named contact through every stage,
  // but no contact picker existed anywhere in the app, so nobody could name
  // the individual; it fired only when resolution failed, which is not the
  // case it promised to answer; and it was the only place in support access
  // that recorded a person's identifying details.
  //
  // The counts above stay. They are the useful half, and they name nobody.

  return result;
}

/**
 * Resolve email addresses to contact names via the contact_emails table.
 *
 * NEW in TASK-2026: Enables resolution of iMessage email handles
 * (e.g., casey@icloud.com, quincypoe@example.com).
 */
export async function resolveEmailNames(
  emails: string[],
  userId?: string
): Promise<Record<string, string>> {
  if (emails.length === 0) return {};

  const result: Record<string, string> = {};

  try {
    const lowerEmails = emails.map((e) => e.toLowerCase());

    const rows = databaseService.getContactNamesByEmails(lowerEmails);

    for (const row of rows) {
      if (row.display_name && row.email) {
        result[row.email] = row.display_name;
        // Also store original-case version for direct lookup
        const original = emails.find(
          (e) => e.toLowerCase() === row.email
        );
        if (original && original !== row.email) {
          result[original] = row.display_name;
        }
      }
    }
  } catch (error) {
    logService.warn(
      "[ContactResolution] Failed to look up email names from contacts",
      "ContactResolution",
      { error }
    );
  }

  // External contacts (iPhone, macOS, Outlook, Google)
  if (userId) {
    try {
      const lowerEmails = emails.map((e) => e.toLowerCase());
      const rows = externalContactDb.getNamesByEmails(userId, lowerEmails);

      for (const row of rows) {
        if (row.name && row.email) {
          const lower = row.email.toLowerCase();
          if (!result[lower]) {
            result[lower] = row.name;
          }
          const original = emails.find((e) => e.toLowerCase() === lower);
          if (original && !result[original]) {
            result[original] = row.name;
          }
        }
      }
    } catch (error) {
      logService.warn(
        "[ContactResolution] Failed to look up email names from external contacts",
        "ContactResolution",
        { error }
      );
    }
  }

  return result;
}

/**
 * Combined resolver: resolves any mix of phones, emails, and Apple IDs to names.
 *
 * Partitions handles by type, calls the appropriate resolver,
 * and merges results into a single map.
 */
export async function resolveHandles(
  handles: string[],
  userId?: string
): Promise<Record<string, string>> {
  if (handles.length === 0) return {};

  // Partition by type
  const phones: string[] = [];
  const emails: string[] = [];
  const appleIds: string[] = [];

  for (const handle of handles) {
    if (!handle || handle.trim() === "") continue;
    const type = classifyHandle(handle);
    if (type === "phone") phones.push(handle);
    else if (type === "email") emails.push(handle);
    else appleIds.push(handle);
  }

  // Resolve in parallel
  const [phoneResults, emailResults] = await Promise.all([
    resolvePhoneNames(phones, userId),
    resolveEmailNames(emails, userId),
  ]);

  const result: Record<string, string> = {
    ...phoneResults,
    ...emailResults,
  };

  // For Apple IDs (no @ and not a phone), try email prefix match
  // e.g., "janesmith" might match "janesmith@icloud.com" in contacts
  if (appleIds.length > 0) {
    try {
      for (const appleId of appleIds) {
        // Skip if empty
        if (!appleId || appleId.trim() === "") continue;

        // Try as email prefix: search contact_emails for emails starting with this prefix
        const row = databaseService.getContactNameByAppleIdPrefix(appleId.toLowerCase());

        if (row?.display_name) {
          result[appleId] = row.display_name;
        }
      }
    } catch (error) {
      logService.warn(
        "[ContactResolution] Failed to resolve Apple ID handles",
        "ContactResolution",
        { error }
      );
    }
  }

  return result;
}

/**
 * Extract all unique participant handles from messages.
 * Collects from chat_members, from/to fields, and sender field.
 * Includes both phone numbers AND email handles (unlike the old extractAllPhones).
 */
export function extractParticipantHandles(
  messages: Array<Communication | Record<string, unknown>>
): string[] {
  const handles = new Set<string>();

  for (const msg of messages) {
    const comm = msg as Communication;

    // Add sender field
    if (comm.sender && comm.sender !== "me" && comm.sender !== "unknown") {
      handles.add(comm.sender);
    }

    // Parse participants JSON
    if (comm.participants) {
      try {
        const parsed =
          typeof comm.participants === "string"
            ? JSON.parse(comm.participants)
            : comm.participants;

        // chat_members (authoritative for group chats)
        if (parsed.chat_members && Array.isArray(parsed.chat_members)) {
          for (const member of parsed.chat_members) {
            if (member && member !== "me" && member !== "unknown" && member.trim() !== "") {
              handles.add(member);
            }
          }
        }

        // from field
        if (parsed.from && parsed.from !== "me" && parsed.from !== "unknown") {
          handles.add(parsed.from);
        }

        // to field
        if (parsed.to) {
          const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
          for (const p of toList) {
            if (p && p !== "me" && p !== "unknown") {
              handles.add(p);
            }
          }
        }
      } catch {
        // Skip invalid JSON
      }
    }
  }

  return Array.from(handles);
}

/**
 * Get group chat participants with resolved names.
 * Uses chat_members as the authoritative source (from Apple's chat_handle_join table).
 * Falls back to from/to extraction if chat_members unavailable.
 *
 * Extracted from folderExportService.getGroupChatParticipants().
 */
export async function resolveGroupChatParticipants(
  messages: Communication[],
  handleNameMap: Record<string, string>,
  userName?: string,
  userEmail?: string
): Promise<ResolvedParticipant[]> {
  const participantHandles = new Set<string>();
  let hasChatMembers = false;
  let userIdentifier: string | null = null;

  // First pass: look for chat_members (authoritative)
  for (const msg of messages) {
    try {
      if (msg.participants) {
        const parsed =
          typeof msg.participants === "string"
            ? JSON.parse(msg.participants)
            : msg.participants;

        // Use chat_members as authoritative source if available
        if (
          !hasChatMembers &&
          parsed.chat_members &&
          Array.isArray(parsed.chat_members) &&
          parsed.chat_members.length > 0
        ) {
          hasChatMembers = true;
          parsed.chat_members.forEach((member: string) =>
            participantHandles.add(member)
          );
        }

        // Extract user's identifier from outbound messages
        if (!userIdentifier && msg.direction === "outbound" && parsed.from) {
          userIdentifier = parsed.from;
        }
      }
    } catch {
      // Continue
    }
  }

  // Add user's identifier
  if (hasChatMembers) {
    participantHandles.add(userIdentifier || "me");
  }

  // Fallback: if no chat_members, extract from from/to
  if (!hasChatMembers) {
    for (const msg of messages) {
      try {
        if (msg.participants) {
          const parsed =
            typeof msg.participants === "string"
              ? JSON.parse(msg.participants)
              : msg.participants;

          if (parsed.from) {
            participantHandles.add(parsed.from);
          }
          if (parsed.to) {
            const toList = Array.isArray(parsed.to)
              ? parsed.to
              : [parsed.to];
            toList.forEach((p: string) => participantHandles.add(p));
          }
        }
      } catch {
        // Continue
      }
    }
  }

  // Convert to resolved participants
  return Array.from(participantHandles)
    .filter((handle) => {
      if (!handle || handle.trim() === "") return false;
      if (handle.toLowerCase().trim() === "unknown") return false;
      return true;
    })
    .map((handle) => {
      const lowerHandle = handle.toLowerCase().trim();
      const type = classifyHandle(handle);

      // Handle "me" -- this is the user
      if (lowerHandle === "me") {
        return { handle: "", name: userName || "You", type: "phone" as const };
      }

      // Try resolution from the pre-built map
      if (type === "phone") {
        const normalized = normalizePhone(handle);
        const name =
          handleNameMap[normalized] || handleNameMap[handle] || null;
        return { handle, name, type };
      }

      if (type === "email") {
        const name =
          handleNameMap[handle.toLowerCase()] ||
          handleNameMap[handle] ||
          null;
        return { handle, name, type };
      }

      // Apple ID: check if it matches the user's email prefix
      if (userName && userEmail) {
        const emailPrefix = userEmail.split("@")[0].toLowerCase();
        if (
          lowerHandle === userEmail.toLowerCase() ||
          lowerHandle === emailPrefix ||
          lowerHandle.includes(emailPrefix)
        ) {
          return { handle, name: userName, type: "appleid" as const };
        }
      }

      // Try direct lookup in map
      const name = handleNameMap[handle] || handleNameMap[lowerHandle] || null;
      return { handle, name: name || handle, type };
    });
}
