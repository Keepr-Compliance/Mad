/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR4 — the portable sender rule-set store.
 *
 * Transcribed producer outputs (fixtures/senderRuleSetRpc-4175/), each the
 * resolved value of `client.rpc("sender_rule_set_current")` from
 * @supabase/supabase-js 2.110.2, captured 2026-11-07:
 *   valid-signed-in.json  the test Supabase project with migration
 *                         20261108100000 applied, called as a signed-in
 *                         synthetic user (example.test, deleted afterwards)
 *   anon-no-session.json  same project, no session (EXECUTE revoked from anon)
 *   pgrst202.json         a project WITHOUT the migration (function absent)
 *   down-refused.json     a closed local port (connection refused)
 *   down-dns.json         an unresolvable host
 * A network failure RESOLVES with status 0 and code ""; it never rejects.
 *
 * Rule-set fixtures are the bundled set with `version` (and the listed field)
 * changed, each passed through parseSenderRuleSet so it is emittable.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

import type { SenderRuleSet } from "../../utils/senderFilter/bundledRules";

let mockBundled: SenderRuleSet | null = null;
jest.mock("../../utils/senderFilter/bundledRules", () => {
  const actual = jest.requireActual("../../utils/senderFilter/bundledRules");
  return {
    ...actual,
    get BUNDLED_SENDER_RULES() {
      return mockBundled ?? actual.BUNDLED_SENDER_RULES;
    },
  };
});

const logCalls: unknown[][] = [];
jest.mock("../logService", () => {
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      logCalls.push([level, ...args]);
      return Promise.resolve();
    };
  const m = { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
  return { __esModule: true, default: m, logService: m };
});

let failWrite = false;
jest.mock("../atRest/fileCrypto", () => {
  const actual = jest.requireActual("../atRest/fileCrypto");
  return {
    ...actual,
    writeFileAtomic: (target: string, data: string) => {
      if (failWrite) return Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
      return actual.writeFileAtomic(target, data);
    },
  };
});

import { installAppPaths, resetAppPaths } from "../../capabilities/appPathsProvider";
import { installErrorReporter, resetErrorReporter } from "../../capabilities/errorReporterProvider";
import type { ErrorReporter } from "../../capabilities/errorReporter";
import { parseSenderRuleSet } from "../../utils/senderFilter/ruleSetSchema";
import * as store from "../senderRuleSetStore";

const actualBundled: SenderRuleSet = jest.requireActual("../../utils/senderFilter/bundledRules").BUNDLED_SENDER_RULES;
const FIX = path.join(__dirname, "fixtures", "senderRuleSetRpc-4175");
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), "utf8"));
const MIGRATION = path.join(__dirname, "..", "..", "..", "supabase", "migrations", "20261108100000_backlog_4175_sender_rule_sets.sql");

function v(version: number, patch: Partial<SenderRuleSet> = {}): SenderRuleSet {
  const r = parseSenderRuleSet(JSON.parse(JSON.stringify({ ...actualBundled, ...patch, version })));
  if (!r) throw new Error(`fixture v${version} is not a valid rule set`);
  return r;
}
const valid = (r: SenderRuleSet): store.ServerOutcome => ({ kind: "valid", rules: r });
const OFFLINE: store.ServerOutcome = { kind: "none", reason: "offline" };

let dir: string;
const cacheFile = () => path.join(dir, store.SENDER_RULES_CACHE_FILE);
function writeCache(body: unknown): void {
  fs.writeFileSync(cacheFile(), typeof body === "string" ? body : JSON.stringify(body));
}
function cacheOf(r: SenderRuleSet, fetchedAt = Date.now(), userId: string | null = "user-a"): void {
  writeCache({ format: 1, fetchedAt, userId, version: r.version, content: r });
}
const sha = () => crypto.createHash("sha256").update(fs.readFileSync(cacheFile())).digest("hex");
const active = () => {
  const a = store.getActiveSenderRules();
  return { version: a.version, source: a.source, downloadRejected: a.downloadRejected };
};

const captured: unknown[][] = [];
const fakeReporter: ErrorReporter = {
  captureException: (e: unknown, o?: unknown) => {
    captured.push([e, o]);
  },
  captureMessage: () => undefined,
  addBreadcrumb: () => undefined,
  flush: async () => true,
  setUser: () => undefined,
};

beforeEach(() => {
  store.__resetForTests();
  mockBundled = null;
  failWrite = false;
  logCalls.length = 0;
  captured.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sender-rules-4175-"));
  installAppPaths({ userData: () => dir });
  installErrorReporter(fakeReporter);
});

afterEach(() => {
  resetAppPaths();
  resetErrorReporter();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("classifyServerAnswer on transcribed supabase-js outputs", () => {
  it("valid-signed-in: data is the bare {version, content} object; content equals the migration seed and the bundled set", () => {
    const f = fixture("valid-signed-in");
    expect(f.status).toBe(200);
    const sql = fs.readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
    const seed = JSON.parse(sql.match(/-- SEED-BEGIN\n'([\s\S]*?)'\n-- SEED-END/)![1]);
    expect(f.data.content).toEqual(seed);
    const out = store.classifyServerAnswer(f, false);
    expect(out.kind).toBe("valid");
    expect(out.kind === "valid" && out.rules).toEqual(JSON.parse(JSON.stringify(actualBundled)));
  });

  it("down-refused and down-dns (resolved, status 0, code \"\") are offline", () => {
    expect(store.classifyServerAnswer(fixture("down-refused"), false)).toEqual({ kind: "none", reason: "offline" });
    expect(store.classifyServerAnswer(fixture("down-dns"), false)).toEqual({ kind: "none", reason: "offline" });
  });

  it("pgrst202 is rpc_missing; anon-no-session (42501) is rpc_error with the code only", () => {
    expect(store.classifyServerAnswer(fixture("pgrst202"), false)).toEqual({ kind: "none", reason: "rpc_missing" });
    expect(store.classifyServerAnswer(fixture("anon-no-session"), false)).toEqual({
      kind: "none",
      reason: "rpc_error",
      code: "42501",
    });
  });

  it("timeout, empty and not-an-object", () => {
    expect(store.classifyServerAnswer(fixture("valid-signed-in"), true)).toEqual({ kind: "none", reason: "timeout" });
    expect(store.classifyServerAnswer({ data: null, error: null, status: 200 }, false)).toEqual({ kind: "none", reason: "empty" });
    expect(store.classifyServerAnswer({ data: [fixture("valid-signed-in").data], error: null, status: 200 }, false)).toEqual({
      kind: "rejected",
      reason: "not_object",
      version: null,
    });
  });

  it("RS4 an extra key anywhere is refused (shape)", () => {
    const content = { ...v(4), extra: 1 };
    expect(store.classifyServerAnswer({ data: { version: 4, content }, error: null, status: 200 }, false)).toEqual({
      kind: "rejected",
      reason: "shape",
      version: 4,
    });
  });

  it("RS5 version != content.version is refused (version_mismatch)", () => {
    expect(store.classifyServerAnswer({ data: { version: 4, content: v(5) }, error: null, status: 200 }, false)).toEqual({
      kind: "rejected",
      reason: "version_mismatch",
      version: 4,
    });
  });

  it("RS6 gmailUpdates live on the detector is refused (shape)", () => {
    const content = JSON.parse(JSON.stringify(v(6)));
    content.modes.gmailUpdates.detector = "live";
    expect(store.classifyServerAnswer({ data: { version: 6, content }, error: null, status: 200 }, false)).toEqual({
      kind: "rejected",
      reason: "shape",
      version: 6,
    });
  });
});

describe("selection and the cache", () => {
  it("RS1 a valid answer wins over a NEWER cache and replaces it, in memory and on disk", async () => {
    cacheOf(v(3));
    await store.applyServerOutcome(valid(v(2)), "user-a");
    expect(active()).toEqual({ version: 2, source: "download", downloadRejected: false });
    expect(JSON.parse(fs.readFileSync(cacheFile(), "utf8")).version).toBe(2);
  });

  it("RS2 no answer: a NEWER bundled set beats an older cache", () => {
    cacheOf(v(1));
    mockBundled = v(2);
    expect(active()).toEqual({ version: 2, source: "bundled", downloadRejected: false });
  });

  it("RS3 a refused download leaves the cache file untouched and is logged count-only", async () => {
    cacheOf(v(3));
    const before = sha();
    const content = { ...v(9), extra: true };
    await store.applyServerOutcome(store.classifyServerAnswer({ data: { version: 9, content }, error: null, status: 200 }, false), "user-a");
    expect(active()).toEqual({ version: 3, source: "cache", downloadRejected: true });
    expect(sha()).toBe(before);
    const rejectLogs = logCalls.filter((c) => c[1] === "Sender rules download rejected");
    expect(rejectLogs).toHaveLength(1);
    expect(rejectLogs[0][3]).toEqual({ version: 9, reason: "shape" });
  });

  it("RS6b a failed cache write still switches the in-memory cache; the next offline attempt competes with it", async () => {
    cacheOf(v(3));
    mockBundled = v(2);
    expect(active().version).toBe(3);
    failWrite = true;
    await store.applyServerOutcome(valid(v(1)), "user-a");
    expect(active()).toEqual({ version: 1, source: "download", downloadRejected: false });
    expect(captured).toHaveLength(1);
    expect(captured[0][1]).toEqual({ tags: { service: "sender-rules" } });
    await store.applyServerOutcome(OFFLINE, "user-a");
    expect(active()).toEqual({ version: 2, source: "bundled", downloadRejected: false });
  });

  it("RS7a a cache file whose content fails the schema is absent (cache_invalid)", () => {
    writeCache({ format: 1, fetchedAt: Date.now(), userId: null, version: 9, content: { ...v(9), extra: 1 } });
    expect(active()).toEqual({ version: 1, source: "bundled", downloadRejected: false });
    expect(logCalls.some((c) => c[1] === "Sender rules cache_invalid")).toBe(true);
  });

  it("RS7b a cache file whose version != content.version is absent", () => {
    writeCache({ format: 1, fetchedAt: Date.now(), userId: null, version: 9, content: v(8) });
    expect(active()).toEqual({ version: 1, source: "bundled", downloadRejected: false });
  });

  it("smoke: a truncated cache file is absent and nothing throws", () => {
    writeCache('{"format":1,"version":');
    expect(() => store.getActiveSenderRules()).not.toThrow();
    expect(active().source).toBe("bundled");
  });

  it("RS8 a missing RPC is logged once at info", async () => {
    await store.applyServerOutcome({ kind: "none", reason: "rpc_missing" }, "user-a");
    await store.applyServerOutcome({ kind: "none", reason: "rpc_missing" }, "user-a");
    expect(logCalls.filter((c) => c[0] === "info" && String(c[1]).includes("RPC not available"))).toHaveLength(1);
    expect(active()).toEqual({ version: 1, source: "bundled", downloadRejected: false });
  });

  it("RS11 a stale cache newer than bundled is still used, and logged once", () => {
    cacheOf(v(5), Date.now() - 30 * 86_400_000);
    expect(active()).toEqual({ version: 5, source: "cache", downloadRejected: false });
    expect(active().version).toBe(5);
    const stale = logCalls.filter((c) => c[1] === "Sender rules cache is stale");
    expect(stale).toHaveLength(1);
    expect(stale[0][3]).toEqual({ version: 5, ageDays: 30 });
  });

  it("RS14a after a valid answer, an offline attempt runs the same set as the cache", async () => {
    await store.applyServerOutcome(valid(v(5)), "user-a");
    await store.applyServerOutcome(OFFLINE, "user-a");
    expect(active()).toEqual({ version: 5, source: "cache", downloadRejected: false });
  });

  it("RS14b after a valid OLDER answer, an offline attempt falls back to the newer bundled set", async () => {
    mockBundled = v(2);
    await store.applyServerOutcome(valid(v(1)), "user-a");
    expect(active().version).toBe(1);
    await store.applyServerOutcome(OFFLINE, "user-a");
    expect(active()).toEqual({ version: 2, source: "bundled", downloadRejected: false });
  });

  it("RS22 a cache equal to bundled is labelled bundled", () => {
    cacheOf(v(1));
    expect(active()).toEqual({ version: 1, source: "bundled", downloadRejected: false });
  });

  it("identity: a cache stamped for user A is absent once the session is user B, and comes back for A", () => {
    cacheOf(v(3), Date.now(), "user-a");
    expect(active().version).toBe(3); // session unknown: not filtered
    store.noteSessionUser("user-b");
    expect(active()).toEqual({ version: 1, source: "bundled", downloadRejected: false });
    store.noteSessionUser("user-a");
    expect(active().version).toBe(3);
  });

  it("no host paths installed: the cache is absent and the getter still answers", () => {
    resetAppPaths();
    expect(active()).toEqual({ version: 1, source: "bundled", downloadRejected: false });
  });
});

describe("throttle and trigger", () => {
  afterEach(() => jest.useRealTimers());

  it("the getter fires the trigger at most once a minute, whatever the last attempt", () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12) });
    const trigger = jest.fn();
    store.setRefreshTrigger(trigger);
    store.getActiveSenderRules();
    store.getActiveSenderRules();
    expect(trigger).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(store.IDENTITY_CHECK_MS);
    store.getActiveSenderRules();
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it("shouldFetch: per user; 6 h after an answer, 5 min after offline", async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 7, 12) });
    expect(store.shouldFetch("user-a")).toBe(true);
    await store.applyServerOutcome({ kind: "none", reason: "rpc_missing" }, "user-a");
    expect(store.shouldFetch("user-a")).toBe(false);
    expect(store.shouldFetch("user-b")).toBe(true);
    jest.advanceTimersByTime(store.REFRESH_INTERVAL_MS);
    expect(store.shouldFetch("user-a")).toBe(true);
    await store.applyServerOutcome(OFFLINE, "user-a");
    jest.advanceTimersByTime(store.RETRY_AFTER_OFFLINE_MS - 1);
    expect(store.shouldFetch("user-a")).toBe(false);
    jest.advanceTimersByTime(1);
    expect(store.shouldFetch("user-a")).toBe(true);
  });

  it("subscribers hear each change of version or source once", async () => {
    const seen: string[] = [];
    store.subscribe((a) => seen.push(`${a.version}/${store.formatSenderRulesSource(a)}`));
    store.getActiveSenderRules();
    await store.applyServerOutcome(valid(v(4)), "user-a");
    await store.applyServerOutcome(valid(v(4)), "user-a");
    await store.applyServerOutcome({ kind: "rejected", reason: "shape", version: 7 }, "user-a");
    expect(seen).toEqual(["4/download", "4/cache (download rejected)"]);
  });
});
