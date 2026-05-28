/**
 * Contact Database Service
 * Handles all contact-related database operations
 */

import crypto from "crypto";
import type { Contact, NewContact, ContactFilters } from "../../types";
import { DatabaseError } from "../../types";
import { dbGet, dbAll, dbRun, dbTransaction } from "./core/dbConnection";
import logService from "../logService";
import { validateFields } from "../../utils/sqlFieldWhitelist";
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
interface TransactionWithRoles {
  id: string;
  property_address: string;
  closing_deadline?: string | null;
  transaction_type?: string | null;
  status: string;
  roles: string;
}

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
  const sql = `
    INSERT INTO contacts (
      id, user_id, display_name, company, title, source, is_imported
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
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
        id, contact_id, phone_e164, phone_display, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)
    `;
    dbRun(phoneSql, [phoneId, id, phoneE164, phone, isFirstPhone ? 1 : 0]);
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
          `INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164, phone_display, is_primary, source, created_at)
           VALUES (?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`,
          [crypto.randomUUID(), id, phoneE164, phone, isFirstPhone ? 1 : 0]
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
 * These are contacts synced from iPhone that haven't been imported yet
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
      ) as phone
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
        id, contact_id, phone_e164, phone_display, is_primary, source, created_at
      ) VALUES (?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)
    `;
    const result = dbRun(phoneSql, [phoneId, contactId, phoneE164, phone, isPrimary]);
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

    // Merge: imported contacts first (already sorted), then message-derived
    // Message-derived contacts go at the end since they're less relevant for transaction assignment
    return [...importedContacts, ...messageDerivedWithActivity];
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

  // Convert map to array and format roles
  return Array.from(transactionMap.values()).map((txn) => ({
    ...txn,
    roles: [...new Set(txn.roles)].join(", "),
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
    LEFT JOIN emails e ON (
      ce_all.email IS NOT NULL
      AND (
        LOWER(e.sender) = LOWER(ce_all.email)
        OR LOWER(e.recipients) LIKE '%' || LOWER(ce_all.email) || '%'
      )
      AND e.user_id = c.user_id
    )
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
        "UPDATE contact_phones SET phone_e164 = ?, is_primary = ? WHERE id = ?",
        [entry.phone, entry.is_primary ? 1 : 0, entry.id],
      );
    } else {
      dbRun(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary, source, created_at) VALUES (?, ?, ?, ?, 'manual', CURRENT_TIMESTAMP)",
        [crypto.randomUUID(), contactId, entry.phone, entry.is_primary ? 1 : 0],
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
      dbRun("UPDATE contact_phones SET phone_e164 = ?, is_primary = 1 WHERE id = ?", [newPhone, existingPhone.id]);
    } else {
      dbRun(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, is_primary, source) VALUES (?, ?, ?, 1, 'manual')",
        [crypto.randomUUID(), contactId, newPhone],
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
