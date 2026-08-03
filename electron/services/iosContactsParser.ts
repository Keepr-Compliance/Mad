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
 * ABPerson columns selected LITERALLY, unconditionally, always.
 *
 * BACKLOG-2407 — these MUST NOT be probe-gated. `PRAGMA table_info` does not
 * list an implicit rowid, so a probe governing `ROWID` would emit
 * `NULL AS ROWID` against any ABPerson that does not declare it and null the id
 * of every contact — silent total corruption, strictly worse than the crash the
 * probe exists to prevent.
 *
 * BACKLOG-2413 — EACH ONE IS ALIASED TO ITSELF, which looks redundant and is
 * not. It is the same result-key trap `identitySelectList()` documents at
 * length, and the bare form left the REQUIRED columns exposed to it while the
 * optional ones were fixed. SQLite resolves an identifier case-insensitively
 * but names the RESULT column after the case it was DECLARED with — and an
 * implicit rowid has no declared case at all, so `SELECT ROWID` comes back
 * under the key `rowid`.
 *
 * Measured on the real driver, bare form vs. this one:
 *
 *   declared `first`/`last`/`organization` — keys `first`/`last`/`organization`,
 *     so `row.First` is undefined and `computeDisplayName` optional-chains past
 *     three undefineds to `"Unknown"`. Cosmetic: matching is on phone/email.
 *   declared `rowid`, OR an IMPLICIT rowid — key `rowid`, so `row.ROWID` is
 *     undefined and `id` is undefined. `buildLookupIndexes()` then misses on
 *     `multiValuesByContact.get(undefined)` and EVERY contact imports with zero
 *     phones and zero emails, while `contactCache.set(undefined, …)` collapses
 *     the whole address book to one entry. The import reports success and
 *     produces contacts that can match nothing.
 *
 * The implicit-rowid shape is precisely the one a probe cannot rescue —
 * `PRAGMA table_info` never lists it — which is why this is an unconditional
 * alias and not an extension of `ABPERSON_OPTIONAL_COLUMNS`. Identical output
 * on the canonical schema, strictly better on every other shape tested. Pinned
 * by the implicit-rowid, lower-case-rowid and lower-case-name suites in
 * `iosContactsParser.realSchema.test.ts`.
 */
const ABPERSON_REQUIRED_COLUMNS =
  "ROWID AS ROWID, First AS First, Last AS Last, Organization AS Organization";

/**
 * ABPerson identity columns (BACKLOG-2407), each emitted only if this backup's
 * ABPerson actually has it.
 *
 * WHY PROBED RATHER THAN HARDCODED INTO THE SQL. `db.prepare()` validates column
 * names, so a `SELECT` naming a column the backup lacks THROWS — inside
 * `open()`, which rethrows at :87-92 — taking down the ENTIRE iPhone contacts
 * import for that user. iPhone sync is the ungated DEFAULT import source for
 * every Windows user (`useImportSource.ts:20-22`), so that blast radius is not
 * niche. The identical hazard on the identical backup format is already handled
 * this way for `message.audio_transcript` in the sibling parser
 * (`iosMessagesParser.ts:192-210`); this mirrors that mechanism rather than
 * inventing a variant.
 *
 * These constants are the ONLY text ever placed into the SQL. The probe decides
 * *whether* an entry is emitted, never *what* is emitted — the `.sqlitedb` is a
 * user-supplied restored backup, and splicing an identifier read out of it into
 * a statement would be a needless injection surface, readonly or not.
 */
const ABPERSON_OPTIONAL_COLUMNS = [
  "ExternalUUID",
  "ExternalIdentifier",
  "ExternalModificationTag",
  "ModificationDate",
  "CreationDate",
  "StoreID",
] as const;

/**
 * Apple/CF absolute time (SECONDS since 2001-01-01T00:00:00Z) to ISO-8601.
 *
 * DELIBERATELY NOT `iosMessagesParser.convertAppleTimestamp()` and NOT
 * `dateUtils.macTimestampToDate()`. Both divide by 1e6 because `sms.db` stores
 * NANOSECONDS; `AddressBook.sqlitedb` stores SECONDS. Reusing either would put
 * every contact date in 2001 — wrong by ~31 years, in a direction nothing would
 * flag. (`macTimestampToDate` also returns `new Date(0)` rather than null for a
 * falsy input, wrong here a second time.)
 *
 * Not generalised with a unit parameter on purpose: that would edit the messages
 * import path and the macOS date path from a task whose whole point is to change
 * no behaviour.
 */
export function appleSecondsToIso(
  seconds: number | null | undefined,
): string | null {
  if (seconds === null || seconds === undefined || seconds === 0) {
    return null;
  }
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return null;
  }

  const APPLE_EPOCH_MS = 978307200000;
  const date = new Date(APPLE_EPOCH_MS + seconds * 1000);

  // An out-of-range value produces an Invalid Date, whose toISOString() throws.
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

/**
 * Population counts for the identity columns (BACKLOG-2407).
 *
 * The deliverable of the capture, not a nicety. Whether `ExternalUUID` is a
 * usable key or merely a secondary signal is an empirical question about real
 * address books, and this is the instrument that answers it.
 *
 * Counters ONLY — never a record id, never a name. These reach logs and support
 * tickets (`contactsDiagnostics.ts:358`).
 */
export interface IdentityCaptureStats {
  /** Contacts parsed — the denominator for every count below. */
  total: number;
  externalUuid: number;
  externalIdentifier: number;
  externalModificationTag: number;
  modifiedAt: number;
  createdAt: number;
  /** Distinct non-null StoreIDs. Explains a sparse `externalUuid`. */
  distinctStores: number;
  /**
   * Identity columns this backup's ABPerson did NOT have, so "column absent" is
   * distinguishable from "column present but empty" — a distinction the whole
   * measurement depends on.
   */
  missingColumns: string[];
}

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
   * BACKLOG-2407: identity columns this backup's ABPerson actually has, cached
   * per open database and cleared in close() — the shape
   * `iosMessagesParser.checkAudioTranscriptColumn()` uses. Null until probed.
   */
  private availableIdentityColumns: Set<string> | null = null;

  /** BACKLOG-2407: population counts, computed once while indexes are built. */
  private identityStats: IdentityCaptureStats | null = null;

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
    // BACKLOG-2407: the probe result belongs to the database that was open, not
    // to the parser. Leaving it set would apply one backup's column shape to the
    // next one opened (the singleton at the bottom of this file is reused).
    this.availableIdentityColumns = null;
    this.identityStats = null;
  }

  /**
   * Checks if the database is currently open.
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * BACKLOG-2407: which identity columns this ABPerson has.
   *
   * CASE. `PRAGMA table_info` reports the column's DECLARED case while SQLite
   * resolves names case-insensitively, so a raw `includes()` would report a
   * present column absent on any backup whose declaration differs in case —
   * losing the data on exactly the databases that have it. Both sides are
   * lower-cased.
   *
   * DETECTING IT IS ONLY HALF THE JOB. A probe that answers "present" while the
   * SELECT emits the bare column still loses the value, because the row comes
   * back keyed under the DECLARED case. `identitySelectList()` aliases every
   * present column back to the case production reads; without that alias this
   * lower-casing buys nothing at all.
   *
   * FAILURE. A probe that throws is treated as "no identity columns": the parser
   * then behaves exactly as it did before this task rather than failing the
   * import, which is the entire point of probing.
   */
  private probeIdentityColumns(): Set<string> {
    if (this.availableIdentityColumns !== null) {
      return this.availableIdentityColumns;
    }

    const present = new Set<string>();
    try {
      if (!this.db) {
        throw new Error("Database not open");
      }
      const rows = this.db.prepare("PRAGMA table_info(ABPerson)").all() as Array<{
        name: string;
      }>;
      const declared = new Set(rows.map((r) => String(r.name).toLowerCase()));
      for (const col of ABPERSON_OPTIONAL_COLUMNS) {
        if (declared.has(col.toLowerCase())) {
          present.add(col);
        }
      }
    } catch (error) {
      log.warn("[iOSContactsParser] ABPerson column probe failed; capturing none", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    this.availableIdentityColumns = present;
    return present;
  }

  /**
   * BACKLOG-2407: the identity part of an ABPerson SELECT list.
   *
   * A column the backup has is selected `<col> AS <col>`; one it lacks becomes
   * `NULL AS <col>`. Either way the row shape is IDENTICAL, so `RawContactRow`
   * can type every field as present-and-nullable rather than optional. Only the
   * constants in `ABPERSON_OPTIONAL_COLUMNS` are ever emitted.
   *
   * WHY THE PRESENT BRANCH IS ALIASED TO ITSELF, WHICH LOOKS REDUNDANT AND IS
   * NOT. SQLite resolves an identifier case-insensitively but names the RESULT
   * column after the case it was DECLARED with. Against an ABPerson declaring
   * `EXTERNALUUID`, `SELECT ExternalUUID` therefore succeeds and returns the row
   * keyed `EXTERNALUUID`; `row.ExternalUUID` is `undefined`, and `buildContact`'s
   * `?? null` converts that into a null capture. The bare form made the
   * case-insensitive probe above a NO-OP — identical in outcome to having no
   * case handling at all, while reading as a protection. Measured on the real
   * driver: with `EXTERNALUUID` declared, the bare form yields result key
   * `EXTERNALUUID` and captures null; `ExternalUUID AS ExternalUUID` yields key
   * `ExternalUUID` and captures the value. Pinned by the "declared in a
   * different case" suite in `iosContactsParser.realSchema.test.ts`, and the
   * same result-key trap on this same table is why that file declares `ROWID`
   * explicitly (see its ABPERSON_REAL_SCHEMA note).
   */
  private identitySelectList(): string {
    const present = this.probeIdentityColumns();
    return ABPERSON_OPTIONAL_COLUMNS.map((col) =>
      present.has(col) ? `        ${col} AS ${col}` : `        NULL AS ${col}`,
    ).join(",\n");
  }

  /**
   * Prepares SQL statements for reuse.
   */
  private prepareStatements(): void {
    if (!this.db) return;

    // BACKLOG-2407: BOTH ABPerson statements are built from the same list. The
    // by-id statement below is not dead code — getContactById() falls through to
    // it on a cache miss, so widening only the first would have that path return
    // contacts whose identity fields were silently undefined.
    const identityColumns = this.identitySelectList();

    // Get all contacts from ABPerson table
    this.stmtAllContacts = this.db.prepare(`
      SELECT
        ${ABPERSON_REQUIRED_COLUMNS},
${identityColumns}
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
        ${ABPERSON_REQUIRED_COLUMNS},
${identityColumns}
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

    // BACKLOG-2407: measure the identity capture over everything just parsed.
    this.identityStats = this.computeIdentityStats();

    const elapsed = Date.now() - startTime;
    log.info("[iOSContactsParser] Built lookup indexes", {
      contactCount: contacts.length,
      phoneIndexSize: this.phoneIndex.size,
      emailIndexSize: this.emailIndex.size,
      elapsedMs: elapsed,
    });

    // BACKLOG-2407: the population rate, as one PII-free counter line.
    //
    // This exists to answer whether ExternalUUID is a usable cross-device key or
    // only a secondary matching signal — a question about real address books
    // that cannot be settled by reading Apple's schema. Sparse is the EXPECTED
    // result for contacts in the local "On My iPhone" store with no server
    // behind them, which is why storeCount is here to explain it.
    //
    // Counters only: no record id, no name, no email. These lines ship in real
    // user logs and land in support tickets (contactsDiagnostics.ts:358).
    const s = this.identityStats;
    log.info("[iOSContactsParser] Identity capture (BACKLOG-2407)", {
      total: s.total,
      externalUuid: `${s.externalUuid}/${s.total}`,
      externalIdentifier: `${s.externalIdentifier}/${s.total}`,
      externalModificationTag: `${s.externalModificationTag}/${s.total}`,
      modifiedAt: `${s.modifiedAt}/${s.total}`,
      createdAt: `${s.createdAt}/${s.total}`,
      distinctStores: s.distinctStores,
      missingColumns: s.missingColumns.length > 0 ? s.missingColumns : "none",
    });
  }

  /**
   * BACKLOG-2407: count how many parsed contacts carry each identity field.
   *
   * `missingColumns` is reported separately from a zero count on purpose: a
   * column the backup does not HAVE and a column present but empty are different
   * findings, and collapsing them would make the measurement unreadable.
   */
  private computeIdentityStats(): IdentityCaptureStats {
    const present = this.probeIdentityColumns();
    const stores = new Set<number>();

    const stats: IdentityCaptureStats = {
      total: this.contactCache.size,
      externalUuid: 0,
      externalIdentifier: 0,
      externalModificationTag: 0,
      modifiedAt: 0,
      createdAt: 0,
      distinctStores: 0,
      missingColumns: ABPERSON_OPTIONAL_COLUMNS.filter(
        (col) => !present.has(col),
      ),
    };

    for (const contact of this.contactCache.values()) {
      if (contact.externalUuid) stats.externalUuid++;
      if (contact.externalIdentifier) stats.externalIdentifier++;
      if (contact.externalModificationTag) stats.externalModificationTag++;
      if (contact.modifiedAt) stats.modifiedAt++;
      if (contact.createdAt) stats.createdAt++;
      if (contact.storeId !== null) stores.add(contact.storeId);
    }

    stats.distinctStores = stores.size;
    return stats;
  }

  /**
   * BACKLOG-2407: identity-capture population for the currently open backup.
   *
   * Returns an all-zero shape when nothing has been parsed, so a caller never
   * has to null-check a measurement.
   */
  getIdentityStats(): IdentityCaptureStats {
    return (
      this.identityStats ?? {
        total: 0,
        externalUuid: 0,
        externalIdentifier: 0,
        externalModificationTag: 0,
        modifiedAt: 0,
        createdAt: 0,
        distinctStores: 0,
        missingColumns: [...ABPERSON_OPTIONAL_COLUMNS],
      }
    );
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
      // BACKLOG-2407 — captured, never matched on. `?? null` because a column
      // the backup lacks arrives as NULL, and a legacy caller constructing a row
      // without these (the mock-based unit test does exactly that) must yield
      // null rather than undefined so the declared type stays honest.
      externalUuid: row.ExternalUUID ?? null,
      externalIdentifier: row.ExternalIdentifier ?? null,
      externalModificationTag: row.ExternalModificationTag ?? null,
      modifiedAt: appleSecondsToIso(row.ModificationDate),
      createdAt: appleSecondsToIso(row.CreationDate),
      storeId: row.StoreID ?? null,
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
