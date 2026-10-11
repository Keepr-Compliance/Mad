/**
 * @jest-environment node
 *
 * BACKLOG-3892 S1 — iPhone parse floors, on a real sms.db read by the real parser.
 *
 * The sync stores only the texts lookback window, except chats of a live deal's
 * contact (by phone, by email, by a member who left a group, or by a thread already
 * linked to the deal), which are read back to the deal start − 24 h. Group = the
 * earliest floor of its people. "All time" = no floor. Seconds-era dates (pre-iOS 11)
 * are compared in seconds; undated rows are kept; the floor edge is inclusive. A
 * failed read is counted, never mistaken for an empty chat.
 *
 * Real sqlite driver. Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under a runtime that cannot load the binary the suite is skipped with a warning.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as nodeOs from "os";
import type { Database as DatabaseType } from "better-sqlite3";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");

jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(require("path").join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")),
);
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

import { writeSmsDbFromSpec, type SmsChatSpec, type SmsDbSpecOptions } from "../../__tests__/perf/fixtures/largeSmsDb-3785";
import { iOSMessagesParser } from "../iosMessagesParser";
import { APPLE_EPOCH_MS } from "../db/appleSmsDbSql";
import { handleKeys, readChatWithFloor, type ChatFloorPlan, type ParseFloorReport } from "../iphoneChatFloors";

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    new Database(":memory:").close();
    return Database;
  } catch (error) {
    process.stderr.write(
      `[3892-floors] real sqlite driver unavailable under this runtime (${String(error).slice(0, 80)}); ` +
        "run under ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js\n",
    );
    return null;
  }
}
const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const DAY = 86_400_000;
/** The lookback setting's floor. */
const F = Date.UTC(2026, 8, 1, 12, 0, 0);
/** A deal's floor (its start − 24 h), well before F. */
const D = Date.UTC(2025, 11, 1, 0, 0, 0) - DAY;
/** A second, earlier deal floor. */
const D2 = Date.UTC(2025, 5, 1, 0, 0, 0) - DAY;

const ns = (ms: number): bigint => BigInt(ms - APPLE_EPOCH_MS) * 1_000_000n;
const sec = (ms: number): number => Math.floor((ms - APPLE_EPOCH_MS) / 1000);

const DEAL_PHONE = "+12025550101";
const DEAL_PHONE_2 = "+12025550103";
const OTHER_PHONE = "+12025550102";
const DEAL_EMAIL = "party7@example.test";

function plan(opts: { settings: number | null; handles?: Record<string, number>; linked?: Record<number, number> }): ChatFloorPlan {
  const handleFloors = new Map<string, number>();
  for (const [h, f] of Object.entries(opts.handles ?? {})) for (const k of handleKeys(h)) handleFloors.set(k, f);
  const linkedChatFloors = new Map<number, number>(Object.entries(opts.linked ?? {}).map(([k, v]) => [Number(k), v]));
  return { settingsFloorMs: opts.settings, handleFloors, linkedChatFloors };
}

let tmp: string;
beforeEach(() => {
  tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "keepr-3892-"));
});
afterEach(() => {
  nodeFs.rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  byChat: Map<number, string[]>;
  skipped: number[];
  report: ParseFloorReport;
  readFailures: number;
}

/** The sync's parse loop (deviceSyncOrchestrator) with this plan; undefined = today's read. */
async function run(chats: SmsChatSpec[], p: ChatFloorPlan | undefined, opts: SmsDbSpecOptions = {}): Promise<Run> {
  writeSmsDbFromSpec(Driver!, tmp, chats, opts);
  const parser = new iOSMessagesParser();
  parser.open(tmp);
  try {
    const report: ParseFloorReport = { floorSource: "none", settingsFloorMs: null, chatsSkippedOld: 0, chatsWidened: 0, messagesBelowFloor: 0 };
    const byChat = new Map<number, string[]>();
    const skipped: number[] = [];
    for (const conv of await parser.getConversationsAsync()) {
      if (p) {
        if ((await readChatWithFloor(parser, p, conv, report)) === "skipped") skipped.push(conv.chatId);
      } else {
        conv.messages = await parser.getMessagesAsync(conv.chatId);
      }
      byChat.set(conv.chatId, conv.messages.map((m) => m.guid).sort());
    }
    return { byChat, skipped, report, readFailures: parser.readFailures };
  } finally {
    parser.close();
  }
}

maybe("BACKLOG-3892 S1: iPhone parse floors (real sms.db)", () => {
  it("floor edge at +/-1 ms: inclusive, one millisecond earlier is not read, a chat entirely below is skipped", async () => {
    const r = await run(
      [
        { id: 1, identifier: OTHER_PHONE, members: [OTHER_PHONE], messages: [{ date: ns(F - 1), from: OTHER_PHONE }, { date: ns(F) }, { date: ns(F + 1), from: OTHER_PHONE }] },
        { id: 2, identifier: "+12025550104", members: ["+12025550104"], messages: [{ date: ns(F - 1) }] },
        { id: 3, identifier: "+12025550105", members: ["+12025550105"], messages: [{ date: ns(F) }] },
      ],
      plan({ settings: F }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-1", "G-1-2"]);
    expect(r.skipped).toEqual([2]);
    expect(r.byChat.get(3)).toEqual(["G-3-0"]);
    expect(r.report).toMatchObject({ chatsSkippedOld: 1, chatsWidened: 0, messagesBelowFloor: 2 });
    expect(r.readFailures).toBe(0);
  });

  it("floor edge at 1 ns: the nanosecond bound is exact (bound as a BigInt)", async () => {
    // An odd-millisecond floor: its nanosecond value is not a multiple of 128, so a
    // Number bind (a double at ~8e17) would round it by 64 ns.
    const odd = F + 1;
    const r = await run(
      [{ id: 1, identifier: OTHER_PHONE, members: [OTHER_PHONE], messages: [{ date: ns(odd) - 1n }, { date: ns(odd) }, { date: ns(odd) + 1n }] }],
      plan({ settings: odd }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-1", "G-1-2"]);
  });

  it('"All time" (settings floor null) reads every text, as with no plan at all', async () => {
    const chats: SmsChatSpec[] = [
      { id: 1, identifier: OTHER_PHONE, members: [OTHER_PHONE], messages: [{ date: ns(Date.UTC(2017, 0, 1)) }, { date: ns(F + DAY) }] },
      { id: 2, identifier: "+12025550104", members: ["+12025550104"], messages: [{ date: ns(Date.UTC(2015, 0, 1)) }] },
    ];
    const allTime = await run(chats, plan({ settings: null, handles: { [DEAL_PHONE]: D } }));
    const none = await run(chats, undefined);
    expect(allTime.byChat).toEqual(none.byChat);
    expect(allTime.byChat.get(1)).toEqual(["G-1-0", "G-1-1"]);
    expect(allTime.skipped).toEqual([]);
  });

  it("a seconds-dated (pre-iOS 11) chat is compared in seconds: recent texts kept, older ones not read", async () => {
    const r = await run(
      [
        { id: 1, identifier: OTHER_PHONE, members: [OTHER_PHONE], messages: [{ date: sec(F) - 1 }, { date: sec(F) }, { date: sec(F) + 3600 }] },
        { id: 2, identifier: "+12025550104", members: ["+12025550104"], messages: [{ date: sec(F) + 60 }] },
      ],
      plan({ settings: F }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-1", "G-1-2"]);
    expect(r.byChat.get(2)).toEqual(["G-2-0"]);
    expect(r.skipped).toEqual([]);
  });

  it("undated texts (date 0 / NULL) are kept: an unknown date is never proof a text is older than the floor", async () => {
    const r = await run(
      [{ id: 1, identifier: OTHER_PHONE, members: [OTHER_PHONE], messages: [{ date: 0 }, { date: null }, { date: ns(F - DAY) }, { date: ns(F + DAY) }] }],
      plan({ settings: F }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-0", "G-1-1", "G-1-3"]);
  });

  it("a deal contact's chat is read back to the deal floor while another chat stops at the settings floor", async () => {
    const dates = [ns(D - 1), ns(D), ns(D + DAY), ns(F - 1), ns(F)];
    const r = await run(
      [
        { id: 1, identifier: DEAL_PHONE, members: [DEAL_PHONE], messages: dates.map((date) => ({ date })) },
        { id: 2, identifier: OTHER_PHONE, members: [OTHER_PHONE], messages: dates.map((date) => ({ date })) },
      ],
      plan({ settings: F, handles: { [DEAL_PHONE]: D } }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-1", "G-1-2", "G-1-3", "G-1-4"]);
    expect(r.byChat.get(2)).toEqual(["G-2-4"]);
    expect(r.report.chatsWidened).toBe(1);
  });

  it("a deal contact matched by EMAIL widens an email-handle iMessage chat (case-insensitive)", async () => {
    const r = await run(
      [{ id: 1, identifier: "Party7@Example.TEST", members: ["Party7@Example.TEST"], messages: [{ date: ns(D + DAY) }, { date: ns(F) }] }],
      plan({ settings: F, handles: { [DEAL_EMAIL]: D } }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-0", "G-1-1"]);
  });

  it("a non-E.164 handle string still matches the deal contact's number", async () => {
    const r = await run(
      [{ id: 1, identifier: "(202) 555-0101", members: ["(202) 555-0101"], messages: [{ date: ns(D + DAY) }, { date: ns(F) }] }],
      plan({ settings: F, handles: { [DEAL_PHONE]: D } }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-0", "G-1-1"]);
  });

  it("a group a deal contact has LEFT is widened by that contact's own messages", async () => {
    const r = await run(
      [
        {
          id: 1,
          identifier: "chat900001",
          members: [OTHER_PHONE, "+12025550104"],
          messages: [{ date: ns(D + DAY), from: DEAL_PHONE }, { date: ns(D + 2 * DAY), from: OTHER_PHONE }, { date: ns(F) }],
        },
      ],
      plan({ settings: F, handles: { [DEAL_PHONE]: D } }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-0", "G-1-1", "G-1-2"]);
  });

  it("a chat already linked to a live deal is widened to that deal's floor, with no contact match", async () => {
    const r = await run(
      [{ id: 7, identifier: OTHER_PHONE, members: [OTHER_PHONE], messages: [{ date: ns(D - 1) }, { date: ns(D) }, { date: ns(F) }] }],
      plan({ settings: F, linked: { 7: D } }),
    );
    expect(r.byChat.get(7)).toEqual(["G-7-1", "G-7-2"]);
  });

  it("a group takes the EARLIEST floor over its people", async () => {
    const r = await run(
      [
        {
          id: 1,
          identifier: "chat900002",
          members: [DEAL_PHONE, DEAL_PHONE_2],
          messages: [{ date: ns(D2 - 1) }, { date: ns(D2) }, { date: ns(D - 1) }, { date: ns(F) }],
        },
      ],
      plan({ settings: F, handles: { [DEAL_PHONE]: D, [DEAL_PHONE_2]: D2 } }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-1", "G-1-2", "G-1-3"]);
  });

  it("a deal that starts AFTER the settings floor does not narrow its chat", async () => {
    const r = await run(
      [{ id: 1, identifier: DEAL_PHONE, members: [DEAL_PHONE], messages: [{ date: ns(F) }, { date: ns(F + DAY) }] }],
      plan({ settings: F, handles: { [DEAL_PHONE]: F + 10 * DAY } }),
    );
    expect(r.byChat.get(1)).toEqual(["G-1-0", "G-1-1"]);
    expect(r.report.chatsWidened).toBe(0);
  });

  it("D5: a failed message read is COUNTED, not mistaken for an empty chat", async () => {
    const r = await run(
      [{ id: 1, identifier: OTHER_PHONE, members: [OTHER_PHONE], messages: [{ date: ns(F + DAY) }] }],
      plan({ settings: F }),
      { omitDateRead: true },
    );
    expect(r.byChat.get(1)).toEqual([]);
    expect(r.readFailures).toBeGreaterThan(0);
  });

  it("D5: a chat whose people could not be read gets NO floor (counted), so a deal chat is never cut short", async () => {
    const r = await run(
      [{ id: 1, identifier: "chat900003", members: [DEAL_PHONE], messages: [{ date: ns(D2) }, { date: ns(F) }] }],
      plan({ settings: F, handles: { [DEAL_PHONE]: D } }),
      { omitChatHandleJoin: true },
    );
    expect(r.byChat.get(1)).toEqual(["G-1-0", "G-1-1"]);
    expect(r.readFailures).toBeGreaterThan(0);
  });

  it("a clean read reports zero failures", async () => {
    const r = await run([{ id: 1, identifier: OTHER_PHONE, members: [OTHER_PHONE], messages: [{ date: ns(F) }] }], plan({ settings: F, handles: { [DEAL_PHONE]: D } }));
    expect(r.readFailures).toBe(0);
  });
});
