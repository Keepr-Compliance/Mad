/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR1b — the address pass runs the shared sender filter
 * (`decide()` on surface `addressPass`, keep rules K1-K3) over what the read
 * returns: From line, mailbox, labels and retained bulk headers.
 *
 * Real driver, real schema; rows written with the sync's own insert
 * (helpers/storedEmail-4175). Rule sets are injected through a mutable mock of
 * bundledRules so a case can make the modes DIFFER per surface — with the
 * shipped modes the live signals are identical on every surface, which would
 * hide a call that passes the wrong surface. Synthetic domains only.
 */
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import type {
  SenderRuleModes,
  SenderRuleSet,
  SenderRuleSignal,
} from "../../utils/senderFilter/bundledRules";

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
let mockRules: SenderRuleSet | null = null;
jest.mock("../../utils/senderFilter/bundledRules", () => {
  const actual = jest.requireActual("../../utils/senderFilter/bundledRules");
  return {
    ...actual,
    get BUNDLED_SENDER_RULES() {
      return mockRules ?? actual.BUNDLED_SENDER_RULES;
    },
  };
});

import { setDb } from "../db/core/dbConnection";
import * as contactWorkerPool from "../../workers/contactWorkerPool";
import { BUNDLED_SENDER_RULES } from "../../utils/senderFilter/bundledRules";
import { queueAddressMatchesForTransaction } from "../reviewStateService";
import { gmailFrom, insertStoredEmail } from "./helpers/storedEmail-4175";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const USER = "user-4175";
const TXN = "txn-4175";
const OTHER_TXN = "txn-4175-other";
const BODY = "News about 1428 Maple Ave, Springfield: a new photo set is up.";

let db: DatabaseType;
let shipped: SenderRuleSet;

/** The shipped rule set with some modes and suppress fields replaced. */
function rulesWith(
  modes: Partial<Record<SenderRuleSignal, Partial<SenderRuleModes>>>,
  suppress: Partial<SenderRuleSet["suppress"]> = {},
): SenderRuleSet {
  const next = { ...shipped.modes } as Record<SenderRuleSignal, SenderRuleModes>;
  for (const [s, m] of Object.entries(modes) as Array<[SenderRuleSignal, Partial<SenderRuleModes>]>) {
    next[s] = { ...next[s], ...m };
  }
  return { ...shipped, suppress: { ...shipped.suppress, ...suppress }, modes: next };
}

function email(id: string, sender: string, extra: Partial<Parameters<typeof insertStoredEmail>[1]> = {}): void {
  insertStoredEmail(db, {
    id,
    userId: USER,
    sender,
    subject: "1428 Maple Ave update",
    bodyPlain: BODY,
    sentAt: "2026-03-01T15:00:00.000Z",
    ...extra,
  });
}

/** A contact on ANOTHER active deal (this deal's contacts never reach the pass). */
function contactOnOtherDeal(address: string): void {
  db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES ('c-1', ?, 'Agent')`).run(USER);
  db.prepare(`INSERT INTO contact_emails (id, contact_id, email) VALUES ('ce-1', 'c-1', ?)`).run(address);
  db.prepare(`INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES ('tc-1', ?, 'c-1')`).run(OTHER_TXN);
}

function pending(): string[] {
  return (
    db
      .prepare(`SELECT email_id FROM pending_review_communications WHERE transaction_id = ? ORDER BY email_id`)
      .all(TXN) as Array<{ email_id: string }>
  ).map((r) => r.email_id);
}

function discoveryLog(): Record<string, unknown> {
  const call = logInfo.mock.calls.find((c) => String(c[0]).includes("address-only discovery"));
  if (!call) throw new Error("no address-only discovery log");
  return call[2] as Record<string, unknown>;
}

async function run() {
  jest.spyOn(contactWorkerPool, "isPoolReady").mockReturnValue(false);
  return queueAddressMatchesForTransaction(TXN);
}

beforeAll(() => {
  shipped = BUNDLED_SENDER_RULES;
});

beforeEach(() => {
  mockRules = null;
  logInfo.mockClear();
  db = new Database(":memory:") as DatabaseType;
  setDb(db);
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'me@example.test', 'google', 'o-1')`).run(USER);
  const deal = db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
     VALUES (?, ?, ?, 'active', '2026-01-01', '2026-01-01', 'not_submitted')`,
  );
  deal.run(TXN, USER, "1428 Maple Ave, Springfield");
  deal.run(OTHER_TXN, USER, "77 Birch Rd, Shelbyville");
});

afterEach(() => {
  jest.restoreAllMocks();
  db.close();
});

describe("shipped rules: only the exact seeds act (behaviour equals PR1a)", () => {
  it("C14 address half: bulk and Promotions mail is queued; the seed is not", async () => {
    email("e-seed", gmailFrom("Alerts", shipped.suppress.exactAddresses[0]));
    email("e-bulk", gmailFrom("News", "news@list.example"), {
      bulkMailHeaders: { list_unsubscribe: "<mailto:u@list.example>" },
    });
    email("e-promo", gmailFrom("Deals", "deals@shop.example"), { labels: ["INBOX", "CATEGORY_PROMOTIONS"] });
    const r = await run();
    expect(r).toEqual({ candidates: 3, matched: 3, queued: 2, seedSkipped: 1 });
    expect(pending()).toEqual(["e-bulk", "e-promo"]);
    const log = discoveryLog();
    expect(log).toMatchObject({ seedSkipped: 1, ruleSkipped: 0 });
    expect(JSON.stringify(log)).not.toContain("@");
  });
});

describe("C3 address half: the pass decides on surface addressPass", () => {
  it("Promotions live on detector and Learn but off on addressPass: a client forward is queued", async () => {
    mockRules = rulesWith({ gmailPromotions: { addressPass: "off", detector: "live", learnQuestions: "live" } });
    email("e-fwd", gmailFrom("Client", "client@example.org"), { labels: ["INBOX", "CATEGORY_PROMOTIONS"] });
    const r = await run();
    expect(r).toMatchObject({ matched: 1, queued: 1 });
    expect(pending()).toEqual(["e-fwd"]);
  });

  it("bulkHeaders = measure on addressPass: the bulk row is still queued", async () => {
    mockRules = rulesWith({ bulkHeaders: { addressPass: "measure" } });
    email("e-bulk", gmailFrom("News", "news@list.example"), {
      bulkMailHeaders: { list_unsubscribe: "<mailto:u@list.example>" },
    });
    const r = await run();
    expect(r).toMatchObject({ matched: 1, queued: 1 });
  });

  it("positive control: bulkHeaders = live on addressPass drops the bulk row (the read carries the headers)", async () => {
    mockRules = rulesWith({ bulkHeaders: { addressPass: "live" } });
    email("e-bulk", gmailFrom("News", "news@list.example"), {
      bulkMailHeaders: { list_unsubscribe: "<mailto:u@list.example>" },
    });
    email("e-plain", gmailFrom("Client", "client@example.org"));
    const r = await run();
    expect(r).toEqual({ candidates: 2, matched: 2, queued: 1, seedSkipped: 0 });
    expect(pending()).toEqual(["e-plain"]);
    expect(discoveryLog()).toMatchObject({ ruleSkipped: 1 });
  });
});

describe("early return: runs when ANY signal is live on addressPass", () => {
  it("seed off, approved host live: the approved-host row is dropped and the seed is queued", async () => {
    mockRules = rulesWith({ seedAddress: { addressPass: "off" } }, { hosts: ["blocked.example"] });
    email("e-seed", gmailFrom("Alerts", shipped.suppress.exactAddresses[0]));
    email("e-host", gmailFrom("News", "news@mail.blocked.example"));
    const r = await run();
    expect(r).toEqual({ candidates: 2, matched: 2, queued: 1, seedSkipped: 0 });
    expect(pending()).toEqual(["e-seed"]);
  });
});

describe("KH address pass: a deal contact on an approved host is never dropped", () => {
  it("K1 keeps the contact; an unkept approved-host sender is dropped (positive control)", async () => {
    mockRules = rulesWith({}, { hosts: ["corp.example", "blocked.example"] });
    contactOnOtherDeal("agent@corp.example");
    email("e-contact", gmailFrom("Agent", "agent@corp.example"));
    email("e-host", gmailFrom("News", "news@blocked.example"));
    const r = await run();
    expect(r).toEqual({ candidates: 2, matched: 2, queued: 1, seedSkipped: 0 });
    expect(pending()).toEqual(["e-contact"]);
  });
});

describe("RS15 (4175 PR4) the address pass reads the ACTIVE rule set", () => {
  const SEED_X = "x@example.test";
  let store: typeof import("../senderRuleSetStore");
  beforeEach(async () => {
    const paths = await import("../../capabilities/appPathsProvider");
    paths.resetAppPaths(); // memory only: never write a cache into the shared test userData
    store = await import("../senderRuleSetStore");
    store.__resetForTests();
  });
  afterEach(() => store.__resetForTests());

  it("a downloaded set's seed (absent from bundled) is not queued", async () => {
    expect(shipped.suppress.exactAddresses).not.toContain(SEED_X);
    const { parseSenderRuleSet } = await import("../../utils/senderFilter/ruleSetSchema");
    const downloaded = parseSenderRuleSet(
      JSON.parse(JSON.stringify({ ...shipped, version: 5, suppress: { ...shipped.suppress, exactAddresses: [SEED_X] } })),
    );
    await store.applyServerOutcome({ kind: "valid", rules: downloaded! }, USER);
    email("e-x", gmailFrom("Alerts", SEED_X));
    email("e-plain", gmailFrom("Client", "client@example.org"));
    const r = await run();
    expect(r).toEqual({ candidates: 2, matched: 2, queued: 1, seedSkipped: 1 });
    expect(pending()).toEqual(["e-plain"]);
  });
});
