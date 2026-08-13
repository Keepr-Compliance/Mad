/**
 * iOS Contacts Database Types
 *
 * Type definitions for parsing iOS AddressBook.sqlitedb contacts
 * from iTunes-style backups.
 */

/**
 * Phone number entry from an iOS contact
 */
export interface iOSContactPhone {
  /** Label for the phone number (e.g., "mobile", "home", "work") */
  label: string;
  /** Raw phone number as stored in the database */
  number: string;
  /** Normalized phone number in E.164 format for matching */
  normalizedNumber: string;
}

/**
 * Email address entry from an iOS contact
 */
export interface iOSContactEmail {
  /** Label for the email address (e.g., "home", "work") */
  label: string;
  /** Email address */
  email: string;
}

/**
 * Parsed iOS contact with all associated data
 */
export interface iOSContact {
  /**
   * Contact ID (ROWID from ABPerson table).
   *
   * BACKLOG-2407 — DEVICE-LOCAL, and the reason the fields below exist.
   * `ABPerson.ROWID` is `INTEGER PRIMARY KEY AUTOINCREMENT`: stable across
   * repeated syncs of the SAME phone, meaningless across a new device, a
   * restore-from-backup, or an address-book rebuild. It REMAINS the key
   * (`external_record_id`) — nothing in this task changes that.
   */
  id: number;
  /** First name, or null if not set */
  firstName: string | null;
  /** Last name, or null if not set */
  lastName: string | null;
  /** Organization name, or null if not set */
  organization: string | null;
  /** All phone numbers associated with this contact */
  phoneNumbers: iOSContactPhone[];
  /** All email addresses associated with this contact */
  emails: iOSContactEmail[];
  /** Computed display name: "First Last", Organization, or "Unknown" */
  displayName: string;

  // -------------------------------------------------------------------------
  // BACKLOG-2407 — CAPTURED, NEVER MATCHED ON
  //
  // Every field below is stored and read by NOTHING. They are captured because
  // capturing them is nearly free today and IMPOSSIBLE later: you cannot go back
  // and read a phone the user no longer owns. The iPhone path is the ungated
  // DEFAULT import source for every Windows user (useImportSource.ts:20-22), so
  // the population of contacts imported without them grows with every install.
  //
  // These are `T | null`, never optional. The parser emits `NULL AS <col>` for
  // any column the backup's ABPerson lacks, so each field is ALWAYS PRESENT and
  // merely null; `?` would declare an absence that cannot occur.
  // -------------------------------------------------------------------------

  /**
   * `ABPerson.ExternalUUID` — the external/server-store identity (UUID4). The
   * iPhone counterpart of the macOS ZEXTERNALUUID captured by BACKLOG-2392.
   *
   * PORTABILITY IS UNVERIFIED, and its population rate is the open question this
   * capture exists to answer: expected NULL for contacts in the local "On My
   * iPhone" store with no server behind them. If it proves sparse it is a
   * secondary matching SIGNAL, not a key. Cross-device equality cannot be
   * settled from a single backup — that needs two devices on one iCloud account,
   * or a restore. Nothing may depend on this until it is measured.
   */
  externalUuid: string | null;
  /** `ABPerson.ExternalIdentifier` — the external record id. */
  externalIdentifier: string | null;
  /** `ABPerson.ExternalModificationTag` — ETag-like change tag from the store. */
  externalModificationTag: string | null;
  /**
   * `ABPerson.ModificationDate` as ISO-8601, or null.
   *
   * The one field here that pays off with no portability question attached: it
   * gives update-vs-insert detection independent of ANY identifier.
   */
  modifiedAt: string | null;
  /** `ABPerson.CreationDate` as ISO-8601, or null. Pairs with `modifiedAt`. */
  createdAt: string | null;
  /**
   * `ABPerson.StoreID` — which account store the record belongs to.
   *
   * Captured because it is the field that EXPLAINS a sparse `externalUuid`
   * (local store vs an iCloud/Exchange account store), rather than leaving the
   * measurement unexplained.
   */
  storeId: number | null;
}

/**
 * Result of looking up a contact by phone or email
 */
export interface ContactLookupResult {
  /** The matched contact, or null if not found */
  contact: iOSContact | null;
  /** How the contact was matched, or null if not found */
  matchedOn: "phone" | "email" | null;
}

/**
 * Raw contact row from ABPerson table.
 *
 * BACKLOG-2407: the four original columns are selected LITERALLY and always
 * present. The six below are `T | null` for the same reason as on `iOSContact`
 * — a column the backup lacks arrives as `NULL AS <col>`, present and null,
 * never absent. See `ABPERSON_OPTIONAL_COLUMNS` in iosContactsParser.ts.
 */
export interface RawContactRow {
  ROWID: number;
  First: string | null;
  Last: string | null;
  Organization: string | null;
  ExternalUUID: string | null;
  ExternalIdentifier: string | null;
  ExternalModificationTag: string | null;
  /** Apple/CF absolute time — SECONDS since 2001-01-01, not nanoseconds. */
  ModificationDate: number | null;
  /** Apple/CF absolute time — SECONDS since 2001-01-01, not nanoseconds. */
  CreationDate: number | null;
  StoreID: number | null;
}

/**
 * Raw multi-value row from ABMultiValue table
 */
export interface RawMultiValueRow {
  record_id: number;
  property: number;
  label: string | null;
  value: string;
}

/**
 * Property types in ABMultiValue table
 */
export const ABMultiValuePropertyType = {
  PHONE: 3,
  EMAIL: 4,
} as const;

export type ABMultiValuePropertyType =
  (typeof ABMultiValuePropertyType)[keyof typeof ABMultiValuePropertyType];
