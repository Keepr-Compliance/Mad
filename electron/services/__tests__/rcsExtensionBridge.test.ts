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
      const reply = await request(port, "GET", "/status", {});
      expect(reply.status).toBe(403);
    });

    it("accepts the pinned extension Origin", async () => {
      const reply = await request(port, "GET", "/status", { Origin: RCS_EXTENSION_ORIGIN });
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
    const reply = await request(port, "GET", "/status", { Origin: RCS_EXTENSION_ORIGIN });
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
    expect((await request(port, "GET", `/job/${jobId}`, EXT)).status).toBe(200);
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
      const claim = await request(port, "GET", `/job/${jobId}`, EXT);
      expect(claim.body).toEqual({ jobId, contacts: [{ contactId: "c-1", displayName: "Test Contact A" }], startDate: null });
    });

    it("claim carries the transaction's start date when the job has one", async () => {
      jobId = bridge.createJob("tx-job", JOB_CONTACTS, { startDate: "2026-03-01" }).jobId;
      const claim = await request(port, "GET", `/job/${jobId}`, EXT);
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
      expect((await request(port, "GET", `/job/${wrong}`, EXT)).status).toBe(404);
      expect((await request(port, "POST", `/job/${wrong}/match`, EXT, JSON.stringify({
        conversationId: CHAT.conversationId, numbers: ["(555) 555-0199"],
      }))).status).toBe(404);
      expect((await request(port, "POST", `/job/${wrong}/chat`, EXT, CHAT_JSON)).status).toBe(404);
      expect(importChat).not.toHaveBeenCalled();
    });

    it("a second claim is refused with 409", async () => {
      expect((await request(port, "GET", `/job/${jobId}`, EXT)).status).toBe(200);
      const second = await request(port, "GET", `/job/${jobId}`, EXT);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("already_running");
    });

    it("the Origin pin applies to job routes too", async () => {
      const reply = await request(port, "GET", `/job/${jobId}`, { Origin: "https://messages.google.com" });
      expect(reply.status).toBe(403);
    });

    it("/job/pending returns an unclaimed job, and nothing once it is claimed", async () => {
      expect((await request(port, "GET", "/job/pending", EXT)).body).toEqual({ jobId });
      await request(port, "GET", `/job/${jobId}`, EXT);
      expect((await request(port, "GET", "/job/pending", EXT)).status).toBe(404);
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
