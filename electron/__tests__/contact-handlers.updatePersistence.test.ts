/**
 * @jest-environment node
 *
 * BACKLOG-2528 — editing a contact must actually write what the user typed.
 *
 * ===========================================================================
 * WHAT WENT WRONG, AND WHY EVERY CHECK STAYED GREEN
 * ===========================================================================
 * Renaming a contact did nothing. The form reported success and closed; the
 * name was unchanged. Founder-confirmed in the running app, 2026-08-05.
 *
 * `contacts` has no `name` column — it has `display_name`. Reads paper over
 * that: `getContactById` selects `c.display_name as name`, so the renderer
 * receives `name` and sends `name` back. The WRITE path never did the reverse
 * mapping. `updateContact`'s allow-list was
 * `["display_name", "company", "title", "default_role"]`, `name` was not in it,
 * so the field was dropped between the validator and the UPDATE — silently,
 * because an unlisted key is skipped rather than rejected.
 *
 * `tsc` had nothing to say about it. `Contact.name` is a DECLARED field
 * (`models.ts`, annotated *"@deprecated Read-only. Use display_name for all
 * writes"*), so `updateContact(id, { name })` against `Partial<Contact>` was
 * type-correct. The hazard was written down as a comment and shipped anyway;
 * `ContactUpdateFields` now states it as a type.
 *
 * ===========================================================================
 * WHAT THIS SUITE DELIBERATELY DOES NOT COVER
 * ===========================================================================
 * A SECOND defect lives on the same UPDATE, established by execution while
 * fixing this one and filed as BACKLOG-2534: `contacts:update` materialises all
 * five validated fields with `?? undefined`, so `company` and `title` are
 * always present as keys, and `undefined` reaches the driver as a bound
 * parameter that lands as NULL. Measured under the shipping Electron driver:
 *
 *   run(undefined, undefined, 'a')  ->  changes=1, row {company: null, title: null}
 *
 * A caller that sends only a name therefore erases the contact's employer and
 * job title. It is NOT fixed here: the repair is not the one line it looks
 * like, because skipping `undefined` in the writer without also removing the
 * handler's `?? undefined` collapse would break CLEARING a field (an emptied
 * box validates to `null`, which the handler turns into `undefined` before the
 * writer ever sees it). Both halves must move together, and this is a P0 that
 * should stay small.
 *
 * The founder's own path does not hit it — `ContactFormModal` always sends
 * company and title — which is why the rename is the urgent half.
 *
 * THE REASON NO TEST CAUGHT IT is the point of this suite. The check that
 * claimed to cover this path was `contact-handlers.test.ts`:
 *
 *     expect(mockDatabaseService.updateContact).toHaveBeenCalled();
 *
 * `updateContact` was mocked, and the assertion was that the mock ran. That is
 * satisfied by a writer that drops every field, by a writer that writes the
 * wrong column, and by `async () => {}`. Its inputs cannot separate pass from
 * fail, so it carried no information about the defect it was standing over. It
 * has been REMOVED, not supplemented — see the pointer left in its place.
 *
 * So this suite mocks no writer. `databaseService` is redirected to the REAL
 * `contactDbService` over a REAL SQLite database built from the REAL
 * `schema.sql`, the REAL IPC handler is driven with the REAL payload
 * `ContactFormModal` sends, and every assertion reads the row back RAW —
 * `SELECT display_name FROM contacts` — never through the code under test.
 *
 * ===========================================================================
 * THE THREE THINGS ASSERTED
 * ===========================================================================
 *   1. The rename reaches the DATABASE (not: reaches a function).
 *   2. It is still there after the handle is closed and the file reopened —
 *      the app-restart property the founder actually cares about, run against
 *      a file-backed database because `:memory:` cannot fail that test.
 *   3. Saving the edit form does not disturb the fields the form carries
 *      alongside the name.
 *
 * Plus a derivation, by execution, of both field sets — see the last describe.
 *
 * Every case runs on BOTH engines this repo's helper can open. Two cases that
 * would not are named and excluded at the end of the first describe, with the
 * measurement that disqualified them.
 *
 * Fixture values are reserved-for-documentation only: `example.com` and the
 * `+1 555 01xx` reserved fictional range. Names are invented.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";
import {
  CONTACT_SOURCE_LINKS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
} from "../services/db/contactIdentitySchemaSql";

let mockDb: TestDb | null = null;
const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false },
}));

jest.mock("../services/db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  // BACKLOG-2496: a REAL transaction, not the `(fn) => fn()` passthrough the
  // other contact-handlers suites use. `contacts:update` is now atomic and
  // nests (the address syncs are each atomic too); the passthrough would mock
  // away the property and also hide a nested-BEGIN error if one were possible.
  dbTransaction: <T,>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

/**
 * `databaseService` is a THIN FACADE — `updateContact` is one line delegating
 * to `contactDb.updateContact`. It is REDIRECTED here rather than stubbed,
 * because stubbing it is exactly the mistake this suite exists to correct:
 * the dropped field happens INSIDE the real function.
 */
jest.mock("../services/databaseService", () => {
  const contactDb = jest.requireActual(
    "../services/db/contactDbService",
  ) as typeof import("../services/db/contactDbService");
  return {
    __esModule: true,
    default: {
      updateContact: (id: string, updates: any) => contactDb.updateContact(id, updates),
    // BACKLOG-2496: `contacts:update` runs the whole edit in one transaction and
    // therefore calls the SYNCHRONOUS core — an async wrapper's throw is a
    // rejected promise, which a sync transaction callback would commit over.
    // Redirected to the REAL writer, like its sibling: stubbing it is exactly
    // the mistake this suite exists to correct.
    updateContactSync: (id: string, updates: any) => contactDb.updateContactSync(id, updates),
      getContactById: (id: string) => contactDb.getContactById(id),
      createContact: (data: any, origin: any) => contactDb.createContact(data, origin),
      findContactByName: () => Promise.resolve(null),
      getUserById: (id: string) => Promise.resolve({ id }),
      isInitialized: () => true,
      getImportedContactsByUserIdAsync: () => Promise.resolve([]),
      getUnimportedContactsByUserId: () => Promise.resolve([]),
    },
  };
});

jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(() =>
    Promise.resolve({ phoneToContactInfo: {}, contacts: [], status: { loaded: true } }),
  ),
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logContactAction: jest.fn() },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../utils/preferenceHelper", () => ({
  __esModule: true,
  isContactSourceEnabled: jest.fn(() => Promise.resolve(true)),
}));

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

jest.mock("../services/db/externalContactDbService", () => ({
  __esModule: true,
  getCount: jest.fn(() => 0),
  getAllForUser: jest.fn(() => []),
  getAllForUserAsync: jest.fn(() => Promise.resolve([])),
  isStale: jest.fn(() => false),
  fullSync: jest.fn(),
  getLastSyncTime: jest.fn(() => null),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  syncOutlookContacts: jest.fn(),
  getContactSourceStats: jest.fn(() => ({})),
  markSourceRecordsCurrent: jest.fn(),
}));

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn(), sync: jest.fn() },
}));

jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: jest.fn(() => false),
  queryContacts: jest.fn(() => Promise.resolve([])),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";
import auditService from "../services/auditService";
import { updateContact } from "../services/db/contactDbService";
import { validateContactData } from "../utils/validation";

const USER = "550e8400-e29b-41d4-a716-446655440000";
/**
 * A UUID because `contacts:update` runs `validateContactId` first and rejects
 * anything else. A readable `"contact-2528"` here made every case fail on
 * "Contact ID must be a valid UUID" before reaching the code under test —
 * i.e. the fixture, not the defect, was doing the failing.
 */
const CONTACT = "9f2b6c1e-4a7d-4c58-9e3b-2f1a0d5c8b47";
const mockEvent = {} as IpcMainInvokeEvent;

const SCHEMA_PATH = path.join(__dirname, "../database/schema.sql");

/**
 * Migration v56's exact DDL, transcribed from the migration (see the identical
 * block in `services/db/__tests__/contactRestore.test.ts`). `schema.sql` is the
 * FRESH-INSTALL shape and predates the tombstone columns, so a database built
 * from it alone is not the shape production has.
 */
const V56_TOMBSTONE_DDL = [
  "ALTER TABLE contacts ADD COLUMN removed_at DATETIME",
  "ALTER TABLE contacts ADD COLUMN removed_reason TEXT",
  "ALTER TABLE transaction_contacts ADD COLUMN removed_at DATETIME",
  "ALTER TABLE transaction_contacts ADD COLUMN removed_reason TEXT",
];

function buildSchema(db: TestDb): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  for (const ddl of V56_TOMBSTONE_DDL) db.exec(ddl);
  // v59's crosswalk — `getContactById` reads it via `getLiveSourcesForContact`.
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);
  db.exec(CONTACT_SOURCE_LINKS_INDEX_SQL);
  // `contacts.user_id` is a real FK and foreign keys are ON, so the owner row
  // has to exist. `oauth_provider` / `oauth_id` are NOT NULL in `schema.sql`.
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner@example.com", "oauth-2528");
}

/** Seed the contact the founder would have been looking at. */
function seedContact(db: TestDb): void {
  db.prepare(
    `INSERT INTO contacts (id, user_id, display_name, company, title, source, is_imported)
     VALUES (?, ?, ?, ?, ?, 'manual', 0)`,
  ).run(CONTACT, USER, "Dana Olsen", "Northgate Realty", "Broker");
  db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, 1, 'manual')",
  ).run("em-2528", CONTACT, "dana@example.com");
  db.prepare(
    `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source)
     VALUES (?, ?, ?, ?, 1, 'manual')`,
  ).run("ph-2528", CONTACT, "+14155550142", "4155550142");
}

/** The contact row read RAW — never through the code under test. */
function rawContact(db: TestDb): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM contacts WHERE id = ?")
    .get(CONTACT) as Record<string, unknown>;
}

/**
 * EXACTLY what `ContactFormModal.tsx` sends on save for an existing contact
 * (`src/components/contact/components/ContactFormModal.tsx`, the
 * `contact && !isExternalContact` branch): `name`, `company`, `title`, and the
 * two arrays. Transcribed from that payload, not invented — a fixture that
 * sent `display_name` would describe a call the renderer never makes and would
 * make this whole suite green against the broken code.
 */
async function saveFromEditForm(overrides: Record<string, unknown> = {}) {
  const handler = registeredHandlers.get("contacts:update");
  return handler(mockEvent, CONTACT, {
    name: "Dana Olsen-Reyes",
    company: "Northgate Realty",
    title: "Broker",
    emails: [{ id: "em-2528", email: "dana@example.com", is_primary: true }],
    phones: [{ id: "ph-2528", phone: "+14155550142", is_primary: true }],
    ...overrides,
  });
}

beforeEach(() => {
  mockDb = openTestDb();
  buildSchema(mockDb);
  seedContact(mockDb);
  registeredHandlers.clear();
  registerContactHandlers({} as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("renaming a contact writes the new name", () => {
  /**
   * THE FOUNDER'S ACTION, END TO END.
   *
   * NEGATIVE CONTROL (executed, output quoted in the PR): remove `name` from
   * `FIELD_TO_COLUMN` in `updateContact` — restoring the allow-list that
   * shipped — and this goes red with
   *   Expected: "Dana Olsen-Reyes"  Received: "Dana Olsen"
   * which is the defect in one line. It is the assertion the replaced
   * `toHaveBeenCalled()` could not make.
   */
  it("persists the new name to contacts.display_name", async () => {
    const result = await saveFromEditForm();
    if (!result.success) throw new Error(`contacts:update failed: ${result.error}`);

    expect(rawContact(mockDb!).display_name).toBe("Dana Olsen-Reyes");
  });

  it("reports the new name back to the renderer it came from", async () => {
    // The form closes on `success` and shows `contact`. If the handler echoed a
    // stale row the user would see the old name and know something was wrong —
    // the silence is what makes this P0, so the echo is asserted too.
    const result = await saveFromEditForm();
    expect(result.contact.name).toBe("Dana Olsen-Reyes");
  });

  it("records the update in the audit log", async () => {
    // Moved here from the mocked suite along with the successful-rename case,
    // so the audit entry is asserted against a save that DEMONSTRABLY landed
    // rather than one that only reached a stub.
    await saveFromEditForm();

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CONTACT_UPDATE",
        resourceType: "CONTACT",
        resourceId: CONTACT,
        success: true,
      }),
    );
  });

  it("leaves company and title exactly as they were", async () => {
    // Renaming must not touch fields the user did not edit. This is the FORM's
    // payload, which always carries company and title — see the suite header
    // for the name-only payload, which does not behave this way (BACKLOG-2534).
    await saveFromEditForm();
    const row = rawContact(mockDb!);
    expect(row.company).toBe("Northgate Realty");
    expect(row.title).toBe("Broker");
  });

  /**
   * TWO CASES ARE DELIBERATELY ABSENT, and this is the record of why.
   *
   *   (a) a name-only payload leaving company and title alone — it does not,
   *       they become NULL;
   *   (b) an emptied box clearing the column — it does, but only by accident.
   *
   * Both go through an `undefined` bound parameter, and THE TWO ENGINES DO
   * OPPOSITE THINGS WITH ONE. Probed directly, same statement, same values:
   *
   *   better-sqlite3-multiple-ciphers (SHIPS in the app, and what CI runs)
   *     run(undefined, undefined, 'a')
   *       -> changes=1, row {company: null, title: null}
   *
   *   node:sqlite (this helper's fallback, used by the pre-push hook on Node 22)
   *     run(undefined, undefined, 'a')
   *       -> TypeError: Provided value cannot be bound to SQLite parameter 1
   *       -> row unchanged
   *
   * So a test over either case asserts the ENGINE, not the product: it would be
   * green here and red on the machine next to it. That is the same "inputs
   * cannot separate pass from fail" failure this suite exists to correct, and
   * writing one to look thorough would be worse than the gap.
   *
   * It also corrects the fix plan for BACKLOG-2534. "Do not break clearing a
   * field" is not preserving a designed behaviour — clearing works in
   * production only because better-sqlite3 happens to bind `undefined` as NULL.
   * The real repair is to send `null` deliberately, and then both cases become
   * assertable on either engine.
   */
});

// ===========================================================================
describe("the rename survives a restart", () => {
  /**
   * The property the founder actually checks: quit, reopen, is the name still
   * right. `:memory:` CANNOT demonstrate it — the data dies with the handle, so
   * asserting "it survived" against one is a check whose input cannot fail for
   * the stated reason. This runs against a real file, closes the handle after
   * the write, and reopens the same path.
   */
  it("is still there after the handle is closed and the file reopened", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keepr-2528-"));
    const file = path.join(dir, "restart.db");
    try {
      mockDb?.close();
      mockDb = openTestDb(file);
      buildSchema(mockDb);
      seedContact(mockDb);
      registeredHandlers.clear();
      registerContactHandlers({} as any);

      const result = await saveFromEditForm();
      if (!result.success) throw new Error(`contacts:update failed: ${result.error}`);

      // The app going away.
      mockDb.close();

      // The app coming back to the same file on disk.
      const reopened = openTestDb(file);
      const row = reopened
        .prepare("SELECT display_name, company, title FROM contacts WHERE id = ?")
        .get(CONTACT) as Record<string, unknown>;
      reopened.close();

      expect(row).toEqual({
        display_name: "Dana Olsen-Reyes",
        company: "Northgate Realty",
        title: "Broker",
      });

      mockDb = null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// ===========================================================================
describe("a partial update touches ONLY what the caller sent (BACKLOG-2534)", () => {
  /**
   * THE DEFECT THIS CLOSES.
   *
   * The handler used to materialise all five validated fields with
   * `?? undefined` whether or not the caller supplied them. `?? undefined`
   * reads like "leave it alone"; it is not. The writer writes any key that is
   * PRESENT, whatever its value, and `undefined` binds as NULL at the shipping
   * driver — measured, not assumed:
   *
   *   UPDATE t SET company = ?, title = ? WHERE id = ?  .run(undefined, undefined, 'a')
   *     -> changes = 1, row { company: null, title: null }
   *
   * So a name-only save emptied the contact's employer and job title, reported
   * success, and told nobody. Those fields feed the transaction party list and
   * the exported audit.
   *
   * It was LATENT only because `ContactFormModal` happens to send every field
   * on every save. That is a property of one caller, not a guarantee — and
   * BACKLOG-2528 is what happens when the two sides of this boundary drift.
   *
   * NEGATIVE CONTROL: restore the `?? undefined` collapse in the handler and
   * the first case here goes red with
   *   Expected: "Northgate Realty"  Received: null
   */
  it("a name-only save leaves company and title untouched", async () => {
    const handler = registeredHandlers.get("contacts:update");
    const result = await handler(mockEvent, CONTACT, { name: "Dana Olsen-Reyes" });
    if (!result.success) throw new Error(`contacts:update failed: ${result.error}`);

    const row = rawContact(mockDb!);
    expect(row.display_name).toBe("Dana Olsen-Reyes");
    // The whole point: absent means absent.
    expect(row.company).toBe("Northgate Realty");
    expect(row.title).toBe("Broker");
  });

  it("a company-only save leaves the name untouched", async () => {
    const handler = registeredHandlers.get("contacts:update");
    const result = await handler(mockEvent, CONTACT, { company: "Southgate Realty" });
    if (!result.success) throw new Error(`contacts:update failed: ${result.error}`);

    const row = rawContact(mockDb!);
    expect(row.company).toBe("Southgate Realty");
    expect(row.display_name).toBe("Dana Olsen");
    expect(row.title).toBe("Broker");
  });

  /**
   * THE HALF THAT MUST NOT BREAK.
   *
   * The suite header warned that skipping `undefined` in the writer without
   * removing the handler's collapse would break CLEARING a field. This asserts
   * the other direction: an emptied box still empties the column.
   *
   * The mechanism is exact — `validateString("")` returns `null`, not
   * `undefined`, so an emptied box arrives as a PRESENT key with a null value
   * and is written. Only genuinely absent keys are dropped.
   */
  it("an emptied box still clears the column", async () => {
    const handler = registeredHandlers.get("contacts:update");
    const result = await handler(mockEvent, CONTACT, {
      name: "Dana Olsen",
      company: "",
      title: "",
    });
    if (!result.success) throw new Error(`contacts:update failed: ${result.error}`);

    const row = rawContact(mockDb!);
    expect(row.company).toBeNull();
    expect(row.title).toBeNull();
    expect(row.display_name).toBe("Dana Olsen");
  });

  it("PRECONDITION: the seeded contact really does start with both fields set", () => {
    // Without this, the two cases above would pass over a contact whose
    // company and title were never there — proving nothing.
    const row = rawContact(mockDb!);
    expect(row.company).toBe("Northgate Realty");
    expect(row.title).toBe("Broker");
  });
});

describe("the validator's fields and the writer's columns agree", () => {
  /**
   * THE TWO-LIST COMPARISON, DERIVED BY EXECUTION.
   *
   * The defect was a NAME disagreeing across a boundary. Grepping the two
   * literals proves they differ today and proves nothing about tomorrow, so
   * both sets are obtained by RUNNING the code:
   *
   *   - what the validator EMITS: call it with every field populated and read
   *     the keys off the object it returns.
   *   - what the writer ACCEPTS: hand `updateContact` one field at a time and
   *     see whether a column moved. It throws "No valid fields to update" when
   *     it recognises nothing, which is an unambiguous answer.
   *
   * Adding a sixth field to `validateContactData` and forgetting the writer
   * turns this red, which is the failure mode that shipped.
   */
  const FULL_INPUT = {
    name: "Probe Name",
    email: "probe@example.com",
    phone: "+14155550143",
    company: "Probe Co",
    title: "Probe Title",
  };

  /** Which columns of `contacts` a single-field update actually moved. */
  async function columnsMovedBy(field: string): Promise<string[] | "rejected"> {
    const before = rawContact(mockDb!);
    try {
      await updateContact(CONTACT, { [field]: `moved-${field}` } as any);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/No valid fields to update/.test(message)) return "rejected";
      throw error;
    }
    const after = rawContact(mockDb!);
    return Object.keys(after)
      .filter((c) => c !== "updated_at" && before[c] !== after[c])
      .sort();
  }

  it("emits exactly the five fields the edit form can send", () => {
    expect(Object.keys(validateContactData(FULL_INPUT, true)).sort()).toEqual([
      "company",
      "email",
      "name",
      "phone",
      "title",
    ]);
  });

  it("routes every emitted field that is a contacts column to that column", async () => {
    // `name` is the one that was dropped. `company` and `title` always worked.
    expect(await columnsMovedBy("name")).toEqual(["display_name"]);
    expect(await columnsMovedBy("company")).toEqual(["company"]);
    expect(await columnsMovedBy("title")).toEqual(["title"]);
  });

  it("still rejects email and phone, which are not columns of contacts", async () => {
    /**
     * NOT the same defect, and deliberately left alone. `contacts` has no
     * `email` or `phone` column — the values live in `contact_emails` /
     * `contact_phones`, and `contacts:update` routes them to
     * `setContactPrimaryEmail` / `setContactPrimaryPhone` itself. Accepting
     * them here would build `UPDATE contacts SET email = ?` and throw.
     */
    expect(await columnsMovedBy("email")).toBe("rejected");
    expect(await columnsMovedBy("phone")).toBe("rejected");
  });

  it("still accepts the two columns no renderer form sends", async () => {
    // `display_name` (written by paths that already speak the column name) and
    // `default_role` (written by role assignment, never by the edit form).
    expect(await columnsMovedBy("display_name")).toEqual(["display_name"]);
    expect(await columnsMovedBy("default_role")).toEqual(["default_role"]);
  });

  it("rejects a column of contacts that no write path is allowed to set", async () => {
    // The allow-list is a security boundary as well as a mapping — proving it
    // still says no is what stops "accept `name` too" from becoming
    // "accept anything".
    expect(await columnsMovedBy("user_id")).toBe("rejected");
    expect(await columnsMovedBy("is_imported")).toBe("rejected");
  });
});
