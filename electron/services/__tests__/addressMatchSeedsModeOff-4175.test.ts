/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR0 — the address pass obeys its own mode: with
 * seedAddress.addressPass = "off" (bundled rules mocked), the seed alert is
 * queued like any other match and nothing is reported skipped. Same fixture
 * as addressMatchSeeds-4175.test.ts.
 */
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../../utils/senderFilter/bundledRules", () => {
  const actual = jest.requireActual("../../utils/senderFilter/bundledRules");
  const rules = actual.BUNDLED_SENDER_RULES;
  return {
    ...actual,
    BUNDLED_SENDER_RULES: {
      ...rules,
      modes: { ...rules.modes, seedAddress: { ...rules.modes.seedAddress, addressPass: "off" } },
    },
  };
});

import { setDb } from "../db/core/dbConnection";
import * as contactWorkerPool from "../../workers/contactWorkerPool";
import { BUNDLED_SENDER_RULES } from "../../utils/senderFilter/bundledRules";
import { queueAddressMatchesForTransaction } from "../reviewStateService";
import { gmailFrom, insertStoredEmail, outlookFrom } from "./helpers/storedEmail-4175";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-4175";
const TXN = "txn-4175";
const SEED = "my-saved-home@mail.zillow.com";
let db: DatabaseType;

beforeEach(() => {
  db = new Database(":memory:") as DatabaseType;
  setDb(db);
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'me@example.test', 'google', 'o-1')`).run(USER);
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
     VALUES (?, ?, '1428 Maple Ave, Springfield', 'active', '2026-01-01', '2026-01-01', 'not_submitted')`,
  ).run(TXN, USER);
  insertStoredEmail(db, {
    id: "e-seed",
    userId: USER,
    sender: gmailFrom("Zillow", SEED),
    subject: "Price cut: 1428 Maple Ave",
    bodyPlain: "A home you saved, 1428 Maple Ave, Springfield, has a new price.",
    sentAt: "2026-03-01T15:00:00.000Z",
  });
  insertStoredEmail(db, {
    id: "e-forward",
    userId: USER,
    source: "outlook",
    sender: outlookFrom("Client", "client@example.org"),
    subject: "Fwd: Price cut: 1428 Maple Ave",
    bodyPlain: `From: Zillow <${SEED}>\nA home you saved, 1428 Maple Ave, Springfield, has a new price.`,
    sentAt: "2026-03-02T15:00:00.000Z",
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  db.close();
});

describe("MODE addressPass = off", () => {
  it("the mock took effect, and both matches are queued with nothing skipped", async () => {
    expect(BUNDLED_SENDER_RULES.modes.seedAddress.addressPass).toBe("off");
    expect(BUNDLED_SENDER_RULES.modes.seedAddress.learnQuestions).toBe("live");
    jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(false);
    const r = await queueAddressMatchesForTransaction(TXN);
    expect(r).toEqual({ candidates: 2, matched: 2, queued: 2, seedSkipped: 0 });
  });
});
