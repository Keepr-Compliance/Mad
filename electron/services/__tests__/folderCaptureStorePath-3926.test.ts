/**
 * @jest-environment node
 */
/**
 * BACKLOG-3926 — the email store path records folder / label ids for EVERY fetched
 * message, already-cached ones included (that is what lets mail cached before this
 * feature fill in on a later fetch), and only writes when a message's set changed.
 *
 * Real driver and schema; the store path is `storeParsedEmailsForAccount` (the same
 * fetchStoreAndDedup every sync path uses). Run under the Electron jest runner.
 * Invented ids only.
 */
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data"), getVersion: () => "0.0.0" } }));
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  getClient: () => undefined,
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
const ACCT = "acct-o-3926s";
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getOAuthToken: jest.fn(async () => ({ id: "acct-o-3926s", connected_email_address: "agent@keepr.test" })) },
}));
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: {
    listFolderCatalogSource: jest.fn(async () => ({
      folders: [{ id: "FA", displayName: "Folder A" }, { id: "FB", displayName: "Folder B" }],
      systemFolderIds: [],
    })),
    peekFolderCatalogSource: jest.fn(() => null),
  },
}));
jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: { listLabelCatalogSource: jest.fn(async () => []), peekLabelCatalogSource: jest.fn(() => null) },
}));

import { setDb } from "../db/core/dbConnection";
import { storeParsedEmailsForAccount, type StoreableEmail } from "../emailSyncService";
import { __resetMailFolderCaptureForTests } from "../mailFolderCaptureService";
import { readAutoLinkInputToken, sameAutoLinkInputToken } from "../db/autoLinkInputTracker";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-3926s";
let db: DatabaseType;

function mk(id: string, parentFolderId: string): StoreableEmail {
  return {
    id,
    threadId: `t-${id}`,
    from: "sender@example.test",
    to: "agent@keepr.test",
    cc: null,
    bcc: null,
    messageIdHeader: `<${id}@example.test>`,
    subject: `Subject ${id}`,
    body: "body",
    bodyPlain: "body",
    date: new Date("2026-02-15T10:00:00Z"),
    hasAttachments: false,
    attachmentCount: 0,
    parentFolderId,
  } as StoreableEmail;
}

const refs = () =>
  (db.prepare(`SELECT external_id || ':' || folder_id AS k FROM mail_folder_refs ORDER BY k`).all() as Array<{ k: string }>).map((r) => r.k);

beforeEach(() => {
  __resetMailFolderCaptureForTests();
  db = new Database(":memory:") as DatabaseType;
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent@keepr.test', 'microsoft', 'o')`).run(USER);
  db.prepare(`INSERT INTO oauth_tokens (id, user_id, provider, purpose) VALUES (?, ?, 'microsoft', 'mailbox')`).run(ACCT, USER);
  setDb(db);
});
afterEach(() => db.close());

describe("BACKLOG-3926 store path records folder ids", () => {
  it("first fetch stores the message and its folder; a re-fetch of the SAME (already cached) message updates the folder", async () => {
    const first = await storeParsedEmailsForAccount({ userId: USER, provider: "outlook", emails: [mk("m1", "FA"), mk("m2", "FA")] });
    expect(first.stored).toBe(2);
    expect(refs()).toEqual(["m1:FA", "m2:FA"]);
    const names = db.prepare(`SELECT COUNT(*) AS n FROM mail_folder_names WHERE account_id = ?`).get(ACCT) as { n: number };
    expect(names.n).toBe(2);

    const again = await storeParsedEmailsForAccount({ userId: USER, provider: "outlook", emails: [mk("m1", "FB")] });
    expect(again.duplicates).toBe(1); // already cached: no new emails row
    expect(refs()).toEqual(["m1:FB", "m2:FA"]);
  });

  it("an unchanged re-fetch writes nothing (the sweep input token does not move); a moved message does move it", async () => {
    await storeParsedEmailsForAccount({ userId: USER, provider: "outlook", emails: [mk("m1", "FA")] });
    const t0 = readAutoLinkInputToken(db);
    await storeParsedEmailsForAccount({ userId: USER, provider: "outlook", emails: [mk("m1", "FA")] });
    expect(sameAutoLinkInputToken(t0, readAutoLinkInputToken(db))).toBe(true);
    await storeParsedEmailsForAccount({ userId: USER, provider: "outlook", emails: [mk("m1", "FB")] });
    expect(sameAutoLinkInputToken(t0, readAutoLinkInputToken(db))).toBe(false);
  });
});
