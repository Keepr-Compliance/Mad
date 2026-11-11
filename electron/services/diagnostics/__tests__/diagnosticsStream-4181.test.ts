/** @jest-environment node */
/**
 * BACKLOG-4181: the diagnostics health stream, end to end, with a REAL Sentry
 * client and the REAL Keepr modules.
 *
 *   - @sentry/node 10.62 client (the SDK @sentry/electron 7.15 builds on), with
 *     `enableLogs` and the shipped `diagnosticsBeforeSendLog`;
 *   - the shipped transport composition (`composeDiagnosticsTransport`) around
 *     the real core `makeOfflineTransport` and the real crash-reporting gate;
 *   - an offline store that hands back `parseEnvelope(raw)` on shift, exactly as
 *     the sealed queue does (atRest/sentrySealedQueue.ts `shift`);
 *   - the real preference module on a temp userData directory;
 *   - the real route producers (wrapHandleForReplySize, createMainLagMonitor,
 *     WindowResponsivenessTracker), which call the real perf helper.
 *
 * @sentry/electron/main cannot load under jest, so the attributes its own
 * `beforeCaptureLog` hook adds to every main log are TRANSCRIBED below from
 * @sentry/electron 7.15 main/sdk.js:108-114 and main/log.js:4-28 (the keys;
 * the values are a fixture).
 */
import fs from "fs";
import os from "os";
import path from "path";
import * as Sentry from "@sentry/node";
import * as core from "@sentry/core";
import { composeDiagnosticsTransport, diagnosticsBeforeSendLog } from "../diagnosticsLogTransport";
import { configureDiagnostics, __resetDiagnosticsForTests } from "../perf";
import * as perf from "../perf";
import {
  getDiagnosticsDeviceId,
  loadDiagnosticsSharingPreference,
  setDiagnosticsSharingEnabled,
  __resetDiagnosticsSharingPreferenceForTests,
} from "../../diagnosticsSharingPreference";
import {
  gateBaseTransport,
  loadCrashReportingPreference,
  setCrashReportingEnabled,
  __resetCrashReportingPreferenceForTests,
} from "../../crashReportingPreference";
import { wrapHandleForReplySize, type HandleTarget } from "../../ipcReplySize";
import { createMainLagMonitor } from "../../mainLagMonitor";
import { WindowResponsivenessTracker } from "../../windowResponsivenessTracker";

const APP_VERSION = "2.47.0";
const OS_VALUE = `${process.platform}-${os.release()}`;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4181-stream-"));

// ---- network + offline queue (no real network) ----
const sent: string[] = [];
let online = true;
const queue: string[] = [];
const store = (): core.OfflineStore => ({
  push: async (e) => void queue.push(core.serializeEnvelope(e) as string),
  unshift: async (e) => void queue.unshift(core.serializeEnvelope(e) as string),
  shift: async () => {
    const raw = queue.shift();
    return raw === undefined ? undefined : core.parseEnvelope(raw);
  },
});
function makeNetwork(options: core.BaseTransportOptions): core.Transport {
  return core.createTransport(options, async (req) => {
    if (!online) throw new Error("offline");
    sent.push(typeof req.body === "string" ? req.body : Buffer.from(req.body as Uint8Array).toString("utf8"));
    return { statusCode: 200 };
  });
}

beforeAll(() => {
  loadCrashReportingPreference(userData);
  loadDiagnosticsSharingPreference(userData);
  Sentry.init({
    dsn: "https://public@o0.ingest.sentry.io/0",
    release: APP_VERSION,
    environment: "production",
    defaultIntegrations: false,
    skipOpenTelemetrySetup: true,
    enableLogs: true,
    beforeSendLog: diagnosticsBeforeSendLog,
    transport: composeDiagnosticsTransport(
      core.makeOfflineTransport as unknown as (b: (o: core.BaseTransportOptions) => core.Transport) => (o: core.BaseTransportOptions) => core.Transport,
      gateBaseTransport,
      makeNetwork,
    ),
    transportOptions: { createStore: store },
  } as Parameters<typeof Sentry.init>[0]);
  const client = Sentry.getClient()!;
  client.on("beforeCaptureLog", (log) => {
    log.attributes = {
      ...log.attributes,
      "electron.process": "browser",
      "os.name": "macOS",
      "os.version": "15.6",
      "device.brand": "Apple",
      "device.model": "Mac16,1",
      "device.family": "Mac",
    };
  });
  // Same sink as installSentry.
  configureDiagnostics({
    sink: (level, body, attributes) => Sentry.logger[level](body, attributes),
    appVersion: APP_VERSION,
    os: OS_VALUE,
  });
  Sentry.setUser({ id: "user-0000" });
});

afterAll(async () => {
  await Sentry.close(1000);
  __resetDiagnosticsForTests();
  __resetDiagnosticsSharingPreferenceForTests();
  __resetCrashReportingPreferenceForTests();
  fs.rmSync(userData, { recursive: true, force: true });
});

afterEach(() => {
  // Every test leaves both switches ON and the network up.
  online = true;
  setCrashReportingEnabled(true);
  setDiagnosticsSharingEnabled(true);
});

async function drain(): Promise<string> {
  await Sentry.flush(2000);
  const s = sent.join("\n");
  sent.length = 0;
  return s;
}
async function replay(): Promise<string> {
  await Sentry.getClient()!.getTransport()!.flush();
  await new Promise((r) => setTimeout(r, 400));
  const s = sent.join("\n");
  sent.length = 0;
  return s;
}
type Attr = { value: unknown; type?: string };
type Log = { body: string; attributes: Record<string, Attr> };
function logItems(s: string): Log[] {
  const out: Log[] = [];
  for (const line of s.split("\n").filter(Boolean)) {
    try {
      const j = JSON.parse(line) as { items?: Log[] };
      if (Array.isArray(j.items)) out.push(...j.items);
    } catch {
      // not JSON
    }
  }
  return out;
}
const one = async (op: string): Promise<Log> => {
  const logs = logItems(await drain()).filter((l) => l.body === op);
  expect(logs).toHaveLength(1);
  return logs[0];
};
const PII = /jane@example\.com|555[-) ]\s?555|token=abc|user-0000/;
const BASE = [
  "keepr.diag",
  "keepr.op",
  "keepr.os",
  "keepr.appVersion",
  "keepr.deviceId",
  "sentry.release",
  "sentry.environment",
  "sentry.timestamp.sequence",
];

describe("C1 exact key set + body (W1 forward message, W3 beforeSendLog-only, W5 denylist)", () => {
  it("the helper log's key set EQUALS the allowlist, body is the op, and nothing else leaves", async () => {
    Sentry.getCurrentScope().setAttributes({ "scope.note": "jane@example.com" });
    Sentry.getIsolationScope().setAttributes({ "iso.note": "jane@example.com" });
    try {
      perf.track("ipc.slow", 1200, { channel: "transactions:batchUpdateContacts", approxBytes: 2048 });
      // forged: marked, with free text in the message
      Sentry.logger.warn("sync for jane@example.com at +1 (555) 555-0199 failed", {
        "keepr.diag": true,
        "keepr.op": "ipc.slow",
        "keepr.deviceId": getDiagnosticsDeviceId(),
      });
      // SDK-integration shaped, unmarked
      Sentry.logger.info("Electron.net request failed: GET https://x.example/?token=abc");
      // renderer-shaped serialized log, straight into the buffer (@sentry/electron main/ipc.js:164-166)
      core._INTERNAL_captureSerializedLog(Sentry.getClient()!, {
        timestamp: Date.now() / 1000,
        level: "warn",
        body: "renderer jane@example.com",
        trace_id: "0".repeat(32),
        severity_number: 13,
        attributes: {
          "electron.process": { value: "renderer", type: "string" },
          "keepr.diag": { value: true, type: "boolean" },
          "keepr.op": { value: "ipc.slow", type: "string" },
          "keepr.deviceId": { value: getDiagnosticsDeviceId(), type: "string" },
          "keepr.channel": { value: "jane@example.com", type: "string" },
        },
      } as Parameters<typeof core._INTERNAL_captureSerializedLog>[1]);
    } finally {
      Sentry.getCurrentScope().setAttributes({ "scope.note": undefined });
      Sentry.getIsolationScope().setAttributes({ "iso.note": undefined });
    }
    const s = await drain();
    const logs = logItems(s);
    expect(logs.length).toBeGreaterThan(0);
    expect(s).not.toMatch(PII);
    expect(s).not.toContain("Mac16,1");
    const helper = logs.filter((l) => l.attributes["keepr.channel"]?.value === "transactions:batchUpdateContacts");
    expect(helper).toHaveLength(1);
    expect(new Set(Object.keys(helper[0].attributes))).toEqual(
      new Set([...BASE, "keepr.durationMs", "keepr.channel", "keepr.approxBytes"]),
    );
    for (const l of logs) {
      expect(l.body).toBe(l.attributes["keepr.op"].value);
      // BACKLOG-4181 SR: no trace id leaves the app (it could join a crash event).
      expect(l).not.toHaveProperty("trace_id");
      for (const k of Object.keys(l.attributes)) {
        expect([...BASE, "keepr.durationMs", "keepr.channel", "keepr.approxBytes", "keepr.threw"]).toContain(k);
      }
    }
  });
});

describe("C2 the switch is read LIVE (W2 boot read, W3, W4)", () => {
  it("C2a OFF before capture: nothing sent", async () => {
    setDiagnosticsSharingEnabled(false);
    perf.track("main.lag", 1500, { inFlightCount: 0 });
    expect(await drain()).not.toContain("main.lag");
  });

  it("C2b captured while ON, OFF before flush: nothing sent", async () => {
    perf.track("main.lag", 1600, { inFlightCount: 0 });
    setDiagnosticsSharingEnabled(false);
    expect(await drain()).not.toContain("main.lag");
  });

  it("C2c queued offline while ON, replayed after OFF: nothing sent", async () => {
    online = false;
    perf.track("window.unresponsive", 7000, { endedBy: "responsive" });
    await Sentry.flush(2000);
    expect(queue.length).toBeGreaterThan(0); // positive control: it really queued
    setDiagnosticsSharingEnabled(false);
    online = true;
    const s = await replay();
    expect(queue.length).toBe(0); // positive control: the replay ran
    expect(s).not.toContain("window.unresponsive");
  });

  it("C2d positive control: a replay while ON does send", async () => {
    online = false;
    perf.track("window.unresponsive", 7100, { endedBy: "quit" });
    await Sentry.flush(2000);
    expect(queue.length).toBeGreaterThan(0);
    online = true;
    expect(await replay()).toContain("window.unresponsive");
  });
});

describe("v2.1 C: device id at send time", () => {
  it("logs queued under the old id are not sent after OFF then ON", async () => {
    const idA = getDiagnosticsDeviceId();
    online = false;
    perf.track("window.unresponsive", 7200, { endedBy: "closed" });
    await Sentry.flush(2000);
    expect(queue.length).toBeGreaterThan(0);
    setDiagnosticsSharingEnabled(false);
    setDiagnosticsSharingEnabled(true);
    expect(getDiagnosticsDeviceId()).not.toBe(idA);
    online = true;
    const s = await replay();
    expect(queue.length).toBe(0);
    expect(s).not.toContain("window.unresponsive");
  });
});

describe("v2.1 note 7: the offline queue only stores filtered logs", () => {
  it("a failed send queues no free text, no unmarked log, no SDK device attributes", async () => {
    online = false;
    Sentry.getCurrentScope().setAttributes({ "scope.note": "jane@example.com" });
    try {
      perf.track("ipc.slow", 1300, { channel: "contacts:get-all", approxBytes: 10 });
      Sentry.logger.info("Electron.net request failed: GET https://x.example/?token=abc");
    } finally {
      Sentry.getCurrentScope().setAttributes({ "scope.note": undefined });
    }
    await Sentry.flush(2000);
    const queued = queue.join("\n");
    expect(queued).toContain("ipc.slow"); // positive control: it queued
    expect(queued).not.toMatch(PII);
    expect(queued).not.toContain("Mac16,1");
    expect(queued).not.toContain("electron.process");
    online = true;
    await replay();
    expect(queue.length).toBe(0);
  });
});

describe("C8 crash reports OFF + diagnostics ON: no log envelope sent", () => {
  it("the crash switch still bounds every log", async () => {
    setCrashReportingEnabled(false);
    perf.track("ipc.slow", 1400, { channel: "contacts:get-all", approxBytes: 1 });
    expect(await drain()).not.toContain("ipc.slow");
  });
});

describe("C9 per-route fields ARRIVE, from the real producers", () => {
  function slowHandler(durationMs: number, impl: () => Promise<unknown>): Promise<unknown> {
    const reg = new Map<string, (e: unknown) => Promise<unknown>>();
    let c = 0;
    const target: HandleTarget = { handle: (ch, l) => void reg.set(ch, l as (e: unknown) => Promise<unknown>) };
    wrapHandleForReplySize(target, { phase: () => null, now: () => (c++ % 2 === 0 ? 0 : durationMs), log: () => {} });
    target.handle("transactions:batchUpdateContacts", impl);
    return reg.get("transactions:batchUpdateContacts")!({});
  }

  it("ipc.slow success path: channel, durationMs, approxBytes, base fields", async () => {
    await slowHandler(1000, async () => ({ ok: true }));
    const l = await one("ipc.slow");
    expect(l.attributes["keepr.channel"].value).toBe("transactions:batchUpdateContacts");
    expect(l.attributes["keepr.durationMs"].value).toBe(1000);
    expect(typeof l.attributes["keepr.approxBytes"].value).toBe("number");
    expect(l.attributes["keepr.threw"]).toBeUndefined();
    expect(l.attributes["keepr.os"].value).toBe(OS_VALUE);
    expect(l.attributes["keepr.appVersion"].value).toBe(APP_VERSION);
    expect(l.attributes["keepr.deviceId"].value).toBe(getDiagnosticsDeviceId());
  });

  it("ipc.slow throw path: threw arrives", async () => {
    await expect(slowHandler(1500, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    const l = await one("ipc.slow");
    expect(l.attributes["keepr.threw"]?.value).toBe(true);
    expect(l.attributes["keepr.channel"].value).toBe("transactions:batchUpdateContacts");
    expect(l.attributes["keepr.approxBytes"]).toBeUndefined();
  });

  it("main.lag: sinceLastIpc, lastIpcAgoMs, inFlight, inFlightCount, syncPhase, suppressed", async () => {
    let t = 0;
    const m = createMainLagMonitor({
      now: () => t,
      log: () => {},
      context: () => ({
        lastChannel: "contacts:get-all",
        lastStartedAt: 0,
        inFlight: ["transactions:batchUpdateContacts", "contacts:get-allx2"],
        syncPhase: "storing:messages",
      }),
    });
    m.tick();
    t = 1300;
    m.tick(); // logged
    t = 2600;
    m.tick(); // inside the 5 s gap: suppressed
    t = 8000;
    m.tick(); // logged, suppressed=1
    const logs = logItems(await drain()).filter((x) => x.body === "main.lag");
    expect(logs).toHaveLength(2);
    const [first, second] = logs;
    expect(first.attributes["keepr.sinceLastIpc"]?.value).toBe("contacts:get-all");
    expect(first.attributes["keepr.lastIpcAgoMs"]?.value).toBe(1300);
    expect(first.attributes["keepr.inFlight"]?.value).toBe("transactions:batchUpdateContacts,contacts:get-allx2");
    expect(first.attributes["keepr.inFlightCount"]?.value).toBe(2);
    expect(first.attributes["keepr.inFlightTruncated"]).toBeUndefined();
    expect(first.attributes["keepr.syncPhase"]?.value).toBe("storing:messages");
    expect(first.attributes["keepr.suppressed"]).toBeUndefined();
    expect(second.attributes["keepr.suppressed"]?.value).toBe(1);
  });

  it.each([
    [0, undefined, 0, false],
    [1, "LONG", 1, false],
    [5, "CAPPED", 5, true],
  ])("main.lag inFlight sweep: %i names at 33+ chars", async (n, expectValue, count, truncated) => {
    // 33 chars: the longest registered ipcMain.handle channel at the build base.
    const name = (i: number) => `auth:microsoft:disconnect-mailbo${i}x2`;
    const names = Array.from({ length: n }, (_, i) => name(i));
    let t = 0;
    const m = createMainLagMonitor({
      now: () => t,
      log: () => {},
      context: () => ({ lastChannel: null, lastStartedAt: 0, inFlight: names, syncPhase: null }),
    });
    m.tick();
    t = 1300;
    m.tick();
    const l = await one("main.lag");
    expect(l.attributes["keepr.inFlightCount"]?.value).toBe(count);
    const v = l.attributes["keepr.inFlight"]?.value as string | undefined;
    if (expectValue === undefined) expect(v).toBeUndefined();
    else {
      expect(typeof v).toBe("string");
      expect(v!.length).toBeLessThanOrEqual(120);
      expect(v!.startsWith(name(0))).toBe(true);
      // whole names only
      for (const part of v!.split(",")) expect(names).toContain(part);
    }
    expect(l.attributes["keepr.inFlightTruncated"]?.value).toBe(truncated ? true : undefined);
  });

  it("window.unresponsive: endedBy + syncPhase; window.unresponsive.start: syncPhase", async () => {
    let t = 0;
    const w = new WindowResponsivenessTracker({ now: () => t, log: () => {}, capture: () => {}, getPhase: () => "post-sync" });
    w.onUnresponsive();
    w.onUnresponsive(); // Electron repeats it: one start event only
    t = 6000;
    w.flush("quit");
    const logs = logItems(await drain());
    const start = logs.filter((x) => x.body === "window.unresponsive.start");
    expect(start).toHaveLength(1);
    expect(start[0].attributes["keepr.syncPhase"]?.value).toBe("post-sync");
    const end = logs.filter((x) => x.body === "window.unresponsive");
    expect(end).toHaveLength(1);
    expect(end[0].attributes["keepr.endedBy"]?.value).toBe("quit");
    expect(end[0].attributes["keepr.syncPhase"]?.value).toBe("post-sync");
    expect(end[0].attributes["keepr.durationMs"]?.value).toBe(6000);
  });
});

describe("C6 boundary sweep 999 / 1000 / 1001 ms", () => {
  it.each([
    [999, false],
    [1000, true],
    [1001, true],
  ])("ipc.slow at %i ms sends: %s", async (ms, sends) => {
    const reg = new Map<string, (e: unknown) => Promise<unknown>>();
    let c = 0;
    const target: HandleTarget = { handle: (ch, l) => void reg.set(ch, l as (e: unknown) => Promise<unknown>) };
    wrapHandleForReplySize(target, { phase: () => null, now: () => (c++ % 2 === 0 ? 0 : ms), log: () => {} });
    target.handle("contacts:get-all", async () => 1);
    await reg.get("contacts:get-all")!({});
    expect(logItems(await drain()).filter((l) => l.body === "ipc.slow")).toHaveLength(sends ? 1 : 0);
  });

  it.each([
    [999, false],
    [1000, true],
    [1001, true],
  ])("main.lag at %i ms lateness sends: %s", async (ms, sends) => {
    let t = 0;
    const m = createMainLagMonitor({
      now: () => t,
      log: () => {},
      context: () => ({ lastChannel: null, lastStartedAt: 0, inFlight: [], syncPhase: null }),
    });
    m.tick();
    t = 100 + ms; // gap = interval + lateness
    m.tick();
    expect(logItems(await drain()).filter((l) => l.body === "main.lag")).toHaveLength(sends ? 1 : 0);
  });

  it.each([
    [999, false],
    [1000, true],
    [1001, true],
  ])("window.unresponsive at %i ms sends: %s", async (ms, sends) => {
    let t = 0;
    const w = new WindowResponsivenessTracker({ now: () => t, log: () => {}, capture: () => {} });
    w.onUnresponsive();
    t = ms;
    w.onResponsive();
    expect(logItems(await drain()).filter((l) => l.body === "window.unresponsive")).toHaveLength(sends ? 1 : 0);
  });
});

describe("C10 the device id is never on the scope", () => {
  it("a crash event after a diagnostics send carries no device id", async () => {
    perf.track("ipc.slow", 1100, { channel: "contacts:get-all", approxBytes: 1 });
    Sentry.captureException(new Error("boom"));
    const s = await drain();
    expect(s).toContain(getDiagnosticsDeviceId()); // positive control: the log carried it
    const events = s.split("\n").filter((x) => x.includes('"exception"'));
    expect(events.length).toBeGreaterThan(0); // positive control: the event exists
    for (const e of events) expect(e).not.toContain(getDiagnosticsDeviceId());
  });
});
