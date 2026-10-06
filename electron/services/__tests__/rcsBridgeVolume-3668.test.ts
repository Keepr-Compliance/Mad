/**
 * @jest-environment node
 */
/**
 * BACKLOG-3668 M3 — volume limits on the extension bridge.
 *
 * Mutation controls (each turns a test red):
 *   V1 msgId bound removed (or > 128 accepted)                    → "msgId over 128"
 *   V2 text bound removed (or measured in chars, not UTF-8 bytes) → "text over 64 KB"
 *   V3 /chat schema back at 50,000 messages                       → "5,000 messages"
 *   V4 a third concurrent write accepted (inFlightWrites counted only) → "third concurrent write"
 *   V5 the per-job chat cap removed                               → "per-job chat cap"
 *   V6 the disk refusal skipped                                   → "free disk"
 */
import * as http from "http";

import { RCS_EXTENSION_ORIGIN, RCS_MAX_CONCURRENT_WRITES, RcsExtensionBridge } from "../rcsExtensionBridge";
import { RCS_JOB_MAX_CHATS, RcsImportJob, RcsJobRegistry } from "../rcsImportJob";
import { parseBridgeBody, RCS_MAX_MESSAGES_PER_POST, RcsBridgeBodySchemas } from "../../schemas/rcsBridge";
import {
  parseIncomingChat,
  RCS_MAX_MSG_ID_CHARS,
  RCS_MAX_TEXT_BYTES,
  type RcsImportResult,
  type RcsIncomingChat,
} from "../rcsImportStore";
import { decideCacheStart, RCS_DISK_SPACE_REFUSAL } from "../rcsCacheService";

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
function post(port: number, path: string, body = "{}"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, agent, headers: { "Content-Type": "application/json", Origin: RCS_EXTENSION_ORIGIN } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const CONV = "aaaaaaaaaaaaaaaaaaa";
const msg = (msgId: string, text = "hi") => ({
  msgId, direction: "inbound", sender: "Sam", text, sentAt: "2026-02-01T10:00:00.000Z",
});
const chatBody = (messages: unknown[]) => ({ conversationId: CONV, title: "Sam", messages });

describe("parseIncomingChat: per-message bounds (M3)", () => {
  it("msgId over 128 chars: that message is refused and counted; the rest kept", () => {
    const ok = "m".repeat(RCS_MAX_MSG_ID_CHARS);
    const r = parseIncomingChat(chatBody([msg(ok), msg(ok + "x"), msg("2")])) as RcsIncomingChat;
    expect(typeof r).toBe("object");
    expect(r.messages.map((m) => m.msgId)).toEqual([ok, "2"]);
    expect(r.refusedOversize).toBe(1);
  });

  it("text over 64 KB (UTF-8 bytes): that message is refused and counted", () => {
    const atLimit = "a".repeat(RCS_MAX_TEXT_BYTES);
    // 3 bytes each in UTF-8: under the limit in chars, over it in bytes.
    const wide = "€".repeat(Math.floor(RCS_MAX_TEXT_BYTES / 3) + 1);
    expect(wide.length).toBeLessThan(RCS_MAX_TEXT_BYTES);
    const r = parseIncomingChat(chatBody([msg("1", atLimit), msg("2", atLimit + "b"), msg("3", wide)])) as RcsIncomingChat;
    expect(r.messages.map((m) => m.msgId)).toEqual(["1"]);
    expect(r.refusedOversize).toBe(2);
  });

  it("a chat whose every message is oversize is refused (an error string); a normal chat has no count", () => {
    expect(typeof parseIncomingChat(chatBody([msg("x".repeat(200))]))).toBe("string");
    const r = parseIncomingChat(chatBody([msg("1")])) as RcsIncomingChat;
    expect(r.refusedOversize).toBeUndefined();
  });
});

describe("/chat schema: 5,000 messages per POST (M3)", () => {
  it("5,000 messages pass; 5,001 are refused", () => {
    expect(RCS_MAX_MESSAGES_PER_POST).toBe(5_000);
    const many = (n: number) => ({ conversationId: CONV, title: "t", messages: Array.from({ length: n }, () => ({})) });
    expect(parseBridgeBody(RcsBridgeBodySchemas.chat, many(5_000))).not.toBeNull();
    expect(parseBridgeBody(RcsBridgeBodySchemas.chat, many(5_001))).toBeNull();
  });
});

/** A number in the reserved fictional range: +1 <area> 555-0100..0199, one area per 100. */
const fictional = (i: number) => `+1${200 + Math.floor(i / 100)}5550${100 + (i % 100)}`;

describe("RcsImportJob: per-job chat cap (M3)", () => {
  it(`chat ${RCS_JOB_MAX_CHATS + 1} is not recorded nor matched, and counted; a chat already seen still re-matches`, () => {
    const jobs = new RcsJobRegistry(() => 1_000_000);
    const job = jobs.createCache("u-1", "2026-01-01T00:00:00.000Z") as RcsImportJob;
    job.claim(1_000_000);
    for (let i = 0; i < RCS_JOB_MAX_CHATS; i++) {
      expect(job.match(`c${i}`, [fictional(i)])).toBe(true);
    }
    expect(job.match("one-too-many", [fictional(RCS_JOB_MAX_CHATS)])).toBe(false);
    expect(job.isMatched("one-too-many")).toBe(false);
    expect(job.numbersFor("one-too-many")).toEqual([]);
    expect(job.chatsOverCap).toBe(1);
    // A retry of a chat already checked is not a new chat.
    expect(job.match("c0", [fictional(0)])).toBe(true);
    expect(job.isMatched("c0")).toBe(true);
  });
});

describe("decideCacheStart: free disk before staging (M3)", () => {
  const base = { userId: "u-1", consentVersion: 999, activeLabel: null, writesPaused: false, consentRequired: false };
  it("free disk below the floor refuses the start with disk_space (507); enough or unchecked starts", () => {
    expect(decideCacheStart({ ...base, diskSufficient: false })).toEqual(RCS_DISK_SPACE_REFUSAL);
    expect(RCS_DISK_SPACE_REFUSAL).toMatchObject({ status: 507, error: "disk_space" });
    expect(decideCacheStart({ ...base, diskSufficient: true })).toEqual({ ok: true, userId: "u-1" });
    expect(decideCacheStart({ ...base })).toEqual({ ok: true, userId: "u-1" });
  });
});

describe("bridge: oversize count, concurrent writes, chat cap (M3)", () => {
  let bridge: RcsExtensionBridge;
  let port: number;
  let jobId: string;
  let importCacheChat: jest.Mock<Promise<RcsImportResult>, [RcsIncomingChat]>;
  let gate: Promise<void> | null;
  const warn = jest.fn();

  beforeEach(async () => {
    gate = null;
    warn.mockReset();
    importCacheChat = jest.fn(async (chat: RcsIncomingChat): Promise<RcsImportResult> => {
      if (gate) await gate;
      return { received: chat.messages.length, stored: chat.messages.length, alreadyPresent: 0, linked: 0, reactions: 0, reactionsStored: 0 };
    });
    bridge = new RcsExtensionBridge({
      importCacheChat,
      currentUserId: async () => "user-1",
      jobs: new RcsJobRegistry(),
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
    jobId = bridge.createCacheJob("user-1", { since: "2026-01-01T00:00:00.000Z" })!.jobId;
    expect((await post(port, `/job/${jobId}/claim`)).status).toBe(200);
    expect((await post(port, `/job/${jobId}/match`, JSON.stringify({ conversationId: CONV, numbers: ["(555) 555-0199"] }))).status).toBe(200);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await bridge.stop();
  });

  it("/chat with an oversize message: 200, the rest saved, refusedOversize counted (no content logged)", async () => {
    const big = "secret ".repeat(20_000);
    const r = await post(port, `/job/${jobId}/chat`, JSON.stringify({ ...chatBody([msg("1"), msg("2", big)]), participants: [] }));
    expect(r.status).toBe(200);
    expect(r.body.refusedOversize).toBe(1);
    expect(importCacheChat.mock.calls[0][0].messages.map((m) => m.msgId)).toEqual(["1"]);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("secret");
  });

  it("a third concurrent write is refused 503 busy; once one ends, writes go through again", async () => {
    expect(RCS_MAX_CONCURRENT_WRITES).toBe(2);
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const body = JSON.stringify({ ...chatBody([msg("1")]), participants: [] });
    const first = post(port, `/job/${jobId}/chat`, body);
    const second = post(port, `/job/${jobId}/chat`, body);
    // Both are inside importCacheChat before the third is sent.
    for (let i = 0; i < 50 && importCacheChat.mock.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(importCacheChat).toHaveBeenCalledTimes(2);
    const third = await post(port, `/job/${jobId}/chat`, body);
    expect([third.status, third.body.error]).toEqual([503, "busy"]);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    gate = null;
    expect((await post(port, `/job/${jobId}/chat`, body)).status).toBe(200);
  });

  it("/match past the per-job chat cap: 200 matched:false overCap, and its /chat is refused", async () => {
    jest.spyOn(RcsImportJob.prototype, "match").mockReturnValue(false);
    const r = await post(port, `/job/${jobId}/match`, JSON.stringify({ conversationId: "bbbbbbbbbbbbbbbbbbb", numbers: ["(555) 555-0142"] }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ matched: false, overCap: true });
    const chat = await post(port, `/job/${jobId}/chat`, JSON.stringify({ conversationId: "bbbbbbbbbbbbbbbbbbb", title: "x", messages: [msg("1")], participants: [] }));
    expect(chat.status).toBe(403);
  });
});
