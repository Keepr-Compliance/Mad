/** @jest-environment node */
/**
 * BACKLOG-4181: unit controls for the preference, the field list, the perf
 * helper and the transport filter. Each layer of the gate is tested on its own
 * here, because end to end (diagnosticsStream-4181.test.ts) the layers back
 * each other up and one missing check can stay green there.
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  DIAGNOSTICS_SHARING_DEFAULT,
  DIAGNOSTICS_SHARING_FILE_NAME,
  getDiagnosticsDeviceId,
  isDiagnosticsSharingEnabled,
  loadDiagnosticsSharingPreference,
  setDiagnosticsSharingEnabled,
  __resetDiagnosticsSharingPreferenceForTests,
} from "../../diagnosticsSharingPreference";
import { DIAG_BASE_FORMATS, DIAG_OP, DIAG_ROUTE_KEYS, DIAG_STRING_FIELDS, joinWholeNames } from "../fields";
import * as perf from "../perf";
import * as prefModule from "../../diagnosticsSharingPreference";
import { diagnosticsBeforeSendLog, filterDiagnosticLogs, filterEnvelopeLogs } from "../diagnosticsLogTransport";

const UUID_V4 = DIAG_BASE_FORMATS["keepr.deviceId"];
const tmp: string[] = [];
function dir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4181-u-"));
  tmp.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  __resetDiagnosticsSharingPreferenceForTests();
  perf.__resetDiagnosticsForTests();
});

describe("C7 preference + random device id", () => {
  it("missing file reads as DIAGNOSTICS_SHARING_DEFAULT and creates a v4 id that survives a reload", () => {
    const d = dir();
    expect(loadDiagnosticsSharingPreference(d)).toBe(DIAGNOSTICS_SHARING_DEFAULT);
    const id = getDiagnosticsDeviceId();
    expect(id).toMatch(UUID_V4);
    __resetDiagnosticsSharingPreferenceForTests(); // the restart
    loadDiagnosticsSharingPreference(d);
    expect(getDiagnosticsDeviceId()).toBe(id);
  });

  it("bad JSON / non-boolean enabled read as the default constant", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, DIAGNOSTICS_SHARING_FILE_NAME), "{not json");
    expect(loadDiagnosticsSharingPreference(d)).toBe(DIAGNOSTICS_SHARING_DEFAULT);
    fs.writeFileSync(path.join(d, DIAGNOSTICS_SHARING_FILE_NAME), JSON.stringify({ enabled: "no" }));
    expect(loadDiagnosticsSharingPreference(d)).toBe(DIAGNOSTICS_SHARING_DEFAULT);
  });

  it("a saved OFF is read; an invalid saved id is replaced with a v4 id", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, DIAGNOSTICS_SHARING_FILE_NAME), JSON.stringify({ enabled: false, deviceId: "not-a-uuid" }));
    expect(loadDiagnosticsSharingPreference(d)).toBe(false);
    expect(isDiagnosticsSharingEnabled()).toBe(false);
    expect(getDiagnosticsDeviceId()).toMatch(UUID_V4);
  });

  it("turning OFF regenerates the id; turning ON keeps it; both are saved", () => {
    const d = dir();
    loadDiagnosticsSharingPreference(d);
    const a = getDiagnosticsDeviceId();
    setDiagnosticsSharingEnabled(false);
    const b = getDiagnosticsDeviceId();
    expect(b).not.toBe(a);
    expect(b).toMatch(UUID_V4);
    setDiagnosticsSharingEnabled(true);
    expect(getDiagnosticsDeviceId()).toBe(b);
    expect(JSON.parse(fs.readFileSync(path.join(d, DIAGNOSTICS_SHARING_FILE_NAME), "utf8"))).toEqual({ enabled: true, deviceId: b });
  });

  it("a write failure still turns sharing off live, and throws", () => {
    const d = dir();
    loadDiagnosticsSharingPreference(d);
    const spy = jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      expect(() => setDiagnosticsSharingEnabled(false)).toThrow("disk full");
      expect(isDiagnosticsSharingEnabled()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("fields", () => {
  it("every op matches the op format, and every string field has a format", () => {
    for (const op of Object.keys(DIAG_ROUTE_KEYS)) expect(op).toMatch(DIAG_OP);
    for (const fmt of Object.values(DIAG_STRING_FIELDS)) expect(fmt).toBeInstanceOf(RegExp);
  });

  it.each([
    [[], null, false],
    [["a"], "a", false],
    [["a".repeat(60), "b".repeat(59)], `${"a".repeat(60)},${"b".repeat(59)}`, false],
    [["a".repeat(60), "b".repeat(60)], "a".repeat(60), true],
    [["a".repeat(121)], null, true],
  ])("joinWholeNames(%j) keeps whole names within 120 chars", (names, value, truncated) => {
    expect(joinWholeNames(names as string[])).toEqual({ value, truncated });
  });
});

describe("C5 perf helper", () => {
  const calls: Array<[string, string, Record<string, unknown>]> = [];
  const configure = (now?: () => number) =>
    perf.configureDiagnostics({ sink: (l, b, a) => void calls.push([l, b, a]), appVersion: "2.47.0", os: "darwin-24.6.0", now });
  beforeEach(() => {
    calls.length = 0;
    loadDiagnosticsSharingPreference(dir());
  });

  it("no sink configured: a no-op", () => {
    perf.track("ipc.slow", 1000, { channel: "contacts:get-all" });
    expect(calls).toHaveLength(0);
  });

  it("body is the op and the attributes are exactly base + passed route fields", () => {
    configure();
    perf.track("ipc.slow", 1000.4, { channel: "contacts:get-all", approxBytes: 5 });
    expect(calls).toHaveLength(1);
    const [level, body, attrs] = calls[0];
    expect(level).toBe("warn");
    expect(body).toBe("ipc.slow");
    expect(attrs).toEqual({
      "keepr.diag": true,
      "keepr.op": "ipc.slow",
      "keepr.os": "darwin-24.6.0",
      "keepr.appVersion": "2.47.0",
      "keepr.deviceId": getDiagnosticsDeviceId(),
      "keepr.durationMs": 1000,
      "keepr.channel": "contacts:get-all",
      "keepr.approxBytes": 5,
    });
  });

  it("an unknown op never reaches the sink", () => {
    configure();
    perf.track("jane@example.com" as never, 1000);
    perf.event("contacts.notARoute" as never);
    expect(calls).toHaveLength(0);
    expect(perf.getDroppedDiagnosticsCount()).toBe(2);
  });

  it("a string field that fails its format is dropped; a field not in the route is dropped", () => {
    configure();
    perf.track("ipc.slow", 1000, { channel: "jane@example.com" });
    perf.track("main.lag", 1000, { syncPhase: "storing messages for Jane" });
    perf.track("ipc.slow", 1000, { endedBy: "quit" } as never);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls)).not.toContain("jane@");
    expect(JSON.stringify(calls)).not.toContain("Jane");
    expect(calls[2][2]["keepr.endedBy"]).toBeUndefined();
    expect(perf.getDroppedDiagnosticsCount()).toBe(3);
  });

  it("non-finite numbers and objects are dropped", () => {
    configure();
    perf.track("main.lag", 1000, { inFlightCount: Number.NaN, lastIpcAgoMs: { x: 1 } as never });
    expect(calls[0][2]["keepr.inFlightCount"]).toBeUndefined();
    expect(calls[0][2]["keepr.lastIpcAgoMs"]).toBeUndefined();
    perf.track("main.lag", Number.POSITIVE_INFINITY);
    expect(calls).toHaveLength(1);
  });

  it("OFF: nothing reaches the sink", () => {
    configure();
    setDiagnosticsSharingEnabled(false);
    perf.track("ipc.slow", 1000, { channel: "contacts:get-all" });
    perf.event("window.unresponsive.start", {});
    expect(calls).toHaveLength(0);
  });

  it("rate cap: 60 per op per minute, then the next minute sends again", () => {
    let t = 0;
    configure(() => t);
    for (let i = 0; i < 70; i += 1) perf.track("ipc.slow", 1000);
    perf.event("window.unresponsive.start");
    expect(calls.filter((c) => c[1] === "ipc.slow")).toHaveLength(perf.DIAG_RATE_CAP_PER_MINUTE);
    expect(calls.filter((c) => c[1] === "window.unresponsive.start")).toHaveLength(1);
    t = 60_000;
    perf.track("ipc.slow", 1000);
    expect(calls.filter((c) => c[1] === "ipc.slow")).toHaveLength(perf.DIAG_RATE_CAP_PER_MINUTE + 1);
  });

  it("a throwing sink never throws into the caller", () => {
    perf.configureDiagnostics({ sink: () => { throw new Error("x"); }, appVersion: "2.47.0", os: "darwin-24.6.0" });
    expect(() => perf.track("ipc.slow", 1000)).not.toThrow();
  });
});

describe("transport filter, each check on its own", () => {
  type Env = [Record<string, unknown>, Array<[Record<string, unknown>, unknown]>];
  const attr = (value: unknown) => ({ value, type: typeof value === "string" ? "string" : typeof value === "boolean" ? "boolean" : "integer" });
  function diagLog(extra: Record<string, unknown> = {}, deviceId = getDiagnosticsDeviceId()) {
    const attrs: Record<string, unknown> = {
      "keepr.diag": true,
      "keepr.op": "ipc.slow",
      "keepr.os": "darwin-24.6.0",
      "keepr.appVersion": "2.47.0",
      "keepr.deviceId": deviceId,
      "keepr.durationMs": 1000,
      "keepr.channel": "contacts:get-all",
      "sentry.release": "2.47.0",
      "sentry.environment": "production",
      "sentry.timestamp.sequence": 0,
      "user.id": "user-0000",
      "device.model": "Mac16,1",
      "sentry.message.template": "x %s",
      "scope.note": "jane@example.com",
      ...extra,
    };
    return {
      timestamp: 1,
      level: "warn",
      body: "free text jane@example.com",
      trace_id: "0".repeat(32),
      severity_number: 13,
      span_id: "abc",
      attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, attr(v)])),
    };
  }
  const envOf = (...logs: unknown[]): Env => [{ sent_at: "x" }, [[{ type: "log", item_count: logs.length }, { items: logs }]]];
  const keysOf = (env: Env | null) => {
    const items = (env![1][0][1] as { items: Array<{ attributes: Record<string, unknown> }> }).items;
    return items.map((l) => Object.keys(l.attributes).sort());
  };

  beforeEach(() => {
    loadDiagnosticsSharingPreference(dir());
  });

  it("ON, marked, current id: rebuilt to exactly the allowed keys, body = op, no extra top-level fields", () => {
    const out = filterEnvelopeLogs(envOf(diagLog()));
    expect(keysOf(out)).toEqual([
      [
        "keepr.appVersion",
        "keepr.channel",
        "keepr.deviceId",
        "keepr.diag",
        "keepr.durationMs",
        "keepr.op",
        "keepr.os",
        "sentry.environment",
        "sentry.release",
        "sentry.timestamp.sequence",
      ],
    ]);
    const log = (out![1][0][1] as { items: Array<Record<string, unknown>> }).items[0];
    expect(log.body).toBe("ipc.slow");
    expect(Object.keys(log).sort()).toEqual(["attributes", "body", "level", "severity_number", "timestamp", "trace_id"]);
    expect(out![1][0][0].item_count).toBe(1);
  });

  it("trace_id is a fresh random 32-hex per log: never the incoming value, never shared (BACKLOG-4181)", () => {
    const out = filterEnvelopeLogs(envOf(diagLog(), diagLog()));
    const logs = (out![1][0][1] as { items: Array<{ trace_id?: unknown }> }).items;
    expect(logs).toHaveLength(2);
    for (const l of logs) {
      expect(l.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(l.trace_id).not.toBe("0".repeat(32)); // the incoming (SDK-stamped) value
    }
    expect(logs[0].trace_id).not.toBe(logs[1].trace_id);
  });

  it("OFF: every log item is dropped (live switch on its own)", () => {
    const env = envOf(diagLog());
    setDiagnosticsSharingEnabled(false);
    // Same id as the log carries, so only the switch can drop it.
    const sameId = (env[1][0][1] as { items: Array<{ attributes: Record<string, { value: unknown }> }> }).items[0];
    sameId.attributes["keepr.deviceId"].value = getDiagnosticsDeviceId();
    expect(filterEnvelopeLogs(env)).toBeNull();
  });

  it("OFF: the device id is never resolved (consent gate does not read it)", () => {
    setDiagnosticsSharingEnabled(false);
    const env = envOf(diagLog()); // stamped with the current id, built before the spy
    const spy = jest.spyOn(prefModule, "getDiagnosticsDeviceId");
    try {
      expect(filterEnvelopeLogs(env)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      // positive control: ON does read it (and then sends the log)
      setDiagnosticsSharingEnabled(true);
      expect(spy).not.toHaveBeenCalled();
      expect(filterEnvelopeLogs(env)).not.toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("ON, another device id: dropped (device-id check on its own)", () => {
    expect(filterEnvelopeLogs(envOf(diagLog({}, ["00000000", "0000", "4000", "8000", "000000000000"].join("-"))))).toBeNull();
  });

  it("unmarked or unknown-op logs are dropped", () => {
    expect(filterEnvelopeLogs(envOf(diagLog({ "keepr.diag": false })))).toBeNull();
    expect(filterEnvelopeLogs(envOf(diagLog({ "keepr.op": "jane@example.com" })))).toBeNull();
  });

  it("a value that fails its format is dropped from the log", () => {
    const out = filterEnvelopeLogs(envOf(diagLog({ "keepr.channel": "jane@example.com", "keepr.os": "darwin 24.6.0" })));
    expect(JSON.stringify(out)).not.toContain("jane@");
    expect(keysOf(out)[0]).not.toContain("keepr.channel");
    expect(keysOf(out)[0]).not.toContain("keepr.os");
  });

  it("non-log items pass through untouched; the envelope handed in is not mutated", () => {
    const event: [Record<string, unknown>, unknown] = [{ type: "event" }, { message: "boom" }];
    const env: Env = [{ sent_at: "x" }, [event, [{ type: "log", item_count: 1 }, { items: [diagLog({ "keepr.diag": false })] }]]];
    const before = JSON.stringify(env);
    const out = filterEnvelopeLogs(env);
    expect(JSON.stringify(env)).toBe(before);
    expect(out![1]).toEqual([event]);
  });

  it("an envelope left empty answers 200 without calling the next layer", async () => {
    const send = jest.fn(async (_envelope: unknown) => ({ statusCode: 200 }));
    const t = filterDiagnosticLogs(() => ({ send, flush: async () => true }))({});
    await expect(t.send(envOf(diagLog({ "keepr.diag": false })) as never)).resolves.toEqual({ statusCode: 200 });
    expect(send).not.toHaveBeenCalled();
    await t.send(envOf(diagLog()) as never);
    expect(send).toHaveBeenCalledTimes(1);
    expect(typeof t.flush).toBe("function");
  });

  it("beforeSendLog first pass: only marked logs while ON", () => {
    expect(diagnosticsBeforeSendLog({ attributes: { "keepr.diag": true } })).not.toBeNull();
    expect(diagnosticsBeforeSendLog({ attributes: {} })).toBeNull();
    setDiagnosticsSharingEnabled(false);
    expect(diagnosticsBeforeSendLog({ attributes: { "keepr.diag": true } })).toBeNull();
  });
});

describe("static checks: device id never on scope, never the hardware id (C7, C10)", () => {
  const root = path.resolve(__dirname, "../../../..");
  // BACKLOG-4185: the device-profile collector and EVERY file in
  // electron/services/deviceProfile/ (a directory listing, not a name list).
  const profileDir = path.join(root, "electron/services/deviceProfile");
  const profileFiles = fs
    .readdirSync(profileDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(profileDir, f));
  const files = [
    ...fs
      .readdirSync(path.join(root, "electron/services/diagnostics"))
      .filter((f) => /^(perf|fields|diagnosticsLogTransport|deviceProfileCollector)\.ts$/.test(f))
      .map((f) => path.join(root, "electron/services/diagnostics", f)),
    path.join(root, "electron/services/diagnosticsSharingPreference.ts"),
    ...profileFiles,
  ];
  const SCOPE_CALL = /\b(setTag|setTags|setUser|setContext|setAttribute|setAttributes|setExtra|setExtras)\s*\(/;
  const DEVICE_SERVICE = /from\s+["'][^"']*deviceService["']|require\(\s*["'][^"']*deviceService["']\s*\)|machineIdSync|node-machine-id/;
  const SYNC_CHILD = /\b(execSync|execFileSync|spawnSync)\b/;

  it("scans the five diagnostics files plus every deviceProfile file (positive control: the list is complete)", () => {
    expect(profileFiles.length).toBeGreaterThanOrEqual(3);
    expect(files).toHaveLength(5 + profileFiles.length);
    for (const f of files) expect(fs.existsSync(f)).toBe(true);
  });

  it("the patterns match the shapes they forbid (positive control)", () => {
    expect(SCOPE_CALL.test('Sentry.getCurrentScope().setTag("keepr.deviceId", id)')).toBe(true);
    expect(DEVICE_SERVICE.test('import { getDeviceId } from "../services/deviceService";')).toBe(true);
    expect(SYNC_CHILD.test('const out = execSync("ioreg -rd1");')).toBe(true);
    expect(SYNC_CHILD.test('execFile("/usr/sbin/diskutil", args, cb)')).toBe(false);
  });

  it("no scope setter, no hardware id and no sync child process in diagnostics code", () => {
    for (const f of files) {
      const code = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect({ f, scope: SCOPE_CALL.test(code) }).toEqual({ f, scope: false });
      expect({ f, device: DEVICE_SERVICE.test(code) }).toEqual({ f, device: false });
      expect({ f, syncChild: SYNC_CHILD.test(code) }).toEqual({ f, syncChild: false });
    }
  });
});
