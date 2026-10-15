/**
 * BACKLOG-3801 — the "Send crash reports" switch.
 *
 * Two halves:
 *  1. The saved choice: default ON, survives a restart, bad files read as ON.
 *  2. The gate: with the switch OFF nothing reaches the network-sending
 *     transport. Driven through the REAL `makeOfflineTransport` from
 *     `@sentry/core` — the same wrapper `@sentry/electron/main`
 *     `makeElectronOfflineTransport` builds (main/transports/electron-offline-net.js:16,
 *     `core.makeOfflineTransport(baseTransport)({ flushAtStartup: true, createStore, ... })`),
 *     with an in-memory store standing in for the on-disk one. That wrapper is
 *     where the likely-wrong fixes leak: a gate on `beforeSend` alone never sees
 *     a replay envelope or an envelope already queued on disk, and a gate via
 *     the `shouldSend` option queues the envelope to disk instead of dropping it.
 *
 * Renderer events: `@sentry/electron/renderer` has no network transport; its
 * transport (renderer/transport.js) hands every envelope to main over IPC, and
 * main sends them through this same transport (main/ipc.js:54 for events via
 * captureEvent, :91/:96 for other envelopes straight to `getTransport().send`).
 * The replay-envelope case below is that second path.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createEnvelope, makeOfflineTransport } from "@sentry/core";
import type { Envelope, OfflineStore } from "@sentry/core";
import {
  CRASH_REPORTING_FILE_NAME,
  __resetCrashReportingPreferenceForTests,
  gateBaseTransport,
  getCrashReportingState,
  isCrashReportingEnabled,
  loadCrashReportingPreference,
  setCrashReportingEnabled,
} from "../crashReportingPreference";

let dir: string;

beforeEach(() => {
  __resetCrashReportingPreferenceForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3801-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  jest.useRealTimers();
});

function writePref(contents: string): void {
  fs.writeFileSync(path.join(dir, CRASH_REPORTING_FILE_NAME), contents, "utf8");
}

describe("the saved choice", () => {
  it.each([
    ["no file", null],
    ["bad JSON", "{not json"],
    ["enabled is not a boolean", JSON.stringify({ enabled: "false" })],
    ["empty object", "{}"],
    ["JSON null", "null"],
  ])("%s → ON (the default is unchanged)", (_label, contents) => {
    if (contents !== null) writePref(contents);
    expect(loadCrashReportingPreference(dir)).toBe(true);
    expect(isCrashReportingEnabled()).toBe(true);
  });

  it("a saved OFF reads as OFF at launch", () => {
    writePref(JSON.stringify({ enabled: false }));
    expect(loadCrashReportingPreference(dir)).toBe(false);
    expect(getCrashReportingState()).toEqual({ enabled: false, wasEnabledAtLaunch: false });
  });

  it("turning it OFF is saved and survives a restart", () => {
    loadCrashReportingPreference(dir);
    setCrashReportingEnabled(false);
    expect(isCrashReportingEnabled()).toBe(false);

    __resetCrashReportingPreferenceForTests(); // the restart
    expect(loadCrashReportingPreference(dir)).toBe(false);
  });

  it("turning it ON after an OFF launch reports that it starts next launch", () => {
    writePref(JSON.stringify({ enabled: false }));
    loadCrashReportingPreference(dir);
    expect(setCrashReportingEnabled(true)).toEqual({ enabled: true, wasEnabledAtLaunch: false });
  });

  it("the live flag goes OFF even if the file cannot be written", () => {
    loadCrashReportingPreference(path.join(dir, "file-in-the-way"));
    fs.writeFileSync(path.join(dir, "file-in-the-way"), "x"); // a FILE where the directory should be
    expect(() => setCrashReportingEnabled(false)).toThrow();
    expect(isCrashReportingEnabled()).toBe(false);
  });
});

// ── the gate ────────────────────────────────────────────────────────────────

function memoryStore(seed: Envelope[] = []): OfflineStore {
  const queue = [...seed];
  return {
    push: async (env) => {
      queue.push(env);
    },
    unshift: async (env) => {
      queue.unshift(env);
    },
    shift: async () => queue.shift(),
  };
}

const eventEnvelope = (): Envelope =>
  createEnvelope({ event_id: "a".repeat(32) }, [[{ type: "event" }, { event_id: "a".repeat(32), message: "boom" }]]) as Envelope;
const replayEnvelope = (): Envelope =>
  // Built by hand: the replay item types are outside createEnvelope's typed union.
  [{ event_id: "b".repeat(32) }, [[{ type: "replay_event" }, { replay_id: "r" }]]] as unknown as Envelope;

interface Harness {
  networkSend: jest.Mock;
  store: OfflineStore;
  send: (env: Envelope) => PromiseLike<unknown>;
}

/** Build the offline transport exactly as installSentry does, around a fake network transport. */
function build(seed: Envelope[] = [], flushAtStartup = false): Harness {
  const networkSend = jest.fn(async () => ({ statusCode: 200 }));
  const makeNetwork = () => ({ send: networkSend, flush: async () => true });
  const store = memoryStore(seed);
  const transport = makeOfflineTransport(gateBaseTransport(makeNetwork) as never)({
    url: "https://o0.ingest.sentry.io/api/0/envelope/",
    recordDroppedEvent: () => undefined,
    flushAtStartup,
    createStore: () => store,
  } as never);
  return { networkSend, store, send: (env) => transport.send(env) };
}

describe("the transport gate", () => {
  it("ON: an event reaches the network (the gate is not vacuous)", async () => {
    loadCrashReportingPreference(dir);
    const h = build();
    await h.send(eventEnvelope());
    expect(h.networkSend).toHaveBeenCalledTimes(1);
  });

  it("OFF at launch: an event never reaches the network and is not queued", async () => {
    writePref(JSON.stringify({ enabled: false }));
    loadCrashReportingPreference(dir);
    const h = build();
    await h.send(eventEnvelope());
    expect(h.networkSend).not.toHaveBeenCalled();
    expect(await h.store.shift()).toBeUndefined();
  });

  it("OFF: a renderer replay envelope (bypasses beforeSend, main/ipc.js:96) never reaches the network", async () => {
    jest.useFakeTimers();
    writePref(JSON.stringify({ enabled: false }));
    loadCrashReportingPreference(dir);
    const h = build();
    await h.send(replayEnvelope());
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.networkSend).not.toHaveBeenCalled();
  });

  it("OFF: envelopes an earlier run left in the offline queue are not sent at startup", async () => {
    jest.useFakeTimers();
    writePref(JSON.stringify({ enabled: false }));
    loadCrashReportingPreference(dir);
    const h = build([eventEnvelope(), eventEnvelope()], true);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.networkSend).not.toHaveBeenCalled();
  });

  it("control for the case above: ON, the same queue IS sent at startup", async () => {
    jest.useFakeTimers();
    loadCrashReportingPreference(dir);
    const h = build([eventEnvelope(), eventEnvelope()], true);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.networkSend).toHaveBeenCalledTimes(2);
  });

  it("turned OFF mid-session: the next event is not sent, with no restart", async () => {
    loadCrashReportingPreference(dir);
    const h = build();
    await h.send(eventEnvelope());
    expect(h.networkSend).toHaveBeenCalledTimes(1);

    setCrashReportingEnabled(false);
    await h.send(eventEnvelope());
    expect(h.networkSend).toHaveBeenCalledTimes(1);
  });
});
