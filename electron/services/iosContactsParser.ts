/**
 * iOS Contacts Parser Service
 *
 * Parses the iOS AddressBook.sqlitedb database from iTunes-style backups
 * to extract contact information for matching with message handles.
 *
 * The AddressBook database is stored in iOS backups as a file with a
 * specific hash name. This service reads that file and provides lookup
 * methods to resolve phone numbers and email addresses to contact names.
 */

import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import path from "path";
import log from "electron-log";
import type {
  iOSContact,
  iOSContactPhone,
  iOSContactEmail,
  ContactLookupResult,
  RawContactRow,
  RawMultiValueRow,
} from "../types/iosContacts";
import { ABMultiValuePropertyType } from "../types/iosContacts";
import {
  toE164,
  isPhoneNumber,
  getTrailingDigits,
} from "../utils/phoneNormalization";

/**
 * Parser for iOS AddressBook.sqlitedb from iTunes-style backups.
 *
 * Usage:
 * ```typescript
 * const parser = new iOSContactsParser();
 * parser.open('/path/to/backup');
 * const contacts = parser.getAllContacts();
 * const result = parser.lookupByHandle('+15551234567');
 * parser.close();
 * ```
 */
export class iOSContactsParser {
  private db: DatabaseType | null = null;
  private phoneIndex: Map<string, number> = new Map(); // normalized phone (trailing digits) -> contact id
  private emailIndex: Map<string, number> = new Map(); // lowercase email -> contact id
  private contactCache: Map<number, iOSContact> = new Map(); // contact id -> contact

  /** The AddressBook hash in iOS backups (SHA1 of domain-path) */
  static readonly ADDRESSBOOK_DB_HASH =
    "31bb7ba8914766d4ba40d6dfb6113c8b614be442";

  // Prepared statements
  private stmtAllContacts: Statement | null = null;
  private stmtMultiValues: Statement | null = null;
  private stmtContactById: Statement | null = null;
  private stmtMultiValuesByContact: Statement | null = null;

  /**
   * Get the full path to a file in an iOS backup.
   * iOS backups store files in subdirectories based on the first 2 characters of the hash.
   * e.g., hash "31bb7ba8..." is stored at "31/31bb7ba8..."
   */
  private static getBackupFilePath(backupPath: string, hash: string): string {
    return path.join(backupPath, hash.substring(0, 2), hash);
  }

  /**
   * Opens the AddressBook database from a backup directory.
   *
   * @param backupPath - Path to the iOS backup directory
   * @throws Error if the database file is not found or cannot be opened
   */
  open(backupPath: string): void {
    const dbPath = iOSContactsParser.getBackupFilePath(
      backupPath,
      iOSContactsParser.ADDRESSBOOK_DB_HASH,
    );

    try {
      // Open in readonly mode - we never modify the backup
      this.db = new Database(dbPath, { readonly: true });
      log.info("[iOSContactsParser] Opened AddressBook database");

      this.prepareStatements();
      this.buildLookupIndexes();
    } catch (error) {
      log.error("[iOSContactsParser] Failed to open AddressBook database", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Closes the database connection and clears all caches.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      log.info("[iOSContactsParser] Closed AddressBook database");
    }

    this.phoneIndex.clear();
    this.emailIndex.clear();
    this.contactCache.clear();
    this.stmtAllContacts = null;
    this.stmtMultiValues = null;
    this.stmtContactById = null;
    this.stmtMultiValuesByContact = null;
  }

  /**
   * Checks if the database is currently open.
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Prepares SQL statements for reuse.
   */
  private prepareStatements(): void {
    if (!this.db) return;

    // Get all contacts from ABPerson table
    this.stmtAllContacts = this.db.prepare(`
      SELECT
        ROWID,
        First,
        Last,
        Organization
      FROM ABPerson
      ORDER BY ROWID
    `);

    // Get all multi-values (phones, emails) with labels
    this.stmtMultiValues = this.db.prepare(`
      SELECT
        mv.record_id,
        mv.property,
        COALESCE(mvl.value, 'other') as label,
        mv.value
      FROM ABMultiValue mv
      LEFT JOIN ABMultiValueLabel mvl ON mv.label = mvl.ROWID
      WHERE mv.property IN (?, ?)
      ORDER BY mv.record_id
    `);

    // Get single contact by ID
    this.stmtContactById = this.db.prepare(`
      SELECT
        ROWID,
        First,
        Last,
        Organization
      FROM ABPerson
      WHERE ROWID = ?
    `);

    // Get multi-values for a specific contact
    this.stmtMultiValuesByContact = this.db.prepare(`
      SELECT
        mv.record_id,
        mv.property,
        COALESCE(mvl.value, 'other') as label,
        mv.value
      FROM ABMultiValue mv
      LEFT JOIN ABMultiValueLabel mvl ON mv.label = mvl.ROWID
      WHERE mv.record_id = ?
        AND mv.property IN (?, ?)
    `);
  }

  /**
   * Builds in-memory indexes for fast phone and email lookups.
   * Called automatically when opening the database.
   */
  private buildLookupIndexes(): void {
    if (!this.db || !this.stmtAllContacts || !this.stmtMultiValues) {
      return;
    }

    const startTime = Date.now();

    // Get all contacts
    const contacts = this.stmtAllContacts.all() as RawContactRow[];

    // Get all multi-values (phones and emails)
    const multiValues = this.stmtMultiValues.all(
      ABMultiValuePropertyType.PHONE,
      ABMultiValuePropertyType.EMAIL,
    ) as RawMultiValueRow[];

    // Group multi-values by contact ID
    const multiValuesByContact = new Map<number, RawMultiValueRow[]>();
    for (const mv of multiValues) {
      const existing = multiValuesByContact.get(mv.record_id) || [];
      existing.push(mv);
      multiValuesByContact.set(mv.record_id, existing);
    }

    // Build contacts and indexes
    for (const row of contacts) {
      const contactMultiValues = multiValuesByContact.get(row.ROWID) || [];
      const contact = this.buildContact(row, contactMultiValues);

      // Cache the contact
      this.contactCache.set(contact.id, contact);

      // Index phone numbers (using trailing 10 digits for fuzzy matching)
      for (const phone of contact.phoneNumbers) {
        const key = getTrailingDigits(phone.normalizedNumber, 10);
        if (key.length >= 7) {
          // Only index if we have enough digits
          this.phoneIndex.set(key, contact.id);
        }
      }

      // Index email addresses (lowercase for case-insensitive matching)
      for (const email of contact.emails) {
        this.emailIndex.set(email.email.toLowerCase(), contact.id);
      }
    }

    const elapsed = Date.now() - startTime;
    log.info("[iOSContactsParser] Built lookup indexes", {
      contactCount: contacts.length,
      phoneIndexSize: this.phoneIndex.size,
      emailIndexSize: this.emailIndex.size,
      elapsedMs: elapsed,
    });
  }

  /**
   * Builds a contact object from raw database rows.
   */
  private buildContact(
    row: RawContactRow,
    multiValues: RawMultiValueRow[],
  ): iOSContact {
    const phoneNumbers: iOSContactPhone[] = [];
    const emails: iOSContactEmail[] = [];

    for (const mv of multiValues) {
      if (mv.property === ABMultiValuePropertyType.PHONE) {
        phoneNumbers.push({
          label: this.cleanLabel(mv.label),
          number: mv.value,
          normalizedNumber: toE164(mv.value),
        });
      } else if (mv.property === ABMultiValuePropertyType.EMAIL) {
        emails.push({
          label: this.cleanLabel(mv.label),
          email: mv.value,
        });
      }
    }

    return {
      id: row.ROWID,
      firstName: row.First,
      lastName: row.Last,
      organization: row.Organization,
      phoneNumbers,
      emails,
      displayName: this.computeDisplayName(
        row.First,
        row.Last,
        row.Organization,
      ),
    };
  }

  /**
   * Cleans up a label value from the database.
   * iOS stores labels like "_$!<Mobile>!$_" - we extract just "Mobile".
   */
  private cleanLabel(label: string | null): string {
    if (!label) return "other";

    // iOS uses format like "_$!<Mobile>!$_" or "_$!<Home>!$_"
    const match = label.match(/_\$!<(.+)>!\$_/);
    if (match) {
      return match[1].toLowerCase();
    }

    return label.toLowerCase();
  }

  /**
   * Computes a display name from contact fields.
   * Priority: "First Last" > Organization > "Unknown"
   */
  private computeDisplayName(
    firstName: string | null,
    lastName: string | null,
    organization: string | null,
  ): string {
    const parts: string[] = [];

    if (firstName?.trim()) {
      parts.push(firstName.trim());
    }
    if (lastName?.trim()) {
      parts.push(lastName.trim());
    }

    if (parts.length > 0) {
      return parts.join(" ");
    }

    if (organization?.trim()) {
      return organization.trim();
    }

    return "Unknown";
  }

  /**
   * Gets all contacts from the database.
   *
   * @returns Array of all contacts
   */
  getAllContacts(): iOSContact[] {
    return Array.from(this.contactCache.values());
  }

  /**
   * Gets a contact by its database ID.
   *
   * @param id - The contact's ROWID from ABPerson
   * @returns The contact, or null if not found
   */
  getContactById(id: number): iOSContact | null {
    // Check cache first
    const cached = this.contactCache.get(id);
    if (cached) {
      return cached;
    }

    // If not in cache and DB is open, try to fetch
    if (!this.db || !this.stmtContactById || !this.stmtMultiValuesByContact) {
      return null;
    }

    const row = this.stmtContactById.get(id) as RawContactRow | undefined;
    if (!row) {
      return null;
    }

    const multiValues = this.stmtMultiValuesByContact.all(
      id,
      ABMultiValuePropertyType.PHONE,
      ABMultiValuePropertyType.EMAIL,
    ) as RawMultiValueRow[];

    const contact = this.buildContact(row, multiValues);
    this.contactCache.set(id, contact);

    return contact;
  }

  /**
   * Looks up a contact by phone number.
   *
   * @param phoneNumber - Phone number in any format
   * @returns Lookup result with contact and match type
   */
  lookupByPhone(phoneNumber: string): ContactLookupResult {
    const key = getTrailingDigits(phoneNumber, 10);

    const contactId = this.phoneIndex.get(key);
    if (contactId === undefined) {
      return { contact: null, matchedOn: null };
    }

    const contact = this.getContactById(contactId);
    return {
      contact,
      matchedOn: contact ? "phone" : null,
    };
  }

  /**
   * Looks up a contact by email address.
   *
   * @param email - Email address (case-insensitive)
   * @returns Lookup result with contact and match type
   */
  lookupByEmail(email: string): ContactLookupResult {
    const key = email.toLowerCase();

    const contactId = this.emailIndex.get(key);
    if (contactId === undefined) {
      return { contact: null, matchedOn: null };
    }

    const contact = this.getContactById(contactId);
    return {
      contact,
      matchedOn: contact ? "email" : null,
    };
  }

  /**
   * Looks up a contact by a message handle (phone or email).
   * Automatically determines whether the handle is a phone or email.
   *
   * @param handle - The handle string from a message (phone or email)
   * @returns Lookup result with contact and match type
   */
  lookupByHandle(handle: string): ContactLookupResult {
    if (!handle || handle.trim().length === 0) {
      return { contact: null, matchedOn: null };
    }

    const trimmedHandle = handle.trim();

    // Determine if handle is phone or email
    if (isPhoneNumber(trimmedHandle)) {
      return this.lookupByPhone(trimmedHandle);
    } else {
      return this.lookupByEmail(trimmedHandle);
    }
  }

  /**
   * Gets the total number of contacts loaded.
   */
  getContactCount(): number {
    return this.contactCache.size;
  }

  /**
   * Gets statistics about the loaded contacts.
   */
  getStats(): {
    contactCount: number;
    phoneIndexSize: number;
    emailIndexSize: number;
  } {
    return {
      contactCount: this.contactCache.size,
      phoneIndexSize: this.phoneIndex.size,
      emailIndexSize: this.emailIndex.size,
    };
  }
}

// Export singleton instance for convenience
export const iosContactsParser = new iOSContactsParser();
export default iosContactsParser;
