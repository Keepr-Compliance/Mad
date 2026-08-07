/**
 * @jest-environment node
 *
 * BACKLOG-2576 — REPRODUCTION GATE. This file is an experiment, not a fix.
 *
 * ===========================================================================
 * WHY A GATE
 * ===========================================================================
 * The item's chain is: timeout -> unhandled rejection -> no error reached the
 * UI -> eternal "Loading contacts...". The founder's observation is not in
 * doubt. The CHAIN is: at this tip the backfill rejection is `.catch()`ed, both
 * renderer loading flags clear in a `finally`, and the scheduler's `run()` is
 * awaited inside a try/catch. An `ipcMain.handle` whose promise rejects
 * surfaces as a rejected `invoke`, which the renderer catches and turns into an
 * error state.
 *
 * So the question this file answers, BEFORE any fix is written, is:
 *
 *   1. When a worker query times out, does anything escape as an unhandled
 *      rejection — and from WHERE?
 *   2. Does the IPC handler still SETTLE? (A hang needs something that never
 *      settles; a timeout alone does not produce one.)
 *
 * Building the three wanted behaviours against an unproven chain is the
 * 2026-08-04 shape: a root cause briefed, built and decided on before anyone
 * ran the real path.
 *
 * Timeouts are driven through `timeoutMs` — a real parameter of
 * `queryContacts` — rather than by sleeping 30 s or by faking timers in a way
 * that stops proving anything.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";
import { appendFileSync } from "fs";

/** Jest's config swallows console here, so findings go to a file. */
const OUT = "/tmp/repro2576.txt";
function record(label: string, data: unknown): void {
  appendFileSync(OUT, `${label} ${JSON.stringify(data, null, 2)}\n`);
}

const registeredHandlers = new Map<string, any>();

/** Which query types should reject as if they had timed out. */
let rejectTypes = new Set<string>();
let poolReady = true;
const queryCalls: string[] = [];

jest.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: any) => registeredHandlers.set(channel, fn) },
  app: { getPath: jest.fn(() => "/tmp") },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));

jest.mock("../workers/contactWorkerPool", () => ({
  __esModule: true,
  isPoolReady: () => poolReady,
  queryContacts: (type: string, _userId: string, timeoutMs = 30_000) => {
    queryCalls.push(type);
    if (rejectTypes.has(type)) {
      // The REAL message and the real shape: contactWorkerPool rejects with
      // exactly this on timeout.
      return Promise.reject(
        new Error(`Contact query timed out after ${timeoutMs}ms (type: ${type})`),
      );
    }
    return Promise.resolve([]);
  },
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getImportedContactsByUserIdAsync: jest.fn(async () => []),
    getImportedContactsByUserId: jest.fn(async () => []),
    getRemovedContactIdentifiers: jest.fn(async () => []),
    getUnimportedContactsByUserId: jest.fn(async () => []),
    getUserById: jest.fn(async (id: string) => ({ id })),
    isInitialized: jest.fn(() => true),
    backfillContactEmails: jest.fn(async () => 0),
    backfillContactPhones: jest.fn(async () => 0),
  },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logContactAction: jest.fn() },
}));

jest.mock("../utils/preferenceHelper", () => ({
  __esModule: true,
  isContactSourceEnabled: jest.fn(async () => true),
}));

jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(async () => ({
    phoneToContactInfo: {},
    contacts: [],
    status: { loaded: true },
  })),
}));

jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), fetchContacts: jest.fn() },
}));

jest.mock("../services/contactSyncService", () => ({
  __esModule: true,
  default: { registerProvider: jest.fn(), sync: jest.fn() },
}));

import { registerContactHandlers } from "../handlers/contactHandlers";

const USER = "550e8400-e29b-41d4-a716-446655440000";
const mockEvent = {} as IpcMainInvokeEvent;

/**
 * Run `fn` while watching for unhandled rejections.
 *
 * Jest installs its own handler, so this records rather than relies on the
 * default crash behaviour. The macrotask turn at the end is what gives an
 * escaped rejection time to be reported.
 */
async function watchingForUnhandledRejections<T>(
  fn: () => Promise<T>,
): Promise<{ result: T | undefined; threw: unknown; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let result: T | undefined;
  let threw: unknown;
  try {
    result = await fn();
  } catch (e) {
    threw = e;
  }
  await new Promise((r) => setTimeout(r, 50));
  process.off("unhandledRejection", onUnhandled);
  return { result, threw, unhandled };
}

/** Did the handler settle at all? A hang is the thing under investigation. */
async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<"settled" | "hung"> {
  return Promise.race([
    p.then(() => "settled" as const).catch(() => "settled" as const),
    new Promise<"hung">((r) => setTimeout(() => r("hung"), ms)),
  ]);
}

beforeEach(() => {
  registeredHandlers.clear();
  rejectTypes = new Set();
  queryCalls.length = 0;
  poolReady = true;
  jest.clearAllMocks();
  registerContactHandlers({} as any);
});

describe("BACKLOG-2576 reproduction — what a timed-out query actually does", () => {
  it("EXPERIMENT 1: contacts:get-all when the BACKFILL query times out", async () => {
    rejectTypes = new Set(["backfill"]);
    const handler = registeredHandlers.get("contacts:get-all");

    const { result, threw, unhandled } = await watchingForUnhandledRejections(() =>
      handler(mockEvent, USER),
    );

    record("[E1 get-all / backfill timeout]", {
      settled: threw === undefined,
      success: (result as any)?.success,
      threw: threw instanceof Error ? threw.message : threw,
      unhandled: unhandled.map((u) => (u instanceof Error ? u.message : String(u))),
      queryCalls: [...queryCalls],
    });

    expect(true).toBe(true);
  });

  it("EXPERIMENT 2: contacts:get-available when the EXTERNAL query times out", async () => {
    rejectTypes = new Set(["external"]);
    const handler = registeredHandlers.get("contacts:get-available");
    if (!handler) {
      record("[E2] no handler", {});
      return;
    }

    const { result, threw, unhandled } = await watchingForUnhandledRejections(() =>
      handler(mockEvent, USER),
    );

    record("[E2 get-available / external timeout]", {
      settled: threw === undefined,
      success: (result as any)?.success,
      error: (result as any)?.error,
      threw: threw instanceof Error ? threw.message : threw,
      unhandled: unhandled.map((u) => (u instanceof Error ? u.message : String(u))),
      queryCalls: [...queryCalls],
    });

    expect(true).toBe(true);
  });

  it("EXPERIMENT 3: does either handler HANG rather than settle?", async () => {
    rejectTypes = new Set(["backfill", "external", "imported"]);

    const getAll = registeredHandlers.get("contacts:get-all");
    const getAvailable = registeredHandlers.get("contacts:get-available");

    const a = await settlesWithin(Promise.resolve(getAll(mockEvent, USER)), 2000);
    const b = getAvailable
      ? await settlesWithin(Promise.resolve(getAvailable(mockEvent, USER)), 2000)
      : "n/a";

    record("[E3 settle check]", { getAll: a, getAvailable: b });

    expect(true).toBe(true);
  });
});
