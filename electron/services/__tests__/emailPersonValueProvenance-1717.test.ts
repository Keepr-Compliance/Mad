/**
 * @jest-environment node
 *
 * BACKLOG-1717 — confirming a person must not lose their address later.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO STOP, MEASURED BEFORE ANY OF IT SHIPPED
 * ---------------------------------------------------------------------------
 * A person found in the user's email carries exactly one thing: an address.
 * The user confirms them, `contacts:import` stores them as `manual`, and the
 * batch writer stamped their address `'import'` — "this came out of an
 * external system, nobody typed it".
 *
 * Every import then runs the linker, which links an address-book card sharing
 * that address. The moment the user unlinks that card — presses "Not this
 * person" — BACKLOG-2427 gives the unlink permission to delete `'import'`
 * values, and the confirmed person's ONLY address is deleted. The contact
 * survives with nothing on it.
 *
 * It was measured at `removedEmails: 1`, `contact_emails` empty.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE IS LOAD-BEARING RATHER THAN BELT-AND-BRACES
 * ---------------------------------------------------------------------------
 * The stamp change was run against all 39 suites that touch the import door —
 * 718 tests — and NOT ONE of them noticed it. Nothing else in the tree pins
 * what this door stamps. If this file is deleted, the defect can come back
 * silently.
 *
 * ---------------------------------------------------------------------------
 * AND THE OVER-CORRECTION IS CONTROLLED TOO
 * ---------------------------------------------------------------------------
 * The wrong fix is to stamp everything `'manual'`. That would make an
 * address-book import's values permanent, and BACKLOG-2427's whole purpose is
 * that rejecting a record takes its values back off. K3b holds that line: an
 * Outlook import still stamps `'import'` and an unlink still removes it.
 *
 * The asymmetry, stated once: misclassifying an imported value as typed costs
 * a stale row the user can delete. The reverse deletes a client's address.
 */

import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";
import { openTestDb, type TestDb } from "./helpers/syncSqliteDriver";

let mockDb: TestDb | null = null;

jest.mock("../db/core/dbConnection", () => ({
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

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../contactLinkingScheduler", () => ({
  __esModule: true,
  requestContactLinking: jest.fn(),
}));

import { createContactsBatch } from "../db/contactDbService";
import { unlinkContactSource } from "../contactProvenance";
import { createLink } from "../db/contactSourceLinkDbService";

const USER = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: invented, not from any live row
const AVERY = "avery@example.com";

interface ValueRow {
  email: string;
  source: string;
}

function emailRowsOn(contactId: string): ValueRow[] {
  return mockDb!
    .prepare(`SELECT email, source FROM contact_emails WHERE contact_id = ? ORDER BY email`)
    .all(contactId) as ValueRow[];
}

/** An address-book card carrying the same address, so a link can be made. */
function addExternalCard(recordId: string, source: string, emails: string[]): void {
  mockDb!
    .prepare(
      `INSERT INTO external_contacts
        (id, user_id, name, phones_json, phones_normalized_json, emails_json,
         external_record_id, source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ext-${source}-${recordId}`,
      USER,
      "Avery Example",
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify(emails),
      recordId,
      source,
      "2026-09-01T00:00:00.000Z",
    );
}

beforeEach(() => {
  mockDb = openTestDb();
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  jest.clearAllMocks();
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

describe("BACKLOG-1717 — a confirmed person keeps their address", () => {
  /** PRECONDITION — without this the controls below could pass on nothing. */
  it("the real writer really does store the address", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "Avery Example",
        email: AVERY,
        allEmails: [AVERY],
        source: "manual",
        origin: { kind: "derived" },
      },
    ]);
    expect(id).toBeTruthy();
    expect(emailRowsOn(id).map((r) => r.email)).toEqual([AVERY]);
  });

  /**
   * K3 — the address is stamped as the user's own, because confirming IS the
   * user asserting it.
   *
   * Mutation that reds this: restore the literal `'import'` at the two inserts
   * in `createContactsBatch`.
   */
  it("K3: stamps a confirmed person's address as typed, not imported", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "Avery Example",
        email: AVERY,
        allEmails: [AVERY],
        source: "manual",
        origin: { kind: "derived" },
      },
    ]);
    expect(emailRowsOn(id)).toEqual([{ email: AVERY, source: "manual" }]);
  });

  /**
   * K3 end to end — the behaviour the stamp exists for.
   *
   * Confirm the person, let an Outlook card carrying the same address be
   * linked to them, then unlink it. The address must still be there: the user
   * put it there by confirming, and rejecting somebody else's card says
   * nothing about it.
   */
  it("K3: unlinking a card that shares the address does not delete it", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "Avery Example",
        email: AVERY,
        allEmails: [AVERY],
        source: "manual",
        origin: { kind: "derived" },
      },
    ]);

    addExternalCard("out-avery", "outlook", [AVERY]);
    const link = createLink({
      userId: USER,
      contactId: id,
      sourceType: "outlook",
      sourceRecordId: "out-avery",
      matchMethod: "email",
    });
    expect(link.id).toBeTruthy(); // the link really exists, or the unlink proves nothing

    const outcome = unlinkContactSource(USER, id, link.id!);
    // Narrow first: the failure arm of the union carries no counts, and an
    // unlink that silently failed would otherwise "keep" the address for the
    // wrong reason entirely.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`unlink failed: ${outcome.error}`);
    expect(outcome.removedEmails ?? 0).toBe(0);
    expect(emailRowsOn(id).map((r) => r.email)).toEqual([AVERY]);
  });

  /**
   * K3b — THE OVER-CORRECTION CONTROL.
   *
   * The lazy version of this fix is to stamp everything `'manual'`. That would
   * make an address-book import's values permanent and quietly disable
   * BACKLOG-2427: the founder presses "Not this person" and the rejected
   * record's address stays on the contact forever, which is the defect 2427
   * exists to fix.
   *
   * So an Outlook import must still stamp `'import'`, and the unlink must
   * still take the address back off.
   *
   * Mutation that reds this: stamp the literal `'manual'` at both inserts.
   */
  it("K3b: an address-book import is still removable when its card is rejected", () => {
    const [id] = createContactsBatch([
      {
        user_id: USER,
        display_name: "Avery Example",
        email: AVERY,
        allEmails: [AVERY],
        source: "outlook",
        origin: {
          kind: "sourceRecords",
          identities: [{ sourceType: "outlook", sourceRecordId: "out-avery", externalUuid: null }],
        },
      },
    ]);

    // The import door's own stamp for an external system.
    expect(emailRowsOn(id)).toEqual([{ email: AVERY, source: "import" }]);

    addExternalCard("out-avery", "outlook", [AVERY]);
    const link = createLink({
      userId: USER,
      contactId: id,
      sourceType: "outlook",
      sourceRecordId: "out-avery",
      matchMethod: "source_id",
    });
    expect(link.id).toBeTruthy();

    unlinkContactSource(USER, id, link.id!);
    // Gone, because nobody asserted it — the record it came from was rejected.
    expect(emailRowsOn(id).map((r) => r.email)).toEqual([]);
  });
});
