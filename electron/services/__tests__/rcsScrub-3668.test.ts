/**
 * @jest-environment node
 */
/**
 * BACKLOG-3668 L3 — RCS error text is scrubbed before it is logged or sent
 * to Sentry.
 *
 * Mutation controls (each turns a test red):
 *   S1 phone redaction removed from scrubRcsText            → "phone numbers"
 *   S2 quoted-text redaction removed                        → "quoted text"
 *   S3 scrubRcsEventPII scrubs every event (or none)        → "only RCS events"
 *   S4 the bridge logs the raw err.message again            → "Request failed"
 *   S5 wrapHandler drops sentryTags / logs the raw message  → "wrapHandler"
 */
import * as http from "http";

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../logService", () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import * as Sentry from "@sentry/electron/main";
import logService from "../logService";
import { scrubRcsText } from "../../utils/redactSensitive";
import { isRcsSentryEvent, RCS_SENTRY_TAGS, scrubRcsEventPII } from "../rcsSentryScrub";
import { RCS_SYNC_OUTCOME_SOURCE } from "../rcsSyncOutcome";
import { scrubUpdaterEventPII } from "../updateDiagnostics";
import { wrapHandler } from "../../utils/wrapHandler";
import { RCS_EXTENSION_ORIGIN, RcsExtensionBridge } from "../rcsExtensionBridge";
import { RcsJobRegistry } from "../rcsImportJob";

describe("scrubRcsText", () => {
  it("phone numbers (any common shape) become <phone>; dates, ports and short counts stay", () => {
    for (const phone of ["+15555550199", "+1 (555) 555-0199", "555-555-0199", "(555) 555 0199", "5555550199"]) {
      const out = scrubRcsText(`chat ${phone} failed`);
      expect([phone, out]).toEqual([phone, "chat <phone> failed"]);
    }
    expect(scrubRcsText("at 2026-10-06T10:00:00.000Z, 42 rows, port 47123")).toBe("at 2026-10-06T10:00:00.000Z, 42 rows, port 47123");
  });

  it("emails, local paths and quoted text (a message's words) are removed", () => {
    const out = scrubRcsText(new Error('Unexpected token, "see you at 5 tomorrow" is not valid JSON; sam@example.com; C:\\Users\\sam\\AppData\\x.db'));
    expect(out).not.toContain("see you");
    expect(out).toContain('"<text>"');
    expect(out).not.toContain("sam@example.com");
    expect(out).not.toContain("Users\\sam");
  });

  it("truncation never leaves part of a number", () => {
    const out = scrubRcsText(`${"x".repeat(15)} +1 555 555 0199`, 20);
    expect(out).not.toMatch(/555/);
  });
});

describe("scrubRcsEventPII: only RCS events", () => {
  const raw = () => ({
    message: "call +1 (555) 555-0199",
    exception: { values: [{ value: 'bad "hello there friend" from sam@example.com' }] },
    breadcrumbs: [{ message: "[RcsCache] +15555550199" }],
    extra: { detail: "+1 555 555 0199", n: 3 },
  });

  it("an event tagged component rcs, or the RCS Sync outcome source, is scrubbed everywhere", () => {
    expect(RCS_SENTRY_TAGS.component).toBe("rcs");
    for (const tags of [{ component: "rcs" }, { source: RCS_SYNC_OUTCOME_SOURCE }]) {
      const e = scrubRcsEventPII({ ...raw(), tags });
      expect(isRcsSentryEvent(e)).toBe(true);
      const text = JSON.stringify(e);
      expect(text).not.toMatch(/555/);
      expect(text).not.toContain("hello there");
      expect(text).not.toContain("sam@example.com");
      expect(e.extra?.n).toBe(3);
    }
  });

  it("any other event is returned untouched (the same object)", () => {
    const other = { ...raw(), tags: { component: "sync" } };
    expect(scrubRcsEventPII(other)).toBe(other);
    const untagged = raw();
    expect(scrubRcsEventPII(untagged)).toBe(untagged);
  });

  it("the auto-updater scrub is unchanged by it (updater events are not RCS events)", () => {
    const updater = { tags: { component: "auto-updater" }, message: "GET https://x/y?X-Amz-Signature=abc failed" };
    const once = scrubUpdaterEventPII(updater);
    expect(scrubRcsEventPII(once)).toBe(once);
  });
});

describe("wrapHandler: RCS options", () => {
  it("tags the Sentry event and logs only the scrubbed text", async () => {
    const h = wrapHandler(async () => { throw new Error("chat +1 (555) 555-0199 failed"); }, {
      module: "RcsImport",
      sentryTags: { ...RCS_SENTRY_TAGS },
      scrubLogText: (e) => scrubRcsText(e),
    });
    await (h as unknown as (event: unknown) => Promise<unknown>)({});
    expect((Sentry.captureException as jest.Mock).mock.calls[0][1]).toEqual({ tags: { component: "rcs" } });
    const logged = JSON.stringify((logService.error as jest.Mock).mock.calls[0]);
    expect(logged).not.toMatch(/555/);
    expect(logged).toContain("<phone>");
  });
});

describe("bridge: a failed request is logged scrubbed", () => {
  it("Request failed: no phone number, no quoted text in the log", async () => {
    const error = jest.fn();
    const bridge = new RcsExtensionBridge({
      importCacheChat: async () => { throw new Error('insert failed for +1 555 555 0199: "running late, call me"'); },
      currentUserId: async () => "user-1",
      jobs: new RcsJobRegistry(),
      logger: { info: jest.fn(), warn: jest.fn(), error },
    });
    try {
      expect(await bridge.start(0)).toBe("listening");
      const port = bridge.getStatus().port;
      const post = (p: string, body: unknown) => new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: p, headers: { "Content-Type": "application/json", Origin: RCS_EXTENSION_ORIGIN } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
      const jobId = bridge.createCacheJob("user-1", { since: "2026-01-01T00:00:00.000Z" })!.jobId;
      expect(await post(`/job/${jobId}/claim`, {})).toBe(200);
      const conv = "aaaaaaaaaaaaaaaaaaa";
      expect(await post(`/job/${jobId}/match`, { conversationId: conv, numbers: ["(555) 555-0199"] })).toBe(200);
      const status = await post(`/job/${jobId}/chat`, {
        conversationId: conv, title: "x", participants: [],
        messages: [{ msgId: "1", direction: "inbound", sender: "x", text: "hi", sentAt: "2026-02-01T10:00:00.000Z" }],
      });
      expect(status).toBe(500);
      const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("[RcsBridge] Request failed");
      expect(logged).not.toMatch(/555/);
      expect(logged).not.toContain("running late");
    } finally {
      await bridge.stop();
    }
  });
});
