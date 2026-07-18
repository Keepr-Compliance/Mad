/**
 * Contact Database Service
 * Handles all contact-related database operations
 */

import crypto from "crypto";
import type { Contact, NewContact, ContactFilters, Message, Communication, ContactMessageThread } from "../../types";
import { DatabaseError } from "../../types";
import { dbGet, dbAll, dbRun, dbTransaction } from "./core/dbConnection";
import logService from "../logService";
import { validateFields } from "../../utils/sqlFieldWhitelist";
import { toLookupKey, toE164 } from "../../utils/phoneNormalization";
// BACKLOG-1933: pure phone-matching helpers only (no transaction-scoped finders).
import { normalizePhone, phonesMatch } from "../messageMatchingService";
import { getContactNames } from "../contactsService";
import { queryContacts, isPoolReady } from "../../workers/contactWorkerPool";
import { ContactSchema, validateResponse } from "../../schemas";

// Contact with activity metadata
interface ContactWithActivity extends Contact {
  last_communication_at?: string | null;
  communication_count?: number;
  address_mention_count?: number;
}

// Transaction with roles for contact
// BACKLOG-1930: `roles` is a typed string[] at the data boundary (deduped,
// NOT pre-joined). The renderer owns display formatting (the ", " join). This
// removes the pre-joined-string antipattern that caused BACKLOG-1898's
// `t.roles?.join is not a function` runtime error.
interface TransactionWithRoles {
  id: string;
  property_address: string;
  closing_deadline?: string | null;
  transaction_type?: string | null;
  status: string;
  roles: string[];
}

// BACKLOG-1933: ContactMessageThread is defined in ../../types/models (a pure
// type module) so main / preload / renderer can share it. Re-exported below.

// Message-derived contact (extracted from messages table participants JSON)
interface MessageDerivedContact {
  id: string;
  display_name: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string;
  is_imported: number;
  is_message_derived: number;
  last_communication_at: string | null;
  communication_count: number; // BACKLOG-311: Pre-computed to avoid N+1 queries
}

/**
 * Get unique contacts derived from message participants (senders/recipients)
 * These are contacts who have sent/received messages but may not be explicitly imported.
 * Uses json_extract to parse the participants JSON field.
 */
export function getMessageDerivedContacts(userId: string): MessageDerivedContact[] {
  // Get emails of imported contacts to exclude (avoid duplicates)
  const importedEmailsSql = `
    SELECT LOWER(email) as email
    FROM contact_emails ce
    JOIN contacts c ON ce.contact_id = c.id
    WHERE c.user_id = ? AND c.is_imported = 1
  `;
  const importedEmailRows = dbAll<{ email: string }>(importedEmailsSql, [userId]);
  const importedEmails = new Set(importedEmailRows.map(r => r.email).filter(Boolean));

  // Get phones of imported contacts to exclude (avoid duplicates)
  const importedPhonesSql = `
    SELECT LOWER(phone_e164) as phone
    FROM contact_phones cp
    JOIN contacts c ON cp.contact_id = c.id
    WHERE c.user_id = ? AND c.is_imported = 1
  `;
  const importedPhoneRows = dbAll<{ phone: string }>(importedPhonesSql, [userId]);
  const importedPhones = new Set(importedPhoneRows.map(r => r.phone).filter(Boolean));

  // Also get display_names of imported contacts to exclude (for SMS contacts without proper phone numbers)
  const importedNamesSql = `
    SELECT LOWER(display_name) as name
    FROM contacts
    WHERE user_id = ? AND is_imported = 1
  `;
  const importedNameRows = dbAll<{ name: string }>(importedNamesSql, [userId]);
  const importedNames = new Set(importedNameRows.map(r => r.name).filter(Boolean));

  // Extract unique senders from messages (from field in participants JSON)
  // BACKLOG-313: Only include senders with actual display names (filter out raw emails/phones)
  // BACKLOG-311: Include COUNT(*) to avoid N+1 queries
  const sql = `
    SELECT
      'msg_' || LOWER(json_extract(participants, '$.from')) as id,
      json_extract(participants, '$.from') as display_name,
      json_extract(participants, '$.from') as name,
      CASE
        WHEN json_extract(participants, '$.from') LIKE '%@%'
        THEN LOWER(json_extract(participants, '$.from'))
        ELSE NULL
      END as email,
      CASE
        WHEN json_extract(participants, '$.from') NOT LIKE '%@%'
        THEN json_extract(participants, '$.from')
        ELSE NULL
      END as phone,
      NULL as company,
      'messages' as source,
      0 as is_imported,
      1 as is_message_derived,
      MAX(sent_at) as last_communication_at,
      COUNT(*) as communication_count
    FROM messages
    WHERE user_id = ?
      AND participants IS NOT NULL
      AND json_extract(participants, '$.from') IS NOT NULL
      AND json_extract(participants, '$.from') != ''
      AND json_extract(participants, '$.from') != 'me'
      -- BACKLOG-313: Filter out entries where "name" is raw phone/email (no display name)
      AND json_extract(participants, '$.from') NOT LIKE '%@%'
      AND json_extract(participants, '$.from') NOT LIKE '+%'
      AND json_extract(participants, '$.from') NOT GLOB '[0-9]*'
      AND json_extract(participants, '$.from') NOT LIKE 'urn:%'
    GROUP BY LOWER(json_extract(participants, '$.from'))
    ORDER BY last_communication_at DESC
    LIMIT 200
  `;

  const results = dbAll<MessageDerivedContact>(sql, [userId]);

  // Filter out contacts whose email, phone, or name is already imported
  return results.filter(contact => {
    // Filter by email match
    if (contact.email && importedEmails.has(contact.email.toLowerCase())) {
      return false;
    }
    // Filter by phone match
    if (contact.phone && importedPhones.has(contact.phone.toLowerCase())) {
      return false;
    }
    // Filter by display name match (for SMS contacts like "*162")
    if (contact.display_name && importedNames.has(contact.display_name.toLowerCase())) {
      return false;
    }
    return true;
  });
}

/**
 * Normalize phone to E.164 format
 */
function normalizeToE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.startsWith('+')) return phone;
  return `+${digits}`;
}

/**
 * Create a new contact
 * Also stores phones and emails in their respective child tables if provided.
 * Supports both single phone/email and arrays (allPhones/allEmails) for complete data storage.
 */
export async function createContact(contactData: NewContact): Promise<Contact> {
  const id = crypto.randomUUID();
  // BACKLOG-1745 Part 2: persist engagement timestamps so contacts imported from
  // a message-derived external row inherit recency. Without this, the unified
  // sort in getContactsSortedByActivity sinks the new row to the bottom.
  const sql = `
    INSERT INTO contacts (
      id, user_id, display_name, company, title, source, is_imported,
      last_inbound_at, last_outbound_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    id,
    contactData.user_id,
    contactData.display_name || "Unknown",
    contactData.company || null,
    contactData.title || null,
    contactData.source || "manual",
    contactData.is_imported !== undefined
      ? contactData.is_imported
        ? 1
        : 0
      : 1,
    contactData.last_inbound_at || null,
    contactData.last_outbound_at || null,
  ];

  dbRun(sql, params);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extendedData = contactData as any;

  // Store ALL phones in contact_phones table
  // Use allPhones array if available, otherwise fall back to single phone
  const allPhones: string[] = extendedData.allPhones || [];
  const singlePhone = extendedData.phone;

  // If no allPhones but we have a single phone, use that
  if (allPhones.length === 0 && singlePhone) {
    allPhones.push(singlePhone);
  }

  // Track stored phones to avoid duplicates
  const storedPhones = new Set<string>();
  let isFirstPhone = true;

  for (const phone of allPhones) {
    if (!phone) continue;

    const phoneE164 = normalizeToE164(phone);
    const normalizedKey = phoneE164.replace(/\D/g, '').slice(-10);

    // Skip if we've already stored this normalized phone
    if (storedPhones.has(normalizedKey)) continue;
    storedPhones.add(normalizedKey);

    const phoneId = crypto.randomUUID();
    const phoneSql = `
      INSERT OR IGNORE INTO contact_phones (
        id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)
    `;
    dbRun(phoneSql, [phoneId, id, phoneE164, phone, toLookupKey(phoneE164), isFirstPhone ? 1 : 0]);
    isFirstPhone = false;
  }

  if (storedPhones.size > 0) {
    logService.info(`[Contacts] Stored ${storedPhones.size} phone(s) for contact ${id}`, "Contacts");
  }

  // Store ALL emails in contact_emails table
  // Use allEmails array if available, otherwise fall back to single email
  const allEmails: string[] = extendedData.allEmails || [];
  const singleEmail = extendedData.email;

  // If no allEmails but we have a single email, use that
  if (allEmails.length === 0 && singleEmail) {
    allEmails.push(singleEmail);
  }

  // Track stored emails to avoid duplicates
  const storedEmails = new Set<string>();
  let isFirstEmail = true;

  for (const email of allEmails) {
    if (!email) continue;

    const normalizedEmail = email.toLowerCase().trim();

    // Skip if we've already stored this email
    if (storedEmails.has(normalizedEmail)) continue;
    storedEmails.add(normalizedEmail);

    const emailId = crypto.randomUUID();
    const emailSql = `
      INSERT OR IGNORE INTO contact_emails (
        id, contact_id, email, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)
    `;
    dbRun(emailSql, [emailId, id, normalizedEmail, isFirstEmail ? 1 : 0]);
    isFirstEmail = false;
  }

  if (storedEmails.size > 0) {
    logService.info(`[Contacts] Stored ${storedEmails.size} email(s) for contact ${id}`, "Contacts");
  }

  const contact = await getContactById(id);
  if (!contact) {
    throw new DatabaseError("Failed to create contact");
  }
  return contact;
}

/**
 * Batch create contacts with transaction for performance
 * Used for bulk import operations (1000+ contacts)
 */
export function createContactsBatch(
  contacts: Array<{
    user_id: string;
    display_name: string;
    email?: string;
    phone?: string;
    company?: string;
    title?: string;
    source?: string;
    is_imported?: boolean;
    allPhones?: string[];
    allEmails?: string[];
  }>,
  onProgress?: (current: number, total: number) => void
): string[] {
  const createdIds: string[] = [];
  const total = contacts.length;

  // Wrap entire operation in a transaction for 10-100x speedup
  dbTransaction(() => {
    for (let i = 0; i < contacts.length; i++) {
      const contactData = contacts[i];
      const id = crypto.randomUUID();
      createdIds.push(id);

      // Insert contact
      dbRun(
        `INSERT INTO contacts (id, user_id, display_name, company, title, source, is_imported)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          contactData.user_id,
          contactData.display_name || "Unknown",
          contactData.company || null,
          contactData.title || null,
          contactData.source || "contacts_app",
          contactData.is_imported !== undefined ? (contactData.is_imported ? 1 : 0) : 1,
        ]
      );

      // Store phones
      const allPhones = contactData.allPhones || [];
      if (allPhones.length === 0 && contactData.phone) {
        allPhones.push(contactData.phone);
      }
      const storedPhones = new Set<string>();
      let isFirstPhone = true;
      for (const phone of allPhones) {
        if (!phone) continue;
        const phoneE164 = normalizeToE164(phone);
        const normalizedKey = phoneE164.replace(/\D/g, '').slice(-10);
        if (storedPhones.has(normalizedKey)) continue;
        storedPhones.add(normalizedKey);
        dbRun(
          `INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`,
          [crypto.randomUUID(), id, phoneE164, phone, toLookupKey(phoneE164), isFirstPhone ? 1 : 0]
        );
        isFirstPhone = false;
      }

      // Store emails
      const allEmails = contactData.allEmails || [];
      if (allEmails.length === 0 && contactData.email) {
        allEmails.push(contactData.email);
      }
      if (allEmails.length > 1) {
        logService.warn(`[DIAG-1270] Batch create: ${contactData.display_name} → storing ${allEmails.length} emails: ${allEmails.join(', ')}`, 'ContactDbService');
      }
      const storedEmails = new Set<string>();
      let isFirstEmail = true;
      for (const email of allEmails) {
        if (!email) continue;
        const normalizedEmail = email.toLowerCase().trim();
        if (storedEmails.has(normalizedEmail)) continue;
        storedEmails.add(normalizedEmail);
        dbRun(
          `INSERT OR IGNORE INTO contact_emails (id, contact_id, email, is_primary, source, created_at)
           VALUES (?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`,
          [crypto.randomUUID(), id, normalizedEmail, isFirstEmail ? 1 : 0]
        );
        isFirstEmail = false;
      }
      logService.warn(`[DIAG-1270] Batch create: ${contactData.display_name} → ${storedEmails.size} emails stored (from ${allEmails.length} input)`, 'ContactDbService');

      // Report progress every 50 contacts
      if (onProgress && (i + 1) % 50 === 0) {
        onProgress(i + 1, total);
      }
    }
  });

  // Final progress update
  if (onProgress) {
    onProgress(total, total);
  }

  return createdIds;
}

/**
 * Get contact by ID
 */
export async function getContactById(contactId: string): Promise<Contact | null> {
  const sql = `
    SELECT c.*,
      c.display_name as name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as phone,
      (SELECT json_group_array(email) FROM contact_emails WHERE contact_id = c.id) as all_emails_json,
      (SELECT json_group_array(phone_e164) FROM contact_phones WHERE contact_id = c.id) as all_phones_json
    FROM contacts c
    WHERE c.id = ?
  `;
  const row = dbGet<Contact & { all_emails_json?: string; all_phones_json?: string }>(sql, [contactId]);
  if (!row) return null;

  const allEmails: string[] = row.all_emails_json
    ? JSON.parse(row.all_emails_json).filter((e: string | null) => e !== null)
    : [];
  const allPhones: string[] = row.all_phones_json
    ? JSON.parse(row.all_phones_json).filter((p: string | null) => p !== null)
    : [];

  const { all_emails_json, all_phones_json, ...rest } = row;
  const contact = {
    ...rest,
    allEmails,
    allPhones,
  } as Contact;
  return validateResponse(ContactSchema, contact, 'contactDbService.getContactById') as Contact;
}

/**
 * Find an imported contact by display name (case-insensitive)
 * Used to prevent duplicate imports of message-derived contacts
 */
export async function findContactByName(userId: string, name: string): Promise<Contact | null> {
  const sql = `
    SELECT * FROM contacts
    WHERE user_id = ?
      AND LOWER(display_name) = LOWER(?)
      AND is_imported = 1
    LIMIT 1
  `;
  const contact = dbGet<Contact>(sql, [userId, name]);
  return contact || null;
}

/**
 * BACKLOG-1745 Part 2 follow-up: backfill engagement timestamps on an existing
 * imported contact row.
 *
 * The Part 2 fix wrote the timestamps on INSERT, but the contacts:create handler
 * has a duplicate-by-name short-circuit: if an imported contact with the same
 * display_name already exists (e.g. imported by a prior, buggy build that did
 * not write the timestamps), the handler returns that row as-is. With NULL
 * last_inbound_at / last_outbound_at, the unified sort still sinks it to the
 * bottom — reproducing the visible "list reorders" symptom even after Part 2.
 *
 * This helper writes the caller-supplied timestamps onto the existing row,
 * but ONLY when the corresponding column is currently NULL. We never overwrite
 * a real, more recent timestamp with an older one supplied by an external row.
 *
 * Returns the number of rows updated (0 if both columns were already populated
 * or no caller value was supplied).
 */
export async function backfillContactEngagementTimestamps(
  contactId: string,
  timestamps: { last_inbound_at?: string | null; last_outbound_at?: string | null },
): Promise<number> {
  const setters: string[] = [];
  const values: unknown[] = [];

  if (timestamps.last_inbound_at) {
    setters.push("last_inbound_at = COALESCE(last_inbound_at, ?)");
    values.push(timestamps.last_inbound_at);
  }
  if (timestamps.last_outbound_at) {
    setters.push("last_outbound_at = COALESCE(last_outbound_at, ?)");
    values.push(timestamps.last_outbound_at);
  }
  if (setters.length === 0) return 0;

  values.push(contactId);
  const sql = `UPDATE contacts SET ${setters.join(", ")} WHERE id = ?`;
  const result = dbRun(sql, values);
  return result.changes;
}

/**
 * Get all contacts for a user
 */
export async function getContacts(filters?: ContactFilters): Promise<Contact[]> {
  let sql = "SELECT * FROM contacts WHERE 1=1";
  const params: unknown[] = [];

  if (filters?.user_id) {
    sql += " AND user_id = ?";
    params.push(filters.user_id);
  }

  if (filters?.source) {
    sql += " AND source = ?";
    params.push(filters.source);
  }

  if (filters?.is_imported !== undefined) {
    sql += " AND is_imported = ?";
    params.push(filters.is_imported ? 1 : 0);
  }

  sql += " ORDER BY display_name ASC";

  return dbAll<Contact>(sql, params);
}

/**
 * Get only imported contacts for a user
 * Returns contacts with display_name aliased as 'name' for backwards compatibility
 * Also includes primary email and phone from child tables
 */
export async function getImportedContactsByUserId(
  userId: string,
): Promise<Contact[]> {
  // Get explicitly imported contacts from contacts table
  // Include all emails/phones as JSON arrays for display in contact details
  const sql = `
    SELECT
      c.*,
      c.display_name as name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as phone,
      (SELECT json_group_array(email) FROM contact_emails WHERE contact_id = c.id) as all_emails_json,
      (SELECT json_group_array(phone_e164) FROM contact_phones WHERE contact_id = c.id) as all_phones_json,
      0 as is_message_derived
    FROM contacts c
    WHERE c.user_id = ? AND c.is_imported = 1
    ORDER BY c.display_name ASC
  `;
  const importedContacts = dbAll<Contact & { all_emails_json?: string; all_phones_json?: string }>(sql, [userId]);

  // Parse JSON arrays into allEmails/allPhones fields
  const contactsWithArrays = importedContacts.map(contact => {
    const allEmails: string[] = contact.all_emails_json
      ? JSON.parse(contact.all_emails_json).filter((e: string | null) => e !== null)
      : [];
    const allPhones: string[] = contact.all_phones_json
      ? JSON.parse(contact.all_phones_json).filter((p: string | null) => p !== null)
      : [];
    // Remove the JSON fields from the result
    const { all_emails_json, all_phones_json, ...rest } = contact;
    return {
      ...rest,
      allEmails,
      allPhones,
    } as Contact;
  });

  // Get message-derived contacts (unique senders from messages, excluding already-imported)
  const messageDerivedContacts = getMessageDerivedContacts(userId);

  // Merge both lists - imported contacts first (with allEmails/allPhones), then message-derived
  // Cast message-derived to Contact type (they have compatible fields)
  const allContacts = [
    ...contactsWithArrays,
    ...messageDerivedContacts.map(mc => ({
      id: mc.id,
      user_id: userId,
      display_name: mc.display_name,
      name: mc.name,
      email: mc.email,
      phone: mc.phone,
      company: mc.company,
      source: mc.source,
      is_imported: mc.is_imported,
      is_message_derived: mc.is_message_derived,
      last_communication_at: mc.last_communication_at,
    } as Contact)),
  ];

  // Sort alphabetically by display_name/name
  return allContacts.sort((a, b) => {
    const nameA = (a.display_name || a.name || '').toLowerCase();
    const nameB = (b.display_name || b.name || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

/**
 * TASK-1956: Async version of getImportedContactsByUserId that runs the SQL
 * in a worker thread via the persistent worker pool. This prevents blocking
 * the Electron main process — no new Worker() spawn per query.
 *
 * Falls back to sync version if pool is not ready.
 */
export async function getImportedContactsByUserIdAsync(
  userId: string,
  timeoutMs: number = 30_000,
): Promise<Contact[]> {
  if (!isPoolReady()) {
    // Fallback to sync version if pool not initialized
    return getImportedContactsByUserId(userId);
  }

  // Run imported contacts SQL in persistent worker thread
  const rawRows = await queryContacts('imported', userId, timeoutMs) as Array<Contact & { all_emails_json?: string; all_phones_json?: string }>;

  // Post-process: parse JSON arrays (fast, no DB access)
  const contactsWithArrays = rawRows.map(contact => {
    const allEmails: string[] = contact.all_emails_json
      ? JSON.parse(contact.all_emails_json).filter((e: string | null) => e !== null)
      : [];
    const allPhones: string[] = contact.all_phones_json
      ? JSON.parse(contact.all_phones_json).filter((p: string | null) => p !== null)
      : [];
    const { all_emails_json, all_phones_json, ...rest } = contact;
    return {
      ...rest,
      allEmails,
      allPhones,
    } as Contact;
  });

  return contactsWithArrays.sort((a, b) => {
    const nameA = (a.display_name || a.name || '').toLowerCase();
    const nameB = (b.display_name || b.name || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

/**
 * Get unimported contacts for a user (available to import)
 * These are contacts synced from iPhone that haven't been imported yet.
 *
 * BACKLOG-1689 / BACKLOG-1727: Populates `last_communication_at` from
 * `phone_last_message` so message-derived externals sort by recency in the
 * contact picker rather than dropping to the bottom with NULL timestamps.
 * The JOIN is keyed on `contact_phones.phone_normalized`, which is populated
 * via the shared `toLookupKey` helper at insert time and matches
 * the writer-side normalization stored in `phone_last_message.phone_normalized`.
 */
export async function getUnimportedContactsByUserId(
  userId: string,
): Promise<Contact[]> {
  const sql = `
    SELECT
      c.*,
      c.display_name as name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as phone,
      (
        SELECT MAX(plm.last_message_at)
        FROM contact_phones cp
        JOIN phone_last_message plm
          ON plm.user_id = c.user_id
         AND plm.phone_normalized = cp.phone_normalized
        WHERE cp.contact_id = c.id
          AND cp.phone_normalized IS NOT NULL
      ) as last_communication_at
    FROM contacts c
    WHERE c.user_id = ? AND c.is_imported = 0
    ORDER BY c.display_name ASC
  `;
  return dbAll<Contact>(sql, [userId]);
}

/**
 * Mark a contact as imported (change is_imported from 0 to 1)
 * Optionally update the source field (e.g., when importing from macOS Contacts)
 * @param contactId - The contact ID to update
 * @param source - Optional source to set (e.g., "contacts_app")
 */
export async function markContactAsImported(contactId: string, source?: string): Promise<void> {
  if (source) {
    const sql =
      "UPDATE contacts SET is_imported = 1, source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?";
    dbRun(sql, [source, contactId]);
  } else {
    const sql =
      "UPDATE contacts SET is_imported = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?";
    dbRun(sql, [contactId]);
  }
}

/**
 * Backfill emails for a contact from external source (e.g., macOS Contacts)
 * Only adds emails that don't already exist in the junction table.
 */
export async function backfillContactEmails(contactId: string, emails: string[]): Promise<number> {
  if (!emails || emails.length === 0) return 0;

  let added = 0;
  const storedEmails = new Set<string>();

  // Get existing emails for this contact
  const existingSql = "SELECT LOWER(email) as email FROM contact_emails WHERE contact_id = ?";
  const existingRows = dbAll<{ email: string }>(existingSql, [contactId]);
  logService.warn(`[DIAG-1270] Backfill emails for ${contactId}: input=${emails.length} emails [${emails.join(', ')}], existing=${existingRows.length}`, 'ContactDbService');
  for (const row of existingRows) {
    storedEmails.add(row.email);
  }

  // Add any new emails
  for (const email of emails) {
    if (!email) continue;

    const normalizedEmail = email.toLowerCase().trim();
    if (storedEmails.has(normalizedEmail)) continue;
    storedEmails.add(normalizedEmail);

    const emailId = crypto.randomUUID();
    const isPrimary = existingRows.length === 0 && added === 0 ? 1 : 0;
    const emailSql = `
      INSERT OR IGNORE INTO contact_emails (
        id, contact_id, email, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)
    `;
    const result = dbRun(emailSql, [emailId, contactId, normalizedEmail, isPrimary]);
    // Only count as added if the insert actually happened (changes > 0)
    if (result.changes > 0) {
      added++;
    }
  }

  logService.warn(`[DIAG-1270] Backfill emails for ${contactId}: added=${added}`, 'ContactDbService');
  if (added > 0) {
    logService.info(`[Contacts] Backfilled ${added} email(s) for contact ${contactId}`, "Contacts");
  }

  return added;
}

/**
 * Backfill phones for a contact from external source (e.g., macOS Contacts)
 * Only adds phones that don't already exist in the junction table.
 */
export async function backfillContactPhones(contactId: string, phones: string[]): Promise<number> {
  if (!phones || phones.length === 0) return 0;

  let added = 0;
  const storedPhones = new Set<string>();

  // Get existing phones for this contact (normalized to last 10 digits)
  const existingSql = "SELECT phone_e164 FROM contact_phones WHERE contact_id = ?";
  const existingRows = dbAll<{ phone_e164: string }>(existingSql, [contactId]);
  for (const row of existingRows) {
    const normalized = row.phone_e164.replace(/\D/g, '').slice(-10);
    storedPhones.add(normalized);
  }

  // Add any new phones
  for (const phone of phones) {
    if (!phone) continue;

    const phoneE164 = normalizeToE164(phone);
    const normalizedKey = phoneE164.replace(/\D/g, '').slice(-10);

    if (storedPhones.has(normalizedKey)) continue;
    storedPhones.add(normalizedKey);

    const phoneId = crypto.randomUUID();
    const isPrimary = existingRows.length === 0 && added === 0 ? 1 : 0;
    const phoneSql = `
      INSERT OR IGNORE INTO contact_phones (
        id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)
    `;
    const result = dbRun(phoneSql, [phoneId, contactId, phoneE164, phone, toLookupKey(phoneE164), isPrimary]);
    // Only count as added if the insert actually happened (changes > 0)
    if (result.changes > 0) {
      added++;
    }
  }

  if (added > 0) {
    logService.info(`[Contacts] Backfilled ${added} phone(s) for contact ${contactId}`, "Contacts");
  }

  return added;
}

/**
 * Backfill last_inbound_at for contacts from their messages.
 * Uses a simpler approach: get max message date per phone, then update contacts.
 */
export async function backfillContactCommunicationDates(userId: string): Promise<number> {
  // Step 1: Get the most recent message date for each normalized phone number
  // This is the simple GROUP BY approach the user suggested
  const phoneMessagesSql = `
    SELECT
      SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) as normalized_phone,
      cp.contact_id,
      MAX(m.sent_at) as last_msg_date
    FROM contact_phones cp
    JOIN contacts c ON cp.contact_id = c.id AND c.user_id = ? AND c.is_imported = 1
    JOIN messages m ON (
      m.user_id = ?
      AND (m.channel = 'sms' OR m.channel = 'imessage')
      AND m.participants_flat LIKE '%' || SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10) || '%'
    )
    WHERE LENGTH(SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)) >= 7
    GROUP BY cp.contact_id
  `;

  const phoneMessages = dbAll<{ normalized_phone: string; contact_id: string; last_msg_date: string }>(
    phoneMessagesSql,
    [userId, userId]
  );

  logService.info("Backfill: Found phone-message matches", "ContactDbService", {
    matchCount: phoneMessages.length,
    samples: phoneMessages.slice(0, 5).map(p => ({
      contactId: p.contact_id.substring(0, 8),
      phone: p.normalized_phone,
      lastDate: p.last_msg_date,
    })),
  });

  // Step 2: Update each contact with their most recent message date
  let updatedCount = 0;
  for (const match of phoneMessages) {
    const updateSql = `
      UPDATE contacts
      SET last_inbound_at = ?
      WHERE id = ? AND (last_inbound_at IS NULL OR last_inbound_at < ?)
    `;
    const result = dbRun(updateSql, [match.last_msg_date, match.contact_id, match.last_msg_date]);
    updatedCount += result.changes;
  }

  // Debug: Show final state
  const debugSql = `
    SELECT c.display_name, c.last_inbound_at
    FROM contacts c
    WHERE c.user_id = ? AND c.is_imported = 1
    ORDER BY c.last_inbound_at DESC NULLS LAST
    LIMIT 10
  `;
  const debugContacts = dbAll<{ display_name: string; last_inbound_at: string | null }>(debugSql, [userId]);

  logService.info("Backfill complete", "ContactDbService", {
    userId,
    updatedCount,
    topContacts: debugContacts.map(c => ({
      name: c.display_name,
      lastInbound: c.last_inbound_at,
    })),
  });

  return updatedCount;
}

/**
 * Get contacts sorted by recent communication and optionally by property address relevance
 * SIMPLIFIED: Uses denormalized last_inbound_at column with simple ORDER BY
 */
export async function getContactsSortedByActivity(
  userId: string,
  _propertyAddress?: string,
): Promise<ContactWithActivity[]> {
  // Check if backfill has ever run (single lightweight query)
  const hasBackfilled = dbGet<{ count: number }>(`
    SELECT COUNT(*) as count FROM contacts
    WHERE user_id = ? AND is_imported = 1 AND last_inbound_at IS NOT NULL
  `, [userId]);

  // Only run backfill once - if no contacts have dates yet
  if (!hasBackfilled || hasBackfilled.count === 0) {
    await backfillContactCommunicationDates(userId);
  }

  // Get contacts sorted by last_inbound_at (denormalized field)
  const contactsSql = `
    SELECT
      c.*,
      c.display_name as name,
      ce_primary.email as email,
      cp_primary.phone_e164 as phone,
      0 as is_message_derived,
      COALESCE(c.last_inbound_at, c.last_outbound_at) as last_communication_at,
      CASE WHEN c.last_inbound_at IS NOT NULL OR c.last_outbound_at IS NOT NULL THEN 1 ELSE 0 END as communication_count,
      0 as address_mention_count
    FROM contacts c
    LEFT JOIN contact_emails ce_primary ON c.id = ce_primary.contact_id AND ce_primary.is_primary = 1
    LEFT JOIN contact_phones cp_primary ON c.id = cp_primary.contact_id AND cp_primary.is_primary = 1
    WHERE c.user_id = ? AND c.is_imported = 1
    ORDER BY
      COALESCE(c.last_inbound_at, c.last_outbound_at) DESC,
      c.display_name ASC
  `;

  try {
    const importedContacts = dbAll<ContactWithActivity>(contactsSql, [userId]);

    // Get message-derived contacts (already have last_communication_at from their source)
    const messageDerivedContacts = getMessageDerivedContacts(userId);

    const messageDerivedWithActivity: ContactWithActivity[] = messageDerivedContacts.map(mc => ({
      id: mc.id,
      user_id: userId,
      display_name: mc.display_name,
      name: mc.name,
      email: mc.email,
      phone: mc.phone,
      company: mc.company,
      source: mc.source,
      is_imported: mc.is_imported,
      is_message_derived: mc.is_message_derived,
      last_communication_at: mc.last_communication_at,
      communication_count: mc.communication_count,
      address_mention_count: 0,
    } as ContactWithActivity));

    // BACKLOG-1745 Part 1: unified iPhone-Messages-style sort across both buckets.
    // Previously concatenated [...imported, ...messageDerived], which bucketed
    // imported contacts at top regardless of recency. That undermined BACKLOG-1689's
    // intent (shipped May 29 via #1750 + #1764 + #1767) of a single chronological
    // list. Now: combine, then sort by last_communication_at DESC with NULLS-LAST
    // and display_name ASC tie-break.
    const combined = [...importedContacts, ...messageDerivedWithActivity];
    return combined.sort((a, b) => {
      // NULLS-LAST: treat null/undefined as oldest so DESC pushes them to the end.
      const aTs = a.last_communication_at ? new Date(a.last_communication_at).getTime() : 0;
      const bTs = b.last_communication_at ? new Date(b.last_communication_at).getTime() : 0;
      const aValid = Number.isFinite(aTs) ? aTs : 0;
      const bValid = Number.isFinite(bTs) ? bTs : 0;
      if (aValid !== bValid) return bValid - aValid; // DESC: most recent first
      // Tie-break: display_name ASC (case-insensitive)
      const aName = (a.display_name || "").toLowerCase();
      const bName = (b.display_name || "").toLowerCase();
      return aName.localeCompare(bName);
    });
  } catch (error) {
    logService.error("Error getting sorted contacts", "ContactDbService", {
      error: (error as Error).message,
      userId,
    });
    throw error;
  }
}

/**
 * Search contacts by name or email
 */
export async function searchContacts(
  query: string,
  userId: string,
): Promise<Contact[]> {
  const sql = `
    SELECT * FROM contacts
    WHERE user_id = ? AND (display_name LIKE ? OR display_name LIKE ?)
    ORDER BY display_name ASC
  `;
  const searchPattern = `%${query}%`;
  return dbAll<Contact>(sql, [userId, searchPattern, searchPattern]);
}

/**
 * Look up contact by phone number.
 * Normalizes the phone number and searches across all contact phones.
 * Returns the contact with display_name if found.
 */
export async function getContactByPhone(
  phone: string
): Promise<{ id: string; display_name: string; phone: string } | null> {
  // Normalize phone to last 10 digits for matching
  const digits = phone.replace(/\D/g, '');
  const normalized = digits.length >= 10 ? digits.slice(-10) : digits;

  if (!normalized || normalized.length < 7) {
    return null;
  }

  const sql = `
    SELECT
      c.id,
      c.display_name,
      cp.phone_e164 as phone
    FROM contacts c
    JOIN contact_phones cp ON c.id = cp.contact_id
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', '') LIKE ?
    LIMIT 1
  `;

  // Match on last 10 digits
  const pattern = `%${normalized}`;
  const result = dbGet<{ id: string; display_name: string; phone: string }>(sql, [pattern]);
  return result || null;
}

/**
 * Synchronous phone lookup scoped by user_id.
 * Used by Android contact promotion to check for duplicates before
 * creating entries in the main contacts table.
 *
 * BACKLOG-1469: Added to support contact promotion dedup.
 *
 * @param userId - Owning user ID
 * @param normalizedPhone - Last 10 digits of the phone number
 * @returns Contact ID and display_name if found, null otherwise
 */
export function findContactByNormalizedPhone(
  userId: string,
  normalizedPhone: string
): { id: string; display_name: string } | null {
  if (!normalizedPhone || normalizedPhone.length < 7) {
    return null;
  }

  const sql = `
    SELECT
      c.id,
      c.display_name
    FROM contacts c
    JOIN contact_phones cp ON c.id = cp.contact_id
    WHERE c.user_id = ?
      AND SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', ''), -10) = ?
    LIMIT 1
  `;

  const result = dbGet<{ id: string; display_name: string }>(sql, [userId, normalizedPhone]);
  return result || null;
}

/**
 * BACKLOG-1762: Build an email address -> contact display_name map for a user.
 *
 * Email views (thread chat bubbles, single-email From/To/CC lines, email list
 * rows) use this to resolve display names when the email header carries no name.
 * Keys are lowercase email addresses.
 *
 * When the same address maps to multiple contacts, imported + primary rows win
 * (ORDER BY ... DESC + keep-first) so the "best" display name is chosen. Rows
 * with an empty address or empty/whitespace display_name are skipped.
 *
 * Read-only; safe to call frequently (the renderer caches the result per user).
 */
export function getEmailNameMap(userId: string): Record<string, string> {
  const sql = `
    SELECT LOWER(ce.email) AS email, c.display_name AS display_name
    FROM contact_emails ce
    JOIN contacts c ON ce.contact_id = c.id
    WHERE c.user_id = ?
      AND ce.email IS NOT NULL AND TRIM(ce.email) != ''
      AND c.display_name IS NOT NULL AND TRIM(c.display_name) != ''
    ORDER BY c.is_imported DESC, ce.is_primary DESC
  `;
  const rows = dbAll<{ email: string; display_name: string }>(sql, [userId]);

  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = (row.email || "").toLowerCase().trim();
    const name = (row.display_name || "").trim();
    if (!key || !name) continue;
    // ORDER BY DESC surfaces the best (imported + primary) row first; keep it.
    if (map[key]) continue;
    map[key] = name;
  }
  return map;
}

/**
 * Batch lookup contacts by multiple phone numbers.
 * Returns a map of normalized phone -> contact name.
 */
export async function getContactNamesByPhones(
  phones: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  if (phones.length === 0) return result;

  // Normalize all phones
  const normalizedPhones = phones.map(p => {
    const digits = p.replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : digits;
  }).filter(p => p.length >= 7);

  if (normalizedPhones.length === 0) return result;

  // Build query with multiple OR conditions
  const conditions = normalizedPhones.map(() =>
    "REPLACE(REPLACE(REPLACE(REPLACE(cp.phone_e164, '+', ''), '-', ''), ' ', ''), '(', '') LIKE ?"
  ).join(' OR ');

  const sql = `
    SELECT
      c.display_name,
      cp.phone_e164 as phone
    FROM contacts c
    JOIN contact_phones cp ON c.id = cp.contact_id
    WHERE ${conditions}
  `;

  const params = normalizedPhones.map(p => `%${p}`);
  const rows = dbAll<{ display_name: string; phone: string }>(sql, params);

  // Map results back to original phone format
  for (const row of rows) {
    const rowDigits = row.phone.replace(/\D/g, '');
    const rowNormalized = rowDigits.slice(-10);

    // Find matching input phone
    for (let i = 0; i < phones.length; i++) {
      if (normalizedPhones[i] === rowNormalized) {
        result.set(phones[i], row.display_name);
      }
    }
    // Store by multiple normalized variants to handle different lookup formats
    // 1. Raw 10-digit (5551234567)
    result.set(rowNormalized, row.display_name);

    // For US numbers (10 digits), also store with country code variants
    if (rowNormalized.length === 10) {
      // 2. With +1 prefix (+15551234567) - E.164 format
      result.set(`+1${rowNormalized}`, row.display_name);
      // 3. With 1 prefix (15551234567) - 11-digit format
      result.set(`1${rowNormalized}`, row.display_name);
    }
  }

  // Fallback: Check macOS Contacts for any unresolved phones
  const unresolvedPhones = phones.filter(p => !result.has(p));
  if (unresolvedPhones.length > 0) {
    try {
      const macOSContacts = await getContactNames();
      const contactMap = macOSContacts.contactMap;

      for (const phone of unresolvedPhones) {
        // Try direct lookup
        if (contactMap[phone]) {
          result.set(phone, contactMap[phone]);
          continue;
        }

        // Try normalized lookup (last 10 digits)
        const digits = phone.replace(/\D/g, '');
        const normalized = digits.length >= 10 ? digits.slice(-10) : digits;

        // Search contactMap for matching phone
        for (const [key, name] of Object.entries(contactMap)) {
          const keyDigits = key.replace(/\D/g, '');
          const keyNormalized = keyDigits.length >= 10 ? keyDigits.slice(-10) : keyDigits;
          if (keyNormalized === normalized && keyNormalized.length >= 7) {
            result.set(phone, name);
            result.set(normalized, name);
            // Also store with country code variants for US numbers
            if (normalized.length === 10) {
              result.set(`+1${normalized}`, name);
              result.set(`1${normalized}`, name);
            }
            break;
          }
        }
      }
    } catch (err) {
      logService.warn("Failed to load macOS Contacts for fallback lookup", "Contacts", { err });
    }
  }

  return result;
}

/**
 * Update contact information
 */
export async function updateContact(
  contactId: string,
  updates: Partial<Contact>,
): Promise<void> {
  const allowedFields = ["display_name", "company", "title", "default_role"];
  const fields: string[] = [];
  const values: unknown[] = [];

  Object.keys(updates).forEach((key) => {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push((updates as Record<string, unknown>)[key]);
    }
  });

  if (fields.length === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  // Validate fields against whitelist before SQL construction
  validateFields("contacts", fields);

  values.push(contactId);
  const sql = `UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`;
  dbRun(sql, values);
}

/**
 * Get all transactions associated with a contact
 */
export async function getTransactionsByContact(
  contactId: string,
): Promise<TransactionWithRoles[]> {
  const transactionMap = new Map<
    string,
    {
      id: string;
      property_address: string;
      closing_deadline?: string | null;
      transaction_type?: string | null;
      status: string;
      roles: string[];
    }
  >();

  // 1. Check direct FK references
  const directQuery = `
    SELECT DISTINCT
      id,
      property_address,
      closing_deadline,
      transaction_type,
      status,
      CASE
        WHEN buyer_agent_id = ? THEN 'Buyer Agent'
        WHEN seller_agent_id = ? THEN 'Seller Agent'
        WHEN escrow_officer_id = ? THEN 'Escrow Officer'
        WHEN inspector_id = ? THEN 'Inspector'
      END as role
    FROM transactions
    WHERE buyer_agent_id = ?
       OR seller_agent_id = ?
       OR escrow_officer_id = ?
       OR inspector_id = ?
  `;

  const directResults = dbAll<{
    id: string;
    property_address: string;
    closing_deadline?: string | null;
    transaction_type?: string | null;
    status: string;
    role: string;
  }>(directQuery, [
    contactId,
    contactId,
    contactId,
    contactId,
    contactId,
    contactId,
    contactId,
    contactId,
  ]);

  directResults.forEach((txn) => {
    if (!transactionMap.has(txn.id)) {
      transactionMap.set(txn.id, {
        id: txn.id,
        property_address: txn.property_address,
        closing_deadline: txn.closing_deadline,
        transaction_type: txn.transaction_type,
        status: txn.status,
        roles: [txn.role],
      });
    } else {
      transactionMap.get(txn.id)?.roles.push(txn.role);
    }
  });

  // 2. Check junction table (transaction_contacts)
  const junctionQuery = `
    SELECT DISTINCT
      t.id,
      t.property_address,
      t.closing_deadline,
      t.transaction_type,
      t.status,
      tc.specific_role,
      tc.role_category
    FROM transaction_contacts tc
    JOIN transactions t ON tc.transaction_id = t.id
    WHERE tc.contact_id = ?
  `;

  const junctionResults = dbAll<{
    id: string;
    property_address: string;
    closing_deadline?: string | null;
    transaction_type?: string | null;
    status: string;
    specific_role?: string;
    role_category?: string;
  }>(junctionQuery, [contactId]);

  junctionResults.forEach((txn) => {
    const role = txn.specific_role || txn.role_category || "Associated Contact";
    if (!transactionMap.has(txn.id)) {
      transactionMap.set(txn.id, {
        id: txn.id,
        property_address: txn.property_address,
        closing_deadline: txn.closing_deadline,
        transaction_type: txn.transaction_type,
        status: txn.status,
        roles: [role],
      });
    } else {
      transactionMap.get(txn.id)?.roles.push(role);
    }
  });

  // 3. Check JSON array (other_contacts)
  try {
    const jsonQuery = `
      SELECT DISTINCT
        t.id,
        t.property_address,
        t.closing_deadline,
        t.transaction_type,
        t.status
      FROM transactions t, json_each(t.other_contacts) j
      WHERE j.value = ?
    `;

    const jsonResults = dbAll<{
      id: string;
      property_address: string;
      closing_deadline?: string | null;
      transaction_type?: string | null;
      status: string;
    }>(jsonQuery, [contactId]);

    jsonResults.forEach((txn) => {
      if (!transactionMap.has(txn.id)) {
        transactionMap.set(txn.id, {
          id: txn.id,
          property_address: txn.property_address,
          closing_deadline: txn.closing_deadline,
          transaction_type: txn.transaction_type,
          status: txn.status,
          roles: ["Other Contact"],
        });
      } else {
        transactionMap.get(txn.id)?.roles.push("Other Contact");
      }
    });
  } catch (error) {
    logService.warn(
      "json_each not supported, using LIKE fallback",
      "ContactDbService",
      { error: (error as Error).message },
    );
    // Fallback implementation using LIKE
    const fallbackQuery = `
      SELECT id, property_address, closing_deadline, transaction_type, status, other_contacts
      FROM transactions
      WHERE other_contacts LIKE ?
    `;

    const fallbackResults = dbAll<{
      id: string;
      property_address: string;
      closing_deadline?: string | null;
      transaction_type?: string | null;
      status: string;
      other_contacts?: string;
    }>(fallbackQuery, [`%"${contactId}"%`]);

    fallbackResults.forEach((txn) => {
      try {
        const contacts = JSON.parse(txn.other_contacts || "[]");
        if (contacts.includes(contactId)) {
          if (!transactionMap.has(txn.id)) {
            transactionMap.set(txn.id, {
              id: txn.id,
              property_address: txn.property_address,
              closing_deadline: txn.closing_deadline,
              transaction_type: txn.transaction_type,
              status: txn.status,
              roles: ["Other Contact"],
            });
          } else {
            transactionMap.get(txn.id)?.roles.push("Other Contact");
          }
        }
      } catch (parseError) {
        logService.error(
          "Error parsing other_contacts JSON",
          "ContactDbService",
          { error: (parseError as Error).message },
        );
      }
    });
  }

  // Convert map to array; roles is a deduped string[] (BACKLOG-1930 —
  // no ", " join here; the renderer formats for display).
  return Array.from(transactionMap.values()).map((txn) => ({
    ...txn,
    roles: [...new Set(txn.roles)],
  }));
}

/**
 * Resolve the owning user_id for a contact (contacts belong to exactly one
 * user). Used to scope the contact-scoped comms queries below.
 */
function getContactUserId(contactId: string): string | null {
  const row = dbGet<{ user_id: string }>(
    "SELECT user_id FROM contacts WHERE id = ?",
    [contactId],
  );
  return row?.user_id ?? null;
}

/**
 * BACKLOG-1933: Get ALL emails involving a contact's email addresses,
 * aggregated across every transaction (contact-scoped, NOT transaction-scoped).
 *
 * Match path: contact's own email addresses (getContactEmailEntries, lowercased)
 * → `email_participants.email_address` (indexed `idx_email_participants_email_address`)
 * → `emails` (the messages/emails content table)
 * → LEFT JOIN `communications c ON c.email_id = e.id` to carry the owning
 *   `transaction_id` (NULL when the email is not linked to any transaction —
 *   EXPECTED per S2, the "See transaction" button is simply hidden for those).
 *
 * Each row is returned as a HYDRATED `Communication` (= `Message`), mirroring the
 * canonical email projection in `communicationDbService.ts:608-690`, so the
 * existing `EmailViewModal` (takes `email: Communication`) can be mounted directly.
 * Deduped by `emails.id`. Newest-first.
 *
 * NOTE: `emails` has NO `duplicate_of` column (dedup on that table is via
 * `content_hash`, not a pointer) — we dedup by primary key `emails.id`.
 *
 * @param contactId - The contact whose emails to fetch
 * @returns Hydrated Communication[] (empty array when none / unknown contact)
 */
export async function getEmailsForContact(
  contactId: string,
): Promise<Communication[]> {
  const userId = getContactUserId(contactId);
  if (!userId) return [];

  // Contact's own email addresses, lowercased+trimmed for exact indexed match.
  const addresses = getContactEmailEntries(contactId)
    .map((e) => e.email.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (addresses.length === 0) return [];

  const placeholders = addresses.map(() => "?").join(", ");

  // Mirror the email branch of getCommunicationsWithMessages
  // (communicationDbService.ts:608-690): populate the Message/Communication
  // fields from REAL `emails` columns. `transaction_id` comes from the
  // `communications` junction (LEFT JOIN → NULL for non-linked emails).
  const sql = `
    SELECT
      e.id                 as id,
      e.user_id            as user_id,
      e.subject            as subject,
      e.body_html          as body,
      e.body_html          as body_html,
      e.body_plain         as body_text,
      e.body_plain         as body_plain,
      e.sender             as sender,
      e.recipients         as recipients,
      e.cc                 as cc,
      e.bcc                as bcc,
      e.sent_at            as sent_at,
      e.received_at        as received_at,
      e.has_attachments    as has_attachments,
      e.attachment_count   as attachment_count,
      e.thread_id          as thread_id,
      e.external_id        as external_id,
      e.source             as source,
      e.direction          as direction,
      'email'              as channel,
      c.transaction_id     as transaction_id
    FROM email_participants ep
    JOIN emails e ON e.id = ep.email_id
    LEFT JOIN communications c ON c.email_id = e.id
    WHERE e.user_id = ?
      AND LOWER(TRIM(ep.email_address)) IN (${placeholders})
    ORDER BY e.sent_at DESC
  `;

  const rows = dbAll<Communication>(sql, [userId, ...addresses]);

  // Dedup by emails.id — a contact can appear as multiple participants on the
  // same email, and multiple contact addresses can match the same email; the
  // LEFT JOIN to communications can also multiply rows when an email is linked
  // to more than one transaction.
  const seen = new Set<string>();
  const deduped: Communication[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    // has_attachments is a required boolean on Message; SQLite returns 0/1.
    row.has_attachments = !!row.has_attachments;
    deduped.push(row);
  }
  return deduped;
}

/**
 * BACKLOG-1933: Get ALL text messages involving a contact's phone numbers,
 * grouped into conversation threads, aggregated across every transaction
 * (contact-scoped, NOT transaction-scoped).
 *
 * Match path: contact's own phones (getContactPhoneEntries, E.164) → scan
 * `messages.participants_flat` using the PURE helpers `phonesMatch`/`toE164`
 * (NOT the transaction-scoped `findTextMessagesByPhones`). Group matched
 * messages by `thread_id`; derive a representative `phoneNumber` per thread
 * (the matched contact phone). `transaction_id` is read DIRECTLY off the
 * message row (`messages.transaction_id`), with the `communications` junction
 * as a fallback.
 *
 * Excludes `duplicate_of IS NOT NULL` rows. Messages within a thread are
 * chronological (oldest → newest); threads are ordered newest-activity-first.
 *
 * @param contactId - The contact whose text threads to fetch
 * @returns ContactMessageThread[] (empty array when none / unknown contact)
 */
export async function getMessagesForContact(
  contactId: string,
): Promise<ContactMessageThread[]> {
  const userId = getContactUserId(contactId);
  if (!userId) return [];

  // Contact's own phones in E.164 (getContactPhoneEntries already stores E.164;
  // normalize defensively via toE164).
  const contactPhones = getContactPhoneEntries(contactId)
    .map((p) => toE164(p.phone))
    .filter((p): p is string => !!p);
  if (contactPhones.length === 0) return [];

  // Fetch the user's text messages (SMS/iMessage), excluding duplicates.
  // participants_flat is a denormalized comma string; a phone lookup inside it
  // is a bounded per-user scan (acceptable MVP per the Query/Index Plan).
  const sql = `
    SELECT
      m.id                 as id,
      m.user_id            as user_id,
      m.channel_account_id as channel_account_id,
      m.external_id        as external_id,
      m.channel            as channel,
      m.direction          as direction,
      m.subject            as subject,
      m.body_html          as body_html,
      m.body_text          as body_text,
      m.participants       as participants,
      m.participants_flat  as participants_flat,
      m.thread_id          as thread_id,
      m.sent_at            as sent_at,
      m.received_at        as received_at,
      m.has_attachments    as has_attachments,
      m.transaction_id     as transaction_id,
      m.message_type       as message_type,
      m.created_at         as created_at
    FROM messages m
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND m.duplicate_of IS NULL
    ORDER BY m.sent_at ASC
  `;

  const allTextMessages = dbAll<Message & { participants_flat?: string }>(sql, [userId]);

  // Filter to messages whose participants_flat contains any of the contact's
  // phones, using the pure phonesMatch helper on each comma-separated token.
  interface ThreadAccumulator {
    thread_id: string;
    phoneNumber: string;
    messages: Message[];
    transaction_id?: string;
    lastActivity: string;
  }
  const threadMap = new Map<string, ThreadAccumulator>();

  for (const msg of allTextMessages) {
    const flat = msg.participants_flat || "";
    if (!flat) continue;

    const tokens = flat.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    // Find which contact phone (if any) this message involves.
    let matchedPhone: string | null = null;
    for (const token of tokens) {
      const hit = contactPhones.find((cp) => phonesMatch(cp, token));
      if (hit) {
        matchedPhone = hit;
        break;
      }
    }
    if (!matchedPhone) continue;

    // Group by thread_id; messages without a thread_id fall back to their own id.
    const threadKey = msg.thread_id || msg.id;
    msg.has_attachments = !!msg.has_attachments;

    const existing = threadMap.get(threadKey);
    const activity = msg.sent_at || msg.received_at || msg.created_at || "";
    if (!existing) {
      threadMap.set(threadKey, {
        thread_id: threadKey,
        phoneNumber: matchedPhone,
        messages: [msg],
        transaction_id: msg.transaction_id || undefined,
        lastActivity: activity,
      });
    } else {
      existing.messages.push(msg);
      // Prefer a defined transaction_id if any message in the thread carries one.
      if (!existing.transaction_id && msg.transaction_id) {
        existing.transaction_id = msg.transaction_id;
      }
      if (activity > existing.lastActivity) existing.lastActivity = activity;
    }
  }

  // Fallback: fill any thread still missing a transaction_id from the
  // communications junction (message_id or thread_id linkage).
  for (const thread of threadMap.values()) {
    if (thread.transaction_id) continue;
    const link = dbGet<{ transaction_id: string | null }>(
      `SELECT transaction_id FROM communications
       WHERE transaction_id IS NOT NULL
         AND (thread_id = ? OR message_id IN (${thread.messages.map(() => "?").join(", ")}))
       LIMIT 1`,
      [thread.thread_id, ...thread.messages.map((m) => m.id)],
    );
    if (link?.transaction_id) thread.transaction_id = link.transaction_id;
  }

  // Threads newest-activity-first; strip the internal lastActivity field.
  return Array.from(threadMap.values())
    .sort((a, b) => (b.lastActivity > a.lastActivity ? 1 : b.lastActivity < a.lastActivity ? -1 : 0))
    .map(({ thread_id, phoneNumber, messages, transaction_id }) => ({
      thread_id,
      phoneNumber,
      messages,
      transaction_id,
    }));
}

/**
 * Delete a contact
 */
export async function deleteContact(contactId: string): Promise<void> {
  const sql = "DELETE FROM contacts WHERE id = ?";
  dbRun(sql, [contactId]);
}

/**
 * Remove a contact from local database (un-import)
 * For contacts from external sources (Contacts App, Outlook), delete entirely
 * since they exist in the external_contacts shadow table and can be re-imported.
 * For other sources, just mark as unimported.
 */
export async function removeContact(contactId: string): Promise<void> {
  const contact = dbGet<{ source: string }>(
    "SELECT source FROM contacts WHERE id = ?",
    [contactId]
  );

  if (contact?.source === "contacts_app" || contact?.source === "outlook") {
    // Delete entirely - contact exists in external_contacts shadow table
    dbRun("DELETE FROM contacts WHERE id = ?", [contactId]);
  } else {
    // Keep in DB but mark as unimported
    dbRun("UPDATE contacts SET is_imported = 0 WHERE id = ?", [contactId]);
  }
}

/**
 * Get or create contact from email address
 */
export async function getOrCreateContactFromEmail(
  userId: string,
  email: string,
  name?: string,
): Promise<Contact> {
  // Try to find existing contact
  let contact = dbGet<Contact>(
    "SELECT * FROM contacts WHERE user_id = ? AND email = ?",
    [userId, email],
  );

  if (!contact) {
    // Create new contact
    contact = await createContact({
      user_id: userId,
      display_name: name || email.split("@")[0],
      email: email,
      source: "email",
      is_imported: true,
    });
  }

  return contact;
}

/**
 * Search contacts for selection modal (database-level search)
 * Searches both imported contacts and message-derived contacts.
 * Used when user types in search box - performs DB search instead of client-side filter.
 *
 * This fixes the LIMIT 200 issue where contacts beyond position 200 were unsearchable.
 * Search has no arbitrary LIMIT on the searchable pool - only limits result count.
 *
 * @param userId - User ID to search contacts for
 * @param query - Search query (min 2 characters for meaningful results)
 * @param limit - Maximum results to return (default 50)
 * @returns Contacts matching the search query, sorted by relevance
 */
export function searchContactsForSelection(
  userId: string,
  query: string,
  limit: number = 50
): ContactWithActivity[] {
  const searchPattern = `%${query}%`;

  // Get emails of imported contacts to exclude duplicates in message-derived results
  const importedEmailsSql = `
    SELECT LOWER(email) as email
    FROM contact_emails ce
    JOIN contacts c ON ce.contact_id = c.id
    WHERE c.user_id = ? AND c.is_imported = 1
  `;
  const importedEmailRows = dbAll<{ email: string }>(importedEmailsSql, [userId]);
  const importedEmails = new Set(importedEmailRows.map(r => r.email).filter(Boolean));

  // Search imported contacts
  // Searches across display_name, all emails, phone, and company
  // BACKLOG-506: Join emails FIRST, then communications by email_id
  const importedSql = `
    SELECT
      c.id,
      c.user_id,
      c.display_name,
      c.display_name as name,
      ce_primary.email as email,
      cp_primary.phone_e164 as phone,
      c.company,
      c.title,
      c.source,
      c.is_imported,
      0 as is_message_derived,
      MAX(e.sent_at) as last_communication_at,
      COUNT(DISTINCT comm.id) as communication_count,
      0 as address_mention_count
    FROM contacts c
    LEFT JOIN contact_emails ce_primary ON c.id = ce_primary.contact_id AND ce_primary.is_primary = 1
    LEFT JOIN contact_phones cp_primary ON c.id = cp_primary.contact_id AND cp_primary.is_primary = 1
    LEFT JOIN contact_emails ce_all ON c.id = ce_all.contact_id
    -- BACKLOG-1722: indexed exact-match via email_participants junction.
    -- The previous LIKE '%' || email || '%' on recipients was unindexed AND
    -- false-positive prone (matched alisa@x.com when querying lisa@x.com).
    LEFT JOIN email_participants ep ON ep.email_address = LOWER(ce_all.email)
    LEFT JOIN emails e ON e.id = ep.email_id AND e.user_id = c.user_id
    LEFT JOIN communications comm ON (
      comm.email_id = e.id
    )
    WHERE c.user_id = ? AND c.is_imported = 1
      AND (
        c.display_name LIKE ?
        OR ce_all.email LIKE ?
        OR cp_primary.phone_e164 LIKE ?
        OR c.company LIKE ?
      )
    GROUP BY c.id
    ORDER BY
      CASE WHEN c.display_name LIKE ? THEN 0 ELSE 1 END,
      last_communication_at DESC NULLS LAST
    LIMIT ?
  `;

  // Search message-derived contacts (no LIMIT 200 restriction when searching)
  // BACKLOG-313 filters still apply: exclude raw emails/phones as names
  const messageSql = `
    SELECT
      'msg_' || LOWER(json_extract(participants, '$.from')) as id,
      ? as user_id,
      json_extract(participants, '$.from') as display_name,
      json_extract(participants, '$.from') as name,
      CASE
        WHEN json_extract(participants, '$.from') LIKE '%@%'
        THEN LOWER(json_extract(participants, '$.from'))
        ELSE NULL
      END as email,
      CASE
        WHEN json_extract(participants, '$.from') NOT LIKE '%@%'
        THEN json_extract(participants, '$.from')
        ELSE NULL
      END as phone,
      NULL as company,
      NULL as title,
      'messages' as source,
      0 as is_imported,
      1 as is_message_derived,
      MAX(sent_at) as last_communication_at,
      COUNT(*) as communication_count,
      0 as address_mention_count
    FROM messages
    WHERE user_id = ?
      AND participants IS NOT NULL
      AND json_extract(participants, '$.from') IS NOT NULL
      AND json_extract(participants, '$.from') != ''
      AND json_extract(participants, '$.from') != 'me'
      -- BACKLOG-313: Filter out entries where "name" is raw phone/email (no display name)
      AND json_extract(participants, '$.from') NOT LIKE '%@%'
      AND json_extract(participants, '$.from') NOT LIKE '+%'
      AND json_extract(participants, '$.from') NOT GLOB '[0-9]*'
      AND json_extract(participants, '$.from') NOT LIKE 'urn:%'
      -- Search filter
      AND json_extract(participants, '$.from') LIKE ?
    GROUP BY LOWER(json_extract(participants, '$.from'))
    ORDER BY last_communication_at DESC
    LIMIT ?
  `;

  try {
    // Execute imported contacts search
    const importedResults = dbAll<ContactWithActivity>(importedSql, [
      userId,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern, // For ORDER BY CASE
      limit,
    ]);

    // Execute message-derived contacts search
    const messageResults = dbAll<ContactWithActivity>(messageSql, [
      userId, // For user_id column
      userId, // For WHERE clause
      searchPattern,
      limit,
    ]);

    // Filter out message-derived contacts whose email is already imported
    const filteredMessageResults = messageResults.filter(contact => {
      if (contact.email) {
        return !importedEmails.has(contact.email.toLowerCase());
      }
      return true;
    });

    // Merge results: imported first, then message-derived
    const allResults = [...importedResults, ...filteredMessageResults];

    // Sort by name match first, then by communication date
    allResults.sort((a, b) => {
      // Prioritize exact name prefix match
      const aNameMatch = (a.display_name || a.name || '').toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
      const bNameMatch = (b.display_name || b.name || '').toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
      if (aNameMatch !== bNameMatch) {
        return aNameMatch - bNameMatch;
      }

      // Then by last communication date
      const dateA = a.last_communication_at ? new Date(a.last_communication_at).getTime() : 0;
      const dateB = b.last_communication_at ? new Date(b.last_communication_at).getTime() : 0;
      return dateB - dateA;
    });

    // Return up to limit results
    return allResults.slice(0, limit);
  } catch (error) {
    logService.error("Error searching contacts for selection", "ContactDbService", {
      error: (error as Error).message,
      userId,
      query,
    });
    throw error;
  }
}

/**
 * Get email entries (with row IDs) for a contact — used by edit form
 */
export function getContactEmailEntries(contactId: string): { id: string; email: string; is_primary: boolean }[] {
  const sql = `
    SELECT id, email, is_primary
    FROM contact_emails
    WHERE contact_id = ?
    ORDER BY is_primary DESC, created_at ASC
  `;
  const rows = dbAll<{ id: string; email: string; is_primary: number }>(sql, [contactId]);
  logService.warn(`[DIAG-1270] getContactEmailEntries(${contactId}): ${rows.length} emails found`, 'ContactDbService');
  return rows.map(r => ({ id: r.id, email: r.email, is_primary: r.is_primary === 1 }));
}

/**
 * Get phone entries (with row IDs) for a contact — used by edit form
 */
export function getContactPhoneEntries(contactId: string): { id: string; phone: string; is_primary: boolean }[] {
  const sql = `
    SELECT id, phone_e164 as phone, is_primary
    FROM contact_phones
    WHERE contact_id = ?
    ORDER BY is_primary DESC, created_at ASC
  `;
  const rows = dbAll<{ id: string; phone: string; is_primary: number }>(sql, [contactId]);
  return rows.map(r => ({ id: r.id, phone: r.phone, is_primary: r.is_primary === 1 }));
}

/**
 * Sync contact email entries. Handles insert/update/delete to match incoming array.
 * Enforces exactly one primary email.
 */
export function syncContactEmails(
  contactId: string,
  emails: Array<{ id?: string; email: string; is_primary: boolean }>,
): void {
  // Filter and normalize incoming emails
  const incomingEmails = emails
    .filter((e) => e.email && e.email.trim())
    .map((e) => ({
      id: e.id || undefined,
      email: e.email.toLowerCase().trim(),
      is_primary: !!e.is_primary,
    }));

  // Enforce exactly one primary
  const hasPrimary = incomingEmails.some((e) => e.is_primary);
  if (!hasPrimary && incomingEmails.length > 0) {
    incomingEmails[0].is_primary = true;
  }

  // Get existing rows
  const existingEmails = getContactEmailEntries(contactId);
  const existingIds = new Set(existingEmails.map((e) => e.id));
  const incomingIds = new Set(incomingEmails.filter((e) => e.id).map((e) => e.id));

  // Delete rows not in incoming
  for (const existing of existingEmails) {
    if (!incomingIds.has(existing.id)) {
      dbRun("DELETE FROM contact_emails WHERE id = ?", [existing.id]);
    }
  }

  // Update existing / insert new
  for (const entry of incomingEmails) {
    if (entry.id && existingIds.has(entry.id)) {
      dbRun(
        "UPDATE contact_emails SET email = ?, is_primary = ? WHERE id = ?",
        [entry.email, entry.is_primary ? 1 : 0, entry.id],
      );
    } else {
      dbRun(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source, created_at) VALUES (?, ?, ?, ?, 'manual', CURRENT_TIMESTAMP)",
        [crypto.randomUUID(), contactId, entry.email, entry.is_primary ? 1 : 0],
      );
    }
  }
}

/**
 * Set a single email as primary for a contact (legacy backward-compat path).
 * If email doesn't exist in contact_emails, replaces all emails with this one.
 */
export function setContactPrimaryEmail(
  contactId: string,
  email: string,
): void {
  const newEmail = email?.trim();
  if (!newEmail) return;

  const normalizedEmail = newEmail.toLowerCase();
  const targetExists = dbGet<{ id: string }>(
    "SELECT id FROM contact_emails WHERE contact_id = ? AND LOWER(email) = LOWER(?)",
    [contactId, normalizedEmail],
  );

  if (targetExists) {
    dbRun("UPDATE contact_emails SET is_primary = 0 WHERE contact_id = ? AND id != ?", [contactId, targetExists.id]);
    dbRun("UPDATE contact_emails SET is_primary = 1 WHERE id = ?", [targetExists.id]);
  } else {
    dbRun("DELETE FROM contact_emails WHERE contact_id = ?", [contactId]);
    dbRun(
      "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, 1, 'manual')",
      [crypto.randomUUID(), contactId, normalizedEmail],
    );
  }
}

/**
 * Sync contact phone entries. Handles insert/update/delete to match incoming array.
 * Enforces exactly one primary phone.
 */
export function syncContactPhones(
  contactId: string,
  phones: Array<{ id?: string; phone: string; is_primary: boolean }>,
): void {
  // Filter and normalize incoming phones
  const incomingPhones = phones
    .filter((p) => p.phone && p.phone.trim())
    .map((p) => ({
      id: p.id || undefined,
      phone: p.phone.trim(),
      is_primary: !!p.is_primary,
    }));

  // Enforce exactly one primary
  const hasPrimary = incomingPhones.some((p) => p.is_primary);
  if (!hasPrimary && incomingPhones.length > 0) {
    incomingPhones[0].is_primary = true;
  }

  // Get existing rows
  const existingPhones = getContactPhoneEntries(contactId);
  const existingIds = new Set(existingPhones.map((p) => p.id));
  const incomingIds = new Set(incomingPhones.filter((p) => p.id).map((p) => p.id));

  // Delete rows not in incoming
  for (const existing of existingPhones) {
    if (!incomingIds.has(existing.id)) {
      dbRun("DELETE FROM contact_phones WHERE id = ?", [existing.id]);
    }
  }

  // Update existing / insert new
  for (const entry of incomingPhones) {
    if (entry.id && existingIds.has(entry.id)) {
      dbRun(
        "UPDATE contact_phones SET phone_e164 = ?, phone_normalized = ?, is_primary = ? WHERE id = ?",
        [entry.phone, toLookupKey(entry.phone), entry.is_primary ? 1 : 0, entry.id],
      );
    } else {
      dbRun(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source, created_at) VALUES (?, ?, ?, ?, ?, 'manual', CURRENT_TIMESTAMP)",
        [crypto.randomUUID(), contactId, entry.phone, toLookupKey(entry.phone), entry.is_primary ? 1 : 0],
      );
    }
  }
}

/**
 * Set a single phone as primary for a contact (legacy backward-compat path).
 * If phone doesn't exist in contact_phones, updates the top phone or inserts new.
 */
export function setContactPrimaryPhone(
  contactId: string,
  phone: string,
): void {
  const newPhone = phone?.trim();
  if (!newPhone) return;

  const targetPhoneExists = dbGet<{ id: string }>(
    "SELECT id FROM contact_phones WHERE contact_id = ? AND phone_e164 = ?",
    [contactId, newPhone],
  );

  if (targetPhoneExists) {
    dbRun("UPDATE contact_phones SET is_primary = 0 WHERE contact_id = ? AND id != ?", [contactId, targetPhoneExists.id]);
    dbRun("UPDATE contact_phones SET is_primary = 1 WHERE id = ?", [targetPhoneExists.id]);
  } else {
    const existingPhone = dbGet<{ id: string }>(
      "SELECT id FROM contact_phones WHERE contact_id = ? ORDER BY is_primary DESC LIMIT 1",
      [contactId],
    );
    if (existingPhone) {
      dbRun("UPDATE contact_phones SET phone_e164 = ?, phone_normalized = ?, is_primary = 1 WHERE id = ?", [newPhone, toLookupKey(newPhone), existingPhone.id]);
    } else {
      dbRun(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, 1, 'manual')",
        [crypto.randomUUID(), contactId, newPhone, toLookupKey(newPhone)],
      );
    }
  }
}

// ============================================
// CONTACT EMAIL QUERY HELPERS (TASK-2000)
// Extracted from emailSyncHandlers.ts raw SQL
// ============================================

/**
 * Get all distinct email addresses for contacts assigned to a transaction.
 * Used by email sync to filter provider searches by relevant contacts.
 */
export function getContactEmailsForTransaction(transactionId: string): string[] {
  const rows = dbAll<{ email: string }>(
    `SELECT DISTINCT LOWER(ce.email) as email
     FROM transaction_contacts tc
     JOIN contact_emails ce ON tc.contact_id = ce.contact_id
     WHERE tc.transaction_id = ?`,
    [transactionId],
  );
  return rows.map((r) => r.email);
}

/**
 * Get email addresses for a single contact (by contact ID).
 * Used during email sync to collect per-contact emails.
 */
export function getEmailsByContactId(contactId: string): string[] {
  const rows = dbAll<{ email: string }>(
    "SELECT email FROM contact_emails WHERE contact_id = ?",
    [contactId],
  );
  return rows.map((r) => r.email);
}

/**
 * Resolve a search query to matching contact email addresses.
 * Searches display_name, email, company, and title fields.
 * Used to translate user search terms into email-based provider filters.
 */
export function resolveContactEmailsByQuery(userId: string, query: string): string[] {
  const queryLower = query.toLowerCase().trim();
  const words = queryLower.split(/\s+/).filter((w) => w.length > 0);

  if (words.length <= 1) {
    // Single-word query: original behavior
    const rows = dbAll<{ email: string }>(
      `SELECT DISTINCT LOWER(ce.email) as email
       FROM contacts c
       JOIN contact_emails ce ON c.id = ce.contact_id
       WHERE c.user_id = ?
         AND (LOWER(c.display_name) LIKE ? OR LOWER(ce.email) LIKE ?
              OR LOWER(c.company) LIKE ? OR LOWER(c.title) LIKE ?)`,
      [userId, `%${queryLower}%`, `%${queryLower}%`, `%${queryLower}%`, `%${queryLower}%`],
    );
    return rows.map((r) => r.email);
  }

  // Multi-word query: each word must match at least one field (AND logic across words)
  const wordClauses = words.map(
    () =>
      `(LOWER(c.display_name) LIKE ? OR LOWER(ce.email) LIKE ?
        OR LOWER(c.company) LIKE ? OR LOWER(c.title) LIKE ?)`,
  );
  const params: string[] = [userId];
  for (const word of words) {
    params.push(`%${word}%`, `%${word}%`, `%${word}%`, `%${word}%`);
  }

  const rows = dbAll<{ email: string }>(
    `SELECT DISTINCT LOWER(ce.email) as email
     FROM contacts c
     JOIN contact_emails ce ON c.id = ce.contact_id
     WHERE c.user_id = ?
       AND ${wordClauses.join("\n       AND ")}`,
    params,
  );
  return rows.map((r) => r.email);
}

// Export types for consumers
export type { ContactWithActivity, TransactionWithRoles };
