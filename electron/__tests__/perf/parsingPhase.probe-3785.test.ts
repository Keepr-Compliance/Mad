/**
 * @jest-environment node
 *
 * BACKLOG-3785 MEASUREMENT PROBE — not a gate. Skipped unless KEEPR_PERF_3785=1.
 *
 * Builds an iPhone sms.db at the founder's PC scale (KEEPR_3785_TOTAL messages, default
 * 668,000, over KEEPR_3785_CHATS chats, default 3,000) and runs the parsing-messages
 * phase the way deviceSyncOrchestrator runs it, printing the longest main-thread block
 * for each step (a 5 ms ticker measures the gap between its own ticks).
 *
 * Run (Electron's node, real driver):
 *   KEEPR_PERF_3785=1 ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 --testTimeout=1800000 electron/__tests__/perf/parsingPhase.probe-3785.test.ts
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import type { Database as DatabaseType } from "better-sqlite3";
import { buildLargeSmsDb } from "./fixtures/largeSmsDb-3785";

// The parser opens sms.db with the real driver (jest maps the module to a mock).
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(require("path").join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")),
);
jest.mock("electron-log", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, ...m };
});
jest.mock("../../services/logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  for (const f of Object.values(m)) f.mockResolvedValue(undefined);
  return { __esModule: true, default: m, logService: m };
});

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const PERF = process.env.KEEPR_PERF_3785 === "1";
function loadDriver(): (new (file: string) => DatabaseType) | null {
  if (!PERF) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(DRIVER);
  } catch {
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const TOTAL = Number(process.env.KEEPR_3785_TOTAL ?? 668_000);
const CHATS = Number(process.env.KEEPR_3785_CHATS ?? 3_000);

/** Longest gap between 5 ms ticks while `work` runs. */
async function block<T>(label: string, work: () => Promise<T> | T): Promise<T> {
  let last = performance.now();
  let max = 0;
  const h = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 5);
    last = now;
  }, 5);
  await new Promise((r) => setTimeout(r, 15));
  const t0 = performance.now();
  const value = await work();
  const wall = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 15));
  clearInterval(h);
  process.stderr.write(`[3785 probe] ${label}: ${Math.round(wall)} ms wall, max main block ${Math.round(max)} ms\n`);
  return value;
}

maybe("BACKLOG-3785 parsing-messages phase at PC scale", () => {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3785-"));
  afterAll(() => nodeFs.rmSync(dir, { recursive: true, force: true }));

  it("measures each step", async () => {
    const info = buildLargeSmsDb(Database!, dir, { total: TOTAL, chats: CHATS });
    process.stderr.write(
      `[3785 probe] fixture: ${info.total} messages, ${info.chats} chats, largest ${info.largestChat}, ${info.chatsUnder500} chats under 500\n`,
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { iOSMessagesParser } = require("../../services/iosMessagesParser");
    const parser = new iOSMessagesParser();
    await block("open", () => parser.open(dir));
    const conversations = await block("getConversationsAsync", () => parser.getConversationsAsync());
    if (process.env.KEEPR_3785_BREAKDOWN === "1") {
      const big = conversations.reduce((a: { chatId: number }, b: { chatId: number }) => (a.chatId < b.chatId ? a : b));
      await block(`largest chat getMessagesAsync (${info.largestChat})`, () => parser.getMessagesAsync(big.chatId));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (parser as any).db as DatabaseType;
      await block("largest chat raw .all() only", () =>
        db.prepare(`SELECT message.ROWID, message.text, message.attributedBody, message.date FROM message
          JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
          WHERE chat_message_join.chat_id = ? ORDER BY message.date ASC`).all(big.chatId),
      );
      const small = conversations.filter((c: { chatId: number }) => c.chatId > 134);
      await block(`${small.length} smallest chats in a row`, async () => {
        for (const conv of small) await parser.getMessagesAsync(conv.chatId);
      });
    }
    let n = 0;
    // The loop deviceSyncOrchestrator runs (parsing-messages, second half).
    await block("load messages (orchestrator loop)", async () => {
      for (const conv of conversations) conv.messages = await parser.getMessagesAsync(conv.chatId);
    });
    for (const c of conversations) n += c.messages.length;
    parser.close();
    process.stderr.write(`[3785 probe] loaded ${n} messages in ${conversations.length} conversations\n`);
    expect(n).toBe(TOTAL);
  });
});
