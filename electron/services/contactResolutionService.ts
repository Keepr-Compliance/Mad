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
import { legacyDigitKey } from "../utils/phoneNormalization";
import type { Communication } from "../types/models";
// BACKLOG-2393: scoped support-access tracing. Both calls are no-ops unless a
// user has granted a support window covering the scope.
import { supportTrace } from "./supportAccess/trace";
// BACKLOG-2757: the "A or B" join lives with the naming rule it belongs to.
import { joinAmbiguousNames } from "./folderExport/threadContactLabel";

/**
 * Resolved participant entry with handle, resolved name, and type classification.
 */
export interface ResolvedParticipant {
  handle: string;
  name: string | null;
  type: "phone" | "email" | "appleid";
}

/**
 * Normalize phone number to last 10 digits for EXPORT RESOLUTION.
 * For email handles, returns lowercase as-is (don't strip non-digit chars).
 *
 * TASK-2027: Fixed to handle email handles correctly. The old version
 * stripped all non-digits, turning "quincypoe@example.com" into "" (empty string),
 * causing duplicate conversation PDFs and unresolved email participants in exports.
 *
 * BACKLOG-1729: Phone branch delegated to the canonical `toLookupKey`.
 *
 * ===========================================================================
 * BACKLOG-2630 slice 1 — DELIBERATELY NO LONGER `toLookupKey`. READ THIS
 * BEFORE "TIDYING" IT BACK.
 * ===========================================================================
 * This function's output is not compared against `phone_normalized`. It is
 * compared against a last-ten key that **SQL re-derives from `phone_e164` in
 * the query itself**, in two places:
 *
 *   - `attachmentDbService.getContactNamesByPhoneDigits` (:575-576) — called
 *     four lines below by `resolveHandles`
 *   - `exportUtils.getContactNamesByPhones` (:135-136)
 *
 * Both read `substr(replace(replace(replace(cp.phone_e164,'+',''),'-',''),' ',''), -10)`.
 * Nothing in either query touches the normalized column, so neither moved when
 * `toLookupKey` became the library's E.164 digits and migration v64 re-keyed the
 * stores. Had this branch followed `toLookupKey`, the JavaScript side would ask
 * for "14155550109" while SQL offered "4155550109" and every lookup would miss.
 *
 * The failure that would have produced is worth naming, because nothing would
 * have caught it: a party's NAME silently absent from an exported compliance
 * PDF, with type-check, lint and every unit test green — the export would still
 * be generated, just with a bare phone number where a person's name belongs.
 *
 * So this keeps the pre-2630 rule verbatim, via the shared `legacyDigitKey`
 * helper. It agrees with the SQL beside it, which is the only thing it has ever
 * had to agree with. If those two queries are ever changed to join on
 * `phone_normalized` (the BACKLOG-2621 treatment), this call moves back to
 * `toLookupKey` in the same commit — not before.
 *
 * The digit floor does NOT apply here either: this resolves message
 * participants for an export, and dropping a below-floor participant would
 * delete a row from the audit record rather than decline to guess at one.
 */
export function normalizePhone(phone: string): string {
  // If it looks like an email, don't strip non-digits
  if (phone.includes("@")) return phone.toLowerCase();
  return legacyDigitKey(phone.trim());
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
 * ===========================================================================
 * BACKLOG-2757 / BACKLOG-2758 — ONE HANDLE IS NOT ALWAYS ONE PERSON
 * ===========================================================================
 *
 * `resolvePhoneNames` used to return `Record<handle, name>` and build it with a
 * bare `result[norm] = row.display_name` inside the imported-contacts loop —
 * **no `if (!result[norm])` guard**, unlike the external-contacts loop below it.
 * `getContactNamesByPhoneDigits` returns every matching row, so when two saved
 * contacts shared a phone number, **the last row won**. SQLite yields rows in
 * rowid order, so "the last row" meant "whichever contact was inserted second",
 * and that name went onto the audit PDF and into a file name on disk.
 *
 * (Worth stating plainly because the ticket said otherwise: the phone collapse
 * was never a `LIMIT 1`. The only `LIMIT 1` in this path is the Apple-ID prefix
 * statement, which is a separate finding with a separate fix.)
 *
 * So resolution now returns TWO views of the same fact, built in one pass:
 *
 *   - `names`  — every alias key -> the decided label. For one match that is the
 *                name, exactly as before. For several it is "A or B".
 *   - `matches`— the same alias keys -> the distinct contact names behind that
 *                label, so a caller that must NOT print a name (the FILENAME)
 *                can tell an ambiguous handle from an unambiguous one.
 *
 * They share alias keys by construction because one loop writes both. Read
 * `matches` through `matchedNamesFor()`, never by direct indexing — that is the
 * one place that knows how a raw handle becomes a key.
 */
export interface HandleNameResolution {
  names: Record<string, string>;
  matches: Record<string, readonly string[]>;
}

/** Scope for an export-time lookup. See attachmentDbService for the semantics. */
export interface ResolutionScope {
  /** Hard filter: another user's contacts never resolve. */
  userId?: string | null;
  /** Preference, not a filter: in-transaction matches win over out-of. */
  transactionId?: string | null;
}

/**
 * The distinct contact names behind a handle's label, using the same key
 * fallback chain every consumer of `names` already uses.
 */
export function matchedNamesFor(
  resolution: HandleNameResolution | undefined,
  handle: string | null | undefined
): readonly string[] {
  if (!resolution || !handle) return [];
  const normalized = normalizePhone(handle);
  return (
    resolution.matches[normalized] ||
    resolution.matches[handle] ||
    resolution.matches[handle.toLowerCase()] ||
    []
  );
}

/**
 * The name a handle is called — the ONE function both surfaces that name a party
 * must call.
 *
 * BACKLOG-2758 finding 3: the broker-portal upload named parties from the macOS
 * AddressBook (`contactsService.getContactNames`) while the desktop PDF named
 * them from the `contacts` table. **The same transaction could be submitted to
 * the broker under one name and archived locally under another**, with nothing
 * that would ever notice. The AddressBook is still consulted — it is tier 3
 * inside `resolvePhoneNames` — but it is no longer a SEPARATE answer.
 *
 * The key chain here is the same one `getThreadContact` uses (normalized, then
 * raw, then lower-cased), so both sides read the same map the same way. Pinned
 * by `exportPartyNaming.parity.test.ts`.
 */
export function nameForHandle(
  resolution: HandleNameResolution | undefined,
  handle: string | null | undefined
): string | undefined {
  if (!resolution || !handle) return undefined;
  const normalized = normalizePhone(handle);
  return (
    resolution.names[normalized] ||
    resolution.names[handle] ||
    resolution.names[handle.toLowerCase()] ||
    undefined
  );
}

/** A single contact matching a handle, before the naming rule is applied. */
interface HandleMatch {
  contactId: string;
  name: string;
  linked: boolean;
}

/**
 * Turn every contact matching one handle into the names that handle is called.
 *
 * 1. **Transaction preference** — if ANY match is linked to the transaction
 *    being exported, the unlinked ones are dropped. They are not deleted from
 *    the world; they simply cannot out-name a party to this deal. A handle whose
 *    only match is unlinked still resolves, which is why this is a preference
 *    and not the hard filter BACKLOG-2758 first proposed: a hard filter would
 *    strip the name off every message participant who is not a formal
 *    `transaction_contacts` party, which is most of them.
 * 2. **Distinct by name** — two contact rows reading "Dana Alvarez" are one name
 *    and therefore NOT ambiguous. Ambiguity is about what we would print.
 * 3. **Declared order** — by name, then contact id. Never rowid, never insertion
 *    order. This is the property whose absence was the defect.
 *
 *    It is also guaranteed a second time, in SQL (`ORDER BY c.display_name
 *    COLLATE NOCASE, c.id`, attachmentDbService). That redundancy is measured,
 *    not assumed: removing EITHER one alone leaves every test green, and
 *    removing both reds three. Deleting one of them is therefore safe today and
 *    makes the other load-bearing tomorrow — read the control notes in
 *    exportThreadNaming-2757.test.ts before doing it.
 */
function namesForHandle(matches: HandleMatch[]): string[] {
  const linked = matches.filter((m) => m.linked);
  const scoped = linked.length > 0 ? linked : matches;

  const byName = new Map<string, HandleMatch>();
  for (const match of scoped) {
    const name = match.name.trim();
    if (!name) continue;
    const existing = byName.get(name);
    // Keep the lowest contact id for a repeated name so the tie-break is stable.
    if (!existing || match.contactId < existing.contactId) byName.set(name, match);
  }

  return Array.from(byName.values())
    .sort((a, b) => {
      const byLabel = a.name.localeCompare(b.name, "en");
      return byLabel !== 0 ? byLabel : a.contactId.localeCompare(b.contactId);
    })
    .map((m) => m.name);
}

/** Accumulates matches and the alias keys they should be readable under. */
class HandleAccumulator {
  private readonly entries = new Map<
    string,
    { aliases: Set<string>; matches: HandleMatch[]; seen: Set<string> }
  >();

  add(canonicalKey: string, aliases: string[], match: HandleMatch): void {
    let entry = this.entries.get(canonicalKey);
    if (!entry) {
      entry = { aliases: new Set(), matches: [], seen: new Set() };
      this.entries.set(canonicalKey, entry);
    }
    for (const alias of aliases) if (alias) entry.aliases.add(alias);
    // One contact reached through two stored formats of the same number is ONE
    // match, not two — otherwise every contact with both an E.164 and a display
    // form would look like a shared line.
    if (entry.seen.has(match.contactId)) return;
    entry.seen.add(match.contactId);
    entry.matches.push(match);
  }

  /** Write labels and match lists into the resolution, without overwriting a
   *  higher-priority source that already answered for a key. */
  drainInto(resolution: HandleNameResolution): void {
    for (const [, entry] of this.entries) {
      const names = namesForHandle(entry.matches);
      if (names.length === 0) continue;
      const label = joinAmbiguousNames(names);
      for (const alias of entry.aliases) {
        if (resolution.names[alias]) continue;
        resolution.names[alias] = label;
        resolution.matches[alias] = names;
      }
    }
  }
}

/**
 * Resolve phone numbers to contact names.
 * Two-source lookup: imported contacts DB + macOS Contacts fallback.
 *
 * Extracted from folderExportService.getContactNamesByPhonesAsync().
 */
export async function resolvePhoneNames(
  phones: string[],
  userId?: string,
  scope?: ResolutionScope
): Promise<HandleNameResolution> {
  const resolution: HandleNameResolution = { names: {}, matches: {} };
  if (phones.length === 0) return resolution;

  const result = resolution.names;

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

    const rows = databaseService.getContactNamesByPhoneDigits(normalizedPhones, {
      userId: scope?.userId ?? userId ?? null,
      transactionId: scope?.transactionId ?? null,
    });

    const acc = new HandleAccumulator();
    for (const row of rows) {
      if (!row.display_name) continue;
      const match = {
        contactId: row.contact_id,
        name: row.display_name,
        linked: Boolean(row.is_transaction_linked),
      };
      // Store under multiple key formats to handle E.164 vs raw digit mismatches
      // (BACKLOG-1083): Some paths store +1234567890, others 1234567890
      for (const stored of [row.phone_e164, row.phone_display]) {
        if (!stored) continue;
        const norm = normalizePhone(stored);
        if (!norm) continue;
        acc.add(norm, [norm, stored], match);
      }
    }
    acc.drainInto(resolution);
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

      // External contacts are already user-scoped by the query and carry no
      // transaction link, so every match here is peers with every other; the
      // "or" rule applies within this tier the same way. `drainInto` will not
      // overwrite a key the imported-contacts tier already answered.
      const acc = new HandleAccumulator();
      for (const row of rows) {
        if (!row.name || !row.phone) continue;
        const norm = normalizePhone(row.phone);
        if (!norm) continue;
        acc.add(norm, [norm, row.phone], {
          contactId: row.contact_id,
          name: row.name,
          linked: false,
        });
      }
      acc.drainInto(resolution);
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
          // One AddressBook entry per key — never ambiguous, but `matches` is
          // written alongside `names` so no key exists in one and not the other.
          const name = contactMap[key];
          result[normalized] = name;
          result[phone] = name;
          resolution.matches[normalized] = [name];
          resolution.matches[phone] = [name];
          // Also store under E.164 format for callers that look up with + prefix
          if (!phone.includes("@")) {
            const e164 = `+${digitsOnly.length === 10 ? "1" + digitsOnly : digitsOnly}`;
            result[e164] = name;
            resolution.matches[e164] = [name];
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

  return resolution;
}

/**
 * Resolve email addresses to contact names via the contact_emails table.
 *
 * NEW in TASK-2026: Enables resolution of iMessage email handles
 * (e.g., casey@icloud.com, quincypoe@example.com).
 */
export async function resolveEmailNames(
  emails: string[],
  userId?: string,
  scope?: ResolutionScope
): Promise<HandleNameResolution> {
  const resolution: HandleNameResolution = { names: {}, matches: {} };
  if (emails.length === 0) return resolution;

  const result = resolution.names;

  try {
    const lowerEmails = emails.map((e) => e.toLowerCase());

    const rows = databaseService.getContactNamesByEmails(lowerEmails, {
      userId: scope?.userId ?? userId ?? null,
      transactionId: scope?.transactionId ?? null,
    });

    const acc = new HandleAccumulator();
    for (const row of rows) {
      if (!row.display_name || !row.email) continue;
      // Also store original-case version for direct lookup
      const original = emails.find((e) => e.toLowerCase() === row.email);
      acc.add(row.email, original ? [row.email, original] : [row.email], {
        contactId: row.contact_id,
        name: row.display_name,
        linked: Boolean(row.is_transaction_linked),
      });
    }
    acc.drainInto(resolution);
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

      const acc = new HandleAccumulator();
      for (const row of rows) {
        if (!row.name || !row.email) continue;
        const lower = row.email.toLowerCase();
        const original = emails.find((e) => e.toLowerCase() === lower);
        acc.add(lower, original ? [lower, original] : [lower], {
          contactId: row.contact_id,
          name: row.name,
          linked: false,
        });
      }
      acc.drainInto(resolution);
    } catch (error) {
      logService.warn(
        "[ContactResolution] Failed to look up email names from external contacts",
        "ContactResolution",
        { error }
      );
    }
  }

  return resolution;
}

/**
 * Combined resolver: resolves any mix of phones, emails, and Apple IDs to names.
 *
 * Partitions handles by type, calls the appropriate resolver,
 * and merges results into a single map.
 */
export async function resolveHandles(
  handles: string[],
  userId?: string,
  scope?: ResolutionScope
): Promise<HandleNameResolution> {
  if (handles.length === 0) return { names: {}, matches: {} };

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
    resolvePhoneNames(phones, userId, scope),
    resolveEmailNames(emails, userId, scope),
  ]);

  const resolution: HandleNameResolution = {
    names: { ...phoneResults.names, ...emailResults.names },
    matches: { ...phoneResults.matches, ...emailResults.matches },
  };
  const result = resolution.names;

  // For Apple IDs (no @ and not a phone), try email prefix match
  // e.g., "janesmith" might match "janesmith@icloud.com" in contacts
  if (appleIds.length > 0) {
    try {
      for (const appleId of appleIds) {
        // Skip if empty
        if (!appleId || appleId.trim() === "") continue;

        // Try as email prefix: search contact_emails for emails starting with
        // this prefix. BACKLOG-2758 finding 2: the query now declares its winner
        // (lowest email, then lowest contact id) instead of taking whatever row
        // SQLite offered first, and is scoped to this user.
        const row = databaseService.getContactNameByAppleIdPrefix(
          appleId.toLowerCase(),
          { userId: scope?.userId ?? userId ?? null }
        );

        if (row?.display_name) {
          result[appleId] = row.display_name;
          resolution.matches[appleId] = [row.display_name];
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

  return resolution;
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
