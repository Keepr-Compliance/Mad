/**
 * @jest-environment node
 */
/**
 * BACKLOG-3619 — Controls 2 and 3, against a real HTTP server on 127.0.0.1.
 *
 * Control 2: only the pinned extension Origin is accepted (wrong AND missing
 *            Origin are refused, and nothing is imported).
 * Control 3: a chat sent with no open session gets an explicit error, never a
 *            success.
 */

import * as http from "http";

import {
  MAX_ATTACHMENT_BODY_BYTES,
  RCS_EXTENSION_ORIGIN,
  RCS_NO_SESSION_MESSAGE,
  RcsExtensionBridge,
  type RcsChatImportedEvent,
} from "../rcsExtensionBridge";
import { RcsJobRegistry, type RcsJobContact, type RcsJobSnapshot } from "../rcsImportJob";
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
const CHAT_JSON = JSON.stringify(CHAT);
const JSON_HEADERS = { "Content-Type": "application/json" };

describe("RcsExtensionBridge", () => {
  let bridge: RcsExtensionBridge;
  let port: number;
  let importChat: jest.Mock<Promise<RcsImportResult>, [RcsIncomingChat, string]>;
  let events: RcsChatImportedEvent[];

  beforeEach(async () => {
    importChat = jest.fn(async (chat: RcsIncomingChat, _transactionId: string): Promise<RcsImportResult> => ({
      received: chat.messages.length,
      stored: chat.messages.length,
      alreadyPresent: 0,
      linked: chat.messages.length,
      reactions: 0,
      reactionsStored: 0,
    }));
    events = [];
    bridge = new RcsExtensionBridge({ importChat, onChatImported: (e) => events.push(e) });
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
    expect(port).toBeGreaterThan(0);
  });

  afterEach(async () => {
    await bridge.stop();
  });

  describe("Origin (control 2)", () => {
    it("refuses a web-page Origin and imports nothing", async () => {
      bridge.openSession("tx-1");
      const reply = await request(port, "POST", "/chat", {
        ...JSON_HEADERS,
        Origin: "https://messages.google.com",
      }, CHAT_JSON);
      expect(reply.status).toBe(403);
      expect(reply.body.error).toBe("forbidden_origin");
      expect(importChat).not.toHaveBeenCalled();
    });

    it("refuses a DIFFERENT extension's Origin", async () => {
      bridge.openSession("tx-1");
      const reply = await request(port, "POST", "/chat", {
        ...JSON_HEADERS,
        Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }, CHAT_JSON);
      expect(reply.status).toBe(403);
      expect(importChat).not.toHaveBeenCalled();
    });

    it("refuses a request with NO Origin", async () => {
      bridge.openSession("tx-1");
      const reply = await request(port, "POST", "/chat", JSON_HEADERS, CHAT_JSON);
      expect(reply.status).toBe(403);
      expect(importChat).not.toHaveBeenCalled();
    });

    it("refuses GET /status without the pinned Origin", async () => {
      const reply = await request(port, "POST", "/status", {});
      expect(reply.status).toBe(403);
    });

    it("accepts the pinned extension Origin", async () => {
      const reply = await request(port, "POST", "/status", { Origin: RCS_EXTENSION_ORIGIN });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ bridge: "listening", session: null });
    });
  });

  describe("session (control 3)", () => {
    it("answers 409 with an explicit message when no session is open", async () => {
      const reply = await request(port, "POST", "/chat", {
        ...JSON_HEADERS,
        Origin: RCS_EXTENSION_ORIGIN,
      }, CHAT_JSON);
      expect(reply.status).toBe(409);
      expect(reply.body).toEqual({ error: "no_session", message: RCS_NO_SESSION_MESSAGE });
      expect(importChat).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });

    it("answers 409 after the session is closed", async () => {
      const s = bridge.openSession("tx-1");
      bridge.closeSession(s.sessionId);
      const reply = await request(port, "POST", "/chat", {
        ...JSON_HEADERS,
        Origin: RCS_EXTENSION_ORIGIN,
      }, CHAT_JSON);
      expect(reply.status).toBe(409);
      expect(importChat).not.toHaveBeenCalled();
    });

    it("imports into the session's transaction and reports it", async () => {
      const s = bridge.openSession("tx-1");
      const reply = await request(port, "POST", "/chat", {
        ...JSON_HEADERS,
        Origin: RCS_EXTENSION_ORIGIN,
      }, CHAT_JSON);
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ ok: true, received: 2, stored: 2, alreadyPresent: 0, linked: 2, reactions: 0, reactionsStored: 0 });
      expect(importChat).toHaveBeenCalledTimes(1);
      expect(importChat.mock.calls[0][1]).toBe("tx-1");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sessionId: s.sessionId, transactionId: "tx-1" });
      expect(bridge.getStatus().session).toMatchObject({ chatsReceived: 1, messagesReceived: 2, messagesStored: 2 });
    });

    it("closeSession with a stale id leaves the current session open", () => {
      bridge.openSession("tx-1");
      bridge.closeSession("not-the-session");
      expect(bridge.getStatus().session?.transactionId).toBe("tx-1");
    });
  });

  it("rejects a malformed chat with 400", async () => {
    bridge.openSession("tx-1");
    const reply = await request(port, "POST", "/chat", {
      ...JSON_HEADERS,
      Origin: RCS_EXTENSION_ORIGIN,
    }, JSON.stringify({ title: "x", messages: [] }));
    expect(reply.status).toBe(400);
    expect(reply.body.message).toBe("conversationId is required");
    expect(importChat).not.toHaveBeenCalled();
  });

  it("a port already in use leaves the bridge unavailable without throwing", async () => {
    const second = new RcsExtensionBridge({ importChat });
    expect(await second.start(port)).toBe("unavailable");
    expect(second.getStatus()).toMatchObject({ bridge: "unavailable", reason: `Port ${port} is already in use` });
    await second.stop();
    // The first bridge is unaffected.
    const reply = await request(port, "POST", "/status", { Origin: RCS_EXTENSION_ORIGIN });
    expect(reply.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3620 — Sync jobs. Controls 1, 3, 4 and 8.
// ---------------------------------------------------------------------------

const JOB_CONTACTS: RcsJobContact[] = [
  { contactId: "c-1", displayName: "Test Contact A", phonesE164: ["+15555550199"] },
];
const EXT = { ...JSON_HEADERS, Origin: RCS_EXTENSION_ORIGIN };

describe("RcsExtensionBridge sync jobs", () => {
  let bridge: RcsExtensionBridge;
  let port: number;
  let importChat: jest.Mock<Promise<RcsImportResult>, [RcsIncomingChat, string]>;
  let importImage: jest.Mock<Promise<RcsImageResult>, [RcsIncomingImage, string]>;
  let finished: RcsJobSnapshot[];
  let jobId: string;

  beforeEach(async () => {
    importChat = jest.fn(async (chat: RcsIncomingChat, _transactionId: string): Promise<RcsImportResult> => ({
      received: chat.messages.length,
      stored: chat.messages.length,
      alreadyPresent: 0,
      linked: chat.messages.length,
      reactions: 0,
      reactionsStored: 0,
    }));
    importImage = jest.fn(async (_image: RcsIncomingImage, _transactionId: string): Promise<RcsImageResult> => ({
      stored: true, alreadyPresent: false, filename: "gmweb-1-0.png", bytes: 3,
    }));
    finished = [];
    bridge = new RcsExtensionBridge({
      importChat,
      importImage,
      onJobFinished: (j) => finished.push(j),
      jobs: new RcsJobRegistry(),
    });
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
    jobId = bridge.createJob("tx-job", JOB_CONTACTS).jobId;
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

  describe("control 1: only a phone-matched chat is imported", () => {
    it("a non-matching number matches no contact, and its chat is refused with 403", async () => {
      const match = await claimAndMatch(["(555) 555-0198"]);
      expect(match.status).toBe(200);
      expect(match.body).toEqual({ matched: false, contactIds: [] });
      const chat = await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON);
      expect(chat.status).toBe(403);
      expect(chat.body.error).toBe("not_matched");
      expect(importChat).not.toHaveBeenCalled();
    });

    it("an image for an unmatched chat is refused with 403", async () => {
      await claimAndMatch(["(555) 555-0198"]);
      const reply = await request(port, "POST", `/job/${jobId}/attachment`, EXT, JSON.stringify({
        conversationId: CHAT.conversationId, msgId: "1", index: 0, mimeType: "image/png", base64: "AAAA",
      }));
      expect(reply.status).toBe(403);
      expect(importImage).not.toHaveBeenCalled();
    });

    it("a matching number lets the chat through, into the JOB's transaction", async () => {
      const match = await claimAndMatch(["(555) 555-0199"]);
      expect(match.body).toEqual({ matched: true, contactIds: ["c-1"] });
      const chat = await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON);
      expect(chat.status).toBe(200);
      expect(importChat).toHaveBeenCalledTimes(1);
      expect(importChat.mock.calls[0][1]).toBe("tx-job");
      expect(bridge.getJob()?.progress).toMatchObject({ imported: 1, messages: 2, matched: 1 });
    });

    it("claim returns names only, never the contacts' numbers", async () => {
      const claim = await request(port, "POST", `/job/${jobId}/claim`, EXT);
      expect(claim.body).toEqual({ jobId, contacts: [{ contactId: "c-1", displayName: "Test Contact A" }], startDate: null, contactsWithoutPhoneCount: 0 });
    });

    it("claim carries the transaction's start date when the job has one", async () => {
      jobId = bridge.createJob("tx-job", JOB_CONTACTS, { startDate: "2026-03-01" }).jobId;
      const claim = await request(port, "POST", `/job/${jobId}/claim`, EXT);
      expect(claim.body).toMatchObject({ jobId, startDate: "2026-03-01" });
    });
  });

  describe("control 3: the job does not depend on the manual-send session", () => {
    it("job posts succeed with no session, and after a session is opened and closed", async () => {
      await claimAndMatch(["(555) 555-0199"]);
      const s = bridge.openSession("tx-other");
      bridge.closeSession(s.sessionId);
      const chat = await request(port, "POST", `/job/${jobId}/chat`, EXT, CHAT_JSON);
      expect(chat.status).toBe(200);
      expect(importChat.mock.calls[0][1]).toBe("tx-job");
      // the manual route still needs its own session
      const manual = await request(port, "POST", "/chat", EXT, CHAT_JSON);
      expect(manual.status).toBe(409);
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
        importChat,
        onJobFinished: (j) => finished.push(j),
        jobs: new RcsJobRegistry(),
        logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) },
      });
      expect(await own.start(0)).toBe("listening");
      try {
        const ownPort = own.getStatus().port;
        const id = own.createJob("tx-job", JOB_CONTACTS).jobId;
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
  describe("BACKLOG-3642/3645: participant key, removed-by-you, not checked", () => {
    it("the chat is imported with the participant key of the numbers THIS job's /match saw — never the page's", async () => {
      await claimAndMatch(["(555) 555-0199"]);
      const body = JSON.stringify({ ...CHAT, participantKey: "+15555550142" });
      expect((await request(port, "POST", `/job/${jobId}/chat`, EXT, body)).status).toBe(200);
      const call = importChat.mock.calls[0] as unknown as [RcsIncomingChat, string, { participantKey?: string }];
      expect(call[2]).toEqual({ participantKey: "+15555550199" });
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
