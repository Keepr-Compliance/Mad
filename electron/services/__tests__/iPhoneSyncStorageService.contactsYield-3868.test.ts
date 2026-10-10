/**
 * @jest-environment node
 *
 * BACKLOG-3868 - the contacts step of the iPhone sync (storeContacts ->
 * upsertFromiPhone) must yield to the event loop between 500-contact upserts and
 * store exactly the same rows. Before: one transaction for every contact, ~525 ms
 * of blocked main at 10k contacts on an encrypted store (arm64 Mac).
 *
 * Real sqlite driver, real schema.sql, encrypted file database. Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under plain node the binary cannot load and the suite is skipped with a warning.
 */

import * as nodePath from "path";
import * as nodeFs from "fs";
import { monitorEventLoopDelay } from "perf_hooks";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({
  app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3868-contacts") },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn().mockReturnValue(null), flushRejectedPathSummary: jest.fn() },
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(true),
}));

import { setDb } from "../db/core/dbConnection";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import type { iOSContact } from "../../types/iosContacts";

const USER = "user-3868-contacts";
const SIZES = [2000, 10000];
const SLICE = 500; // CONTACT_UPSERT_SLICE

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(
      nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
    );
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(
      `[3868-contacts] real sqlite driver unavailable under this runtime (${String(error).slice(0, 80)}); ` +
        "run under ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js\n",
    );
    return null;
  }
}

const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const DB_DIR = nodePath.join(jest.requireActual<typeof import("os")>("os").tmpdir(), "keepr-3868-contacts-db");
const KEY_HEX = "3868".repeat(16);

function openEncrypted(): DatabaseType {
  const opened = new Driver!(nodePath.join(DB_DIR, "mad.db"));
  opened.pragma(`key = "x'${KEY_HEX}'"`);
  opened.pragma("cipher_compatibility = 4");
  opened.pragma("journal_mode = WAL");
  opened.pragma("synchronous = NORMAL");
  return opened;
}


function makeContact(id: number): iOSContact {
  return {
    id,
    firstName: `First${id}`,
    lastName: `Last${id}`,
    displayName: `First${id} Last${id}`,
    organization: null,
    phoneNumbers: [{ label: "mobile", number: `+1555${String(id).padStart(7, "0")}`, normalizedNumber: `+1555${String(id).padStart(7, "0")}` }],
    emails: [{ label: "home", email: `test${id}@example.test` }],
  } as iOSContact;
}

type StoreContacts = (
  userId: string,
  contacts: iOSContact[],
  onProgress?: (current: number, total: number) => void,
  sessionId?: string,
) => Promise<{ stored: number; skipped: number }>;
const storeContacts: StoreContacts = (...args) =>
  (iPhoneSyncStorageService as unknown as { storeContacts: StoreContacts }).storeContacts(...args);

maybe("BACKLOG-3868: iPhone sync contact upsert yields between slices (real driver, encrypted)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db?.close();
    nodeFs.rmSync(DB_DIR, { recursive: true, force: true });
    nodeFs.mkdirSync(DB_DIR, { recursive: true });
    db = openEncrypted();
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(
      USER,
      "u3868c@example.test",
      "oauth-3868c",
    );
    db.close();
    db = openEncrypted();
    setDb(db);
  });

  afterAll(() => {
    db?.close();
    nodeFs.rmSync(DB_DIR, { recursive: true, force: true });
  });

  it.each(SIZES)("%i contacts: same rows, a yield between slices, bounded stall", async (n) => {
    const contacts = Array.from({ length: n }, (_, i) => makeContact(i));
    const immediate = jest.spyOn(global, "setImmediate");
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const result = await storeContacts(USER, contacts, undefined, "session-3868c");
    await new Promise((resolve) => setTimeout(resolve, 50));
    histogram.disable();
    const maxBlockMs = Math.round(histogram.max / 1e6);
    const wallMs = Date.now() - started;
    const yields = immediate.mock.calls.length;
    immediate.mockRestore();
    process.stderr.write(`[3868-contacts] ${n} contacts: wall=${wallMs}ms maxEventLoopDelay=${maxBlockMs}ms setImmediate=${yields}\n`);

    expect(result).toEqual({ stored: n, skipped: 0 });
    const ids = (
      db.prepare("SELECT external_record_id FROM external_contacts WHERE user_id = ? AND source = 'iphone' ORDER BY external_record_id").all(USER) as {
        external_record_id: string;
      }[]
    ).map((r) => r.external_record_id);
    expect(ids).toEqual(Array.from({ length: n }, (_, i) => String(i)).sort());
    // One yield before the first slice (existing) plus one between each pair of slices.
    expect(yields).toBeGreaterThanOrEqual(Math.ceil(n / SLICE));
    expect(maxBlockMs).toBeLessThan(Math.max(100, wallMs * 0.2));
  }, 120_000);
});
