/**
 * @jest-environment node
 *
 * BACKLOG-3785 — automatic renderer CPU profile on a renderer freeze.
 *
 * The profiler is driven only through its public surface: heartbeat ticks
 * (`noteTick`), an injected clock and watchdog timer, a fake WebContents whose
 * debugger records CDP commands, and an injected encrypted writer / Sentry sink.
 * The profile returned by the fake `Profiler.stop` has the shape CDP returns
 * (nodes / startTime / endTime / samples / timeDeltas — captured from this
 * repo's Electron in the spike recorded on BACKLOG-3785).
 */

jest.mock("electron", () => ({ app: { getVersion: () => "9.9.9-test", getPath: () => "/mock" } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../syncTimeline", () => ({ syncTimeline: { currentPhase: () => "post-sync" } }));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createFileCrypto } from "../atRest/fileCrypto";
import { Readable } from "stream";
import {
  RendererFreezeProfiler,
  summarizeProfile,
  buildFreezeEvent,
  buildCaptureFailedEvent,
  createWindowFreezeReporter,
  isProfilingPhase,
  FreezeReportGate,
  PROFILE_SAMPLING_INTERVAL_US,
  FREEZE_SILENCE_MS,
  FREEZE_CAPTURE_MIN_INTERVAL_MS,
  MAX_PROFILE_BYTES,
  PROFILE_FILE_PREFIX,
  PROFILE_FILE_SUFFIX,
  type CpuProfile,
  type FreezeProfilerDeps,
  type ProfiledContents,
} from "../rendererFreezeProfiler";

const SECRET_STRING = "body text a user typed 3785";

/** A CDP-shaped profile: a 12 s block in a bundle function, some node_modules and native time. */
function blockProfile(): CpuProfile {
  const nodes = [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2, 5, 6, 7] },
    { id: 2, callFrame: { functionName: "handleSyncComplete", url: "app://./assets/index-AbC123.js", lineNumber: 41 }, children: [3] },
    { id: 3, callFrame: { functionName: "buildRows", url: "app://./assets/index-AbC123.js?v=1#x", lineNumber: 99 }, children: [4] },
    { id: 4, callFrame: { functionName: "deepClone", url: "app://./node_modules/lodash/clone.js", lineNumber: 9 } },
    { id: 5, callFrame: { functionName: "(program)", url: "", lineNumber: -1 } },
    { id: 6, callFrame: { functionName: "ipcRendererInternal", url: "node:electron/js2c/renderer_init", lineNumber: 3 } },
    { id: 7, callFrame: { functionName: "", url: "", lineNumber: -1 } },
  ];
  // 5 ms samples: 2000 in buildRows (10 s), 200 in deepClone (1 s), 100 (program), 50 electron, 50 anon.
  const samples: number[] = [];
  for (let i = 0; i < 2000; i++) samples.push(3);
  for (let i = 0; i < 200; i++) samples.push(4);
  for (let i = 0; i < 100; i++) samples.push(5);
  for (let i = 0; i < 50; i++) samples.push(6);
  for (let i = 0; i < 50; i++) samples.push(7);
  const timeDeltas = samples.map(() => 5000);
  const startTime = 1_000_000;
  return { nodes, startTime, endTime: startTime + samples.length * 5000, samples, timeDeltas, ...{ title: SECRET_STRING } } as CpuProfile;
}

class FakeContents implements ProfiledContents {
  destroyed = false;
  devTools = false;
  attached = false;
  listeners = new Map<string, (...args: unknown[]) => void>();
  debuggerListeners = new Map<string, () => void>();
  commands: string[] = [];
  failOn: string | null = null;
  profile: CpuProfile = blockProfile();
  debugger = {
    isAttached: () => this.attached,
    attach: jest.fn(() => {
      this.attached = true;
    }),
    detach: jest.fn(() => {
      this.attached = false;
      // Real Electron emits 'detach' for our own detach() too.
      this.debuggerListeners.get("detach")?.();
    }),
    on: (event: string, fn: () => void) => {
      this.debuggerListeners.set(event, fn);
      return this;
    },
    removeListener: (event: string) => {
      this.debuggerListeners.delete(event);
      return this;
    },
    sendCommand: jest.fn(async (method: string) => {
      this.commands.push(method);
      if (this.failOn === method) throw new Error(`${method} failed`);
      if (method === "Profiler.stop") return { profile: this.profile };
      return {};
    }),
  };
  isDestroyed = () => this.destroyed;
  isDevToolsOpened = () => this.devTools;
  on = (event: string, fn: (...args: unknown[]) => void) => {
    this.listeners.set(event, fn);
    return this;
  };
  removeListener = (event: string) => {
    this.listeners.delete(event);
    return this;
  };
}

interface Harness {
  profiler: RendererFreezeProfiler;
  contents: FakeContents;
  clock: { now: number };
  /** Run the watchdog every second from now to `until`, as a responsive main would. */
  liveUntil: (until: number) => void;
  tick: (at: number, extra?: { first?: boolean; hidden?: boolean; stopped?: boolean; screen?: string }) => Promise<void>;
  written: Array<{ dest: string; data: Buffer }>;
  /** Whether the post-backup profiling window is open (default: open). */
  window: { open: boolean };
  gate: FreezeReportGate;
  reports: Array<{ message: string; options: Record<string, unknown> }>;
  logs: string[];
}

function harness(overrides: Partial<FreezeProfilerDeps> = {}, dir?: string): Harness {
  const clock = { now: 0 };
  let watchdog: (() => void) | null = null;
  const written: Harness["written"] = [];
  const reports: Harness["reports"] = [];
  const logs: string[] = [];
  const window = { open: true };
  const gate = new FreezeReportGate();
  const profiler = new RendererFreezeProfiler({
    profilingAllowed: () => window.open,
    gate,
    now: () => clock.now,
    setInterval: (fn) => {
      watchdog = fn;
      return 1;
    },
    clearInterval: () => {
      watchdog = null;
    },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    profileDir: () => dir ?? path.join(os.tmpdir(), "keepr-3785-unused"),
    writeEncrypted: async (dest, data) => {
      written.push({ dest, data });
    },
    report: (message, options) => reports.push({ message, options: options as Record<string, unknown> }),
    appVersion: () => "9.9.9-test",
    platform: () => "win32",
    ...overrides,
  });
  const contents = new FakeContents();
  const h: Harness = {
    profiler,
    contents,
    clock,
    liveUntil: (until) => {
      while (clock.now + 1000 <= until) {
        clock.now += 1000;
        watchdog?.();
      }
      clock.now = until;
    },
    tick: async (at, extra = {}) => {
      h.liveUntil(at);
      profiler.noteTick(contents, { screen: "dashboard+IPhoneSync", ...extra });
      await profiler.idle();
    },
    written,
    reports,
    logs,
    window,
    gate,
  };
  return h;
}

/** One sync: first tick at 0, healthy ticks to `freezeStart`, silence, resume at `resumeAt`. */
async function freeze(h: Harness, freezeStart: number, resumeAt: number, opts: { first?: boolean } = {}): Promise<void> {
  if (opts.first !== false) await h.tick(h.clock.now, { first: true });
  for (let t = h.clock.now + 1000; t <= freezeStart; t += 1000) await h.tick(t);
  await h.tick(resumeAt);
}

describe("BACKLOG-3785: when the profiler captures", () => {
  it("arms on the first tick: attaches, enables, sets 5 ms sampling, starts", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    expect(h.contents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(h.contents.commands).toEqual(["Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start"]);
    const calls = h.contents.debugger.sendCommand.mock.calls as unknown as Array<[string, unknown?]>;
    const interval = calls.find(([m]) => m === "Profiler.setSamplingInterval");
    expect(interval?.[1]).toEqual({ interval: PROFILE_SAMPLING_INTERVAL_US });
    expect(PROFILE_SAMPLING_INTERVAL_US).toBe(20_000);
  });

  it("does not profile outside the post-backup window (e.g. during the device backup)", async () => {
    const h = harness();
    h.window.open = false;
    await h.tick(0, { first: true });
    for (let t = 1000; t <= 5000; t += 1000) await h.tick(t);
    await h.tick(30_000);
    expect(h.contents.debugger.attach).not.toHaveBeenCalled();
    expect(h.reports).toHaveLength(0);
    // The window opens (backup finished): profiling starts on the next tick.
    h.window.open = true;
    await h.tick(31_000);
    expect(h.contents.attached).toBe(true);
  });

  it("stops and detaches when the window closes (sync end + 3 min) while the renderer is healthy", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    h.window.open = false;
    await h.tick(1000);
    expect(h.contents.attached).toBe(false);
    expect(h.contents.commands[h.contents.commands.length - 1]).toBe("Profiler.stop");
  });

  it("a freeze that outlasts the window is still captured when ticks resume", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    await h.tick(1000);
    h.window.open = false; // window closed during the freeze
    await h.tick(300_000);
    expect(h.written).toHaveLength(1);
    expect(h.reports).toHaveLength(1);
    expect(h.contents.attached).toBe(false);
  });

  it("captures when the renderer is silent > 10 s and main stayed responsive", async () => {
    const h = harness();
    await freeze(h, 5000, 5000 + FREEZE_SILENCE_MS + 2000);
    expect(h.contents.commands).toContain("Profiler.stop");
    expect(h.written).toHaveLength(1);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].message).toBe("renderer_freeze");
    const line = h.logs.find((l) => l.includes("renderer-freeze gapMs=12000"));
    expect(line).toBeDefined();
    expect(line).toContain("buildRows index-AbC123.js:100");
    // Profiling restarts after a capture while the sync is still showing.
    expect(h.contents.commands[h.contents.commands.length - 1]).toBe("Profiler.start");
  });

  it("does not capture for a gap of exactly 10 s", async () => {
    const h = harness();
    await freeze(h, 5000, 5000 + FREEZE_SILENCE_MS);
    expect(h.contents.commands).not.toContain("Profiler.stop");
    expect(h.written).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
  });

  it("does not capture when main stalled during the gap (the gap was main's, not the renderer's)", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    await h.tick(1000);
    // Main blocked 8 s inside the gap: the watchdog runs late once.
    h.liveUntil(4000);
    h.clock.now = 12_000; // clock moves 8 s with no watchdog run: main was blocked
    h.liveUntil(16_000); // watchdog resumes: its first run is 8 s late
    await h.tick(16_000);
    expect(h.contents.commands).not.toContain("Profiler.stop");
    expect(h.logs.some((l) => l.includes("main was not responsive"))).toBe(true);
  });

  it("does not capture when main's watchdog has not run in the last 2 s (main blocked right up to the tick)", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    await h.tick(1000);
    h.liveUntil(3000);
    h.clock.now = 20_000; // main blocked from 3 s to 20 s; the tick drains first
    h.profiler.noteTick(h.contents, {});
    await h.profiler.idle();
    expect(h.contents.commands).not.toContain("Profiler.stop");
  });

  it("does not capture when the window was hidden (timer throttling, not a hang)", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    await h.tick(1000, { hidden: true });
    await h.tick(20_000, { hidden: true });
    expect(h.contents.commands).not.toContain("Profiler.stop");
  });

  it("rate limit: at most one capture per 10 minutes (Sentry shares the limit)", async () => {
    const h = harness();
    await freeze(h, 5000, 20_000);
    expect(h.written).toHaveLength(1);
    // A second freeze 5 minutes later is not captured.
    await freeze(h, 300_000, 320_000, { first: false });
    expect(h.written).toHaveLength(1);
    expect(h.reports).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("rate limited"))).toBe(true);
    // One more after the 10 minutes have passed is.
    await freeze(h, 20_000 + FREEZE_CAPTURE_MIN_INTERVAL_MS, 20_000 + FREEZE_CAPTURE_MIN_INTERVAL_MS + 15_000, {
      first: false,
    });
    expect(h.written).toHaveLength(2);
    expect(h.reports).toHaveLength(2);
  });

  it("a `stopped` tick after a long gap captures first, then detaches", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    await h.tick(1000);
    await h.tick(30_000, { stopped: true });
    expect(h.written).toHaveLength(1);
    expect(h.contents.debugger.detach).toHaveBeenCalled();
    expect(h.contents.attached).toBe(false);
  });

  it("a `stopped` tick with no gap just stops and detaches", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    await h.tick(1000, { stopped: true });
    expect(h.written).toHaveLength(0);
    expect(h.contents.commands).toEqual([
      "Profiler.enable",
      "Profiler.setSamplingInterval",
      "Profiler.start",
      "Profiler.stop",
    ]);
    expect(h.contents.attached).toBe(false);
  });

  it("restarts the profile every 60 s of healthy ticks (bounds what a capture holds)", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    for (let t = 1000; t <= 61_000; t += 1000) await h.tick(t);
    expect(h.contents.commands.filter((c) => c === "Profiler.start")).toHaveLength(2);
    expect(h.contents.commands.filter((c) => c === "Profiler.stop")).toHaveLength(1);
  });
});

describe("BACKLOG-3785: the profiler never gets in the way", () => {
  it("never attaches with DevTools open or another debugger attached", async () => {
    const h = harness();
    h.contents.devTools = true;
    await h.tick(0, { first: true });
    await h.tick(1000);
    await h.tick(30_000);
    expect(h.contents.debugger.attach).not.toHaveBeenCalled();
    expect(h.contents.commands).toEqual([]);

    const h2 = harness();
    h2.contents.attached = true;
    await h2.tick(0, { first: true });
    expect(h2.contents.debugger.attach).not.toHaveBeenCalled();
  });

  it("a tick from a different renderer detaches the old one before arming the new one", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    expect(h.contents.attached).toBe(true);
    const next = new FakeContents();
    h.profiler.noteTick(next, { first: true });
    await h.profiler.idle();
    expect(h.contents.attached).toBe(false);
    expect(h.contents.debugger.detach).toHaveBeenCalled();
    expect(next.attached).toBe(true);
    expect(next.commands).toEqual(["Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start"]);
  });

  it("detaches when DevTools opens", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    h.contents.listeners.get("devtools-opened")!();
    await h.profiler.idle();
    expect(h.contents.attached).toBe(false);
  });

  it("detaches on a CDP error, reports the failed capture, and never throws", async () => {
    const h = harness();
    await h.tick(0, { first: true });
    await h.tick(1000);
    h.contents.failOn = "Profiler.stop";
    await expect(h.tick(20_000)).resolves.toBeUndefined();
    expect(h.contents.debugger.detach).toHaveBeenCalled();
    expect(h.contents.attached).toBe(false);
    expect(h.written).toHaveLength(0);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].options).toEqual(buildCaptureFailedEvent({ gapMs: 19_000, phase: "post-sync" }));
  });

  it("a failing attach, a throwing writer and a throwing Sentry sink are all swallowed", async () => {
    const h = harness({
      writeEncrypted: async () => {
        throw new Error("no data key");
      },
      report: () => {
        throw new Error("sentry down");
      },
    });
    await h.tick(0, { first: true });
    await h.tick(1000);
    await expect(h.tick(20_000)).resolves.toBeUndefined();
    expect(h.logs.some((l) => l.includes("profile not written: no data key"))).toBe(true);
    expect(h.logs.some((l) => l.includes("Sentry report failed"))).toBe(true);

    const h2 = harness();
    h2.contents.debugger.attach.mockImplementation(() => {
      throw new Error("Another debugger is already attached");
    });
    expect(() => h2.profiler.noteTick(h2.contents, { first: true })).not.toThrow();
    await expect(h2.profiler.idle()).resolves.toBeUndefined();
  });
});

describe("BACKLOG-3785: the written profile", () => {
  const KEY = Buffer.alloc(32, 7);
  const files = createFileCrypto({
    currentKey: async () => ({ keyId: "ab".repeat(16), key: KEY }),
    keyFor: async () => KEY,
  });
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3785-profile-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const realWriter = async (dest: string, data: Buffer): Promise<void> => {
    await files.encryptStreamToFile(Readable.from([data]), dest);
  };

  it("is encrypted (KEPRENC header, no profile text on disk) and decrypts to the profile", async () => {
    const h = harness({ writeEncrypted: realWriter }, dir);
    await freeze(h, 2000, 20_000);
    const names = fs.readdirSync(dir).filter((n) => n.endsWith(PROFILE_FILE_SUFFIX));
    expect(names).toHaveLength(1);
    expect(names[0].startsWith(PROFILE_FILE_PREFIX)).toBe(true);
    const raw = fs.readFileSync(path.join(dir, names[0]));
    expect(raw.subarray(0, 7).toString("ascii")).toBe("KEPRENC");
    expect(raw.includes(Buffer.from("buildRows"))).toBe(false);
    expect(raw.includes(Buffer.from(SECRET_STRING))).toBe(false);
    const plain = await files.readAllDecrypted(path.join(dir, names[0]));
    expect(JSON.parse(plain.toString("utf8")).nodes).toHaveLength(7);
  });

  it("keeps only the 3 newest profiles", async () => {
    for (const stamp of ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"]) {
      fs.writeFileSync(path.join(dir, `${PROFILE_FILE_PREFIX}${stamp}${PROFILE_FILE_SUFFIX}`), "old");
    }
    fs.writeFileSync(path.join(dir, "unrelated.txt"), "keep me");
    const h = harness({ writeEncrypted: realWriter }, dir);
    h.clock.now = Date.parse("2026-10-09T00:00:00Z");
    await freeze(h, h.clock.now + 2000, h.clock.now + 20_000);
    const kept = fs.readdirSync(dir).sort();
    expect(kept.filter((n) => n.endsWith(PROFILE_FILE_SUFFIX))).toHaveLength(3);
    expect(kept).toContain("unrelated.txt");
    expect(kept).toContain(`${PROFILE_FILE_PREFIX}2020-01-04${PROFILE_FILE_SUFFIX}`);
    expect(kept).not.toContain(`${PROFILE_FILE_PREFIX}2020-01-02${PROFILE_FILE_SUFFIX}`);
  });

  it("is not written above the size cap (the summary is still logged)", async () => {
    const h = harness({ writeEncrypted: realWriter }, dir);
    const big = blockProfile();
    big.nodes[2].callFrame.functionName = "x".repeat(MAX_PROFILE_BYTES + 1);
    h.contents.profile = big;
    await freeze(h, 2000, 20_000);
    expect(fs.readdirSync(dir)).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("exceeds"))).toBe(true);
  });
});

describe("BACKLOG-3785: the profiler disarms when the page or debugger goes away", () => {
  async function armed(): Promise<Harness> {
    const h = harness();
    await h.tick(0, { first: true });
    await h.tick(1000);
    expect(h.contents.attached).toBe(true);
    return h;
  }
  const stopsAfter = (h: Harness): number => h.contents.commands.filter((c) => c === "Profiler.stop").length;

  it("a main-frame navigation (Reload) stops profiling and detaches", async () => {
    const h = await armed();
    h.contents.listeners.get("did-start-navigation")?.({ isMainFrame: true });
    await h.profiler.idle();
    expect(stopsAfter(h)).toBe(1);
    expect(h.contents.attached).toBe(false);
    expect(h.contents.debugger.detach).toHaveBeenCalledTimes(1);
    expect(h.contents.listeners.size).toBe(0);
  });

  it("a same-document main-frame navigation (URL change, same page) does not stop or detach", async () => {
    const h = await armed();
    const before = stopsAfter(h);
    h.contents.listeners.get("did-start-navigation")?.({ isMainFrame: true, isSameDocument: true });
    h.contents.listeners.get("did-start-navigation")?.({}, "u", true, true);
    await h.profiler.idle();
    expect(stopsAfter(h)).toBe(before);
    expect(h.contents.attached).toBe(true);
    expect(h.contents.debugger.detach).not.toHaveBeenCalled();
  });

  it("a legacy positional main-frame navigation also disarms; a sub-frame one does not", async () => {
    const h = await armed();
    h.contents.listeners.get("did-start-navigation")?.({}, "u", false, false);
    await h.profiler.idle();
    expect(h.contents.attached).toBe(true);
    h.contents.listeners.get("did-start-navigation")?.({}, "u", false, true);
    await h.profiler.idle();
    expect(h.contents.attached).toBe(false);
  });

  it("render-process-gone disarms without sending commands", async () => {
    const h = await armed();
    const before = h.contents.commands.length;
    h.contents.listeners.get("render-process-gone")?.();
    await h.profiler.idle();
    expect(h.contents.commands.length).toBe(before);
    expect(h.contents.listeners.size).toBe(0);
    expect(h.contents.debuggerListeners.size).toBe(0);
  });

  it("an external debugger detach clears state: no watchdog, no further sampling or capture", async () => {
    const h = await armed();
    const detachSpy = h.contents.debugger.detach;
    h.contents.attached = false; // someone else detached
    h.contents.debuggerListeners.get("detach")?.();
    await h.profiler.idle();
    expect(h.contents.listeners.size).toBe(0);
    expect(h.contents.debuggerListeners.size).toBe(0);
    expect(detachSpy).not.toHaveBeenCalled();
    // A 20 s silence then a tick does not capture anything from the dead session.
    const commandsBefore = h.contents.commands.length;
    h.window.open = false;
    await h.tick(21_000);
    expect(h.reports).toHaveLength(0);
    expect(h.contents.commands.slice(commandsBefore)).toEqual([]);
  });
});

describe("BACKLOG-3785: what leaves the machine (Sentry event)", () => {
  it("summarizeProfile's bundleSelf holds Keepr bundle frames only (first filter, on its own)", () => {
    const summary = summarizeProfile(blockProfile());
    expect(summary.bundleSelf.length).toBeGreaterThan(0);
    expect(summary.bundleSelf.every((e) => e.bundle)).toBe(true);
    expect(summary.bundleSelf.map((e) => e.functionName)).toEqual(["buildRows"]);
    // The unfiltered list does contain non-bundle frames, so the assertion above can fail.
    expect(summary.self.some((e) => !e.bundle)).toBe(true);
  });

  it("buildFreezeEvent drops non-bundle entries even if handed them (second filter, on its own)", () => {
    const entry = (functionName: string, bundle: boolean) => ({
      label: functionName, functionName, file: "f.js", line: 1, bundle, ms: 5,
    });
    const event = buildFreezeEvent({
      gapMs: 1,
      bundleSelf: [entry("keep", true), entry("drop", false)],
      phase: null,
      screen: "x",
      appVersion: "1",
      platform: "darwin",
    });
    const frames = (event.extra as { top_self_frames: Array<{ functionName: string }> }).top_self_frames;
    expect(frames.map((f) => f.functionName)).toEqual(["keep"]);
  });

  it("contains only the whitelisted keys and only Keepr bundle frames", async () => {
    const h = harness();
    await freeze(h, 2000, 20_000);
    expect(h.reports).toHaveLength(1);
    const { message, options } = h.reports[0];
    expect(message).toBe("renderer_freeze");
    expect(Object.keys(options).sort()).toEqual(["extra", "level", "tags"]);
    expect(options.level).toBe("warning");
    expect(options.tags).toEqual({
      app_version: "9.9.9-test",
      platform: "win32",
      sync_phase: "post-sync",
      screen: "dashboard+IPhoneSync",
    });
    const extra = options.extra as Record<string, unknown>;
    expect(Object.keys(extra).sort()).toEqual(["freeze_ms", "top_self_frames"]);
    expect(extra.freeze_ms).toBe(18_000);
    const frames = extra.top_self_frames as Array<Record<string, unknown>>;
    for (const frame of frames) {
      expect(Object.keys(frame).sort()).toEqual(["file", "functionName", "line", "selfMs"]);
    }
    // Only the app bundle: no node_modules, Electron internals, native or anonymous-native frames.
    expect(frames.map((f) => `${f.functionName} ${f.file}:${f.line}`)).toEqual(["buildRows index-AbC123.js:100"]);
    expect(JSON.stringify(options)).not.toContain(SECRET_STRING);
    expect(JSON.stringify(options)).not.toContain("app://");
  });

  it("a screen value that is not a plain name is reported as unknown", () => {
    const event = buildFreezeEvent({
      gapMs: 1,
      bundleSelf: [],
      phase: null,
      screen: "transaction/8c1f-uuid?x=1",
      appVersion: "1",
      platform: "darwin",
    });
    expect(event.tags).toEqual({ app_version: "1", platform: "darwin", sync_phase: "none", screen: "unknown" });
  });
});

describe("BACKLOG-3785: profiling window phases", () => {
  it("post-backup phases only", () => {
    for (const p of ["decrypting", "parsing-contacts", "parsing-messages", "resolving", "cleanup", "storing:messages", "storing:attachments", "running", "post-sync"]) {
      expect([p, isProfilingPhase(p)]).toEqual([p, true]);
    }
    for (const p of [null, "backup", "backup:waiting-for-device", "backup:transferring", "idle"]) {
      expect([p, isProfilingPhase(p)]).toEqual([p, false]);
    }
  });
});

describe("BACKLOG-3785: window freezes outside a sync (no profile)", () => {
  function reporter(gate = new FreezeReportGate(), start = 1_000_000) {
    const sent: Array<{ message: string; options: Record<string, unknown> }> = [];
    const timers: Array<() => void> = [];
    let now = start;
    const report = createWindowFreezeReporter({
      now: () => now,
      setTimeout: (fn) => void timers.push(fn),
      gate,
      report: (message, options) => sent.push({ message, options: options as Record<string, unknown> }),
      screen: () => "dashboard+AuditTransaction",
      appVersion: () => "9.9.9-test",
      platform: () => "win32",
      log: () => undefined,
    });
    return {
      sent,
      gate,
      fire: (ms: number, phase: string | null) => {
        report(ms, phase);
        while (timers.length) timers.shift()!();
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("a 53 s freeze outside a sync sends renderer_freeze with exactly the whitelisted keys and no frames", () => {
    const r = reporter();
    r.fire(53_000, null);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].message).toBe("renderer_freeze");
    const options = r.sent[0].options;
    expect(Object.keys(options).sort()).toEqual(["extra", "level", "tags"]);
    expect(options.level).toBe("warning");
    expect(options.tags).toEqual({
      app_version: "9.9.9-test",
      platform: "win32",
      sync_phase: "none",
      screen: "dashboard+AuditTransaction",
    });
    expect(options.extra).toEqual({ freeze_ms: 53_000 });
  });

  it("under 10 s sends nothing", () => {
    const r = reporter();
    r.fire(9_999, null);
    expect(r.sent).toHaveLength(0);
  });

  it("shares the 10-minute limit with profiled captures", async () => {
    const gate = new FreezeReportGate();
    const h = harness({ gate });
    await freeze(h, 2000, 20_000); // profiled capture takes the slot
    expect(h.reports).toHaveLength(1);
    // The same freeze seen by the window events 2 s later: the capture already holds the slot.
    const r = reporter(gate, 22_000);
    r.fire(30_000, "post-sync");
    expect(r.sent).toHaveLength(0);
    r.advance(10 * 60_000);
    r.fire(30_000, null);
    expect(r.sent).toHaveLength(1);
  });

  it("a throwing Sentry sink never throws out of the reporter", () => {
    const report = createWindowFreezeReporter({
      setTimeout: (fn) => {
        fn();
        return 0;
      },
      gate: new FreezeReportGate(),
      report: () => {
        throw new Error("sentry down");
      },
      screen: () => "x",
      appVersion: () => "1",
      platform: () => "darwin",
      log: () => undefined,
    });
    expect(() => report(20_000, null)).not.toThrow();
  });
});

describe("BACKLOG-3785: summarizeProfile", () => {
  it("self and inclusive time over the freeze window, labels are name + basename:line", () => {
    const s = summarizeProfile(blockProfile());
    expect(s.samples).toBe(2400);
    expect(s.self[0]).toMatchObject({ label: "buildRows index-AbC123.js:100", ms: 10_000 });
    expect(s.total.find((e) => e.functionName === "handleSyncComplete")?.ms).toBe(11_000);
    expect(s.self.map((e) => e.label)).toContain("(program)");
    for (const e of [...s.self, ...s.total]) expect(e.label).not.toMatch(/app:|node:|\//);
  });

  it("a window keeps only the last N ms of samples", () => {
    const s = summarizeProfile(blockProfile(), 1000);
    expect(s.sampledMs).toBe(1000);
    expect(s.self.find((e) => e.functionName === "buildRows")).toBeUndefined();
  });
});
