/**
 * @jest-environment node
 *
 * BACKLOG-2471 PR D — `confirmContactSources` is all-or-nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND EXACTLY WHAT IT DOES AND DOES NOT COVER
 * ---------------------------------------------------------------------------
 * `writeAtomicity.guard.test.ts` (BACKLOG-2530) scans `DB_DIR =
 * electron/services/db`. `contactCompare.ts` is a COMPOSITION service, a layer
 * above that, alongside `contactLinkReview.ts` and `contactProvenance.ts` — the
 * SR ruling on BACKLOG-2426 is that a guard's directory constant must not
 * dictate architecture, and BACKLOG-2584 is where that standing gap gets closed.
 *
 * So THIS TEST IS THE ONLY THING standing between a future edit and a
 * half-confirmed contact.
 *
 * **It covers removal of `dbTransaction` FROM `confirmContactSources` AS
 * WRITTEN. It does NOT cover a new multi-write added to this file later without
 * its own crash test.** Carried verbatim from `contactManualLink.ts`, because
 * "we have a rollback test" otherwise implies more than it delivers.
 *
 * ---------------------------------------------------------------------------
 * WHAT A HALF-WRITE WOULD ACTUALLY DO
 * ---------------------------------------------------------------------------
 * The write is: one `same_person` verdict per non-origin link, then the pending
 * review-queue questions for those pairs. A crash between them leaves some links
 * confirmed and the rest not — so the contact still reads UNCONFIRMED and
 * re-opens the compare screen on every click, while the queue has already been
 * told the question is settled. The user is asked again about something the app
 * has recorded as answered.
 *
 * It lives in its own file because it mocks `resolveProposal` to throw, and that
 * mock must not reach the 33 tests in `contactCompare.test.ts`.
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";
import { CONTACT_COMMUNICATION_SCHEMA } from "./helpers/contactCommunicationSchema";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

let mockDb: DatabaseType | null = null;

jest.mock("../db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => mockDb!.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...params);
    return { lastInsertRowid: r.lastInsertRowid as number, changes: r.changes };
  },
  // A REAL SQLite transaction, so a rollback is a rollback and not a stub
  // agreeing with the test.
  dbTransaction: <T>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
}));

jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

/**
 * The LAST step of the write throws — the crash the transaction exists for.
 *
 * Everything else is the real module: the verdicts really are written by the
 * real `recordVerdict` before the throw, which is what makes their absence
 * afterwards mean something.
 */
const resolveProposalMock = jest.fn(() => {
  throw new Error("disk full");
});
jest.mock("../db/contactLinkReviewDbService", () => ({
  ...jest.requireActual("../db/contactLinkReviewDbService"),
  resolveProposal: (...args: unknown[]) => resolveProposalMock(...(args as [])),
}));

import { confirmContactSources } from "../contactCompare";
import { createLink } from "../db/contactSourceLinkDbService";
import { recordContactOrigin } from "../db/contactOriginLink";
import { proposeLink } from "../db/contactLinkReviewDbService";

const USER = "user-rollback-2471";

beforeEach(() => {
  mockDb = new RealDatabase(":memory:");
  mockDb.exec(CONTACT_IDENTITY_SCHEMA);
  mockDb.exec(CONTACT_COMMUNICATION_SCHEMA);
  resolveProposalMock.mockClear();

  mockDb
    .prepare(
      `INSERT INTO contacts (id, user_id, display_name, source, is_imported)
       VALUES ('c1', ?, 'Paul Dorian', 'contacts_app', 1)`,
    )
    .run(USER);
  expect(recordContactOrigin(USER, "c1", "contacts_app")).toBe(true);

  for (const [source, record] of [
    ["macos", "mac-1"],
    ["outlook", "out-1"],
  ] as const) {
    mockDb
      .prepare(
        `INSERT INTO external_contacts
          (id, user_id, name, phones_json, emails_json, external_record_id, source, synced_at)
         VALUES (?, ?, 'Paul Dorian', '[]', '[]', ?, ?, datetime('now'))`,
      )
      .run(`ec-${record}`, USER, record, source);
    createLink({
      userId: USER,
      contactId: "c1",
      sourceType: source,
      sourceRecordId: record,
      matchMethod: source === "macos" ? "source_id" : "email",
      assertMethod: true,
    });
  }

  proposeLink({
    userId: USER,
    contactId: "c1",
    sourceType: "outlook",
    sourceRecordId: "out-1",
    reason: "ambiguous_identifier",
    matchedOn: "email",
    identityAssessment: "possibly_same_person",
    relationshipAssessment: "possibly_connected",
    clusterKey: "record:out-1",
    evidence: { lines: [] } as never,
  });
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

const verdictCount = () =>
  (mockDb!.prepare("SELECT COUNT(*) AS n FROM contact_link_verdicts").get() as { n: number }).n;

const pendingCount = () =>
  (
    mockDb!
      .prepare("SELECT COUNT(*) AS n FROM contact_link_proposals WHERE status = 'pending'")
      .get() as { n: number }
  ).n;

describe("the confirmation is all-or-nothing", () => {
  /**
   * CONTROL: remove `dbTransaction` from `confirmContactSources` (return the
   * body directly).
   * OBSERVED: 1 failed / 2 passed — both `same_person` verdicts survive the
   * throw, leaving a contact the app has recorded as partly confirmed and the
   * queue still holding its question.
   */
  it("rolls both verdicts back when the last step throws", () => {
    expect(verdictCount()).toBe(0);

    expect(() => confirmContactSources(USER, "c1")).toThrow("disk full");

    // The real `recordVerdict` DID write two rows before the throw. Their
    // absence here is the transaction, not the absence of an attempt.
    expect(resolveProposalMock).toHaveBeenCalled();
    expect(verdictCount()).toBe(0);
    expect(pendingCount()).toBe(1);
  });

  it("leaves the contact unconfirmed rather than half-confirmed", () => {
    expect(() => confirmContactSources(USER, "c1")).toThrow("disk full");

    // Not one verdict, not two — none. A single surviving verdict is the state
    // that reads "confirmed" to the matcher and "unconfirmed" to the screen.
    expect(
      mockDb!
        .prepare("SELECT source_record_id FROM contact_link_verdicts ORDER BY source_record_id")
        .all(),
    ).toEqual([]);
  });
});
