/**
 * @jest-environment node
 *
 * BACKLOG-3925 fix round 2 — the address-only Needs Review candidate read (instr over
 * every body of the user in the deal's window; no index can serve it) runs on a
 * dedicated contact query worker when the pool is up, as BACKLOG-3868 / 3883 did for
 * the auto-link candidate reads. Measured before the move: one synchronous block of
 * 0.3 s at 20k and 1 s at 60k cached emails (probe: perf/addressMatchPass.probe-3925).
 *
 * Dispatch: pool up -> the worker runs the statement with the pass's own inputs, and
 * classifies there (only matched ids come back), and the main connection never prepares
 * it; `start_failed` -> the main thread reads, same
 * rows; any other worker failure -> the pass throws and the sweep is not clean.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --runTestsByPath <this file>
 * Reserved .test addresses, invented ids.
 */
import path from "path";
import { readFileSync } from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

import { setDb } from "../db/core/dbConnection";
import * as contactWorkerPool from "../../workers/contactWorkerPool";
import {
  ADDRESS_MATCH_CANDIDATE_EMAILS_SQL,
  classifyAddressMatchCandidatesOn,
  readAddressMatchCandidatesOn,
} from "../db/addressMatchCandidatesDb";
import { normalizeAddress } from "../../utils/addressNormalization";
import {
  addressMatchCandidateParamsForTests,
  queueAddressMatchesForTransaction,
  runAddressMatchPassInSweep,
} from "../reviewStateService";

const DRIVER = path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require(DRIVER);
    new D(":memory:").close();
    return D;
  } catch (error) {
    process.stderr.write(`[3925] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const USER = "user-3925w";
const TXN = "txn-3925w";
const CANDIDATE_SQL = String(ADDRESS_MATCH_CANDIDATE_EMAILS_SQL);

maybe("BACKLOG-3925 — the address-match candidate read runs off the main thread", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new (Database as NonNullable<typeof Database>)(":memory:");
    db.exec(readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
    db.prepare(
      `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
       VALUES (?, ?, '1428 Maple Ave, Springfield', 'active', '2026-01-01', '2026-01-01', 'not_submitted')`,
    ).run(TXN, USER);
    const ins = db.prepare("INSERT INTO emails (id, user_id, subject, body_plain, sent_at) VALUES (?, ?, ?, ?, '2026-03-01T15:00:00.000Z')");
    ins.run("e-match", USER, "Showing at 1428 Maple Ave", "Buyers loved it.");
    ins.run("e-near", USER, "1428 Maplewood Dr", "Different street.");
    ins.run("e-other", USER, "1428 Elm St", "Another listing.");
    setDb(db);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    db.close();
  });

  function spyPrepare(): string[] {
    const texts: string[] = [];
    const real = db.prepare.bind(db);
    jest.spyOn(db, "prepare").mockImplementation(((t: string) => {
      texts.push(String(t));
      return real(t);
    }) as typeof db.prepare);
    return texts;
  }

  it("pool up: the worker reads and classifies with the pass's inputs; the main connection never reads", async () => {
    const params = addressMatchCandidateParamsForTests(TXN) as Array<string | number>;
    const address = normalizeAddress("1428 Maple Ave, Springfield");
    const rows = readAddressMatchCandidatesOn(db, params);
    expect((rows as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(["e-match", "e-near"]);
    // What the worker returns: the classification, run here on the same statement.
    const classified = classifyAddressMatchCandidatesOn(db, params, address!);
    expect(classified).toEqual({ candidates: 2, matchedIds: ["e-match"] });
    jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
    const query = jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker").mockResolvedValue([classified]);
    const texts = spyPrepare();

    const r = await queueAddressMatchesForTransaction(TXN);

    // The window is open-ended (no close date), so its end is "now" at each call.
    const expectedParams: unknown[] = [...params];
    expectedParams[2] = expect.any(String);
    expect(query).toHaveBeenCalledWith("addressMatchCandidates", USER, expect.any(Number), {
      params: expectedParams,
      address,
    });
    expect(texts.filter((t) => t === CANDIDATE_SQL)).toEqual([]);
    expect(r).toMatchObject({ candidates: 2, matched: 1, queued: 1 });
  });

  it("worker could not start: the main thread reads, same rows", async () => {
    jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
    jest
      .spyOn(contactWorkerPool, "queryOnDedicatedWorker")
      .mockRejectedValue(new contactWorkerPool.DedicatedWorkerError("x", "start_failed"));
    const texts = spyPrepare();

    const r = await queueAddressMatchesForTransaction(TXN);

    expect(texts.filter((t) => t === CANDIDATE_SQL)).toHaveLength(1);
    expect(r).toMatchObject({ candidates: 2, matched: 1, queued: 1 });
  });

  it("pool not up: the main thread reads", async () => {
    jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(false);
    const query = jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker");

    const r = await queueAddressMatchesForTransaction(TXN);

    expect(query).not.toHaveBeenCalled();
    expect(r).toMatchObject({ candidates: 2, queued: 1 });
  });

  it.each(["timeout", "stopped", "failed", "unavailable"] as const)(
    "worker %s: no main-thread scan, the sweep is not clean",
    async (code) => {
      jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(true);
      jest.spyOn(contactWorkerPool, "queryOnDedicatedWorker").mockRejectedValue(new contactWorkerPool.DedicatedWorkerError(code, code));
      const texts = spyPrepare();

      expect(await runAddressMatchPassInSweep(TXN, "test")).toEqual({ queued: 0, clean: false });
      expect(texts.filter((t) => t === CANDIDATE_SQL)).toEqual([]);
    },
  );
});
