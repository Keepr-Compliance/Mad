/**
 * @jest-environment node
 *
 * BACKLOG-2556 — THE FOLD IS DELETED. Founder, 2026-08-09: *"ok lets delete
 * the fold"*.
 *
 * ===========================================================================
 * WHAT WAS DELETED
 * ===========================================================================
 * `findDuplicateOwner` in `contacts:get-available`, its two call sites (the
 * legacy local-contacts loop and the shadow-table loop), the
 * `absorbedRecords` / `collapsedSources` payload they wrote, and the purple
 * `contact-row-collapsed-toggle` that drew it. Together they decided that two
 * records the user had NEVER linked were one person, dropped the loser, and
 * labelled the survivor "N records combined".
 *
 * ===========================================================================
 * THE CORPUS IS THE FOUNDER'S, AND IT IS FICTIONAL BY CONSTRUCTION
 * ===========================================================================
 * Every name, address and number below comes from the vCard set he built and
 * synced into macOS Contacts on 2026-08-09 specifically so this behaviour could
 * be reported without exposing anyone: RFC 2606 `example.com`, NANP 555-01xx.
 * Reproducing his cases rather than inventing new ones matters — each is a
 * DIFFERENT harm, and a suite that only covered the row count would have missed
 * two of the three.
 *
 *   1. ELENA MARSH / ELENA MARSH-OKONKWO — the fold HID A PERSON. Two different
 *      surnames sharing `el…@example.com`, folded on the shared address. She
 *      was not mislabelled, she was absent from the array the renderer
 *      receives, so she could not be imported as her own contact even if she is
 *      a different person.
 *   2. TOBIAS QUILL x2, one carrying `ORG: Quill Inspections` — the fold
 *      DISCARDED DATA. He opened the row and the organisation was nowhere, on
 *      the row or in the detail pane. Asserted here as a VALUE, never a row
 *      count: a count of 2 cannot tell "the company survived" from "the company
 *      is gone and a second empty row appeared".
 *   3. LUIS FERREIRA x2 — the fold LAUNDERED A GUESS INTO A FACT. He imported
 *      ONE row and got THREE source records attached, each written
 *      `match_method: 'source_id'` — the method meaning "the source itself says
 *      these are the same record". After that no query can tell the guess from
 *      a real identifier match, and there is no undo. This is the most
 *      important control in the file.
 *   4. MARCUS ORD / PRIYA RAMAN on one office line `(415) 555-0120` — the
 *      DISCRIMINATING NEGATIVE. They already rendered as two rows BEFORE the
 *      deletion, because of the `namesAreCompatible` guard INSIDE the fold. If
 *      the deletion had been done by removing that guard instead of the fold,
 *      every case above would still pass and this one would silently invert.
 *
 * ===========================================================================
 * THIS DRIVES THE REAL HANDLERS AGAINST REAL SQL
 * ===========================================================================
 * The crosswalk reads and writes are real statements against a real in-memory
 * SQLite, and `dbTransaction` is a REAL transaction (`mockDb.transaction(fn)()`),
 * not the `(fn) => fn()` passthrough BACKLOG-2368 exists to reject. Import
 * tests feed `contacts:import` THE OBJECTS `contacts:get-available` RETURNED —
 * never a hand-built payload — because the whole question is what a picker row
 * carries.
 *
 * NO SYNC RUNS. `contactSourceLinker` throws if reached, so every crosswalk row
 * asserted below was written by the import and by nothing else.
 *
 * ===========================================================================
 * OBSERVED REDS (2026-08-09) — each control made to fail on purpose
 * ===========================================================================
 * Reinstating `findDuplicateOwner` + `absorbSourceIdentity` at the shadow-loop
 * `continue`:
 *   1. Elena       -> Received ["Elena Marsh"], expected both surnames
 *   2. Tobias      -> Received `undefined` for the company value
 *   3. Luis        -> Received TWO crosswalk rows from ONE import, the second
 *                     being the record the user never picked
 *   4. Ord/Raman   -> STAYS GREEN. That is what makes it discriminating.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { CONTACT_IDENTITY_SCHEMA } from "../services/__tests__/helpers/contactIdentitySchema";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

const registeredHandlers = new Map<string, any>();

let mockImportedContacts: any[] = [];
let mockShadowRows: any[] = [];

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp") },
}));

// REAL SQL for the crosswalk, and a REAL transaction (BACKLOG-2368).
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
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

const createdContactIds: string[] = [];

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getRemovedContactIdentifiers: jest.fn(() => Promise.resolve([])),
    getImportedContactsByUserId: jest.fn(() => Promise.resolve(mockImportedContacts)),
    getUnimportedContactsByUserId: jest.fn(() => Promise.resolve([])),
    getUserById: jest.fn((id: string) => Promise.resolve({ id })),
    isInitialized: jest.fn(() => true),
    backfillContactEmails: jest.fn(() => Promise.resolve(0)),
    backfillContactPhones: jest.fn(() => Promise.resolve(0)),
    markContactAsImported: jest.fn(() => Promise.resolve()),
    getContactById: jest.fn((id: string) =>
      Promise.resolve(
        mockDb!.prepare("SELECT * FROM contacts WHERE id = ?").get(id) ?? null,
      ),
    ),
    // Real rows: the crosswalk has a foreign key onto `contacts`, so invented
    // ids would let a link be written for a contact the database would reject.
    createContactsBatch: jest.fn((rows: any[]) => {
      const ids: string[] = [];
      rows.forEach((row, i) => {
        const id = `created-${createdContactIds.length + i}-${row.display_name
          .replace(/\W+/g, "-")
          .toLowerCase()}`;
        mockDb!
          .prepare(
            "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, ?, 1)",
          )
          .run(id, row.user_id, row.display_name, row.source ?? "contacts_app");
        ids.push(id);
      });
      createdContactIds.push(...ids);
      return ids;
    }),
  },
}));

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
  getCount: jest.fn(() => mockShadowRows.length),
  getAllForUser: jest.fn(() => mockShadowRows),
  getAllForUserAsync: jest.fn(() => Promise.resolve(mockShadowRows)),
  isStale: jest.fn(() => false),
  fullSync: jest.fn(),
  getLastSyncTime: jest.fn(() => null),
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
  syncOutlookContacts: jest.fn(),
  getContactSourceStats: jest.fn(() => ({})),
  markSourceRecordsCurrent: jest.fn(),
}));

jest.mock("../services/db/contactDbService", () => ({
  ...(jest.requireActual("../services/db/contactDbService") as object),
  getContactEmailEntries: jest.fn(() => []),
  getContactPhoneEntries: jest.fn(() => []),
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

/** A link may only appear because the IMPORT wrote it. */
jest.mock("../services/contactSourceLinker", () => ({
  __esModule: true,
  linkExternalContactsForUser: jest.fn(() => {
    throw new Error("no sync may run in this suite (BACKLOG-2556)");
  }),
}));

import { registerContactHandlers } from "../handlers/contactHandlers";
import { getLinksForContact } from "../services/db/contactSourceLinkDbService";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

/**
 * One address-book record, in the shape `external_contacts` hands the picker.
 *
 * `company` is a real parameter here, unlike the sibling suites' helper, because
 * control 2 is entirely about a field the fold discarded.
 */
function shadowRow(opts: {
  recordId: string;
  name: string;
  source: string;
  emails?: string[];
  phones?: string[];
  company?: string | null;
}) {
  return {
    id: `ext-${opts.recordId}`,
    user_id: USER,
    name: opts.name,
    phones: opts.phones ?? [],
    emails: opts.emails ?? [],
    company: opts.company ?? null,
    source: opts.source,
    external_record_id: opts.recordId,
    external_uuid: null,
    last_message_at: null,
    synced_at: "2026-08-09T00:00:00.000Z",
  };
}

/** The picker's rows, exactly as the renderer receives them. */
async function getAvailable(): Promise<any[]> {
  const handler = registeredHandlers.get("contacts:get-available");
  const result = await handler(mockEvent, USER);
  expect(result.success).toBe(true);
  return result.contacts as any[];
}

/** The rows the picker offered, by NAME. Identity, never a count. */
async function offeredNames(): Promise<string[]> {
  return (await getAvailable()).map((r) => r.name).sort();
}

/** Import the picker's own objects — filtered, never rebuilt. */
async function importRows(rows: any[]): Promise<void> {
  const handler = registeredHandlers.get("contacts:import");
  const result = await handler(mockEvent, USER, rows);
  if (!result.success) throw new Error(`import failed: ${result.error}`);
}

/** EVERY crosswalk row in the table, as sortable strings. Identity, never a count. */
function allLinks(): string[] {
  return (
    mockDb!
      .prepare(
        "SELECT source_type, source_record_id, match_method FROM contact_source_links WHERE user_id = ?",
      )
      .all(USER) as Array<{
      source_type: string;
      source_record_id: string;
      match_method: string;
    }>
  )
    .map((l) => `${l.source_type}/${l.source_record_id}/${l.match_method}`)
    .sort();
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockImportedContacts = [];
  mockShadowRows = [];
  createdContactIds.length = 0;
  registeredHandlers.clear();
  registerContactHandlers({
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  } as any);
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

// ===========================================================================
describe("CONTROL 1 — the fold hid a person (Elena Marsh, 2026-08-09)", () => {
  /**
   * His screenshot, verbatim:
   *
   *     Elena Marsh
   *     1 record combined
   *       Elena Marsh-Okonkwo from your Mac address book is shown on this row,
   *       because both list the email address el…@example.com.
   *
   * Two different surnames. `namesAreCompatible` accepted them because
   * "Elena Marsh" is a token-prefix of "Elena Marsh-Okonkwo" — which is exactly
   * as true of a mother and daughter, or a woman and her sister-in-law.
   *
   * Neither record is imported and no crosswalk row exists, so the ONLY thing
   * that could have removed one is the fold.
   */
  beforeEach(() => {
    mockShadowRows = [
      shadowRow({
        recordId: "mac-elena-marsh",
        name: "Elena Marsh",
        source: "macos",
        emails: ["elena.marsh@example.com"],
      }),
      shadowRow({
        recordId: "mac-elena-okonkwo",
        name: "Elena Marsh-Okonkwo",
        source: "macos",
        emails: ["elena.marsh@example.com"],
      }),
    ];
  });

  it("offers BOTH records as their own rows", async () => {
    expect(await offeredNames()).toEqual(["Elena Marsh", "Elena Marsh-Okonkwo"]);
  });

  it("gives neither row anything absorbed, and no fold payload at all", async () => {
    for (const row of await getAvailable()) {
      expect(row.absorbedRecords).toBeUndefined();
      expect(row.collapsedSources).toBeUndefined();
    }
  });

  it("lets the previously-hidden record be imported as her OWN contact", async () => {
    // The harm was never the label. It was that she could not be reached: the
    // record the fold dropped never entered `availableContacts`, so no import
    // button in the application could reach it.
    const okonkwo = (await getAvailable()).filter(
      (r) => r.externalRecordId === "mac-elena-okonkwo",
    );
    expect(okonkwo).toHaveLength(1);

    await importRows(okonkwo);

    const saved = mockDb!
      .prepare("SELECT display_name FROM contacts WHERE user_id = ?")
      .all(USER) as Array<{ display_name: string }>;
    expect(saved.map((c) => c.display_name)).toEqual(["Elena Marsh-Okonkwo"]);
    expect(allLinks()).toEqual(["macos/mac-elena-okonkwo/source_id"]);
  });
});

// ===========================================================================
describe("CONTROL 2 — the fold discarded data (Tobias Quill, 2026-08-09)", () => {
  /**
   * Two records with the IDENTICAL name and the same address; one of them
   * carries `ORG: Quill Inspections`. The fold kept the representative's fields
   * and `continue`d the other away, so the organisation appeared nowhere — not
   * on the row, not in the detail pane. A user with a work contact recorded in
   * two address-book entries lost the employer, silently.
   *
   * ASSERTED AS A VALUE, NOT A ROW COUNT. This is the requirement that makes
   * the control worth running: "2 rows" is satisfied by a second row that
   * carries nothing, which is the failure mode a naive fix produces. The
   * founder's question was *where did Quill Inspections go*, so the assertion
   * has to be able to answer it.
   *
   * The record carrying the organisation is deliberately SECOND, so it is the
   * one the fold dropped (first claim wins).
   */
  beforeEach(() => {
    mockShadowRows = [
      shadowRow({
        recordId: "mac-tobias-plain",
        name: "Tobias Quill",
        source: "macos",
        emails: ["tobias.quill@example.com"],
      }),
      shadowRow({
        recordId: "out-tobias-org",
        name: "Tobias Quill",
        source: "outlook",
        emails: ["tobias.quill@example.com"],
        company: "Quill Inspections",
      }),
    ];
  });

  it("the organisation on the folded record is REACHABLE — asserted by value", async () => {
    const rows = await getAvailable();

    const companies = rows
      .map((r) => r.company)
      .filter((c: string | null) => c !== null);
    expect(companies).toEqual(["Quill Inspections"]);

    // ...and it is on the record that actually carries it, not smeared onto the
    // other one. `undefined` here would mean the row is gone; the wrong record
    // id would mean the value was merged rather than kept.
    const carrier = rows.find((r) => r.company === "Quill Inspections");
    expect(carrier?.externalRecordId).toBe("out-tobias-org");
  });

  it("keeps both records addressable, so the one with the ORG can be imported", async () => {
    expect(
      (await getAvailable()).map((r) => r.externalRecordId).sort(),
    ).toEqual(["mac-tobias-plain", "out-tobias-org"]);
  });
});

// ===========================================================================
describe("CONTROL 3 — the fold laundered a guess into a fact (Luis Ferreira)", () => {
  /**
   * ===========================================================================
   * THE MOST IMPORTANT CONTROL IN THIS FILE.
   * ===========================================================================
   * The founder imported ONE Luis Ferreira row and the saved contact came back
   * carrying three sources:
   *
   *     Sources 3
   *       Mac address book — Nadia Ibori    You confirmed this yourself
   *       Mac address book — Luis Ferreira  Recognised by its own entry in your Mac address book
   *       Mac address book — Luis Ferreira  Recognised by its own entry in your Mac address book
   *
   * `contactLinkEvidence.ts` maps that sentence from `match_method: 'source_id'`
   * — the method reserved for a SOURCE asserting two entries are the same
   * record. The picker's display-time guess about a shared address had been
   * written into the durable store as the strongest evidence the system has,
   * and after the write there is no way to tell it from a real identifier match.
   *
   * The mechanism was `absorbSourceIdentity` -> `collapsedSources` ->
   * `toSourceIdentities` -> `linkImportedContact`. Every link in that chain is
   * now removed at the first step.
   *
   * ASSERTED AS THE CROSSWALK ROW ID SET. A count cannot distinguish "the right
   * record was claimed" from "a different one was".
   */
  beforeEach(() => {
    mockShadowRows = [
      shadowRow({
        recordId: "mac-luis-a",
        name: "Luis Ferreira",
        source: "macos",
        emails: ["luis.ferreira@example.com"],
        phones: ["(415) 555-0133"],
      }),
      shadowRow({
        recordId: "mac-luis-b",
        name: "Luis Ferreira",
        source: "macos",
        emails: ["luis.ferreira@example.com"],
        phones: ["(415) 555-0133"],
      }),
    ];
  });

  it("importing ONE row writes EXACTLY ONE crosswalk row — the record picked", async () => {
    const rows = await getAvailable();
    expect(rows).toHaveLength(2);

    const picked = rows.filter((r) => r.externalRecordId === "mac-luis-a");
    expect(picked).toHaveLength(1);

    await importRows(picked);

    expect(allLinks()).toEqual(["macos/mac-luis-a/source_id"]);
  });

  it("leaves the OTHER record unclaimed and still importable", async () => {
    const rows = await getAvailable();
    await importRows(rows.filter((r) => r.externalRecordId === "mac-luis-a"));

    // Second import, second record, second contact. Two people or one is the
    // user's call to make later; the app does not make it for them.
    const remaining = (await getAvailable()).filter(
      (r) => r.externalRecordId === "mac-luis-b",
    );
    expect(remaining).toHaveLength(1);

    await importRows(remaining);

    expect(allLinks()).toEqual([
      "macos/mac-luis-a/source_id",
      "macos/mac-luis-b/source_id",
    ]);
    // Two contacts, each owning one record — not one contact owning two.
    const owners = mockDb!
      .prepare("SELECT DISTINCT contact_id FROM contact_source_links WHERE user_id = ?")
      .all(USER) as Array<{ contact_id: string }>;
    expect(owners).toHaveLength(2);
  });

  it("the claimed record is then suppressed BY THE CROSSWALK — the knowledge half", async () => {
    // The other direction, and the one that matters most: deleting the guessing
    // must not delete the knowing. Founder, D2: "if a contact is imported don't
    // show it twice, show the imported one."
    const rows = await getAvailable();
    await importRows(rows.filter((r) => r.externalRecordId === "mac-luis-a"));

    expect(
      (await getAvailable()).map((r) => r.externalRecordId),
    ).toEqual(["mac-luis-b"]);

    // ...and it is the crosswalk row doing it, not a content resemblance:
    // delete the row and the record comes back.
    mockDb!
      .prepare("DELETE FROM contact_source_links WHERE source_record_id = ?")
      .run("mac-luis-a");
    expect(
      (await getAvailable()).map((r) => r.externalRecordId).sort(),
    ).toEqual(["mac-luis-a", "mac-luis-b"]);
  });

  it("records the method as source_id only for the record the user chose", async () => {
    const rows = await getAvailable();
    await importRows(rows.filter((r) => r.externalRecordId === "mac-luis-b"));

    const contactId = (
      mockDb!
        .prepare("SELECT id FROM contacts WHERE user_id = ? LIMIT 1")
        .get(USER) as { id: string }
    ).id;
    expect(
      getLinksForContact(contactId).map(
        (l) => `${l.source_record_id}/${l.match_method}`,
      ),
    ).toEqual(["mac-luis-b/source_id"]);
  });
});

// ===========================================================================
describe("CONTROL 4 — the discriminating negative (Marcus Ord / Priya Raman)", () => {
  /**
   * Two DIFFERENT people sharing one office line, `(415) 555-0120`. They
   * rendered as two rows BEFORE this deletion, because `findDuplicateOwner`
   * required `namesAreCompatible` on the phone branch (BACKLOG-2416).
   *
   * WHY THIS TEST EXISTS. There were two ways to make control 1 pass: delete
   * the fold, or delete the name guard inside it. The second is smaller, would
   * have turned every case above green, and would have started merging
   * strangers on a shared office line — the exact defect BACKLOG-2416 fixed.
   * This case is red under that mistake and green under the real deletion, so
   * it is the one assertion here that distinguishes them.
   *
   * It therefore does NOT go red when the fold is reinstated, and that is
   * correct: it is a guard against the wrong fix, not a control for the right
   * one.
   */
  beforeEach(() => {
    mockShadowRows = [
      shadowRow({
        recordId: "mac-marcus",
        name: "Marcus Ord",
        source: "macos",
        phones: ["(415) 555-0120"],
      }),
      shadowRow({
        recordId: "mac-priya",
        name: "Priya Raman",
        source: "macos",
        phones: ["(415) 555-0120"],
      }),
    ];
  });

  it("two different people on one office line are still two rows", async () => {
    expect(await offeredNames()).toEqual(["Marcus Ord", "Priya Raman"]);
  });

  it("importing one of them claims only that one", async () => {
    const rows = await getAvailable();
    await importRows(rows.filter((r) => r.externalRecordId === "mac-priya"));

    expect(allLinks()).toEqual(["macos/mac-priya/source_id"]);
  });
});

// ===========================================================================
describe("the funnel stops reporting a suppression it no longer performs", () => {
  /**
   * `duplicateSuppressed` counted the fold's drops. The FIELD survives on
   * `PickerStage` because that shape is persisted and read back by the support
   * bundle and `contactsDiagnostics`, but its value is now structurally 0 and
   * `collapsedIdentitiesCarried` is omitted rather than reported as zero — so
   * `formatPickerLine` prints no "(identity carried …)" parenthetical claiming
   * a mechanism that is gone.
   */
  it("counts no duplicate suppression on a corpus that used to produce three", async () => {
    mockShadowRows = [
      shadowRow({
        recordId: "mac-elena-marsh",
        name: "Elena Marsh",
        source: "macos",
        emails: ["elena.marsh@example.com"],
      }),
      shadowRow({
        recordId: "mac-elena-okonkwo",
        name: "Elena Marsh-Okonkwo",
        source: "macos",
        emails: ["elena.marsh@example.com"],
      }),
      shadowRow({
        recordId: "mac-tobias-plain",
        name: "Tobias Quill",
        source: "macos",
        emails: ["tobias.quill@example.com"],
      }),
      shadowRow({
        recordId: "out-tobias-org",
        name: "Tobias Quill",
        source: "outlook",
        emails: ["tobias.quill@example.com"],
        company: "Quill Inspections",
      }),
      shadowRow({
        recordId: "mac-luis-a",
        name: "Luis Ferreira",
        source: "macos",
        emails: ["luis.ferreira@example.com"],
      }),
      shadowRow({
        recordId: "mac-luis-b",
        name: "Luis Ferreira",
        source: "macos",
        emails: ["luis.ferreira@example.com"],
      }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getContactIngestionFunnel } = require("../services/contactIngestionFunnel");
    await getAvailable();

    const picker = getContactIngestionFunnel().picker;
    expect(picker).toBeDefined();
    expect(picker.rowsIn).toBe(6);
    expect(picker.duplicateSuppressed).toBe(0);
    expect(picker.collapsedIdentitiesCarried).toBeUndefined();
    expect(picker.shown).toBe(6);
  });
});
