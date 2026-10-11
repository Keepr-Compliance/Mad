/**
 * @jest-environment node
 *
 * BACKLOG-3892 S1 — the iPhone sync's floor plan, built against the REAL Keepr
 * schema (electron/database/schema.sql) with the real import-plan resolver, so the
 * deal SQL and the lookback rule run verbatim. Only the stored preference is stubbed.
 *
 *  - lookback absent → the shared default (1.5 months); explicit null ("All time")
 *    → no floor; deals never move the SETTINGS floor (they widen per handle);
 *  - deal floor = computeTransactionDateRange(deal).start − 24 h, by phone AND
 *    email, earliest deal wins, rejected deals and removed contacts ignored;
 *  - a thread linked to a live deal (`ios-chat-<ROWID>`) carries that deal's floor;
 *  - any failure → undefined (no floor at all); gated off → no plan.
 *
 * Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");

const mockGetPreferences = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: (...a: unknown[]) => mockGetPreferences(...a) },
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop }, logService: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));

import { setDb } from "../db/core/dbConnection";
import { buildChatFloorPlan, floorPlanForSync } from "../iphoneChatFloorPlan";
import { handleKeys, IPHONE_PARSE_FLOORS_ENABLED } from "../iphoneChatFloors";
import { computeTransactionDateRange } from "../../utils/emailDateRange";

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    new Database(":memory:").close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3892-plan] real sqlite driver unavailable (${String(error).slice(0, 80)}); run under Electron\n`);
    return null;
  }
}
const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const USER = "user-3892";
const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 9, 10, 12, 0, 0));
let db: DatabaseType;

function deal(id: string, startedAt: string | null, status = "active"): void {
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at) VALUES (?, ?, ?, ?, ?)").run(id, USER, `${id} Test St`, status, startedAt);
}
function contact(id: string, phone: string | null, email: string | null, removed = false): void {
  db.prepare("INSERT INTO contacts (id, user_id, display_name, removed_at) VALUES (?, ?, ?, ?)").run(id, USER, id, removed ? "2026-01-01" : null);
  if (phone) db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?, ?, ?)").run(`p-${id}`, id, phone);
  if (email) db.prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)").run(`e-${id}`, id, email);
}
function onDeal(txn: string, c: string, removed = false): void {
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id, removed_at) VALUES (?, ?, ?, ?)").run(`${txn}-${c}`, txn, c, removed ? "2026-01-01" : null);
}
const floorOf = (startedAt: string): number =>
  computeTransactionDateRange({ started_at: startedAt, created_at: null, closed_at: null }).start.getTime() - DAY;

beforeEach(() => {
  db = new Driver!(":memory:") as unknown as DatabaseType;
  db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'u@example.test', 'google', 'o-3892')").run(USER);
  setDb(db as never);
  mockGetPreferences.mockReset().mockResolvedValue({});
});
afterEach(() => db.close());

maybe("BACKLOG-3892 S1: iPhone floor plan (real schema)", () => {
  it("no stored lookback → the shared 1.5-month default", async () => {
    const p = await buildChatFloorPlan(USER, NOW);
    expect(p).toBeDefined();
    const months = (NOW.getTime() - p!.settingsFloorMs!) / DAY;
    expect(months).toBeGreaterThan(44);
    expect(months).toBeLessThan(47);
  });

  it('explicit null lookback ("All time") → no floor', async () => {
    mockGetPreferences.mockResolvedValue({ messageImport: { filters: { lookbackMonths: null } } });
    const p = await buildChatFloorPlan(USER, NOW);
    expect(p).toEqual({ settingsFloorMs: null, handleFloors: new Map(), linkedChatFloors: new Map() });
  });

  it("deal floors by phone AND email, earliest deal wins; deals do not move the settings floor", async () => {
    const base = await buildChatFloorPlan(USER, NOW);
    deal("t1", "2025-12-01");
    deal("t2", "2025-06-01");
    contact("c1", "+12025550101", "Party7@Example.test");
    contact("c2", "+12025550103", null);
    onDeal("t1", "c1");
    onDeal("t2", "c1");
    onDeal("t1", "c2");
    const p = (await buildChatFloorPlan(USER, NOW))!;
    expect(p.settingsFloorMs).toBe(base!.settingsFloorMs);
    for (const k of handleKeys("+12025550101")) expect(p.handleFloors.get(k)).toBe(floorOf("2025-06-01"));
    expect(p.handleFloors.get("party7@example.test")).toBe(floorOf("2025-06-01"));
    for (const k of handleKeys("+12025550103")) expect(p.handleFloors.get(k)).toBe(floorOf("2025-12-01"));
  });

  it("rejected deals, contacts removed from a deal and removed contacts give no floor", async () => {
    deal("t1", "2025-12-01", "rejected");
    deal("t2", "2025-12-01");
    contact("c1", "+12025550101", null);
    contact("c2", "+12025550103", null);
    contact("c3", "+12025550104", null, true);
    onDeal("t1", "c1");
    onDeal("t2", "c2", true);
    onDeal("t2", "c3");
    const p = (await buildChatFloorPlan(USER, NOW))!;
    expect(p.handleFloors.size).toBe(0);
  });

  it("a thread linked to a live deal carries that deal's floor (thread link and message link)", async () => {
    deal("t1", "2025-12-01");
    deal("t2", "2025-03-01", "rejected");
    db.prepare("INSERT INTO messages (id, user_id, channel, thread_id) VALUES ('m1', ?, 'imessage', 'ios-chat-42')").run(USER);
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, message_id) VALUES ('co1', ?, 't1', 'm1')").run(USER);
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES ('co2', ?, 't1', 'ios-chat-7')").run(USER);
    db.prepare("INSERT INTO communications (id, user_id, transaction_id, thread_id) VALUES ('co3', ?, 't2', 'ios-chat-9')").run(USER);
    const p = (await buildChatFloorPlan(USER, NOW))!;
    expect([...p.linkedChatFloors.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [7, floorOf("2025-12-01")],
      [42, floorOf("2025-12-01")],
    ]);
  });

  it("a failing deal read → undefined (no floor at all), never a plan without its deal floors", async () => {
    db.exec("DROP TABLE contact_emails");
    expect(await buildChatFloorPlan(USER, NOW)).toBeUndefined();
  });

  it("gated off until S2: the shipped flag is false and sync:start gets no plan", async () => {
    expect(IPHONE_PARSE_FLOORS_ENABLED).toBe(false);
    expect(await floorPlanForSync(USER)).toBeUndefined();
    expect(mockGetPreferences).not.toHaveBeenCalled();
  });
});
