/**
 * @jest-environment node
 *
 * BACKLOG-3892 — the "inspector" case, end to end on the REAL Keepr schema:
 *   a deal starts on D; a person (the inspector) is added to it later, after a sync
 *   already ran; their first text is D + 10 days; the next iPhone sync reads them
 *   back to the deal start. Keepr has then LOOKED back to D for everyone on the
 *   deal, so the deal reads covered to D and the export gate does not fire — even
 *   though the deal's oldest stored text is after D (founder design note,
 *   pm_comments 16f7dfa0: once read back to the deal start, absence = covered).
 *
 * The floor plan is built by the real buildChatFloorPlan from the deal rows (only
 * the preferences read is mocked: no stored lookback = the shared 1.5-month
 * default), persistence is the real iPhoneSyncStorageService.persistSyncResult,
 * and the readers are the real iphoneCoverageService / auditCoverageService. Only
 * the sms.db parse is replaced by the SyncResult it hands over (shape as in
 * iphoneCoverage-3892.test.ts).
 *
 * Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");

jest.mock("electron", () => ({
  app: {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    getPath: jest.fn(() => require("./helpers/testUserData").testUserDataDir()),
  },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop }, logService: { info: noop, warn: noop, error: noop, debug: noop } };
});
const mockGetPreferences = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: (...a: unknown[]) => mockGetPreferences(...a) },
}));
jest.mock("../permissionService", () => ({ __esModule: true, default: { checkFullDiskAccess: jest.fn(async () => ({ hasPermission: false })) } }));
jest.mock("../db/externalContactDbService");
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: { resolveAttachmentPath: jest.fn().mockReturnValue(null), flushRejectedPathSummary: jest.fn() },
}));
jest.mock("../../utils/preferenceHelper", () => ({ isContactSourceEnabled: jest.fn().mockResolvedValue(true) }));
jest.mock("../databaseService", () => {
  const sync = jest.requireActual("../db/syncDbService");
  return {
    __esModule: true,
    default: new Proxy({}, { get: (_t, name: string) => (typeof sync[name] === "function" ? sync[name] : undefined) }),
  };
});
jest.mock("../sourceCoverageFloors", () => {
  const actual = jest.requireActual("../sourceCoverageFloors");
  const { dbAll } = jest.requireActual("../db/core/dbConnection");
  const { MESSAGES_FLOOR_BY_SOURCE_SQL } = jest.requireActual("../db/auditCoverageSql");
  return { ...actual, readSourceFloors: async (userId: string) => dbAll(MESSAGES_FLOOR_BY_SOURCE_SQL, [userId]) };
});

import { setDb } from "../db/core/dbConnection";
import { iPhoneSyncStorageService } from "../iPhoneSyncStorageService";
import { getIphoneDealCoverage } from "../iphoneCoverageService";
import { checkExportCompleteness } from "../auditCoverageService";
import { buildChatFloorPlan } from "../iphoneChatFloorPlan";
import { handleKeys, type ChatFloorPlan } from "../iphoneChatFloors";
import type { SyncResult } from "../deviceSyncOrchestrator";
import type { iOSMessage, iOSConversation } from "../../types/iosMessages";
import { removeTestUserDataDir } from "./helpers/testUserData";

afterAll(() => removeTestUserDataDir());

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    new Database(":memory:").close();
    return Database;
  } catch (error) {
    process.stderr.write(`[3892-inspector] real sqlite driver unavailable (${String(error).slice(0, 80)}); run under Electron\n`);
    return null;
  }
}
const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const USER = "user-3892-insp";
const DAY = 86_400_000;
const PHONE = "udid-inspector-phone";
/** Sync 1 and sync 2 (the plan is built "now" = the run's start). */
const T1 = Date.UTC(2026, 9, 10, 12);
const T2 = Date.UTC(2026, 9, 11, 12);
/** The deal starts D (before the 1.5-month settings floor of either run). */
const DEAL_START = "2026-06-01";
const D = Date.UTC(2026, 5, 1);
const SELLER = "+12025550111";
const INSPECTOR = "+12025550122";
let db: DatabaseType;
let n = 0;

const iso = (ms: number): string => new Date(ms).toISOString();

function deal(id: string, startedAt: string): void {
  db.prepare("INSERT INTO transactions (id, user_id, property_address, status, started_at) VALUES (?, ?, ?, 'active', ?)").run(id, USER, `${id} Test St`, startedAt);
}
function contactOnDeal(txn: string, c: string, phone: string): void {
  db.prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)").run(c, USER, c);
  db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?, ?, ?)").run(`p-${c}`, c, phone);
  db.prepare("INSERT INTO transaction_contacts (id, transaction_id, contact_id) VALUES (?, ?, ?)").run(`${txn}-${c}`, txn, c);
}

/** The chat floor each chat was read to under `plan`: its handle's deal floor, else the settings floor. */
function appliedFloor(plan: ChatFloorPlan, handle: string): number | null {
  let floor = plan.settingsFloorMs;
  for (const k of handleKeys(handle)) {
    const f = plan.handleFloors.get(k);
    if (f !== undefined && (floor === null || f < floor)) floor = f;
  }
  return floor;
}

/** The SyncResult a sync hands persistence: one 1:1 chat per handle, texts at the given times. */
function syncResult(startedAtMs: number, plan: ChatFloorPlan, chats: Array<{ chatId: number; handle: string; texts: number[] }>): SyncResult {
  const messages: iOSMessage[] = [];
  const conversations: iOSConversation[] = [];
  for (const chat of chats) {
    const conv = { chatId: chat.chatId, chatIdentifier: chat.handle, displayName: null, participants: [chat.handle], messages: [] as iOSMessage[], lastMessage: new Date(startedAtMs), isGroupChat: false } as unknown as iOSConversation;
    for (const t of chat.texts) {
      n += 1;
      const m = {
        id: n, guid: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, text: "t", audioTranscript: null,
        handle: chat.handle, isFromMe: false, date: new Date(t), dateRead: null, dateDelivered: null, service: "iMessage", attachments: [],
      } as unknown as iOSMessage;
      messages.push(m);
      conv.messages.push(m);
    }
    conversations.push(conv);
  }
  return {
    success: true,
    messages,
    contacts: [],
    conversations,
    error: null,
    duration: 0,
    sessionId: `s-${startedAtMs}`,
    chatReadFailures: 0,
    coverageRun: {
      udid: PHONE,
      startedAtMs,
      floorPlan: plan,
      chatFloors: chats.map((c) => [c.chatId, appliedFloor(plan, c.handle)] as [number, number | null]),
    },
  } as unknown as SyncResult;
}

async function persist(r: SyncResult): Promise<void> {
  const out = await iPhoneSyncStorageService.persistSyncResult(USER, r, undefined, undefined, r.sessionId);
  expect(out.success).toBe(true);
}

beforeEach(() => {
  n = 0;
  db = new Driver!(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'u3892i@example.test', 'google', 'o-3892i')").run(USER);
  setDb(db as never);
  // No stored lookback: the shared 1.5-month default (founder answer (a), 16f7dfa0).
  mockGetPreferences.mockReset().mockResolvedValue({});
});
afterEach(() => db.close());

maybe("BACKLOG-3892: the inspector — added after a sync, first text D + 10 days", () => {
  it("after the next sync the deal is covered to D and the export gate does not fire", async () => {
    deal("t1", DEAL_START);
    contactOnDeal("t1", "seller", SELLER);

    // Sync 1: only the seller is on the deal; the inspector's chat is read to the settings floor.
    const plan1 = (await buildChatFloorPlan(USER, new Date(T1)))!;
    expect(plan1.settingsFloorMs).toBeGreaterThan(D);
    expect(appliedFloor(plan1, INSPECTOR)).toBe(plan1.settingsFloorMs);
    await persist(
      syncResult(T1, plan1, [
        { chatId: 1, handle: SELLER, texts: [D + 2 * DAY, T1 - 5 * DAY] },
        { chatId: 2, handle: INSPECTOR, texts: [T1 - 3 * DAY] },
      ]),
    );

    // The inspector is added to the deal AFTER that sync.
    contactOnDeal("t1", "inspector", INSPECTOR);
    // Before the next sync: not covered to D (the inspector was not read back) — the gate fires.
    expect(Date.parse(getIphoneDealCoverage(USER, "t1")!.coveredSince)).toBeGreaterThan(D);
    expect(await checkExportCompleteness("t1", USER, "iphone")).toMatchObject({ complete: false, iphoneGap: true });

    // Sync 2: the real plan now widens the inspector to the deal start; their first text is D + 10 days.
    const plan2 = (await buildChatFloorPlan(USER, new Date(T2)))!;
    expect(appliedFloor(plan2, INSPECTOR)).toBeLessThanOrEqual(D);
    await persist(
      syncResult(T2, plan2, [
        { chatId: 1, handle: SELLER, texts: [D + 2 * DAY, T1 - 5 * DAY] },
        { chatId: 2, handle: INSPECTOR, texts: [D + 10 * DAY, T1 - 3 * DAY] },
      ]),
    );

    // The inspector's texts start after D: nothing older exists …
    const oldest = db.prepare("SELECT MIN(sent_at) AS m FROM messages WHERE user_id = ? AND thread_id = 'ios-chat-2'").get(USER) as { m: string };
    expect(oldest.m).toBe(iso(D + 10 * DAY));
    // … yet Keepr read everyone on the deal back to D, so the deal is covered to D …
    expect(Date.parse(getIphoneDealCoverage(USER, "t1")!.coveredSince)).toBeLessThanOrEqual(D);
    // … and the export gate does not fire.
    expect(await checkExportCompleteness("t1", USER, "iphone")).toMatchObject({ complete: true, iphoneGap: false });
  });
});
