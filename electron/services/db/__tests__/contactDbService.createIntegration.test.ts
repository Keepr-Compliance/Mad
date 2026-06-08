/**
 * @jest-environment node
 *
 * BACKLOG-1745 Part 2 follow-up #2: REAL (non-mocked) integration test for the
 * create-new-row path in contactDbService.createContact.
 *
 * Live runtime evidence on Sue Ubqt (external SMS-derived contact, no email,
 * with last_communication_at populated; NEW UUID assigned by the handler — so
 * findContactByName did NOT short-circuit) showed:
 *   PRE:  last_communication_at = "2026-05-29T16:13:31.667Z"
 *   POST: last_inbound_at = null, last_outbound_at = null
 *
 * The pre-existing mocked suite at contactDbService.timestampPassthrough.test.ts
 * asserts the INSERT SQL + bound params include last_inbound_at / last_outbound_at,
 * but bypasses the real SQLite driver and the post-INSERT getContactById SELECT.
 * This test closes that gap by exercising the full DB chain end-to-end with
 * the real better-sqlite3 driver (via the migration test harness), proving
 * that a value supplied at the API boundary actually survives all the way back
 * out via getContactById.
 *
 * If createContact ever stops persisting these columns (or getContactById ever
 * stops returning them), this test fails — unlike the mocked suite, which only
 * fails when the SQL string changes.
 */

import path from "path";
import { jest } from "@jest/globals";

// ---------------------------------------------------------------------------
// MOCKS — keep minimal. The harness uses the REAL better-sqlite3 driver.
// Everything else Electron-dependent must be stubbed so the module graph
// loads in a Node Jest environment.
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../../logService", () => {
  const fns = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: fns, logService: fns };
});

jest.mock("../../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
  default: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));

jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// ---------------------------------------------------------------------------
// IMPORTS — only after mocks above are wired.
// ---------------------------------------------------------------------------

import {
  createMigrationHarness,
  type MigrationHarness,
} from "../../__tests__/helpers/migrationTestHarness";

// Sanity: assert the harness brought up the real driver, not the auto-mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realDatabase = require(
  path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "node_modules",
    "better-sqlite3-multiple-ciphers",
  ),
);

const USER_ID = "user-create-integ";

describe("BACKLOG-1745 Part 2 follow-up #2: createContact persists engagement timestamps end-to-end (real SQLite)", () => {
  let harness: MigrationHarness;

  beforeEach(async () => {
    harness = createMigrationHarness({ seedV29Schema: true });
    harness.seedSchemaVersion(40); // skip migration runner; v29-shape already has
                                   // last_inbound_at / last_outbound_at columns.
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("sanity: harness wired the real better-sqlite3 driver", () => {
    expect(realDatabase).toBeDefined();
    // Real driver supports pragma returning a list; the mock does not.
    const result = harness.db.pragma("user_version");
    expect(Array.isArray(result)).toBe(true);
  });

  it("persists last_inbound_at across INSERT → SELECT chain (Sue Ubqt scenario)", async () => {
    // Re-require so the createContact import resolves AFTER our mocks AND after
    // the harness wired setDb() — production write path will now target the
    // in-memory DB.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createContact } = require("../contactDbService");

    const externalRecency = "2026-05-29T16:13:31.667Z";

    const created = await createContact({
      user_id: USER_ID,
      display_name: "Sue ubqt",
      source: "messages",
      is_imported: true,
      // Mirrors what the handler computes for an external SMS-derived contact:
      // last_inbound_at is synthesized from last_communication_at by the
      // handler's ?? chain; last_outbound_at remains undefined for an inbound-
      // only conversation.
      last_inbound_at: externalRecency,
      last_outbound_at: undefined,
    });

    // The returned Contact (post getContactById SELECT) MUST reflect the
    // persisted value — this is what the renderer receives back over IPC.
    expect(created.last_inbound_at).toBe(externalRecency);
    expect(created.last_outbound_at == null).toBe(true);

    // Also verify the raw row directly via a hand-written SELECT — defends
    // against any case where getContactById silently masks the column.
    const row = harness.db
      .prepare(
        "SELECT last_inbound_at, last_outbound_at FROM contacts WHERE id = ?",
      )
      .get(created.id) as { last_inbound_at: string | null; last_outbound_at: string | null };

    expect(row.last_inbound_at).toBe(externalRecency);
    expect(row.last_outbound_at).toBeNull();
  });

  it("persists last_outbound_at when only outbound timestamp is supplied", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createContact } = require("../contactDbService");

    const outboundTs = "2026-04-01T12:00:00Z";

    const created = await createContact({
      user_id: USER_ID,
      display_name: "Outbound Only",
      source: "manual",
      is_imported: true,
      last_outbound_at: outboundTs,
    });

    expect(created.last_outbound_at).toBe(outboundTs);
    expect(created.last_inbound_at == null).toBe(true);

    const row = harness.db
      .prepare(
        "SELECT last_inbound_at, last_outbound_at FROM contacts WHERE id = ?",
      )
      .get(created.id) as { last_inbound_at: string | null; last_outbound_at: string | null };

    expect(row.last_outbound_at).toBe(outboundTs);
    expect(row.last_inbound_at).toBeNull();
  });

  it("persists BOTH timestamps when supplied (bidirectional conversation)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createContact } = require("../contactDbService");

    const inbound = "2026-06-01T10:00:00Z";
    const outbound = "2026-06-02T11:00:00Z";

    const created = await createContact({
      user_id: USER_ID,
      display_name: "Two-Way",
      source: "contacts_app",
      is_imported: true,
      last_inbound_at: inbound,
      last_outbound_at: outbound,
    });

    expect(created.last_inbound_at).toBe(inbound);
    expect(created.last_outbound_at).toBe(outbound);
  });

  it("writes NULL for both timestamps when caller supplies neither (existing manual-add path)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createContact } = require("../contactDbService");

    const created = await createContact({
      user_id: USER_ID,
      display_name: "Manual Add",
      source: "manual",
      is_imported: true,
    });

    expect(created.last_inbound_at == null).toBe(true);
    expect(created.last_outbound_at == null).toBe(true);
  });
});
