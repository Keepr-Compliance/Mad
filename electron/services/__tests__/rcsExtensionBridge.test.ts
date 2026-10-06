/**
 * @jest-environment node
 */
/**
 * BACKLOG-3619 — Controls 2 and 3, against a real HTTP server on 127.0.0.1.
 *
 * Control 2: only the pinned extension Origin is accepted (wrong AND missing
 *            Origin are refused, and nothing is imported).
 * (Control 3, the manual session, is gone with the manual Send: BACKLOG-3662.)
 */

import * as http from "http";

import {
  MAX_ATTACHMENT_BODY_BYTES,
  RCS_EXTENSION_ORIGIN,
  RcsExtensionBridge,
} from "../rcsExtensionBridge";
import { RcsJobRegistry, type RcsJobSnapshot } from "../rcsImportJob";
import { handleCacheJobEnded } from "../rcsCacheService";
import type { RcsImageResult, RcsIncomingImage } from "../rcsImportMedia";
import type { RcsImportResult, RcsIncomingChat } from "../rcsImportStore";

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers },
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
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const CHAT: RcsIncomingChat = {
  conversationId: "aaaaaaaaaaaaaaaaaaa",
  title: "Test Contact A",
  messages: [
    { msgId: "1", direction: "inbound", sender: "Test Contact A", text: "one", sentAt: "2026-09-20T13:05:00.000Z", transport: "sms" },
    { msgId: "2", direction: "outbound", sender: "me", text: "two", sentAt: "2026-09-20T13:06:00.000Z", transport: "rcs" },
  ],
};
// BACKLOG-3630: the page sends the chat's Details rows with every chat.
const CHAT_JSON = JSON.stringify({ ...CHAT, participants: [{ name: "Test Contact A", number: "(555) 555-0199" }] });
const JSON_HEADERS = { "Content-Type": "application/json" };
/** The cache job's history floor (the only job kind since 2026-10-05). */
const SINCE = "2026-08-01T00:00:00.000Z";
const EXT_HEADERS = { ...JSON_HEADERS, Origin: RCS_EXTENSION_ORIGIN };

describe("RcsExtensionBridge", () => {
  let bridge: RcsExtensionBridge;
  let port: number;
  let importChat: jest.Mock<Promise<RcsImportResult>, [RcsIncomingChat, string, unknown, string]>;

  beforeEach(async () => {
    importChat = jest.fn(async (chat: RcsIncomingChat, _userId: string, _people: unknown, _jobId: string): Promise<RcsImportResult> => ({
      received: chat.messages.length,
      stored: chat.messages.length,
      alreadyPresent: 0,
      linked: chat.messages.length,
      reactions: 0,
      reactionsStored: 0,
    }));
    bridge = new RcsExtensionBridge({ importCacheChat: importChat, jobs: new RcsJobRegistry() });
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
    expect(port).toBeGreaterThan(0);
  });

  afterEach(async () => {
    await bridge.stop();
  });

  /** A claimed transaction job whose chat matched: its /chat route is open. */
  async function matchedChatPath(): Promise<string> {
    const jobId = bridge.createCacheJob("user-1", { since: SINCE })!.jobId;
    expect((await request(port, "POST", `/job/${jobId}/claim`, EXT_HEADERS)).status).toBe(200);
    await request(port, "POST", `/job/${jobId}/match`, EXT_HEADERS, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0199"] }));
    return `/job/${jobId}/chat`;
  }

  describe("Origin (control 2)", () => {
    it("refuses a web-page Origin and imports nothing", async () => {
      const chatPath = await matchedChatPath();
      const reply = await request(port, "POST", chatPath, {
        ...JSON_HEADERS,
        Origin: "https://messages.google.com",
      }, CHAT_JSON);
      expect(reply.status).toBe(403);
      expect(reply.body.error).toBe("forbidden_origin");
      expect(importChat).not.toHaveBeenCalled();
    });

    it("refuses a DIFFERENT extension's Origin", async () => {
      const chatPath = await matchedChatPath();
      const reply = await request(port, "POST", chatPath, {
        ...JSON_HEADERS,
        Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }, CHAT_JSON);
      expect(reply.status).toBe(403);
      expect(importChat).not.toHaveBeenCalled();
    });

    it("refuses a request with NO Origin", async () => {
      const chatPath = await matchedChatPath();
      const reply = await request(port, "POST", chatPath, JSON_HEADERS, CHAT_JSON);
      expect(reply.status).toBe(403);
      expect(importChat).not.toHaveBeenCalled();
    });

    it("refuses POST /status without the pinned Origin", async () => {
      const reply = await request(port, "POST", "/status", {});
      expect(reply.status).toBe(403);
    });

    it("accepts the pinned extension Origin; /status reports the bridge only", async () => {
      const reply = await request(port, "POST", "/status", { Origin: RCS_EXTENSION_ORIGIN });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ bridge: "listening" });
    });
  });

  // BACKLOG-3662: the manual Send and its import session are gone. Mutation:
  // bring the manual POST /chat route back → red.
  it("there is no manual POST /chat outside a Sync job", async () => {
    const reply = await request(port, "POST", "/chat", EXT_HEADERS, CHAT_JSON);
    expect(reply.status).toBe(404);
    expect(importChat).not.toHaveBeenCalled();
  });

  // BACKLOG-3657: while Force re-import clears the Google Messages for Web
  // texts, nothing may be written. Mutations that turn these red: no 503 while
  // paused; pauseWrites resolving before in-progress writes finish; no job cancel.
  describe("BACKLOG-3657: writes paused while the texts are cleared", () => {
    it("refuses new chats with 503, waits for the chat already being written", async () => {
      const chatPath = await matchedChatPath();
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      importChat.mockImplementationOnce(async (chat: RcsIncomingChat) => {
        await gate;
        return { received: chat.messages.length, stored: 2, alreadyPresent: 0, linked: 2, reactions: 0, reactionsStored: 0 };
      });
      const first = request(port, "POST", chatPath, EXT_HEADERS, CHAT_JSON);
      await new Promise((r) => setTimeout(r, 50));
      expect(importChat).toHaveBeenCalledTimes(1);

      let paused = false;
      const pausing = bridge.pauseWrites().then(() => {
        paused = true;
      });
      const refused = await request(port, "POST", chatPath, EXT_HEADERS, CHAT_JSON);
      expect(refused.status).toBe(503);
      expect(refused.body.error).toBe("busy");
      expect(importChat).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 20));
      expect(paused).toBe(false); // the first chat is still being written

      release();
      expect((await first).status).toBe(200);
      await pausing;
      expect(paused).toBe(true);
      bridge.resumeWrites();
      expect(bridge.writesArePaused).toBe(false);
    });

    // SR F1 / O1. Mutations that turn these red: an unbounded drain; readBody
    // not settling on 'close'; a boolean pause flag instead of a count.
    it("a write that never completes: the drain gives up after its timeout (busy), writes reopen, and a closed client releases the write", async () => {
      const chatPath = await matchedChatPath();
      const stalled = http.request({
        host: "127.0.0.1", port, method: "POST", path: chatPath,
        headers: { ...EXT_HEADERS, "Content-Length": "100000" },
      });
      stalled.on("error", () => {});
      stalled.write("{\"conversationId\":");
      await new Promise((r) => setTimeout(r, 50));

      await expect(bridge.pauseWrites(200)).rejects.toThrow("Keepr is busy importing");
      bridge.resumeWrites();
      expect(bridge.writesArePaused).toBe(false);

      stalled.destroy();
      await new Promise((r) => setTimeout(r, 50));
      await expect(bridge.pauseWrites(200)).resolves.toBeUndefined();
      bridge.resumeWrites();
      expect(importChat).not.toHaveBeenCalled();
    });

    it("pauses are counted: overlapping clears cannot reopen writes early", async () => {
      const chatPath = await matchedChatPath();
      await bridge.pauseWrites();
      await bridge.pauseWrites();
      bridge.resumeWrites();
      expect(bridge.writesArePaused).toBe(true);
      expect((await request(port, "POST", chatPath, EXT_HEADERS, CHAT_JSON)).status).toBe(503);
      bridge.resumeWrites();
      expect(bridge.writesArePaused).toBe(false);
      bridge.resumeWrites(); // an extra resume never goes below zero
      await bridge.pauseWrites();
      expect(bridge.writesArePaused).toBe(true);
      bridge.resumeWrites();
    });

    it("pausing cancels the running Sync job", async () => {
      const job = bridge.createCacheJob("user-1", { since: SINCE })!;
      await bridge.pauseWrites();
      expect(bridge.getJob()?.state).toBe("cancelled");
      expect(bridge.writesArePaused).toBe(true);
      bridge.resumeWrites();
      expect(bridge.writesArePaused).toBe(false);
      expect(job.jobId).toBeTruthy();
    });
  });

  // BACKLOG-3641: the page's "Open Keepr". Mutation: the route not calling
  // onFocusRequested (or skipping the Origin check) → red.
  describe("POST /focus (Open Keepr)", () => {
    it("asks Keepr to come forward; refused without the pinned Origin, or by GET", async () => {
      const focus = jest.fn();
      const own = new RcsExtensionBridge({ importCacheChat: importChat, onFocusRequested: focus });
      expect(await own.start(0)).toBe("listening");
      try {
        const p = own.getStatus().port;
        expect((await request(p, "POST", "/focus", { Origin: "https://messages.google.com" })).status).toBe(403);
        expect((await request(p, "GET", "/focus", EXT_HEADERS)).status).toBe(405);
        expect(focus).not.toHaveBeenCalled();
        const reply = await request(p, "POST", "/focus", EXT_HEADERS);
        expect(reply.status).toBe(200);
        expect(focus).toHaveBeenCalledTimes(1);
      } finally {
        await own.stop();
      }
    });

    // SR: /focus is open, so at most one per 2 s (more → 429); it only calls
    // onFocusRequested. Mutation: the limit removed → red.
    it("at most one per 2 s: more → 429, Keepr not raised again", async () => {
      const focus = jest.fn();
      let clock = 10_000;
      const own = new RcsExtensionBridge({ importCacheChat: importChat, onFocusRequested: focus, now: () => clock });
      expect(await own.start(0)).toBe("listening");
      try {
        const p = own.getStatus().port;
        expect((await request(p, "POST", "/focus", EXT_HEADERS)).status).toBe(200);
        clock += 500;
        expect((await request(p, "POST", "/focus", EXT_HEADERS)).status).toBe(429);
        clock += 1_499; // 1 999 ms after the first
        expect((await request(p, "POST", "/focus", EXT_HEADERS)).status).toBe(429);
        expect(focus).toHaveBeenCalledTimes(1);
        clock += 1;
        expect((await request(p, "POST", "/focus", EXT_HEADERS)).status).toBe(200);
        expect(focus).toHaveBeenCalledTimes(2);
      } finally {
        await own.stop();
      }
    });

    it("a bridge without a focus handler answers 501", async () => {
      expect((await request(port, "POST", "/focus", EXT_HEADERS)).status).toBe(501);
    });
  });

  // BACKLOG-3658 — /hello. Mutations: echo the hello back / no version cap → red.
  describe("POST /hello (BACKLOG-3658)", () => {
    it("/hello passes a capped version / paired to Keepr and sends nothing back", async () => {
      const hellos: unknown[] = [];
      const own = new RcsExtensionBridge({ importCacheChat: importChat, onHello: (h) => void hellos.push(h) });
      expect(await own.start(0)).toBe("listening");
      try {
        const p = own.getStatus().port;
        const reply = await request(p, "POST", "/hello", EXT_HEADERS, JSON.stringify({ version: "9".repeat(100), extra: "x" }));
        expect(reply).toEqual({ status: 200, body: { ok: true } });
        await request(p, "POST", "/hello", EXT_HEADERS, JSON.stringify({ paired: true }));
        expect(hellos).toEqual([{ version: "9".repeat(40) }, { paired: true }]);
        expect((await request(p, "POST", "/hello", { Origin: "https://messages.google.com" }, "{}")).status).toBe(403);
      } finally {
        await own.stop();
      }
    });
  });

  it("rejects a malformed chat with 400", async () => {
    const chatPath = await matchedChatPath();
    const reply = await request(port, "POST", chatPath, EXT_HEADERS, JSON.stringify({ title: "x", messages: [] }));
    expect(reply.status).toBe(400);
    expect(reply.body.message).toBe("Invalid chat request"); // SR C5: the zod schema
    expect(importChat).not.toHaveBeenCalled();
  });

  it("a port already in use leaves the bridge unavailable without throwing", async () => {
    const second = new RcsExtensionBridge({ importCacheChat: importChat });
    expect(await second.start(port)).toBe("unavailable");
    expect(second.getStatus()).toMatchObject({ bridge: "unavailable", reason: `Port ${port} is already in use` });
    await second.stop();
    // The first bridge is unaffected.
    const reply = await request(port, "POST", "/status", { Origin: RCS_EXTENSION_ORIGIN });
    expect(reply.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3620 — Sync jobs (now cache jobs only). Controls 1, 3, 4 and 8.
// ---------------------------------------------------------------------------

const EXT = { ...JSON_HEADERS, Origin: RCS_EXTENSION_ORIGIN };

describe("RcsExtensionBridge sync jobs", () => {
  let bridge: RcsExtensionBridge;
  let port: number;
  let importChat: jest.Mock<Promise<RcsImportResult>, [RcsIncomingChat, string, unknown, string]>;
  let importImage: jest.Mock<Promise<RcsImageResult>, [RcsIncomingImage, string, string, string[], string]>;
  let finished: RcsJobSnapshot[];
  let jobId: string;

  beforeEach(async () => {
    importChat = jest.fn(async (chat: RcsIncomingChat, _userId: string, _people: unknown, _jobId: string): Promise<RcsImportResult> => ({
      received: chat.messages.length,
      stored: chat.messages.length,
      alreadyPresent: 0,
      linked: chat.messages.length,
      reactions: 0,
      reactionsStored: 0,
    }));
    importImage = jest.fn(async (_image: RcsIncomingImage, _userId: string, _hash: string, _numbers: string[], _jobId: string): Promise<RcsImageResult> => ({
      stored: true, alreadyPresent: false, filename: "gmweb-1-0.png", bytes: 3,
    }));
    finished = [];
    bridge = new RcsExtensionBridge({
      importCacheChat: importChat,
      importCacheImage: importImage,
      onJobFinished: (j) => finished.push(j),
      jobs: new RcsJobRegistry(),
      finishSaveWaitMs: 0,
    });
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
    jobId = bridge.createCacheJob("user-1", { since: SINCE })!.jobId;
  });

  afterEach(async () => {
    await bridge.stop();
  });

  async function claimAndMatch(numbers: string[]): Promise<Reply> {
    expect((await request(port, "POST", `/job/${jobId}/claim`, EXT)).status).toBe(200);
    return request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({
      conversationId: CHAT.conversationId,
      numbers,
    }));
  }

  // Founder (2026-10-05): no contact gate any more — every chat with a
  // number is kept; a chat this job's /match never saw is still refused.
  describe("control 1: only a chat this job checked is imported", () => {
    it("a chat (or its image) the job never /match'ed is refused with 403", async () => {
      expect((await request(port, "POST", `/job/${jobId}/claim`, EXT)).status).toBe(200);
      const chat = await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON);
      expect(chat.status).toBe(403);
      expect(chat.body.error).toBe("not_matched");
      const reply = await request(port, "POST", `/job/${jobId}/attachment`, EXT, JSON.stringify({
        conversationId: CHAT.conversationId, msgId: "1", index: 0, mimeType: "image/png", base64: "AAAA",
      }));
      expect(reply.status).toBe(403);
      expect(importChat).not.toHaveBeenCalled();
      expect(importImage).not.toHaveBeenCalled();
    });

    it("a checked chat goes through, for the job's user", async () => {
      const match = await claimAndMatch(["(555) 555-0199"]);
      expect(match.body).toMatchObject({ matched: true, contactIds: [] });
      const chat = await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON);
      expect(chat.status).toBe(200);
      expect(importChat).toHaveBeenCalledTimes(1);
      expect(importChat.mock.calls[0][1]).toBe("user-1");
      expect(bridge.getJob()?.progress).toMatchObject({ imported: 1, messages: 2, matched: 1 });
    });

    it("claim: no names, no numbers", async () => {
      const claim = await request(port, "POST", `/job/${jobId}/claim`, EXT);
      expect(claim.body).toEqual({ jobId, kind: "cache", startDate: SINCE, since: SINCE });
    });
  });

  describe("control 4: job id", () => {
    it("a wrong job id is refused (404) on every route", async () => {
      const wrong = "00000000-0000-4000-8000-000000000000"; // pii-allow-uuid: invented, not from any live row
      expect((await request(port, "POST", `/job/${wrong}/claim`, EXT)).status).toBe(404);
      expect((await request(port, "POST", `/job/${wrong}/match`, EXT, JSON.stringify({
        conversationId: CHAT.conversationId, numbers: ["(555) 555-0199"],
      }))).status).toBe(404);
      expect((await request(port, "POST", `/job/${wrong}/chat`, EXT, CHAT_JSON)).status).toBe(404);
      expect(importChat).not.toHaveBeenCalled();
    });

    it("a second claim is refused with 409", async () => {
      expect((await request(port, "POST", `/job/${jobId}/claim`, EXT)).status).toBe(200);
      const second = await request(port, "POST", `/job/${jobId}/claim`, EXT);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("already_running");
    });

    it("the Origin pin applies to job routes too", async () => {
      const reply = await request(port, "POST", `/job/${jobId}/claim`, { Origin: "https://messages.google.com" });
      expect(reply.status).toBe(403);
    });

    it("/job/pending returns an unclaimed job, and nothing once it is claimed", async () => {
      expect((await request(port, "POST", "/job/pending", EXT)).body).toEqual({ jobId });
      await request(port, "POST", `/job/${jobId}/claim`, EXT);
      expect((await request(port, "POST", "/job/pending", EXT)).status).toBe(404);
    });
  });

  // Chrome on Windows sends a service-worker GET WITHOUT Origin, so the claim
  // and the pending check are POSTs, and the bridge answers every GET 405.
  // Mutations that turn these red: re-accepting GET for the claim / pending /
  // status; loosening the Origin check to `origin && origin !== …`; deleting
  // the Host check, or comparing it with the fixed 38619 instead of the bound
  // port (this bridge runs on a random port).
  describe("BACKLOG-3628: POST only, strict Origin, exact Host", () => {
    it("GET on the claim, the pending check and status answers 405 and claims nothing", async () => {
      for (const p of [`/job/${jobId}/claim`, `/job/${jobId}`, "/job/pending", "/status"]) {
        const reply = await request(port, "GET", p, EXT);
        expect([p, reply.status, reply.body.error]).toEqual([p, 405, "method_not_allowed"]);
      }
      expect(bridge.getJob()?.state).toBe("created");
    });

    it("the old bare claim URL claims nothing on POST either", async () => {
      expect((await request(port, "POST", `/job/${jobId}`, EXT)).status).toBe(404);
      expect(bridge.getJob()?.state).toBe("created");
    });

    it("a POST claim with NO Origin is refused, even with the right job id", async () => {
      const reply = await request(port, "POST", `/job/${jobId}/claim`, JSON_HEADERS);
      expect(reply.status).toBe(403);
      expect(reply.body.error).toBe("forbidden_origin");
      expect(bridge.getJob()?.state).toBe("created");
    });

    it("a Host other than 127.0.0.1:<bound port> is refused before anything else", async () => {
      for (const host of [`localhost:${port}`, "evil.test", `127.0.0.1:${port + 1}`, "127.0.0.1"]) {
        const reply = await request(port, "POST", `/job/${jobId}/claim`, { ...EXT, Host: host });
        expect([host, reply.status, reply.body.error]).toEqual([host, 403, "forbidden_host"]);
      }
      expect(bridge.getJob()?.state).toBe("created");
      // The exact Host (what http.request sends by default) is accepted.
      const ok = await request(port, "POST", `/job/${jobId}/claim`, { ...EXT, Host: `127.0.0.1:${port}` });
      expect(ok.status).toBe(200);
    });

    it("the CORS preflight offers POST only", async () => {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "OPTIONS", path: "/job/pending", headers: EXT }, resolve);
        req.on("error", reject);
        req.end();
      });
      res.resume();
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-methods"]).toBe("POST");
    });
  });

  // BACKLOG-3629. Mutation that turns this red: drop the parseNotReached
  // argument from job.finish in the /finish case.
  describe("BACKLOG-3629: /finish carries the chats the page left out", () => {
    it("stores the named entries (capped at 20, the rest counted) and logs the count only", async () => {
      const logged: string[] = [];
      const own = new RcsExtensionBridge({
        importCacheChat: importChat,
        onJobFinished: (j) => finished.push(j),
        jobs: new RcsJobRegistry(),
        finishSaveWaitMs: 0,
        logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) },
      });
      expect(await own.start(0)).toBe("listening");
      try {
        const ownPort = own.getStatus().port;
        const id = own.createCacheJob("user-1", { since: SINCE })!.jobId;
        expect((await request(ownPort, "POST", `/job/${id}/claim`, EXT)).status).toBe(200);
        const list = Array.from({ length: 22 }, (_, i) => ({ name: `Chat Name ${i}`, reason: "not_opened" }));
        list[1] = { name: "Chat Name 1", reason: "images_failed", count: 2 } as (typeof list)[number];
        list[2] = { name: "Chat Name 1", reason: "history_truncated" };
        await request(ownPort, "POST", `/job/${id}/progress`, EXT, JSON.stringify({
          stage: "Checked 8 of 8 chats", listed: 19, candidates: 8, checked: 8, skipped: 1,
        }));
        const reply = await request(ownPort, "POST", `/job/${id}/finish`, EXT, JSON.stringify({
          chats: 0, messages: 0, images: 0, notReached: list, notReachedMore: 3,
        }));
        expect(reply.status).toBe(200);
        const snap = finished[finished.length - 1];
        expect(snap.notReached).toHaveLength(20);
        expect(snap.notReached?.[1]).toEqual({ name: "Chat Name 1", reason: "images_failed", count: 2 });
        expect(snap.notReachedMore).toBe(5); // 3 from the page + 2 over the cap
        const line = logged.find((m) => m.includes("Sync job finished")) ?? "";
        // 20 kept entries but 19 distinct chats ("Chat Name 1" twice), and
        // 5 more past the cap. Mutation: count entries, not names → red.
        expect(line).toContain("19 chats not fully imported (20 entries, +5 more)");
        // BACKLOG-3641: the scan counts are in Keepr's log. Mutation: drop
        // them from the finish line → red.
        expect(line).toContain("listed 19, candidates 8, checked 8, matched 0, skipped 1");
        expect(logged.join("\n")).not.toContain("Chat Name");
        expect(logged.join("\n")).not.toContain("Hidden tab");
      } finally {
        await own.stop();
      }
    });

    // Founder (2026-10-03): the hidden-tab telemetry is logged (numbers only).
    // Mutation: not logged → red; a non-number passed through → red.
    it("/finish logs the time hidden and the history loaded while hidden", async () => {
      const logged: string[] = [];
      const own = new RcsExtensionBridge({
        importCacheChat: importChat,
        jobs: new RcsJobRegistry(),
        finishSaveWaitMs: 0,
        logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) },
      });
      expect(await own.start(0)).toBe("listening");
      try {
        const ownPort = own.getStatus().port;
        const id = own.createCacheJob("user-1", { since: SINCE })!.jobId;
        await request(ownPort, "POST", `/job/${id}/claim`, EXT);
        await request(ownPort, "POST", `/job/${id}/finish`, EXT, JSON.stringify({
          chats: 0, messages: 0, images: 0, hidden: { ms: 61_400, spells: 2, chats: 3, batches: "x<script>" },
        }));
        expect(logged).toContain("[RcsBridge] Hidden tab: 61s in 2 spells; 0 history batches in 3 chats loaded while hidden");
      } finally {
        await own.stop();
      }
    });

    it("a /finish with nothing left out adds no notReached fields", async () => {
      expect((await request(port, "POST", `/job/${jobId}/claim`, EXT)).status).toBe(200);
      await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 1, messages: 2, images: 0, notReached: [], notReachedMore: 0 }));
      expect(finished[finished.length - 1]).not.toHaveProperty("notReached");
    });
  });

  // BACKLOG-3642 / 3645. Mutations that turn these red: pass the page's own
  // participantKey (or none) to importChat; drop the removedNotRelinked sum;
  // drop notChecked from /progress or /finish.
  // BACKLOG-3661. Mutation that turns this red: createJob replacing the
  // running job.
  describe("BACKLOG-3661: one Sync at a time", () => {
    it("createCacheJob while a job runs creates nothing (null) and leaves the running job; activeJob names it", () => {
      expect(bridge.createCacheJob("user-2", { since: SINCE })).toBeNull();
      expect(bridge.activeJob()?.jobId).toBe(jobId);
      expect(bridge.activeJob()?.kind).toBe("cache");
      expect(bridge.activeJob()?.state).toBe("created");
    });
  });

  describe("BACKLOG-3642/3645: participant key, removed-by-you, not checked", () => {
    // BACKLOG-3630. Mutation: take the numbers from the page's body → red.
    it("the chat is keyed on the numbers THIS job's /match saw — the page only names them", async () => {
      await claimAndMatch(["(555) 555-0199"]);
      const body = JSON.stringify({
        ...CHAT,
        participants: [
          { name: "Test Contact A", number: "(555) 555-0199" },
          { name: "Test Contact Unmatched", number: "+1 555 555 0142" },
        ],
      });
      expect((await request(port, "POST", `/job/${jobId}/chat`, EXT, body)).status).toBe(200);
      const call = importChat.mock.calls[0] as unknown as [RcsIncomingChat, string, { numbers: string[]; names: unknown[] }];
      expect(call[2]).toEqual({ numbers: ["+15555550199"], names: [{ name: "Test Contact A", number: "+15555550199" }] });
    });

    it("messages the user removed are summed into progress.removedNotRelinked and returned to the page", async () => {
      importChat.mockImplementation(async (chat: RcsIncomingChat) => ({
        received: chat.messages.length, stored: 0, alreadyPresent: chat.messages.length,
        linked: 0, reactions: 0, reactionsStored: 0, removedByUser: chat.messages.length,
      }));
      await claimAndMatch(["(555) 555-0199"]);
      const reply = await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON);
      expect(reply.body).toMatchObject({ ok: true, removedByUser: 2 });
      expect(bridge.getJob()?.progress.removedNotRelinked).toBe(2);
    });

    it("notChecked from /progress and /finish lands on the job", async () => {
      expect((await request(port, "POST", `/job/${jobId}/claim`, EXT)).status).toBe(200);
      await request(port, "POST", `/job/${jobId}/progress`, EXT, JSON.stringify({ stage: "Checking chat 1 of 2", notChecked: 58 }));
      expect(bridge.getJob()?.progress.notChecked).toBe(58);
      await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 0, messages: 0, images: 0, notChecked: 57 }));
      expect(finished[finished.length - 1].progress.notChecked).toBe(57);
    });
  });

  describe("control 8: an oversize image gets a real 413 reply", () => {
    it("answers 413 JSON before the connection closes", async () => {
      await claimAndMatch(["(555) 555-0199"]);
      const reply = await request(port, "POST", `/job/${jobId}/attachment`, {
        ...EXT,
        "Content-Length": String(MAX_ATTACHMENT_BODY_BYTES + 1),
      });
      expect(reply.status).toBe(413);
      expect(reply.body.error).toBe("too_large");
      expect(importImage).not.toHaveBeenCalled();
    });
  });

  it("finish marks the job finished and asks Keepr to come forward", async () => {
    await claimAndMatch(["(555) 555-0199"]);
    const reply = await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 1 }));
    expect(reply.status).toBe(200);
    expect(finished).toHaveLength(1);
    expect(bridge.getJob()?.state).toBe("finished");
  });

  it("an error before the claim (not signed in) fails the job with the page's message", async () => {
    const reply = await request(port, "POST", `/job/${jobId}/error`, EXT, JSON.stringify({
      code: "not_signed_in", message: "Sign in to Google Messages, then click Sync in Keepr again",
    }));
    expect(reply.status).toBe(200);
    expect(bridge.getJob()).toMatchObject({
      state: "failed",
      error: { code: "not_signed_in", message: "Sign in to Google Messages, then click Sync in Keepr again" },
    });
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3658 — a cache job end to end through the bridge.
// Mutations that turn these red: numbers taken from the /chat body; the user
// check skipped; a not-a-contact image counted silently; the end announced
// twice / never.
// ---------------------------------------------------------------------------
describe("RcsExtensionBridge cache jobs (BACKLOG-3658)", () => {
  let bridge: RcsExtensionBridge;
  let port: number;
  let current: string | null;
  let cacheChats: Array<[string, string, unknown]>;
  let ended: Array<{ state: string; kind: string; userId: string | null }>;
  /** The end snapshots as Keepr's handlers receive them. */
  const endedSnapshots: RcsJobSnapshot[] = [];
  let imageAnswer: { stored: false; reason: "not_a_contact" } | { stored: true; alreadyPresent: false; filename: string; bytes: number };
  let jobId: string;
  let focus: string[];
  let cancelWhileChecking: boolean;
  let stagedFor: string[];
  /** What Keepr's (mocked) save records for a finished job; undefined: never answers. */
  let savedAnswer: { chats: number; messages: number; newMessages: number } | null | undefined;
  const mediaCounts: Array<[string, { photosSeen: number; videosSeen: number }]> = [];
  const floorAsks: unknown[][] = [];
  const reachedSeen: Array<boolean | undefined> = [];
  const DEAL_FLOOR = Date.parse("2026-01-10T00:00:00.000Z");

  beforeEach(async () => {
    mediaCounts.length = 0;
    floorAsks.length = 0;
    reachedSeen.length = 0;
    current = "user-a";
    savedAnswer = { chats: 0, messages: 0, newMessages: 0 };
    focus = [];
    cacheChats = [];
    cancelWhileChecking = false;
    stagedFor = [];
    ended = [];
    imageAnswer = { stored: false, reason: "not_a_contact" };
    bridge = new RcsExtensionBridge({
      importCacheChat: async (chat, userId, people, forJob) => {
        cacheChats.push([chat.conversationId, userId, people]);
        reachedSeen.push(chat.reachedFloor);
        stagedFor.push(forJob);
        return { received: chat.messages.length, stored: chat.messages.length, alreadyPresent: 0, linked: 0, reactions: 0, reactionsStored: 0 };
      },
      importCacheImage: async (_image, _userId, _hash, _numbers, forJob) => {
        stagedFor.push(forJob);
        return imageAnswer;
      },
      currentUserId: async () => {
        // A Cancel that lands while the user is being checked.
        if (cancelWhileChecking) bridge.cancelJob();
        return current;
      },
      onJobEnded: (e) => {
        ended.push({ state: e.snapshot.state, kind: e.kind, userId: e.userId });
        endedSnapshots.push(e.snapshot);
        // Keepr's save (handlers: commitCacheJob) answers a moment later.
        if (e.snapshot.state === "finished" && savedAnswer !== undefined) {
          const answer = savedAnswer;
          setTimeout(() => bridge.recordCacheSaved(e.snapshot.jobId, answer), 5);
        }
      },
      onJobFinished: () => void focus.push("front"),
      finishSaveWaitMs: 200,
      // P3b contacts-only flag: this test number is not a transaction contact.
      cacheChatAllowed: (_jobId, _userId, numbers) => !numbers.includes("+15555550199"),
      // SR M: photos kept for this (contact) number; videos never in this fixture.
      cacheMediaKept: (_jobId, _userId, numbers) => ({ photos: numbers.includes("+15555550142"), videos: false }),
      onMediaCounts: (userId, counts) => void mediaCounts.push([userId, counts]),
      // SR (2026-10-02): a deal chat (this number) has its own, earlier floor.
      cacheChatFloor: (...a) => {
        floorAsks.push(a);
        return (a[3] as string[]).includes("+15555550155") ? DEAL_FLOOR : null;
      },
      // 3671 P3 "Try again": this number's chat was saved by the failed run.
      cacheChatSkip: (_j, _u, _c, numbers) => numbers.includes("+15555550166"),
      jobs: new RcsJobRegistry(),
    });
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
    jobId = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!.jobId;
    const claimed = (await request(port, "POST", `/job/${jobId}/claim`, EXT)).body;
    expect(claimed).toMatchObject({ kind: "cache" });
    expect(claimed).not.toHaveProperty("contacts");
  });

  afterEach(async () => {
    await bridge.stop();
  });

  // SR (on eb040dde7): the page's phoneDisconnected reaches Keepr's end
  // snapshot through the bridge, and Keepr then does not move "last synced".
  // Mutation: the bridge dropping it → red.
  it("POST /finish with phoneDisconnected: on the end snapshot; lastCacheFinishedAt not advanced", async () => {
    const body = JSON.stringify({ chats: 1, messages: 2, images: 0, notReached: [], notReachedMore: 0, listStop: "stable", phoneDisconnected: true });
    expect((await request(port, "POST", `/job/${jobId}/finish`, EXT, body)).status).toBe(200);
    const snap = endedSnapshots[endedSnapshots.length - 1];
    expect(snap).toMatchObject({ state: "finished", phoneDisconnected: true });
    const saved: string[] = [];
    await handleCacheJobEnded({ kind: "cache", userId: "user-a", snapshot: snap, detectedOwnNumber: null }, {
      saveFinishedAt: (u: string, iso: string) => void saved.push(u + " " + iso),
      saveOwnNumber: () => undefined,
      commit: async () => undefined,
      discard: async () => undefined,
      autoLink: async () => undefined,
      afterLink: async () => undefined,
      onSaved: () => undefined,
      now: () => Date.now(),
    } as unknown as Parameters<typeof handleCacheJobEnded>[1]);
    expect(saved).toEqual([]);
  });

  it("every chat with a number is matched; /chat stores it for the job's user with the numbers /match saw", async () => {
    const match = await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0142"] }));
    // History v2: keepImages tells the page whether to run its image pass.
    expect(match.body).toEqual({ matched: true, contactIds: [], keepPhotos: true, keepVideos: false, keepImages: true });
    const body = JSON.stringify({ ...CHAT, participants: [{ name: "Test Contact Unmatched", number: "+1 555 555 0177" }] });
    expect((await request(port, "POST", `/job/${jobId}/chat`, EXT, body)).status).toBe(200);
    expect(cacheChats).toEqual([[CHAT.conversationId, "user-a", { numbers: ["+15555550142"], names: [] }]]);
    // BACKLOG-3658 atomic import: staged under THIS job.
    expect(stagedFor).toEqual([jobId]);
  });

  // SR (2026-10-02): /match carries a deal chat's own floor, computed in
  // Keepr from the numbers this job saw; other chats get none. /chat passes
  // the page's reachedFloor boolean on. Mutations: floorMs not replied → red;
  // replied for every chat → red; reachedFloor dropped by the parser → red.
  it("/match: floorMs for a deal chat only; /chat passes reachedFloor on", async () => {
    const deal = await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: "conv-deal", numbers: ["(555) 555-0155"] }));
    expect(deal.body).toMatchObject({ matched: true, floorMs: DEAL_FLOOR });
    expect(floorAsks).toEqual([[jobId, "user-a", "conv-deal", ["+15555550155"]]]);
    const other = await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0142"] }));
    expect(other.body).not.toHaveProperty("floorMs");
    expect((await request(port, "POST", `/job/${jobId}/chat`, EXT, JSON.stringify({ ...CHAT, reachedFloor: true }))).status).toBe(200);
    expect((await request(port, "POST", `/job/${jobId}/chat`, EXT, JSON.stringify({ ...CHAT, reachedFloor: "yes" }))).status).toBe(200);
    expect(reachedSeen).toEqual([true, undefined]);
  });

  // 3671 P3: /match says skip (a boolean) for a chat the failed run saved;
  // none for others. Mutation: never replied → red.
  it("/match: skip for a chat Keepr says the failed run saved", async () => {
    const saved = await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: "conv-saved", numbers: ["(555) 555-0166"] }));
    expect(saved.body).toMatchObject({ matched: true, skip: true });
    const other = await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0142"] }));
    expect(other.body).not.toHaveProperty("skip");
  });

  // History v2 / SR M. Mutation: keepPhotos always true → red.
  it("/match tells the page when Keepr does NOT keep a chat's photos", async () => {
    const match = await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0177"] }));
    expect(match.body).toEqual({ matched: true, contactIds: [], keepPhotos: false, keepVideos: false, keepImages: false });
  });

  // SR M: the media counts of a finished Sync (numbers only). Mutation: not passed on → red.
  it("/finish passes the photo / video bubble counts on (counts only)", async () => {
    const body = JSON.stringify({ chats: 0, messages: 0, images: 0, media: { photos: { seen: 12, saved: 9 }, videos: { seen: 3, saved: 0 } } });
    await request(port, "POST", `/job/${jobId}/finish`, EXT, body);
    expect(mediaCounts).toEqual([["user-a", { photosSeen: 12, videosSeen: 3 }]]);
  });

  // BACKLOG-3658 atomic import. Mutation: drop the isActive re-check → red
  // (a chat or image of an ended job would be staged after its discard).
  it("a job that ended while the user was checked stages nothing: 410", async () => {
    await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0142"] }));
    cancelWhileChecking = true;
    const chatReply = await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON);
    expect(chatReply.status).toBe(410);
    expect(stagedFor).toEqual([]);
  });

  it("an image of a job that ended while the user was checked is not staged: 410", async () => {
    await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0142"] }));
    cancelWhileChecking = true;
    const reply = await request(port, "POST", `/job/${jobId}/attachment`, EXT, JSON.stringify({
      conversationId: CHAT.conversationId, msgId: "1", index: 0, mimeType: "image/png", base64: "AAAA",
    }));
    expect(reply.status).toBe(410);
    expect(stagedFor).toEqual([]);
  });

  // BACKLOG-3658 P3b: with the contacts-only flag on, a chat without a
  // transaction contact is not matched (so never staged). Mutation: the
  // filter not passed to job.match → red.
  it("contacts-only: a chat the filter refuses is not matched and cannot be sent", async () => {
    const match = await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0199"] }));
    expect(match.body).toEqual({ matched: false, contactIds: [] });
    expect((await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON)).status).toBe(403);
    expect(cacheChats).toEqual([]);
  });

  it("another user signed in meanwhile: nothing stored, the Sync is cancelled, its end announced once", async () => {
    await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0142"] }));
    current = "user-b";
    const reply = await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON);
    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe("user_changed");
    expect(cacheChats).toEqual([]);
    expect(bridge.getJob()?.state).toBe("cancelled");
    bridge.cancelJob();
    expect(ended).toEqual([{ state: "cancelled", kind: "cache", userId: "user-a" }]);
  });

  it("an image of a chat with no transaction contact: 422, counted as skipped (never silent)", async () => {
    await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0142"] }));
    const reply = await request(port, "POST", `/job/${jobId}/attachment`, EXT, JSON.stringify({
      conversationId: CHAT.conversationId, msgId: "1", index: 0, mimeType: "image/png", base64: "AAAA",
    }));
    expect(reply.status).toBe(422);
    expect(reply.body.error).toBe("not_a_contact");
    expect(bridge.getJob()?.progress.imagesSkipped).toBe(1);
  });

  it("/finish announces the end once, with the job's user", async () => {
    await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 0, messages: 0, images: 0 }));
    expect(ended).toEqual([{ state: "finished", kind: "cache", userId: "user-a" }]);
    bridge.cancelJob();
    expect(ended).toHaveLength(1);
  });

  // BACKLOG-3658 P2: the page's Cancel. Mutations: cancel any job (ignore the
  // id), announce twice, accept a GET, or skip the Origin check → red.
  it("POST /job/:id/cancel cancels that job and announces its end once", async () => {
    const reply = await request(port, "POST", `/job/${jobId}/cancel`, EXT, "{}");
    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(bridge.getJob()?.state).toBe("cancelled");
    expect(ended).toEqual([{ state: "cancelled", kind: "cache", userId: "user-a" }]);
    // Over: 410, and nothing announced again.
    const again = await request(port, "POST", `/job/${jobId}/cancel`, EXT, "{}");
    expect(again.status).toBe(410);
    expect(ended).toHaveLength(1);
  });

  it("cancel of an unknown job: 404, and the running job keeps going", async () => {
    const other = "99999999-8888-4777-8666-555555555555"; // pii-allow-uuid: invented, not from any live row
    const reply = await request(port, "POST", `/job/${other}/cancel`, EXT, "{}");
    expect(reply.status).toBe(404);
    expect(bridge.getJob()?.state).toBe("running");
    expect(ended).toEqual([]);
  });

  it("cancel needs POST and the extension's Origin", async () => {
    expect((await request(port, "GET", `/job/${jobId}/cancel`, { Origin: RCS_EXTENSION_ORIGIN })).status).toBe(405);
    expect((await request(port, "POST", `/job/${jobId}/cancel`, { ...JSON_HEADERS, Origin: "https://messages.google.com" }, "{}")).status).toBe(403);
    expect(bridge.getJob()?.state).toBe("running");
  });

  it("Keepr is not brought forward during a cache job — only when it finishes", async () => {
    await request(port, "POST", `/job/${jobId}/progress`, EXT, JSON.stringify({ stage: "Chat 1 of 2" }));
    await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0142"] }));
    await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON);
    expect(focus).toEqual([]);
    await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 1, messages: 1, images: 0 }));
    expect(focus).toEqual(["front"]);
  });

  // Founder decision (BACKLOG-3658): a Sync is always started from Keepr — the
  // page routes are gone. Mutation: bring either route back → red.
  it("there is no page start or status route", async () => {
    expect((await request(port, "POST", "/job/cache/start", EXT, "{}")).status).toBe(404);
    expect((await request(port, "POST", "/cache/status", EXT, "{}")).status).toBe(404);
  });

  // Founder (2026-10-01): the page shows what Keepr SAVED. Mutations: /finish
  // not waiting for the save, or the saved counts not on the snapshot → red.
  it("/finish of a cache job answers with what Keepr saved, and the job carries it", async () => {
    savedAnswer = { chats: 3, messages: 212, newMessages: 212 };
    const reply = await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 5, messages: 328, images: 0, noMessagesYet: 2 }));
    expect(reply).toEqual({ status: 200, body: { ok: true, saved: { chats: 3, messages: 212, newMessages: 212 } } });
    expect(bridge.getJob()).toMatchObject({ state: "finished", saved: { chats: 3, messages: 212, newMessages: 212 } });
    expect(bridge.getJob()?.progress.noMessagesYet).toBe(2);
  });

  it("/finish of a cache job whose save failed answers saved: null", async () => {
    savedAnswer = null;
    const reply = await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 1, messages: 1, images: 0 }));
    expect(reply.body).toEqual({ ok: true, saved: null });
  });

  it("/finish does not wait past the bound for a slow save; the job gets it later", async () => {
    savedAnswer = undefined;
    const reply = await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 1, messages: 1, images: 0 }));
    expect(reply.body).toEqual({ ok: true });
    expect(bridge.getJob()?.saved).toBeUndefined();
    // SR minor: the timed-out waiter's entry is gone.
    expect(bridge.pendingSavedWaiters(jobId)).toBe(0);
    bridge.recordCacheSaved(jobId, { chats: 1, messages: 1, newMessages: 0 });
    expect(bridge.getJob()?.saved).toEqual({ chats: 1, messages: 1, newMessages: 0 });
  });

  // BACKLOG-3664. Mutation: notText not parsed from /finish → red.
  it("/finish records the AI chats skipped as not text conversations", async () => {
    await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 0, messages: 0, images: 0, notText: 2 }));
    expect(bridge.getJob()?.progress.notText).toBe(2);
  });

  // SR (C): a cancel after the job ended is 410, never 200, and changes nothing.
  it("cancel of a finished job: 410, still finished, announced once", async () => {
    await request(port, "POST", `/job/${jobId}/finish`, EXT, JSON.stringify({ chats: 0, messages: 0, images: 0 }));
    const reply = await request(port, "POST", `/job/${jobId}/cancel`, EXT, "{}");
    expect(reply.status).toBe(410);
    expect(bridge.getJob()?.state).toBe("finished");
    expect(ended).toHaveLength(1);
  });

  it("/error announces the end too", async () => {
    await request(port, "POST", `/job/${jobId}/error`, EXT, JSON.stringify({ code: "scan_failed", message: "x" }));
    expect(ended).toEqual([{ state: "failed", kind: "cache", userId: "user-a" }]);
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3658 P3c — the eye on each row: /exclusions/* and /match.
// Mutations that turn these red: the routes without a signed-in user, or
// with names; the list not capped; an excluded chat matched (any Sync kind);
// the refusal not counted.
// ---------------------------------------------------------------------------
describe("RcsExtensionBridge exclusions (BACKLOG-3658 P3c)", () => {
  let bridge: RcsExtensionBridge;
  let port: number;
  let user: string | null;
  let excluded: Set<string>;
  let sets: Array<[string, string, boolean]>;
  let checks: Array<[string, string, string]>;

  beforeEach(async () => {
    user = "user-a";
    excluded = new Set(["conv-off"]);
    sets = [];
    checks = [];
    bridge = new RcsExtensionBridge({
      importCacheChat: jest.fn(),
      currentUserId: async () => user,
      chatExcluded: (userId, hash, conversationId) => {
        checks.push([userId, hash, conversationId]);
        return excluded.has(conversationId);
      },
      listExclusions: () => Array.from({ length: 2100 }, (_, i) => `conv-${i}`),
      setExclusion: (userId, conversationId, off) => void sets.push([userId, conversationId, off]),
      jobs: new RcsJobRegistry(),
    });
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
  });

  afterEach(async () => {
    await bridge.stop();
  });

  it("/exclusions/list: ids only, capped; refused signed out or from a web page", async () => {
    const r = await request(port, "POST", "/exclusions/list", EXT, "{}");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(["conversationIds"]);
    expect((r.body.conversationIds as string[]).length).toBe(2000);
    expect((await request(port, "POST", "/exclusions/list", { ...JSON_HEADERS, Origin: "https://messages.google.com" }, "{}")).status).toBe(403);
    expect((await request(port, "GET", "/exclusions/list", EXT)).status).toBe(405);
    user = null;
    expect((await request(port, "POST", "/exclusions/list", EXT, "{}")).status).toBe(403);
  });

  it("/exclusions/set: a valid conversation id and a boolean, for the signed-in user", async () => {
    expect((await request(port, "POST", "/exclusions/set", EXT, JSON.stringify({ conversationId: "conv-1", excluded: true }))).status).toBe(200);
    expect((await request(port, "POST", "/exclusions/set", EXT, JSON.stringify({ conversationId: "../x", excluded: true }))).status).toBe(400);
    expect((await request(port, "POST", "/exclusions/set", EXT, JSON.stringify({ conversationId: "conv-1", excluded: "yes" }))).status).toBe(400);
    expect(sets).toEqual([["user-a", "conv-1", true]]);
  });

  it("/match: a switched-off chat is refused and COUNTED", async () => {
    const jobId = bridge.createCacheJob("user-a", { since: "2026-08-01T00:00:00.000Z" })!.jobId;
    expect((await request(port, "POST", `/job/${jobId}/claim`, EXT)).status).toBe(200);
    const off = await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: "conv-off", numbers: ["(555) 555-0199"] }));
    expect(off.body).toEqual({ matched: false, contactIds: [], excluded: true });
    expect((await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON)).status).toBe(403);
    const on = await request(port, "POST", `/job/${jobId}/match`, EXT, JSON.stringify({ conversationId: CHAT.conversationId, numbers: ["(555) 555-0199"] }));
    expect(on.body.matched).toBe(true);
    expect(bridge.getJob()?.progress).toMatchObject({ notSynced: 1, checked: 2 });
    // Keepr gets the chat's hash, never a name.
    expect(checks[0][0]).toBe("user-a");
    expect(checks[0][1]).toMatch(/^[0-9a-f]{64}$/);
  });
});
