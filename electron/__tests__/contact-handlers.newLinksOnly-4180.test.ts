/**
 * @jest-environment node
 *
 * BACKLOG-4180 PR 2 — the scheduler's linking pass re-runs the whole-book
 * backfill ONLY when something it would copy changed: a NEW link, or a write to
 * `external_contacts` since the last backfill that completed.
 *
 * Before: `linksCreated` summed `idMatched` (links that ALREADY exist), so every
 * pass over an address book with any linked contact re-ran the backfill over
 * every contact.
 *
 * ===========================================================================
 * REAL DATABASE, REAL WRITERS
 * ===========================================================================
 * `better-sqlite3` resolved by path (the jest stub is bypassed), the full
 * `schema.sql`, and `setDb`. Source records go through the real writers
 * (`fullSync`, `upsertFromiPhone`, `upsertExternalContacts`); a saved contact
 * and its crosswalk row go through `createLink` + `applyLinkedSourceValuesOrThrow`
 * (what `linkImportedContact` calls inside `contacts:import`). The pass is the
 * one `registerContactHandlers` injects into the scheduler. The async
 * `databaseService.backfillContact*` facades delegate to the REAL
 * `contactDbService` writers, so a baseline run on code that still calls them
 * writes real rows (otherwise C2 would be green for no reason).
 *
 * Controls (each mutation run; results in the PR's pm_comments):
 *   C1  a pass over 10k already-linked contacts with nothing new runs NO backfill.
 *   C2  an address-book edit to an already-linked record reaches the contact —
 *       macOS, iPhone session, iPhone non-session, generic (outlook) writers —
 *       in-session and after a simulated restart.
 *   C3  a uuid capture on an already-linked record is not a link, and a macOS
 *       sync that changed no content does not count as a source change.
 *   C4  a name-rule link (auto mode) still triggers the backfill.
 *   C5  a failed value copy rolls its link back (content and name rule); the
 *       main-thread backfill writes one contact's values all-or-nothing.
 *   C6  a backfill that throws leaves the work owed: the next pass backfills.
 *   C7  first pass of a session backfills with no write in that session.
 *   R2.3 pool down: two `contacts:get-all` calls run the backfill once.
 *
 * Fixtures are fictional: 415 555-01xx and example.test.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import path from "path";
import fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp") },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../services/databaseService", () => {
  const real = jest.requireActual("../services/db/contactDbService");
  return {
    __esModule: true,
    default: {
      // Delegate to the real writers: see the header.
      backfillContactEmails: (id: string, v: string[]) => real.backfillContactEmails(id, v),
      backfillContactPhones: (id: string, v: string[]) => real.backfillContactPhones(id, v),
      backfillContactEmailsSync: (id: string, v: string[]) => real.backfillContactEmailsSync(id, v),
      backfillContactPhonesSync: (id: string, v: string[]) => real.backfillContactPhonesSync(id, v),
      getImportedContactsWithStatusAsync: jest.fn(() =>
        Promise.resolve({ contacts: [], messageDerivedPending: false }),
      ),
      isInitialized: jest.fn(() => true),
    },
  };
});

jest.mock("../utils/userIdHelper", () => ({
  __esModule: true,
  getValidUserId: jest.fn((id: string) => Promise.resolve(id)),
  getValidUserIdSync: jest.fn((id: string) => id),
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

jest.mock("../utils/preferenceHelper", () => ({
  __esModule: true,
  isContactSourceEnabled: jest.fn(() => Promise.resolve(true)),
}));

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn(), sync: jest.fn(), syncAll: jest.fn() },
}));

let poolReady = false;
jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: jest.fn(() => poolReady),
  queryContacts: jest.fn(() => Promise.resolve([])),
}));

/**
 * The unique-name rule's mode. Production resolves `off` (no add-on) or
 * `suggest`; `auto` is unreachable until BACKLOG-2616 adds the toggle
 * (`contactAutoLinkPolicy.ts` readAutoLinkToggle). C4/C5b set `auto` to guard
 * the term for that day.
 */
let autoLinkMode: "off" | "suggest" | "auto" = "off";
jest.mock("../services/contactAutoLinkPolicy", () => {
  const actual = jest.requireActual("../services/contactAutoLinkPolicy");
  return { ...actual, resolveContactAutoLinkMode: jest.fn(() => autoLinkMode) };
});

import { setDb } from "../services/db/core/dbConnection";
import { registerContactHandlers, resetContactSessionState } from "../handlers/contactHandlers";
import { setMainWindow } from "../windowRegistry";
import * as externalContactDb from "../services/db/externalContactDbService";
import { syncContactEmails, syncContactPhones } from "../services/db/contactDbService";
import { createLink } from "../services/db/contactSourceLinkDbService";
import { applyLinkedSourceValuesOrThrow } from "../services/contactSourceValues";
import { IMPORTED_CONTACT_IDS_SQL } from "../services/db/contactBackfillPlanSql";
import { queryContacts } from "../workers/contactWorkerPool";
import logService from "../services/logService";
import {
  QUIET_PERIOD_MS,
  __resetContactLinkingScheduler,
  requestContactLinking,
} from "../services/contactLinkingScheduler";

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
const V40_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_contact_phones_normalized ON contact_phones(phone_normalized)";

const USER = "user-4180-pr2";

let db: DatabaseType;
/** Executions of the main-thread backfill's first statement. */
let fallbackBackfills = 0;
const send = jest.fn();

function makeDb(): DatabaseType {
  const d = new Database(":memory:") as unknown as DatabaseType;
  d.exec(SCHEMA_SQL);
  d.exec(V40_INDEX_SQL);
  d.pragma("foreign_keys = ON");
  d.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-4180-pr2')`,
  ).run(USER, "owner@example.test");
  const prepare = d.prepare.bind(d);
  (d as any).prepare = (sqlText: string) => {
    if (sqlText === IMPORTED_CONTACT_IDS_SQL) fallbackBackfills++;
    return prepare(sqlText);
  };
  return d;
}

/** Every backfill run, either path. */
function backfills(): number {
  return fallbackBackfills + (queryContacts as jest.Mock).mock.calls.filter((c) => c[0] === "backfill").length;
}

function passCount(): number {
  return send.mock.calls.filter((c) => c[0] === "contacts:link-review-updated").length;
}

/** Fire the coalesced pass and wait for it to settle (the scheduler notifies after every pass). */
async function settle(): Promise<void> {
  const before = passCount();
  jest.advanceTimersByTime(QUIET_PERIOD_MS);
  for (let i = 0; i < 200 && passCount() === before; i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (passCount() === before) throw new Error("the linking pass never settled");
}

function addContact(contactId: string, name: string, emails: string[], phones: string[]): void {
  db.prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)").run(
    contactId,
    USER,
    name,
  );
  syncContactEmails(contactId, emails.map((email, i) => ({ email, is_primary: i === 0 })));
  syncContactPhones(contactId, phones.map((phone, i) => ({ phone, is_primary: i === 0 })));
}

/** A saved contact that owns a source record — the state `contacts:import` leaves. */
function addLinkedContact(
  contactId: string,
  name: string,
  sourceType: string,
  recordId: string,
  emails: string[] = [],
  phones: string[] = [],
): void {
  addContact(contactId, name, emails, phones);
  createLink({ userId: USER, contactId, sourceType: sourceType as any, sourceRecordId: recordId, matchMethod: "source_id" });
  applyLinkedSourceValuesOrThrow(USER, contactId);
}

function phonesOf(contactId: string): string[] {
  return (
    db.prepare("SELECT phone_normalized FROM contact_phones WHERE contact_id = ? ORDER BY 1").all(contactId) as Array<{
      phone_normalized: string;
    }>
  ).map((r) => r.phone_normalized);
}

function emailsOf(contactId: string): string[] {
  return (
    db.prepare("SELECT LOWER(email) AS e FROM contact_emails WHERE contact_id = ? ORDER BY 1").all(contactId) as Array<{
      e: string;
    }>
  ).map((r) => r.e);
}

function linkOf(recordId: string): string | null {
  const row = db
    .prepare("SELECT contact_id FROM contact_source_links WHERE user_id = ? AND source_record_id = ?")
    .get(USER, recordId) as { contact_id: string } | undefined;
  return row?.contact_id ?? null;
}

function failPhoneInsertsFor(contactId: string): void {
  db.exec(
    `CREATE TRIGGER fail_phone_4180 BEFORE INSERT ON contact_phones WHEN NEW.contact_id = '${contactId}'
     BEGIN SELECT RAISE(ABORT, 'forced phone insert failure'); END`,
  );
}

function register(): void {
  const stubWindow = { isDestroyed: () => false, webContents: { send } };
  setMainWindow(stubWindow as never);
  registerContactHandlers();
}

/** What a restart leaves: no in-memory state, the database intact. */
function simulateRestart(): void {
  resetContactSessionState();
  __resetContactLinkingScheduler();
  registeredHandlers.clear();
  register();
}

const A = "(415) 555-0111";
const B = "(415) 555-0112";
const KEY_B = "14155550112";

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
  db = makeDb();
  setDb(db as never);
  fallbackBackfills = 0;
  poolReady = false;
  autoLinkMode = "off";
  (queryContacts as jest.Mock).mockClear();
  (logService.info as jest.Mock).mockClear();
  send.mockClear();
  registeredHandlers.clear();
  resetContactSessionState();
  __resetContactLinkingScheduler();
  register();
});

afterEach(() => {
  resetContactSessionState();
  __resetContactLinkingScheduler();
  jest.useRealTimers();
  db.close();
});

// ---------------------------------------------------------------------------
// C1 — the step-1 symptom
// ---------------------------------------------------------------------------
describe("C1 a pass with nothing new runs no backfill", () => {
  it.each([false, true])("10k already-linked contacts, pool ready = %s", async (ready) => {
    poolReady = ready;
    const N = 10_000;
    externalContactDb.fullSync(
      USER,
      Array.from({ length: N }, (_, i) => ({
        recordId: `bulk-${i}`,
        name: `Bulk ${i}`,
        emails: [`bulk${i}@example.test`],
        phones: [],
      })) as any,
    );
    const insertContact = db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
    );
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        insertContact.run(`bc-${i}`, USER, `Bulk ${i}`);
        createLink({ userId: USER, contactId: `bc-${i}`, sourceType: "macos", sourceRecordId: `bulk-${i}`, matchMethod: "source_id" });
      }
    })();

    await settle(); // the sync's pass: sources changed -> backfill
    expect(backfills()).toBe(1);

    requestContactLinking(USER); // what get-available reconciliation does
    await settle();

    expect(backfills()).toBe(1);
    const passLines = (logService.info as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith("[Contacts] linking pass:"));
    expect(passLines[passLines.length - 1]).toMatch(/linking pass: 0 link\(s\) created/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// C2 — address-book edits still reach already-linked contacts
// ---------------------------------------------------------------------------
type Writer = {
  name: string;
  source: string;
  seed: (phones: string[]) => void;
  /** Write the edit; returns after the writer (and its commit-point signal) ran. */
  edit: (phones: string[]) => void;
};

const WRITERS: Writer[] = [
  {
    name: "macOS fullSync",
    source: "macos",
    seed: (phones) => externalContactDb.fullSync(USER, [{ recordId: "r-1", name: "Pat Riverton", emails: [], phones }] as any),
    edit: (phones) => externalContactDb.fullSync(USER, [{ recordId: "r-1", name: "Pat Riverton", emails: [], phones }] as any),
  },
  {
    name: "iPhone with a session (signal at the commit point)",
    source: "iphone",
    seed: (phones) => externalContactDb.upsertFromiPhone(USER, [{ recordId: "r-1", name: "Pat Riverton", phones }]),
    edit: (phones) => {
      externalContactDb.upsertFromiPhone(USER, [{ recordId: "r-1", name: "Pat Riverton", phones }], "session-4180");
      // iPhoneSyncStorageService.persistSyncResult, past every rollback branch:
      requestContactLinking(USER);
    },
  },
  {
    name: "iPhone without a session",
    source: "iphone",
    seed: (phones) => externalContactDb.upsertFromiPhone(USER, [{ recordId: "r-1", name: "Pat Riverton", phones }]),
    edit: (phones) => externalContactDb.upsertFromiPhone(USER, [{ recordId: "r-1", name: "Pat Riverton", phones }]),
  },
  {
    name: "generic upsert (outlook)",
    source: "outlook",
    seed: (phones) =>
      externalContactDb.upsertExternalContacts(USER, "outlook", [
        { external_record_id: "r-1", name: "Pat Riverton", emails: [], phones, company: null } as any,
      ]),
    edit: (phones) =>
      externalContactDb.upsertExternalContacts(USER, "outlook", [
        { external_record_id: "r-1", name: "Pat Riverton", emails: [], phones, company: null } as any,
      ]),
  },
];

describe.each(WRITERS)("C2 an edit to an already-linked record reaches the contact — $name", (w) => {
  async function converged(): Promise<void> {
    w.seed([A]);
    addLinkedContact("c-1", "Pat Riverton", w.source, "r-1", [], [A]);
    await settle();
    expect(phonesOf("c-1")).toEqual(["14155550111"]);
  }

  it("within the session", async () => {
    await converged();
    w.edit([A, B]);
    await settle();
    expect(phonesOf("c-1")).toContain(KEY_B);
  });

  it("after a restart between the write and the pass", async () => {
    await converged();
    w.edit([A, B]);
    simulateRestart(); // the pending pass and every in-memory flag are gone
    requestContactLinking(USER); // the first pass of the new session
    await settle();
    expect(phonesOf("c-1")).toContain(KEY_B);
  });
});

// ---------------------------------------------------------------------------
// C3 — a uuid capture is not a link; an unchanged macOS sync is not a change
// ---------------------------------------------------------------------------
describe("C3 uuid capture on an already-linked record", () => {
  it("captures the uuid and runs no backfill", async () => {
    externalContactDb.fullSync(USER, [{ recordId: "r-1", name: "Pat Riverton", emails: [], phones: [A] }] as any);
    addLinkedContact("c-1", "Pat Riverton", "macos", "r-1", [], [A]);
    await settle();
    const after1 = backfills();
    expect(after1).toBe(1);

    // Same content; only the portable id is new. classifyMacOSSync: unchanged.
    externalContactDb.fullSync(USER, [
      { recordId: "r-1", name: "Pat Riverton", emails: [], phones: [A], externalUuid: "uuid-4180" },
    ] as any);
    await settle();

    const link = db
      .prepare("SELECT external_uuid FROM contact_source_links WHERE source_record_id = 'r-1'")
      .get() as { external_uuid: string | null };
    expect(link.external_uuid).toBe("uuid-4180"); // the capture happened
    expect(backfills()).toBe(after1);
  });
});

// ---------------------------------------------------------------------------
// C4 — a name-rule link still triggers the backfill
// ---------------------------------------------------------------------------
describe("C4 a unique-name link (auto mode) triggers the backfill", () => {
  it("backfills after a pass whose only new link is the name rule's", async () => {
    autoLinkMode = "auto";
    externalContactDb.fullSync(USER, [{ recordId: "r-C", name: "Casey Named", emails: ["casey@example.test"], phones: [] }] as any);
    externalContactDb.upsertExternalContacts(USER, "outlook", [
      { external_record_id: "o-c", name: "Casey Named", emails: [], phones: [B], company: null } as any,
    ]);
    await settle(); // nothing saved yet; first pass of the session backfills
    const before = backfills();

    // The import: a saved contact claiming r-C. external_contacts unchanged.
    addLinkedContact("c-C", "Casey Named", "macos", "r-C", ["casey@example.test"], []);
    requestContactLinking(USER);
    await settle();

    expect(linkOf("o-c")).toBe("c-C"); // the name rule linked it
    expect(backfills()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// C5 — a link and its value copy commit or roll back together
// ---------------------------------------------------------------------------
describe("C5 a failed copy rolls its link back", () => {
  it("content match: the failing record has neither link nor values; the others have both", async () => {
    // Saved contacts with no crosswalk row yet: the content fallback links them.
    addContact("c-1", "Pat Riverton", ["pat@example.test"], []);
    addContact("c-2", "Robin Marsh", ["robin@example.test"], []);
    failPhoneInsertsFor("c-1");

    externalContactDb.fullSync(USER, [
      // Matches c-1 by email; its phone copy fails.
      { recordId: "r-1", name: "Pat Riverton", emails: ["pat@example.test"], phones: [A] },
      // Matches c-1 ONLY through the phone that was rolled back.
      { recordId: "r-1b", name: "Pat Riverton", emails: [], phones: [A] },
      // Matches c-2 by email; copies cleanly.
      { recordId: "r-2", name: "Robin Marsh", emails: ["robin@example.test"], phones: [B] },
    ] as any);
    await settle();

    expect(linkOf("r-1")).toBeNull();
    expect(linkOf("r-1b")).toBeNull();
    expect(phonesOf("c-1")).toEqual([]);
    expect(linkOf("r-2")).toBe("c-2");
    expect(phonesOf("c-2")).toEqual([KEY_B]);
    // The funnel line reports the rolled-back link (r-1).
    const funnel = (logService.info as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith("[Contacts] links:"));
    expect(funnel[funnel.length - 1]).toContain("-> link-failed 1 ->");
  });

  it("name rule (auto mode): the failing link is not written and not counted", async () => {
    autoLinkMode = "auto";
    externalContactDb.fullSync(USER, [{ recordId: "r-C", name: "Casey Named", emails: ["casey@example.test"], phones: [] }] as any);
    externalContactDb.upsertExternalContacts(USER, "outlook", [
      { external_record_id: "o-c", name: "Casey Named", emails: [], phones: [B], company: null } as any,
    ]);
    await settle();
    addLinkedContact("c-C", "Casey Named", "macos", "r-C", ["casey@example.test"], []);
    failPhoneInsertsFor("c-C");
    const before = backfills();

    requestContactLinking(USER);
    await settle();

    expect(linkOf("o-c")).toBeNull();
    expect(phonesOf("c-C")).toEqual([]);
    expect(backfills()).toBe(before); // no new link, no source change
  });

  it("main-thread backfill: one contact's emails and phones land together or not at all", async () => {
    externalContactDb.fullSync(USER, [
      { recordId: "r-0", name: "Avery Existing", emails: ["avery@example.test"], phones: [A] },
      { recordId: "r-1", name: "Pat Riverton", emails: ["pat@example.test"], phones: [B] },
    ] as any);
    // Linked rows WITHOUT their values (no copy) — what the backfill exists to fill.
    for (const [cid, name, rid] of [["c-0", "Avery Existing", "r-0"], ["c-1", "Pat Riverton", "r-1"]]) {
      db.prepare("INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)").run(cid, USER, name);
      createLink({ userId: USER, contactId: cid, sourceType: "macos", sourceRecordId: rid, matchMethod: "source_id" });
    }
    failPhoneInsertsFor("c-1");

    await settle();

    expect(emailsOf("c-0")).toEqual(["avery@example.test"]);
    expect(phonesOf("c-0")).toEqual(["14155550111"]);
    expect(emailsOf("c-1")).toEqual([]); // its phone failed, so its email rolled back too
    expect(phonesOf("c-1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C6 — a backfill that throws leaves the work owed
// ---------------------------------------------------------------------------
describe("C6 the source-change flag clears only after a backfill completes", () => {
  it("next pass backfills again after a failed one", async () => {
    externalContactDb.fullSync(USER, [{ recordId: "r-1", name: "Pat Riverton", emails: [], phones: [A] }] as any);
    addLinkedContact("c-1", "Pat Riverton", "macos", "r-1", [], [A]);
    await settle();

    failPhoneInsertsFor("c-1");
    externalContactDb.fullSync(USER, [{ recordId: "r-1", name: "Pat Riverton", emails: [], phones: [A, B] }] as any);
    await settle();
    expect(phonesOf("c-1")).not.toContain(KEY_B);
    const afterFailure = backfills();

    db.exec("DROP TRIGGER fail_phone_4180");
    requestContactLinking(USER); // no write, no new link
    await settle();

    expect(backfills()).toBe(afterFailure + 1);
    expect(phonesOf("c-1")).toContain(KEY_B);
  });
});

// ---------------------------------------------------------------------------
// C7 — the first pass of a session counts as "sources changed"
// ---------------------------------------------------------------------------
describe("C7 first pass per session backfills with no write in the session", () => {
  it("fresh module state, no upsert -> the first pass backfills", async () => {
    externalContactDb.fullSync(USER, [{ recordId: "r-1", name: "Pat Riverton", emails: [], phones: [A] }] as any);
    addLinkedContact("c-1", "Pat Riverton", "macos", "r-1", [], [A]);
    simulateRestart();
    fallbackBackfills = 0;

    requestContactLinking(USER);
    await settle();

    expect(backfills()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C8 — a source write that lands while a backfill is awaiting stays owed
// ---------------------------------------------------------------------------
describe("C8 a write during the worker-planned backfill is not marked done", () => {
  it("the next pass backfills again", async () => {
    poolReady = true;
    externalContactDb.fullSync(USER, [{ recordId: "r-1", name: "Pat Riverton", emails: [], phones: [A] }] as any);
    addLinkedContact("c-1", "Pat Riverton", "macos", "r-1", [], [A]);
    // The worker plans while a sync writes an edit (main is free during the await).
    (queryContacts as jest.Mock).mockImplementationOnce(async () => {
      externalContactDb.fullSync(USER, [{ recordId: "r-1", name: "Pat Riverton", emails: [], phones: [A, B] }] as any);
      return [];
    });

    await settle(); // backfill #1, edit lands mid-way and arms another pass
    expect(backfills()).toBe(1);

    await settle(); // the edit's pass: no new link, but the edit is owed
    expect(backfills()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R2.3 — the main-thread fallback marks the user backfilled
// ---------------------------------------------------------------------------
describe("R2.3 pool down: Clients & Contacts opened twice backfills once", () => {
  it("the second get-all does not re-run the backfill", async () => {
    externalContactDb.fullSync(USER, [{ recordId: "r-1", name: "Pat Riverton", emails: [], phones: [A] }] as any);
    addLinkedContact("c-1", "Pat Riverton", "macos", "r-1", [], [A]);
    jest.clearAllTimers(); // no scheduler pass in this test: only get-all
    const getAll = registeredHandlers.get("contacts:get-all");

    await getAll({} as any, USER);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(backfills()).toBe(1);

    await getAll({} as any, USER);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(backfills()).toBe(1);
  });
});
