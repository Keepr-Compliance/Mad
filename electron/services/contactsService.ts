/**
 * Contacts Service
 * Handles loading and resolving contacts from the macOS Contacts databases.
 *
 * BACKLOG-2392 — macOS stores ONE address book per account. This service used
 * to read exactly one of them: it walked the candidate `.abcddb` files and
 * returned on the first with more than 10 records. A user with iCloud +
 * Exchange + "On My Mac" therefore had two accounts silently discarded, and
 * which account won could change between runs (it is readdir order, not size —
 * the doc comment claiming "uses the one with most records" was wrong). One
 * reporter's count moved 947 -> 716 in two days for exactly this reason.
 *
 * The reader now takes every book it can open, keyed on a stable identifier,
 * with per-book failure isolation. See the block comments on
 * `discoverAddressBooks`, `openAddressBookReadOnly` and `loadAddressBook`.
 */

import path from "path";
import fs from "fs/promises";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import logService from "./logService";
import {
  recordDiscovery,
  recordParse,
  redactAddressBookPath,
  type AddressBookCandidate,
  type ParseStage,
} from "./contactIngestionFunnel";
// BACKLOG-2394: discovery lives in its own module so the support-ticket
// diagnostics block reports the SAME set of books this reader will attempt.
// A diagnostics-only second copy of the walk would drift; see the file header.
import { discoverAddressBooks } from "./addressBookDiscovery";

const {
  toE164: normalizePhoneNumber,
  formatPhoneNumber,
} = require("../utils/phoneNormalization");
const { CONTACTS_BASE_DIR, DEFAULT_CONTACTS_DB } = require("../constants");

// ============================================
// TYPES
// ============================================

interface ContactMap {
  [key: string]: string; // Maps phone/email to contact name
}

interface ContactInfo {
  name: string;
  phones: string[];
  emails: string[];
  company?: string;   // TASK-1773: Organization from macOS Contacts
  recordId?: string;  // TASK-1773: Unique identifier for shadow table sync
  /**
   * BACKLOG-2401 — ZEXTERNALUUID, the CardDAV server-side identity.
   *
   * CAPTURED, NEVER MATCHED ON. `recordId` (ZUNIQUEID) is device-local: two
   * Macs on one iCloud account assign different values to the same person, so
   * it can never be a cross-device key. ZEXTERNALUUID is the only candidate
   * portable identifier in the store (measured 1125/1128 populated — the three
   * nulls are a group, an info row and a container), but its portability is
   * UNVERIFIED and nothing may depend on it until two Macs on one account
   * confirm it.
   *
   * It is read now purely because reading it LATER is impossible: a user who
   * changes machines or reinstalls takes the old store with them.
   */
  externalUuid?: string;
}

interface PhoneToContactInfo {
  [key: string]: ContactInfo; // Maps phone to full contact info
}

interface LoadStatus {
  success: boolean;
  contactCount: number;
  source?: string;
  /** BACKLOG-2392: every address book that contributed, not just the winner. */
  sources?: string[];
  error?: string;
  lastError?: string;
  attemptedPaths?: string[];
  userMessage?: string;
  action?: string;
}

interface ContactNamesResult {
  contactMap: ContactMap;
  phoneToContactInfo: PhoneToContactInfo;
  /**
   * BACKLOG-2316: Person-deduped list — exactly one entry per macOS Contacts
   * record. Unlike `phoneToContactInfo` (keyed by phone, subject to a last-wins
   * overwrite when two DIFFERENT people share a normalized number), this array
   * never drops a person whose only phone is a shared household/office line.
   * Callers that need a per-person view (e.g. building the external-contacts
   * shadow-table sync payload) MUST prefer this over iterating the phone map.
   */
  contacts?: ContactInfo[];
  status: LoadStatus;
}

/**
 * A ZABCDRECORD row, exactly as selected.
 *
 * BACKLOG-2392: `uid` is ZUNIQUEID, NOT Z_PK. Z_PK is a Core Data rowid —
 * on a real store it ran 1..1577 for 1128 rows (449 gaps) and is reassigned
 * whenever the store is rebuilt, so persisting it as `external_record_id` meant
 * the upsert conflict key could silently point at a different human after a
 * rebuild. ZUNIQUEID (`<UUID>:ABPerson`) was 1128/1128 populated and
 * 1128/1128 distinct, is the string Apple's Contacts framework returns as
 * `CNContact.identifier`, and is the filename of the authoritative vCard in the
 * sibling `Metadata/` directory — so it survives a rebuild.
 *
 * NOTE it is DEVICE-LOCAL: two Macs on one iCloud account assign different
 * values. It must never be used as a cross-device sync key.
 */
interface DatabaseRow {
  uid: string | null;
  first_name?: string;
  last_name?: string;
  organization?: string;
  /** BACKLOG-2401 — ZEXTERNALUUID. Captured, never matched on. */
  external_uuid?: string | null;
}

interface PhoneRow {
  person_uid: string | null;
  phone: string;
}

interface EmailRow {
  person_uid: string | null;
  email: string;
}

/**
 * A person as read, BEFORE a display label is chosen.
 *
 * The label cannot be decided here: it may need to fall back to an email or
 * phone, and those are attached after the record rows are walked. Keeping the
 * raw name components on the draft is what lets `finalizePersons` make that
 * decision once, explicitly, with everything in hand.
 */
interface PersonDraft {
  /** ZUNIQUEID — the identity. Never Z_PK. */
  recordId: string;
  /** ZEXTERNALUUID — captured, never matched on. See ContactInfo.externalUuid. */
  externalUuid?: string;
  firstName?: string;
  lastName?: string;
  company?: string;   // TASK-1773: Organization/company
  phones: string[];
  emails: string[];
}

/** Keyed by ZUNIQUEID. */
interface PersonMap {
  [personUid: string]: PersonDraft;
}

/** Row counts for one address book, for the BACKLOG-2391 parse funnel. */
interface BookCounts {
  rowsRead: number;
  nonPersonRows: number;
  missingUniqueId: number;
  phoneRows: number;
  emailRows: number;
  /**
   * Person rows whose first name, last name AND organisation were all empty.
   *
   * This is the import-everything population: exactly the rows the old name
   * gate discarded without a trace (18 of 1123 on a verified store). Counted
   * from the raw columns, so it is a real measurement rather than something
   * inferred later by comparing a label back against an email string.
   */
  namelessRows: number;
}

interface BookReadResult {
  persons: PersonMap;
  counts: BookCounts;
}

/** The minimal read-only surface the reader needs from a database handle. */
interface OpenAddressBook {
  all: (sql: string) => Promise<any[]>;
  close: () => Promise<void>;
}

/**
 * A per-book failure, tagged with WHICH phase failed.
 *
 * BACKLOG-2391 SR review: "could not open" and "opened, then threw partway"
 * are different diagnoses — a permissions problem versus a corrupt store — and
 * the funnel reports them separately so the user is sent to the right remedy.
 * Carrying the phase on the error is what lets the caller tell them apart
 * without re-deriving it by matching on a message string.
 */
class AddressBookError extends Error {
  constructor(
    message: string,
    readonly phase: "open" | "load",
  ) {
    super(message);
    this.name = "AddressBookError";
  }
}

// ============================================
// READING
// ============================================

/**
 * Open an address book for reading. **In place, read-only, never copied.**
 *
 * BACKLOG-2392 — these stores are SQLite in WAL mode and Contacts.app holds a
 * writer open, so recent changes live in the sibling `-wal` file, not in the
 * `.abcddb`. Verified on a real machine: a store's main file was last written
 * months before its `-wal`, which had grown to 3.9 MB.
 *
 * ⚠️ THIS WAS NOT A LIVE BUG. The reader has ALWAYS opened in place, and SR
 * review confirmed the old call shape returned both committed and WAL-only rows
 * against an uncheckpointed store. There is no copy anywhere in this file's
 * history, and WAL staleness never cost anyone a contact. Do not attribute any
 * recovered contacts to this seam.
 *
 * It exists as a REGRESSION GUARD, because the failure it prevents is silent.
 * Copying the `.abcddb` elsewhere and opening the copy returns the pre-WAL
 * contents **with no error at all** — verified against real SQLite: a
 * copy-then-read of a store with a pending write returned the stale row set and
 * reported success. Full Disk Access problems make "just copy the file
 * somewhere we can read it" a tempting fix, and that fix would ship months-old
 * contacts with nothing in any log to show for it.
 *
 * Concentrating handle creation here makes "we never read a detached copy" one
 * reviewable line rather than a convention. If a future change genuinely must
 * copy, it has to copy the `-wal` and `-shm` alongside.
 *
 * OPENING IS ASYNC AND ERRORS ARE ROUTED DELIBERATELY. `new sqlite3.Database()`
 * without an open callback reports failure by EMITTING an `error` event on the
 * handle; an unhandled `error` event on an EventEmitter is an uncaught
 * exception, which in the main process is a CRASH. Verified: opening a
 * nonexistent path this way took the process down with SQLITE_CANTOPEN even
 * though every query call was inside try/catch, while a corrupt file happened
 * to surface through the query callback instead. Since this reader now walks
 * several books and a store can vanish or be replaced between discovery and
 * read, that difference is the difference between "one account failed" and "the
 * app died". The open callback plus the no-op-guarded `error` listener turn
 * both cases into a normal rejection the caller can isolate.
 */
function openAddressBookReadOnly(dbPath: string): Promise<OpenAddressBook> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve({
        all: promisify(db.all.bind(db)) as (sql: string) => Promise<any[]>,
        close: promisify(db.close.bind(db)) as () => Promise<void>,
      });
    });
    db.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** ZUNIQUEID looks like `<UUID>:ABPerson` / `:ABGroup` / `:ABInfo` / `:ABContainer`. */
const PERSON_UID_SUFFIX = ":ABPerson";

function isPersonUid(uid: string | null | undefined): uid is string {
  return typeof uid === "string" && uid.endsWith(PERSON_UID_SUFFIX);
}

/**
 * Read ONE address book. Throws if the book cannot be opened or queried — the
 * caller isolates that failure so one bad book cannot cost the user the others.
 *
 * BACKLOG-2392: phones and emails are joined to ZABCDRECORD in SQL so the
 * driver hands back `person_uid` directly and Z_PK never escapes the query.
 * That makes "the row number is not the identity" structural rather than a rule
 * someone has to remember. The join is LEFT so an orphan phone/email row is
 * still COUNTED (2391's `phoneRows`/`emailRows` are rows read, not rows
 * attached) while contributing to nobody.
 */
async function loadAddressBook(dbPath: string): Promise<BookReadResult> {
  let db: OpenAddressBook;
  try {
    db = await openAddressBookReadOnly(dbPath);
  } catch (err) {
    throw new AddressBookError((err as Error).message, "open");
  }

  let records: DatabaseRow[];
  let phones: PhoneRow[];
  let emails: EmailRow[];
  try {
    // No WHERE clause on record type: non-person rows are classified below so
    // they can be COUNTED. The old `WHERE Z_PK IS NOT NULL` was a no-op (a
    // primary key is never null) that pulled groups, containers and info rows
    // in alongside people, where they survived only by accident.
    records = await db.all(`
      SELECT
        ZABCDRECORD.ZUNIQUEID as uid,
        ZABCDRECORD.ZFIRSTNAME as first_name,
        ZABCDRECORD.ZLASTNAME as last_name,
        ZABCDRECORD.ZORGANIZATION as organization,
        -- BACKLOG-2401: one extra field in a SELECT already being run. Captured
        -- for a future cross-device story; nothing reads it today.
        ZABCDRECORD.ZEXTERNALUUID as external_uuid
      FROM ZABCDRECORD
    `);

    phones = await db.all(`
      SELECT
        ZABCDRECORD.ZUNIQUEID as person_uid,
        ZABCDPHONENUMBER.ZFULLNUMBER as phone
      FROM ZABCDPHONENUMBER
      LEFT JOIN ZABCDRECORD ON ZABCDRECORD.Z_PK = ZABCDPHONENUMBER.ZOWNER
      WHERE ZABCDPHONENUMBER.ZFULLNUMBER IS NOT NULL
    `);

    emails = await db.all(`
      SELECT
        ZABCDRECORD.ZUNIQUEID as person_uid,
        ZABCDEMAILADDRESS.ZADDRESS as email
      FROM ZABCDEMAILADDRESS
      LEFT JOIN ZABCDRECORD ON ZABCDRECORD.Z_PK = ZABCDEMAILADDRESS.ZOWNER
      WHERE ZABCDEMAILADDRESS.ZADDRESS IS NOT NULL
    `);
  } catch (err) {
    // Opened fine, then threw partway through: the corrupt-store signature.
    throw new AddressBookError((err as Error).message, "load");
  } finally {
    // Always release the handle, including when a query threw.
    try {
      await db.close();
    } catch {
      // A close failure must not mask the original read error.
    }
  }

  return buildBookResult(records, phones, emails);
}

/**
 * Turn one book's rows into people.
 *
 * BACKLOG-2392: NO field is a precondition for import (founder requirement,
 * 2026-07-31). The old code gated person creation on a non-empty display name
 * and dropped everyone without one — on a real store that was 18 people, with
 * no log line to show for it. Labels are decided afterwards, deliberately.
 */
function buildBookResult(
  records: DatabaseRow[],
  phones: PhoneRow[],
  emails: EmailRow[],
): BookReadResult {
  const persons: PersonMap = {};
  const counts: BookCounts = {
    rowsRead: 0,
    nonPersonRows: 0,
    missingUniqueId: 0,
    phoneRows: phones.length,
    emailRows: emails.length,
    namelessRows: 0,
  };

  for (const row of records) {
    if (!row.uid) {
      // Unkeyable: with no ZUNIQUEID there is no stable id to upsert against.
      counts.missingUniqueId++;
      continue;
    }
    if (!isPersonUid(row.uid)) {
      counts.nonPersonRows++;
      continue;
    }
    counts.rowsRead++;
    if (!buildDisplayName(row.first_name, row.last_name, row.organization)) {
      counts.namelessRows++;
    }
    persons[row.uid] = {
      recordId: row.uid,
      externalUuid: row.external_uuid || undefined,
      firstName: row.first_name,
      lastName: row.last_name,
      company: row.organization || undefined,
      phones: [],
      emails: [],
    };
  }

  for (const p of phones) {
    if (isPersonUid(p.person_uid) && persons[p.person_uid]) {
      persons[p.person_uid].phones.push(p.phone);
    }
  }

  for (const e of emails) {
    if (isPersonUid(e.person_uid) && persons[e.person_uid]) {
      persons[e.person_uid].emails.push(e.email);
    }
  }

  return { persons, counts };
}

// ============================================
// PUBLIC ENTRY POINT
// ============================================

/**
 * Get contact names from the macOS Contacts databases.
 *
 * BACKLOG-2392: reads EVERY address book it can open — one per account — and
 * merges them. Per-book failures are isolated: a locked or corrupt Exchange
 * store must never cost the user their iCloud contacts. Partial success is
 * success, and the funnel log says "read 2 of 3" so it cannot be mistaken for a
 * clean run.
 */
async function getContactNames(): Promise<ContactNamesResult> {
  const contactMap: ContactMap = {};
  const phoneToContactInfo: PhoneToContactInfo = {};
  let lastError: Error | null = null;
  const attemptedPaths: string[] = [];

  try {
    // Kept inside the try: a missing $HOME throws here and must still surface
    // as the structured failure status below, not as a rejected promise.
    const baseDir = path.join(process.env.HOME as string, CONTACTS_BASE_DIR);
    const defaultPath = path.join(process.env.HOME as string, DEFAULT_CONTACTS_DB);

    const { books, usedFallback } = await discoverAddressBooks(
      baseDir,
      defaultPath,
    );

    if (books.length === 0) {
      // Home-relative only: an absolute path carries the user's account name,
      // and these lines are written to be pastable into a public issue.
      logService.warn(
        "[ContactsService] No .abcddb files found",
        "ContactsService",
        { baseDir: redactAddressBookPath(baseDir) },
      );
      lastError = new Error("No contacts database files found");
    }

    const candidates: AddressBookCandidate[] = [];
    const merged: PersonMap = {};
    const sourcesRead: string[] = [];
    const totals: BookCounts & { books: number } = {
      books: 0,
      rowsRead: 0,
      nonPersonRows: 0,
      missingUniqueId: 0,
      phoneRows: 0,
      emailRows: 0,
      namelessRows: 0,
    };
    let failedCount = 0;

    for (const book of books) {
      attemptedPaths.push(book.fullPath);
      try {
        // The FULL load lives inside this try. If it only wrapped a probe, a
        // book that opened but threw mid-read would abort every remaining book
        // — which is exactly the failure this loop exists to contain.
        const { persons, counts } = await loadAddressBook(book.fullPath);

        mergePersons(merged, persons);
        totals.books++;
        totals.rowsRead += counts.rowsRead;
        totals.nonPersonRows += counts.nonPersonRows;
        totals.missingUniqueId += counts.missingUniqueId;
        totals.phoneRows += counts.phoneRows;
        totals.emailRows += counts.emailRows;
        totals.namelessRows += counts.namelessRows;
        sourcesRead.push(book.fullPath);
        candidates.push({
          path: book.redacted,
          recordCount: counts.rowsRead,
          read: true,
        });
      } catch (err) {
        failedCount++;
        lastError = err as Error;
        // "Could not open" (permissions) vs "opened, then threw" (corruption)
        // are different diagnoses and the funnel keeps them apart.
        const phase = err instanceof AddressBookError ? err.phase : "open";
        logService.error(
          `[ContactsService] Failed to read address book, continuing with the rest`,
          "ContactsService",
          { book: book.redacted, phase, error: (err as Error).message },
        );
        candidates.push({
          path: book.redacted,
          recordCount: null,
          read: false,
          skipReason: phase === "load" ? "load-error" : "read-error",
        });
      }
    }

    recordDiscovery({
      found: books.length,
      candidates,
      readCount: totals.books,
      failedCount,
      usedFallback,
    });

    if (totals.books === 0) {
      throw new Error("No contacts could be loaded from any database");
    }

    const { contacts, labelStats } = finalizePersons(merged);
    recordParse(buildParseStage(totals, contacts, labelStats));
    buildContactMaps(contacts, contactMap, phoneToContactInfo);

    return {
      contactMap,
      phoneToContactInfo,
      contacts,
      status: {
        success: true,
        // BACKLOG-2392: count PEOPLE, not reachable identifiers.
        //
        // This was `Object.keys(contactMap).length`, and contactMap is keyed
        // only by phone and email. An address book of name-only contacts
        // therefore reported `contactCount: 0` — and `permissionService` reads
        // that as `canLoadContacts: false` and tells the user to grant Full
        // Disk Access. A perfectly readable account was indistinguishable from
        // a permissions failure, and the advice given was wrong.
        //
        // That directly defeats import-everything: name-only records are
        // exactly what this ticket started importing. They are reported by the
        // parse funnel's `neither` bucket, which exists for this purpose.
        contactCount: contacts.length,
        source: sourcesRead[0],
        sources: sourcesRead,
      },
    };
  } catch (error) {
    logService.error(
      "[ContactsService] Error accessing contacts database:",
      "ContactsService",
      { error },
    );
    return {
      contactMap,
      phoneToContactInfo,
      contacts: [],
      status: {
        success: false,
        contactCount: 0,
        error: (error as Error).message,
        lastError: lastError?.message,
        attemptedPaths,
        userMessage: "Could not load contacts from Contacts app",
        action:
          "Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access",
      },
    };
  }
}

/**
 * Merge one book's people into the running set, keyed on ZUNIQUEID.
 *
 * A collision across two books is not expected — the UUID half is per-store —
 * but if it happens the contact methods are unioned rather than one record
 * silently replacing the other. Cross-ACCOUNT duplicates (the same human in
 * iCloud and Exchange, with different ZUNIQUEIDs) are deliberately NOT linked
 * here: macOS does that via the undocumented, unpopulated-on-single-account
 * `ZLINKID`, which cannot be tested before shipping. Existing cross-source
 * dedup handles content matching, and BACKLOG-2391's counters measure whether
 * that is sufficient.
 */
function mergePersons(target: PersonMap, incoming: PersonMap): void {
  for (const [uid, person] of Object.entries(incoming)) {
    const existing = target[uid];
    if (!existing) {
      target[uid] = person;
      continue;
    }
    for (const phone of person.phones) {
      if (!existing.phones.includes(phone)) existing.phones.push(phone);
    }
    for (const email of person.emails) {
      if (!existing.emails.includes(email)) existing.emails.push(email);
    }
    existing.company = existing.company || person.company;
    existing.firstName = existing.firstName || person.firstName;
    existing.lastName = existing.lastName || person.lastName;
  }
}

/**
 * Assign every person their display label and return the person-deduped list.
 *
 * The label is decided HERE, explicitly, once the contact methods are known —
 * rather than falling out of `buildDisplayName` returning `""` and the caller
 * treating that as "drop this record".
 */
function finalizePersons(persons: PersonMap): {
  contacts: ContactInfo[];
  /** Where each label came from — counted at the decision, never re-derived. */
  labelStats: { fromName: number; fromEmail: number; fromPhone: number; none: number };
} {
  const labelStats = { fromName: 0, fromEmail: 0, fromPhone: 0, none: 0 };

  const contacts = Object.values(persons).map((person) => {
    const name = buildDisplayName(person.firstName, person.lastName, person.company);
    if (name) {
      labelStats.fromName++;
    } else if (person.emails.length > 0 && person.emails[0]) {
      labelStats.fromEmail++;
    } else if (person.phones.length > 0 && person.phones[0]) {
      labelStats.fromPhone++;
    } else {
      labelStats.none++;
    }

    return {
      name: buildContactLabel(
        person.firstName,
        person.lastName,
        person.company,
        person.emails,
        person.phones,
      ),
      phones: person.phones,
      emails: person.emails,
      company: person.company,
      recordId: person.recordId,
      externalUuid: person.externalUuid,
    };
  });

  return { contacts, labelStats };
}

/** Split the finalized people into the BACKLOG-2391 parse counters. */
function buildParseStage(
  totals: BookCounts & { books: number },
  contacts: ContactInfo[],
  labelStats: { fromName: number; fromEmail: number; fromPhone: number; none: number },
): ParseStage {
  let withPhone = 0;
  let emailOnly = 0;
  let neither = 0;

  for (const c of contacts) {
    if (c.phones.length > 0) withPhone++;
    else if (c.emails.length > 0) emailOnly++;
    else neither++;
  }

  return {
    books: totals.books,
    rowsRead: totals.rowsRead,
    nonPersonRows: totals.nonPersonRows,
    missingUniqueId: totals.missingUniqueId,
    phoneRows: totals.phoneRows,
    emailRows: totals.emailRows,
    // MEASURED, never asserted: rows read minus distinct contacts produced.
    // ANY reintroduced drop makes it non-zero without anyone remembering to
    // update a counter, and a cross-book ZUNIQUEID collision shows up here too.
    // It was briefly the literal `0` — a sentinel that could never fire.
    droppedRows: totals.rowsRead - contacts.length,
    // The population the old gate discarded: no first name, no last name, no
    // organisation. Non-zero and healthy means import-everything is working.
    nameless: totals.namelessRows,
    usable: contacts.length,
    withPhone,
    emailOnly,
    neither,
    labelFromContact: labelStats.fromEmail + labelStats.fromPhone,
    unlabelled: labelStats.none,
  };
}

/**
 * Load contacts from a single database file.
 *
 * Retained as the single-book entry point. Returns empty maps (rather than
 * throwing) when the file is not accessible, matching its prior contract.
 */
async function loadContactsFromDatabase(
  contactsDbPath: string,
): Promise<{
  contactMap: ContactMap;
  phoneToContactInfo: PhoneToContactInfo;
  contacts: ContactInfo[];
  /**
   * BACKLOG-2391: the parse counters are RETURNED rather than logged here, so
   * the caller controls when the line is emitted. Logging inside the load put
   * the parse line before the discovery block it belongs under.
   */
  parse: ParseStage;
}> {
  const contactMap: ContactMap = {};
  const phoneToContactInfo: PhoneToContactInfo = {};
  const empty: ParseStage = {
    books: 0, rowsRead: 0, nonPersonRows: 0, missingUniqueId: 0,
    phoneRows: 0, emailRows: 0, droppedRows: 0, nameless: 0, usable: 0,
    withPhone: 0, emailOnly: 0, neither: 0, labelFromContact: 0, unlabelled: 0,
  };

  try {
    await fs.access(contactsDbPath);
  } catch (error) {
    logService.error(
      `[ContactsService] Cannot access database at ${redactAddressBookPath(contactsDbPath)}:`,
      "ContactsService",
      { error: (error as Error).message },
    );
    return { contactMap, phoneToContactInfo, contacts: [], parse: empty };
  }

  const { persons, counts } = await loadAddressBook(contactsDbPath);
  const { contacts, labelStats } = finalizePersons(persons);
  buildContactMaps(contacts, contactMap, phoneToContactInfo);
  return {
    contactMap,
    phoneToContactInfo,
    contacts,
    parse: buildParseStage({ ...counts, books: 1 }, contacts, labelStats),
  };
}

// ============================================
// LABELS
// ============================================

/**
 * Build a display name from name components alone.
 *
 * ⚠️ THE PRECEDENCE BELOW IS KNOWN-WRONG AND IS DELIBERATELY LEFT ALONE.
 *
 * `organization` is tested BEFORE a lone first name, so "Jane" at "Acme Corp"
 * with no surname displays as **"Acme Corp"** — which mis-files exactly the
 * realtor-style "FirstName / Role-in-Org" contacts this product is full of.
 * BACKLOG-2392 was scoped to fix it and did not, for a reason worth writing
 * down:
 *
 * `contacts` has NO source-identity column. The ONLY bridge from an imported
 * contact back to its address-book row is display-name string equality —
 * `contactHandlers.ts` backfill: `SELECT ... FROM external_contacts WHERE
 * user_id = ? AND name = ?` against `contacts.display_name`. Correcting the
 * precedence would, on the release that shipped it, change the reader's output
 * for every contact currently stored under an organisation name and break that
 * join for all of them at once.
 *
 * Blast radius, verified rather than assumed:
 *   - The already-imported filter matches on EMAIL and PHONE only, never on
 *     name (BACKLOG-2316). A contact with either identifier therefore does NOT
 *     duplicate in the picker; it only stops receiving backfill.
 *   - The genuinely dangerous population is "stored under an org name AND has
 *     no email/phone yet" — which both orphans and can be re-imported as a
 *     second record. That is precisely the population the name-based backfill
 *     exists to repair.
 *
 * And a migration cannot rescue it: re-deriving `display_name` requires
 * matching those rows by email or phone, the very identifiers the at-risk rows
 * are missing — so it would repair the safe rows and miss the unsafe ones,
 * while overwriting names the user may have edited by hand.
 *
 * The fix belongs after BACKLOG-2401 ("give saved contacts a real link to where
 * they came from"), which replaces that display-name join with a real source
 * identity and so makes the relabelling safe. The precedence flip itself is
 * BACKLOG-2399, which also owns updating the regression test pinning this
 * output.
 *
 * Returns "" when there is nothing to build from; `buildContactLabel` owns what
 * happens next.
 */
function buildDisplayName(
  firstName?: string,
  lastName?: string,
  organization?: string,
): string {
  const first = firstName || "";
  const last = lastName || "";
  const org = organization || "";

  if (first && last) {
    return `${first} ${last}`;
  } else if (org) {
    return org;
  } else if (first) {
    return first;
  } else if (last) {
    return last;
  }

  return "";
}

/**
 * The label a contact is imported under.
 *
 * BACKLOG-2392: a nameless record is still a real person — on a verified store,
 * 18 of 1123 people had no name at all and were dropped without a trace. The
 * fallback chain is explicit and ordered: name -> first email -> first phone.
 *
 * Unlike the precedence bug documented on `buildDisplayName`, this fallback is
 * purely additive and cannot orphan anything: these records were dropped
 * BEFORE reaching `external_contacts`, so no imported contact's `display_name`
 * was ever derived from one.
 *
 * A record with no name, no email and no phone gets "". It is still imported
 * (no field is a precondition) and is counted as `unlabelled` in the parse
 * funnel, so an implausible number of blank records is visible rather than
 * discovered by a user scrolling the picker.
 */
function buildContactLabel(
  firstName?: string,
  lastName?: string,
  organization?: string,
  emails: string[] = [],
  phones: string[] = [],
): string {
  const name = buildDisplayName(firstName, lastName, organization);
  if (name) return name;
  if (emails.length > 0 && emails[0]) return emails[0];
  if (phones.length > 0 && phones[0]) return formatPhoneNumber(phones[0]);
  return "";
}

/**
 * Build contact lookup maps.
 *
 * BACKLOG-2392: takes the FINALIZED people, so a label decided by the
 * email/phone fallback is the same string here, in the shadow table and in the
 * picker. Deriving it twice is how those three drift apart.
 */
function buildContactMaps(
  people: ContactInfo[],
  contactMap: ContactMap,
  phoneToContactInfo: PhoneToContactInfo,
): void {
  people.forEach((person) => {
    // Map phone numbers to name and full contact info
    person.phones.forEach((phone: string) => {
      const normalized = normalizePhoneNumber(phone);

      // Map both normalized and original to name
      contactMap[normalized] = person.name;
      contactMap[phone] = person.name;

      // Map to full contact info (all phones and emails)
      // TASK-1773: Include company and recordId for shadow table sync
      const fullInfo: ContactInfo = {
        name: person.name,
        phones: person.phones,
        emails: person.emails,
        company: person.company,
        recordId: person.recordId,
        externalUuid: person.externalUuid,
      };
      phoneToContactInfo[normalized] = fullInfo;
      phoneToContactInfo[phone] = fullInfo;
    });

    // Map emails to name
    person.emails.forEach((email: string) => {
      const emailLower = email.toLowerCase();
      contactMap[emailLower] = person.name;
    });
  });
}

/**
 * Resolve contact name from various identifiers
 */
function resolveContactName(
  contactId: string,
  chatIdentifier: string,
  displayName: string | undefined,
  contactMap: ContactMap,
): string {
  // If we have a display_name from Messages, use it
  if (displayName) return displayName;

  // Try to find contact name by contactId (phone or email)
  if (contactId) {
    // Try direct match
    if (contactMap[contactId]) {
      return contactMap[contactId];
    }

    // Try normalized phone number match (E.164 format: +15551234567)
    const normalized = normalizePhoneNumber(contactId);
    if (normalized && contactMap[normalized]) {
      return contactMap[normalized];
    }

    // If not found and number has US country code (+1), try without it
    if (normalized && normalized.startsWith("+1") && normalized.length === 12) {
      const withoutCountryCode = "+" + normalized.substring(2);
      if (contactMap[withoutCountryCode]) {
        return contactMap[withoutCountryCode];
      }
    }

    // Try lowercase email match
    const lowerEmail = contactId.toLowerCase();
    if (contactMap[lowerEmail]) {
      return contactMap[lowerEmail];
    }
  }

  // Try chat_identifier as fallback
  if (chatIdentifier) {
    if (contactMap[chatIdentifier]) {
      return contactMap[chatIdentifier];
    }

    const normalized = normalizePhoneNumber(chatIdentifier);
    if (normalized && contactMap[normalized]) {
      return contactMap[normalized];
    }

    // If not found and number has US country code (+1), try without it
    if (normalized && normalized.startsWith("+1") && normalized.length === 12) {
      const withoutCountryCode = "+" + normalized.substring(2);
      if (contactMap[withoutCountryCode]) {
        return contactMap[withoutCountryCode];
      }
    }
  }

  // Final fallback: format and show the phone/email nicely
  const fallbackValue = contactId || chatIdentifier || "Unknown";
  return formatPhoneNumber(fallbackValue);
}

export {
  getContactNames,
  loadContactsFromDatabase,
  resolveContactName,
  buildDisplayName,
  buildContactLabel,
};

export type {
  ContactMap,
  ContactInfo,
  PhoneToContactInfo,
  LoadStatus,
  ContactNamesResult,
};
