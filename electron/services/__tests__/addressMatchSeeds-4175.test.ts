/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR0 — the address pass does not queue mail from an exact
 * sender seed. Real driver, real schema; rows written with the sync's own
 * insert statement (helpers/storedEmail-4175.ts).
 *
 *   P7  main-thread path: a seed alert naming the deal address is matched but
 *       not queued; a client-forwarded copy (From client@example.org) is
 *       queued. Result {matched: 2, queued: 1, seedSkipped: 1}; the log is
 *       count-only.
 *   P8  the same through the query-worker path (pool up, worker result
 *       injected from the worker's own classifier).
 *
 * Both start from a precondition: with no filter, the matcher returns BOTH
 * ids, so a green here cannot come from a fixture the matcher never sees.
 */
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
const logInfo = jest.fn().mockResolvedValue(undefined);
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: { info: (...a: unknown[]) => logInfo(...a), warn: noop, error: noop, debug: noop },
  };
});

import { setDb } from "../db/core/dbConnection";
import * as contactWorkerPool from "../../workers/contactWorkerPool";
import { classifyAddressMatchCandidatesOn } from "../db/addressMatchCandidatesDb";
import { normalizeAddress } from "../../utils/addressNormalization";
import { addressMatchCandidateParamsForTests, queueAddressMatchesForTransaction } from "../reviewStateService";
import { gmailFrom, insertStoredEmail, outlookFrom } from "./helpers/storedEmail-4175";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-4175";
const TXN = "txn-4175";
const DEAL_ADDRESS = "1428 Maple Ave, Springfield";
const SEED = "my-saved-home@mail.zillow.com";

let db: DatabaseType;

function seedFixture(): void {
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'me@example.test', 'google', 'o-1')`).run(USER);
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
     VALUES (?, ?, ?, 'active', '2026-01-01', '2026-01-01', 'not_submitted')`,
  ).run(TXN, USER, DEAL_ADDRESS);
  // The seed alert, as Gmail stores its From header.
  insertStoredEmail(db, {
    id: "e-seed",
    userId: USER,
    sender: gmailFrom("Zillow", SEED),
    subject: "Price cut: 1428 Maple Ave",
    bodyPlain: "A home you saved, 1428 Maple Ave, Springfield, has a new price.",
    sentAt: "2026-03-01T15:00:00.000Z",
  });
  // The same alert forwarded by a client: the forwarder's From, the seed in the body.
  insertStoredEmail(db, {
    id: "e-forward",
    userId: USER,
    source: "outlook",
    sender: outlookFrom("Client", "client@example.org"),
    subject: "Fwd: Price cut: 1428 Maple Ave",
    bodyPlain: `Can we see this one?\n\nFrom: Zillow <${SEED}>\nA home you saved, 1428 Maple Ave, Springfield, has a new price.`,
    sentAt: "2026-03-02T15:00:00.000Z",
  });
}

function pending(): string[] {
  return (
    db
      .prepare(
        `SELECT p.email_id || ':' || COALESCE(r.reason, '-') AS k
           FROM pending_review_communications p
           LEFT JOIN pending_review_match_reasons r ON r.transaction_id = p.transaction_id AND r.email_id = p.email_id
          WHERE p.transaction_id = ? ORDER BY k`,
      )
      .all(TXN) as Array<{ k: string }>
  ).map((r) => r.k);
}

function discoveryLog(): Record<string, unknown> {
  const call = logInfo.mock.calls.find((c) => String(c[0]).includes("address-only discovery"));
  if (!call) throw new Error("no address-only discovery log");
  return call[2] as Record<string, unknown>;
}

beforeEach(() => {
  logInfo.mockClear();
  db = new Database(":memory:") as DatabaseType;
  setDb(db);
  seedFixture();
});

afterEach(() => {
  jest.restoreAllMocks();
  db.close();
});

function classified() {
  const params = addressMatchCandidateParamsForTests(TXN) as Array<string | number>;
  return classifyAddressMatchCandidatesOn(db, params, normalizeAddress(DEAL_ADDRESS)!);
}

describe("P7 main-thread path", () => {
  it("precondition: the matcher returns both the seed alert and the forward", () => {
    expect([...classified().matchedIds].sort()).toEqual(["e-forward", "e-seed"]);
  });

  it("queues the forward only: matched 2, queued 1, seedSkipped 1; the log carries counts only", async () => {
    jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(false);
    const r = await queueAddressMatchesForTransaction(TXN);
    expect(r).toEqual({ candidates: 2, matched: 2, queued: 1, seedSkipped: 1 });
    expect(pending()).toEqual(["e-forward:address"]);
    const log = discoveryLog();
    expect(log).toMatchObject({ matched: 2, queued: 1, seedSkipped: 1 });
    expect(JSON.stringify(log)).not.toContain("@");
  });
});

describe("P8 query-worker path", () => {
  it("the worker's classification is filtered the same way", async () => {
    const result = classified();
    expect([...result.matchedIds].sort()).toEqual(["e-forward", "e-seed"]);
    jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
    const query = jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker").mockResolvedValue([result]);
    const r = await queueAddressMatchesForTransaction(TXN);
    expect(query).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ candidates: 2, matched: 2, queued: 1, seedSkipped: 1 });
    expect(pending()).toEqual(["e-forward:address"]);
  });
});
