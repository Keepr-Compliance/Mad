/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * =============================================================================
 * BACKLOG-2707 — WHAT A NAMELESS CONTACT IS ACTUALLY CALLED ON DISK
 * =============================================================================
 * This is the suite the item stands on, and it is deliberately NOT at the
 * handler level.
 *
 * `contacts:import` used to refuse a record with no name but a phone, while the
 * button offering it called it importable. Relaxing the validator makes the
 * record import — and, before this PR, stored the literal string `"Unknown"`
 * anyway, because `createContactsBatch` carried its OWN
 * `contactData.display_name || "Unknown"` substitution. A fix that only edited
 * `validation.ts` and `contactHandlers.ts` would have shipped a green suite
 * over exactly the state BACKLOG-2461 exists to remove.
 *
 * WHY THE 2684 HANDLER HARNESS CANNOT ASSERT THIS. That suite mocks
 * `createContactsBatch` with an insert that writes `row.display_name` RAW and
 * omits `company` and `title` from its column list entirely. It therefore
 * cannot go red on the writer's substitution, and cannot see a company-only
 * record's company at all. It proves the handler FORWARDS — a real claim, and a
 * lesser one. The stored value is only observable here.
 *
 * So this harness mocks `../core/dbConnection` and NOTHING else. `dbTransaction`
 * routes to a REAL transaction rather than the `(fn) => fn()` passthrough that
 * ten sibling suites use — that passthrough satisfies every caller while
 * silently removing the atomicity, and is the mutant BACKLOG-2368's suite
 * exists to reject.
 *
 * MEASURED BEFORE THE FIX, on `9d97e9c38`, through this exact call:
 *
 *   {display_name:"", phone}                     -> stored {"display_name":"Unknown"}
 *   {display_name:"", company:"Vantrees Realty"} -> stored {"display_name":"Unknown"}
 *   {display_name:"Rosalind Vance"}              -> stored {"display_name":"Rosalind Vance"}
 *
 * Restoring `|| "Unknown"` at either substitution site reds this file.
 */

import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";
import { CONTACT_IDENTITY_SCHEMA } from "../../__tests__/helpers/contactIdentitySchema";
// The RENDERER label function on purpose: it is what actually renders the
// contacts list, so asserting through it is asserting what the founder sees.
import { labelForContact } from "../../../../src/utils/contactDisplayLabel";

let mockDb: TestDb | null = null;

jest.mock("../core/dbConnection", () => ({
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

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../contactsService", () => ({ getContactNames: () => new Map() }));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: () => false,
}));

import { createContact, createContactsBatch } from "../contactDbService";

const USER = "user-2707";

/** The `origin` every create path requires — a caller that omits it does not compile. */
function originFor(recordId: string) {
  return {
    kind: "sourceRecords" as const,
    identities: [
      { sourceType: "macos", sourceRecordId: recordId, externalUuid: null },
    ],
  };
}

function storedRow(id: string) {
  return mockDb!
    .prepare("SELECT display_name, company FROM contacts WHERE id = ?")
    .get(id) as { display_name: string; company: string | null };
}

function storedPhone(id: string): string | null {
  const row = mockDb!
    .prepare("SELECT phone_display FROM contact_phones WHERE contact_id = ? ORDER BY is_primary DESC")
    .get(id) as { phone_display: string } | undefined;
  return row?.phone_display ?? null;
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
});

afterEach(() => {
  mockDb?.close?.();
  mockDb = null;
});

describe("createContactsBatch stores the caller's name, not a label of its own (BACKLOG-2707)", () => {
  /**
   * The four spellings the handler can produce, swept rather than sampled. The
   * validator collapses absent / `null` / `""` / whitespace to `""`, and
   * `contactHandlers` forwards it with `?? ""` — so `""` and `undefined` are
   * the two values that can actually arrive here, and both must land as `""`.
   */
  it.each([
    ["an empty string, what the handler forwards for a nameless record", ""],
    ["undefined, if a caller omits the field entirely", undefined],
  ])("%s -> display_name stores \"\"", (_label, value) => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: value as string,
        phone: "+14155550142",
        allPhones: ["+14155550142"],
        allEmails: [],
        source: "contacts_app",
        origin: originFor("rec-empty"),
      },
    ]);

    // BY VALUE. Asserting "a row exists" passes while storing "Unknown", which
    // is exactly what this file exists to catch.
    expect(storedRow(id).display_name).toBe("");
  });

  it("a company-only record keeps its company and stores no name", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "",
        company: "Vantrees Realty",
        allPhones: [],
        allEmails: [],
        source: "contacts_app",
        origin: originFor("rec-company"),
      },
    ]);

    // `company` is the column the 2684 harness's mock does not even insert.
    expect(storedRow(id)).toEqual({ display_name: "", company: "Vantrees Realty" });
  });

  it("a named record is stored verbatim — the regression baseline", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "Rosalind Vance",
        allPhones: ["+14155550145"],
        allEmails: [],
        source: "contacts_app",
        origin: originFor("rec-named"),
      },
    ]);

    expect(storedRow(id).display_name).toBe("Rosalind Vance");
  });

  it("createContact — the single-row path carries the same rule", async () => {
    const contact = await createContact(
      { user_id: USER, display_name: "", phone: "+14155550149" } as any,
      originFor("rec-single") as any,
    );

    expect(storedRow((contact as any).id).display_name).toBe("");
  });
});

/**
 * The BACKLOG-2461 display chain, asserted on what is ACTUALLY STORED rather
 * than on a fixture. If the stored value and the label chain ever disagree, a
 * nameless contact becomes unidentifiable on screen — which is the founder's
 * original complaint on 2461 and the reason `""` had to be safe to store.
 */
describe("the label chain renders the stored row (BACKLOG-2461 x BACKLOG-2707)", () => {
  it("a nameless contact with a phone displays the formatted number", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "",
        phone: "+14155550142",
        allPhones: ["+14155550142"],
        allEmails: [],
        source: "contacts_app",
        origin: originFor("rec-label-phone"),
      },
    ]);

    // Both halves read back out of the database — nothing here is invented.
    const row = storedRow(id);
    const label = labelForContact({
      display_name: row.display_name,
      company: row.company,
      phone: storedPhone(id),
    });

    expect(label).toBe("+1 (415) 555-0142");
    expect(label).not.toMatch(/unknown/i);
    expect(label).not.toBe("No name");
  });

  it("a nameless contact with a company displays the company", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "",
        company: "Vantrees Realty",
        allPhones: [],
        allEmails: [],
        source: "contacts_app",
        origin: originFor("rec-label-company"),
      },
    ]);

    const row = storedRow(id);
    expect(labelForContact({ display_name: row.display_name, company: row.company })).toBe(
      "Vantrees Realty",
    );
  });
});
