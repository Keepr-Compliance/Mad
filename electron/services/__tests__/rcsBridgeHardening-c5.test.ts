/**
 * @jest-environment node
 */
/**
 * SR clean-up C5 (CASA hardening) — the bridge side.
 *
 * Mutation controls (each turns a test red):
 *   M1 an SVG (or any type off the allow-list) accepted            → "415"
 *   M2 no rate limit                                                → "429"
 *   M3 /attachment counted in the job bucket (one bucket for all)   → "own bucket"
 *   M4 the window never reopens                                     → "reopens"
 *   M5 a job route's body not validated (schema gate removed)       → "400"
 *   M6 the schemas strict (an extra field refused)                  → "extra fields"
 */
import * as http from "http";

import { RCS_EXTENSION_ORIGIN, RCS_RATE_LIMITS, RCS_RATE_WINDOW_MS, RcsExtensionBridge } from "../rcsExtensionBridge";
import { RcsJobRegistry, type RcsJobContact } from "../rcsImportJob";
import { parseBridgeBody, RcsBridgeBodySchemas, RcsHelloBodySchema, RcsLinkBodySchemas } from "../../schemas/rcsBridge";
import { RCS_ALLOWED_IMAGE_MIME, type RcsImageResult, type RcsIncomingImage } from "../rcsImportMedia";
import type { RcsImportResult, RcsIncomingChat } from "../rcsImportStore";

interface Reply {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: string;
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
          resolve({
            status: res.statusCode ?? 0,
            body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
            retryAfter: res.headers["retry-after"] as string | undefined,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const CONTACTS: RcsJobContact[] = [{ contactId: "c-1", displayName: "Test Contact A", phonesE164: ["+15555550199"] }];
const CONV = "aaaaaaaaaaaaaaaaaaa";

describe("bridge hardening (C5)", () => {
  let bridge: RcsExtensionBridge;
  let port: number;
  let clock: number;
  let importImage: jest.Mock<Promise<RcsImageResult>, [RcsIncomingImage, string]>;
  let jobId: string;

  beforeEach(async () => {
    clock = 1_000_000;
    importImage = jest.fn(async (_image: RcsIncomingImage, _tx: string): Promise<RcsImageResult> => ({ stored: true, alreadyPresent: false, filename: "gmweb-1-0.png", bytes: 3 }));
    bridge = new RcsExtensionBridge({
      importChat: jest.fn(async (chat: RcsIncomingChat): Promise<RcsImportResult> => ({
        received: chat.messages.length, stored: chat.messages.length, alreadyPresent: 0, linked: 0, reactions: 0, reactionsStored: 0,
      })),
      importImage,
      jobs: new RcsJobRegistry(),
      now: () => clock,
    });
    expect(await bridge.start(0)).toBe("listening");
    port = bridge.getStatus().port;
    jobId = bridge.createJob("tx-job", CONTACTS)!.jobId;
    expect((await post(port, `/job/${jobId}/claim`)).status).toBe(200);
    expect((await post(port, `/job/${jobId}/match`, JSON.stringify({ conversationId: CONV, numbers: ["(555) 555-0199"] }))).status).toBe(200);
  });
  afterEach(async () => {
    await bridge.stop();
  });

  const image = (mimeType: string) => JSON.stringify({ conversationId: CONV, msgId: "1", index: 0, mimeType, base64: "AAAA" });

  it("415: an image type off the allow-list (SVG, BMP, a non-image) is refused and nothing is stored", async () => {
    for (const mime of ["image/svg+xml", "image/bmp", "text/html", "application/octet-stream"]) {
      const r = await post(port, `/job/${jobId}/attachment`, image(mime));
      expect([mime, r.status, r.body.error]).toEqual([mime, 415, "unsupported_media_type"]);
    }
    expect(importImage).not.toHaveBeenCalled();
    // The allowed types still go through.
    for (const mime of ["image/jpeg", "image/PNG", "image/gif", "image/webp", "image/heic", "image/heif"]) {
      expect([mime, (await post(port, `/job/${jobId}/attachment`, image(mime))).status]).toEqual([mime, 200]);
    }
    expect([...RCS_ALLOWED_IMAGE_MIME].sort()).toEqual(["image/gif", "image/heic", "image/heif", "image/jpeg", "image/jpg", "image/png", "image/webp"]);
  });

  it("route groups: /attachment has its own bucket; job, link and other routes theirs", () => {
    expect(RcsExtensionBridge.rateGroup(`/job/${jobId}/attachment`)).toBe("attachment");
    expect(RcsExtensionBridge.rateGroup(`/job/${jobId}/chat`)).toBe("job");
    expect(RcsExtensionBridge.rateGroup(`/job/${jobId}`)).toBe("job");
    expect(RcsExtensionBridge.rateGroup("/link/start")).toBe("link");
    expect(RcsExtensionBridge.rateGroup("/status")).toBe("other");
    expect(RCS_RATE_LIMITS.attachment).toBeGreaterThanOrEqual(1200);
  });

  it("429 past a group's limit, with retryAfterMs and Retry-After; the window reopens", async () => {
    // Fill the link bucket over HTTP (the beforeEach used 2 job requests, not link ones).
    for (let i = 0; i < RCS_RATE_LIMITS.link; i++) {
      expect((await post(port, "/link/poll", "{}")).status).not.toBe(429);
    }
    const over = await post(port, "/link/poll", "{}");
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("rate_limited");
    expect(over.body.retryAfterMs).toBe(RCS_RATE_WINDOW_MS);
    expect(over.retryAfter).toBe("60");
    // Other buckets are untouched.
    expect((await post(port, "/status")).status).toBe(200);
    clock += 30_000;
    expect((await post(port, "/link/poll", "{}")).body.retryAfterMs).toBe(30_000);
    clock += 30_000;
    expect((await post(port, "/link/poll", "{}")).status).not.toBe(429);
  });

  it("a 300-image chat stays well inside the /attachment bucket; its own bucket, not the job's", async () => {
    // 600 job-route requests (the job bucket full) do not block an image.
    for (let i = 0; i < RCS_RATE_LIMITS.job - 2; i++) await post(port, `/job/${jobId}/progress`, JSON.stringify({ stage: "x" }));
    expect((await post(port, `/job/${jobId}/progress`, JSON.stringify({ stage: "x" }))).status).toBe(429);
    for (let i = 0; i < 300; i++) {
      const r = await post(port, `/job/${jobId}/attachment`, JSON.stringify({ conversationId: CONV, msgId: String(i), index: 0, mimeType: "image/jpeg", base64: "AAAA" }));
      if (r.status !== 200) throw new Error(`image ${i}: ${r.status}`);
    }
    expect(importImage).toHaveBeenCalledTimes(300);
  });

  it("400: a job route's body that does not match its zod schema is refused, and nothing happens", async () => {
    const bad: Array<[string, unknown]> = [
      ["match", { conversationId: CONV, numbers: "555-0199" }],
      ["match", { conversationId: "", numbers: [] }],
      ["chat", { conversationId: CONV, title: "x", messages: "nope" }],
      ["chat", [1, 2, 3]],
      ["attachment", { conversationId: CONV, msgId: "1", index: 100, mimeType: "image/png", base64: "AAAA" }],
      ["attachment", { conversationId: CONV, msgId: "1", index: 0, mimeType: "image/png", base64: 7 }],
      ["progress", { stage: "x", listed: "many" }],
      ["progress", { stage: "x".repeat(1001) }],
      ["finish", { notChecked: -1 }],
      ["finish", { media: "lots" }],
      ["error", { code: 42 }],
    ];
    for (const [action, body] of bad) {
      const r = await post(port, `/job/${jobId}/${action}`, JSON.stringify(body));
      expect([action, JSON.stringify(body).slice(0, 60), r.status, r.body.error]).toEqual([action, JSON.stringify(body).slice(0, 60), 400, "bad_request"]);
    }
    expect(importImage).not.toHaveBeenCalled();
    expect(bridge.getJob()?.state).toBe("running");
  });

  it("extra fields (a newer extension) and null counts still pass", async () => {
    const ok = await post(port, `/job/${jobId}/progress`, JSON.stringify({ stage: "x", listed: null, checked: 3, futureField: { a: 1 } }));
    expect(ok.status).toBe(200);
    expect(parseBridgeBody(RcsBridgeBodySchemas.finish, { notReached: [], notChecked: null, media: { photos: { seen: 2 } }, somethingNew: true })).not.toBeNull();
    expect(parseBridgeBody(RcsHelloBodySchema, { version: "0.3.66", linked: false })).not.toBeNull();
    expect(parseBridgeBody(RcsHelloBodySchema, { version: 3 })).toBeNull();
    expect(parseBridgeBody(RcsLinkBodySchemas["/link/finish"], { sessionId: "s", cA: "c" })).not.toBeNull();
    expect(parseBridgeBody(RcsLinkBodySchemas["/link/start"], { pA: "x".repeat(201) })).toBeNull();
    expect(parseBridgeBody(RcsBridgeBodySchemas.claim, null)).toBeNull();
    expect(parseBridgeBody(RcsBridgeBodySchemas.claim, [])).toBeNull();
  });
});
