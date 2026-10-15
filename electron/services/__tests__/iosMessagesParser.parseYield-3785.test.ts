/**
 * @jest-environment node
 *
 * BACKLOG-3785 - reading an iPhone sms.db (sync phase parsing-messages) must not hold
 * the main thread: the parser yields to the event loop whenever PARSE_YIELD_BUDGET_MS
 * of work have passed, across chats as well as inside one.
 *
 * Before: the yield was counted (every 500 messages inside ONE chat). The sync loads
 * chat after chat, so a run of chats under 500 messages never yielded. Generated
 * 668k-message sms.db (3,000 chats, 2,866 under 500), arm64 Mac: max main block
 * 4,296 ms; the founder's PC logged [MainLag] 15,697 ms syncPhase=parsing-messages.
 *
 * Real sqlite driver on a generated sms.db (iOS backup layout). Run under Electron:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 --runTestsByPath <this file>
 * Under a runtime that cannot load the binary the suite is skipped with a warning.
 * Scale: KEEPR_3785_GATE_SMALL_CHATS (default 1,200 chats x 50 messages) plus one
 * chat of KEEPR_3785_GATE_LARGE (default 6,000).
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");

// The parser opens sms.db with the real driver (jest maps the module to a mock).
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(require("path").join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")),
);
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  for (const f of Object.values(m)) f.mockResolvedValue(undefined);
  return { __esModule: true, default: m, logService: m };
});

import { buildLargeSmsDb, type LargeSmsDbInfo } from "../../__tests__/perf/fixtures/largeSmsDb-3785";

function loadDriver(): (new (file: string) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(DRIVER);
    const probe = new Database(":memory:");
    probe.close();
    return Database;
  } catch (error) {
    process.stderr.write(
      `[3785-parse] real sqlite driver unavailable under this runtime (${String(error).slice(0, 80)}); ` +
        "run under ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js\n",
    );
    return null;
  }
}

const Driver = loadDriver();
const maybe = Driver ? describe : describe.skip;

const SMALL_CHATS = Number(process.env.KEEPR_3785_GATE_SMALL_CHATS ?? 1_200);
const SMALL_SIZE = 50;
const LARGE = Number(process.env.KEEPR_3785_GATE_LARGE ?? 6_000);
/** A block this long fails the gate. Pre-fix at the default scale: ~1.5 s (arm64 Mac). */
const MAX_BLOCK_MS = 300;

/** Longest gap between 5 ms ticks while `work` runs. */
async function longestBlock<T>(work: () => Promise<T>): Promise<{ value: T; maxMs: number }> {
  let last = performance.now();
  let maxMs = 0;
  const h = setInterval(() => {
    const now = performance.now();
    maxMs = Math.max(maxMs, now - last - 5);
    last = now;
  }, 5);
  await new Promise((r) => setTimeout(r, 15));
  const value = await work();
  await new Promise((r) => setTimeout(r, 15));
  clearInterval(h);
  return { value, maxMs };
}

maybe("BACKLOG-3785 iPhone sms.db parse yields across chats", () => {
  const dir = nodeFs.mkdtempSync(nodePath.join(jest.requireActual<typeof import("os")>("os").tmpdir(), "keepr-3785-gate-"));
  let info: LargeSmsDbInfo;

  beforeAll(() => {
    // One large chat first (oldest ROWIDs), then many small ones: the shape that blocked.
    const sizes = [LARGE, ...Array.from({ length: SMALL_CHATS }, () => SMALL_SIZE)];
    info = buildLargeSmsDb(Driver!, dir, {
      total: sizes.reduce((a, b) => a + b, 0),
      chats: sizes.length,
      sizes,
    });
  });
  afterAll(() => nodeFs.rmSync(dir, { recursive: true, force: true }));

  it("loads every message chat by chat (the orchestrator loop) without a long main-thread block", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { iOSMessagesParser } = require("../iosMessagesParser");
    const parser = new iOSMessagesParser();
    parser.open(dir);
    try {
      const conversations: Array<{ chatId: number; messages: Array<{ guid: string }> }> =
        await parser.getConversationsAsync();
      expect(conversations).toHaveLength(info.chats);

      // Same loop as deviceSyncOrchestrator (parsing-messages, both call sites).
      const { maxMs } = await longestBlock(async () => {
        for (const conv of conversations) conv.messages = await parser.getMessagesAsync(conv.chatId);
      });
      process.stderr.write(`[3785-parse] ${info.total} messages, ${info.chats} chats: max main block ${Math.round(maxMs)} ms\n`);

      // Correctness: the same rows, by ID set.
      const loaded = conversations.flatMap((c) => c.messages.map((m) => m.guid));
      expect(loaded).toHaveLength(info.total);
      expect(new Set(loaded)).toEqual(new Set(info.guids()));

      expect(maxMs).toBeLessThan(MAX_BLOCK_MS);
    } finally {
      parser.close();
    }
  });
});
