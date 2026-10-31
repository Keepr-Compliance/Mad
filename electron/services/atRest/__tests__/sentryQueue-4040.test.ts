/**
 * @jest-environment node
 */

/**
 * BACKLOG-4040 S3 — the Sentry offline queue at rest.
 *
 * Driven through the REAL `makeElectronOfflineTransport` (`@sentry/electron`
 * 7.15, loaded by file path because jest maps the package name to a stub) and
 * the REAL `@sentry/core` offline wrapper, with the exact `Sentry.init` options
 * `installSentry.ts` builds. Only the network transport is replaced.
 *
 *   G1  runtime guard: every file under userData/sentry is KEPRENC and no file
 *       holds the marker (any extension — the stock bodies have none). Q1 at
 *       614794fae: red, `sentry/queue/<uuid>` held the marker.
 *   G2  plaintext queue left by 2.41 / 2.42 is deleted at install (also with
 *       crash reporting OFF).
 *   G3  key closed: nothing reaches disk; shift() neither reads nor deletes
 *       the sealed files a previous run left.
 *   G4  an event still sends: online, straight to the network; queued while
 *       offline, sent after the key opens, byte-for-byte the same event.
 *   G5  breadcrumbs of every category lose emails and phone numbers before the
 *       scope (= scope_v3.json) holds them.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { addBreadcrumb, createEnvelope, getCurrentScope, getIsolationScope, parseEnvelope, serializeEnvelope } from "@sentry/core";
import type { Envelope } from "@sentry/core";
import { createFileCrypto, MAGIC, type FileCrypto, type KeyResolver } from "../fileCrypto";
import { sealedQueueDir } from "../sentrySealedQueue";

type QueueModule = typeof import("../sentrySealedQueue");
/** The queue module instance installSentry.ts loaded (jest.isolateModules gives it its own registry). */
let queue: QueueModule | null = null;
function activateSentrySealedQueue(f: FileCrypto): Promise<void> {
  if (!queue) throw new Error("installSentry not loaded");
  return queue.activateSentrySealedQueue(f);
}

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const SENTRY_PKG = path.join(REPO, "node_modules/@sentry/electron/main");
const REAL_OFFLINE_NET = path.join(SENTRY_PKG, "transports/electron-offline-net.js");
const REAL_STORE = path.join(SENTRY_PKG, "store.js");
const MARKER_EMAIL = "jane@example.com";
const MARKER_EMAIL_LOCAL = "jane@";
const MARKER_PHONE = "+1 (555) 555-0199";
const MARKER_PHONE_TAIL = "555-0199";
/** Library-written files with no hook: allowed as plaintext, never with a marker. */
const REDACTED_PLAINTEXT = new Set(["sentry/scope_v3.json", "sentry/session.json"]);

const KEY = Buffer.alloc(32, 7);
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: "a".repeat(32), key: KEY }),
  keyFor: async (id) => {
    if (id !== "a".repeat(32)) throw new Error("unknown key");
    return KEY;
  },
};
const files: FileCrypto = createFileCrypto(resolver);

let userData: string;

/*
 * CI runs jest under plain node; locally it runs under Electron-as-node. The real
 * @sentry/electron modules parse process.versions.electron at load, and the
 * packaged branch of installSentry reads process.resourcesPath. Give both a value
 * for every test and restore them after, so the suite behaves the same in both.
 */
const hadElectronVersion = Object.prototype.hasOwnProperty.call(process.versions, "electron");
const hadResourcesPath = Object.prototype.hasOwnProperty.call(process, "resourcesPath");
const previousResourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
beforeAll(() => {
  if (!hadElectronVersion) Object.defineProperty(process.versions, "electron", { value: "38.8.6", configurable: true });
  Object.defineProperty(process, "resourcesPath", { value: "/unused-resources", configurable: true, writable: true });
});
afterAll(() => {
  if (!hadElectronVersion) delete (process.versions as { electron?: string }).electron;
  if (hadResourcesPath) {
    Object.defineProperty(process, "resourcesPath", { value: previousResourcesPath, configurable: true, writable: true });
  } else {
    delete (process as unknown as { resourcesPath?: string }).resourcesPath;
  }
});

beforeEach(() => {
  queue = null;
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4040-s3-"));
});
afterEach(() => {
  queue?.resetSentrySealedQueueForTests();
  fs.rmSync(userData, { recursive: true, force: true });
});

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(userData, p).split(path.sep).join("/");

/** G1: the at-rest rule for the whole sentry directory. Returns the violations. */
function sentryDirViolations(): string[] {
  const bad: string[] = [];
  for (const f of walk(path.join(userData, "sentry"))) {
    const bytes = fs.readFileSync(f);
    const r = rel(f);
    if (bytes.includes(MARKER_EMAIL_LOCAL) || bytes.includes(MARKER_PHONE_TAIL)) bad.push(`${r}: holds the marker`);
    if (!REDACTED_PLAINTEXT.has(r) && !bytes.subarray(0, MAGIC.length).equals(MAGIC)) bad.push(`${r}: not KEPRENC`);
  }
  return bad;
}

function markerEnvelope(n = 0): Envelope {
  const id = String(n).padStart(32, "0");
  return createEnvelope({ event_id: id, sent_at: new Date().toISOString() }, [
    [{ type: "event" }, { event_id: id, message: `failed for ${MARKER_EMAIL} ${MARKER_PHONE}` }],
  ] as never) as Envelope;
}

type Transport = { send: (e: Envelope) => Promise<unknown>; flush: (t?: number) => PromiseLike<boolean> };
interface Loaded {
  transport: Transport;
  network: { online: boolean; sent: Envelope[] };
  logError: jest.Mock;
}

/** Evaluate installSentry.ts for real (only init and the network transport are stubbed). */
function loadInstallSentry(opts: { crashReportingFile?: string } = {}): Loaded {
  const init = jest.fn();
  const network = { online: false, sent: [] as Envelope[] };
  const logError = jest.fn();
  let transportRef: Transport | null = null;
  if (opts.crashReportingFile !== undefined) {
    fs.writeFileSync(path.join(userData, "crash-reporting.json"), opts.crashReportingFile);
  }
  jest.isolateModules(() => {
    jest.doMock("electron", () => ({
      app: { isPackaged: true, getVersion: () => "0.0.0", getPath: () => userData },
    }));
    jest.doMock("electron-log", () => {
      const m = { error: logError, warn: jest.fn(), info: jest.fn() };
      return { ...m, default: m };
    });
    jest.doMock("@sentry/electron/main", () => ({
      init,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      makeElectronOfflineTransport: require(REAL_OFFLINE_NET).makeElectronOfflineTransport,
      makeElectronTransport: () => ({
        send: async (env: Envelope) => {
          if (!network.online) throw new Error("offline");
          network.sent.push(env);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
      getClient: () => ({ getTransport: () => transportRef }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../../../bootstrap/installSentry");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    queue = require("../sentrySealedQueue");
  });
  jest.dontMock("electron");
  jest.dontMock("electron-log");
  jest.dontMock("@sentry/electron/main");
  expect(init).toHaveBeenCalledTimes(1);
  const o = init.mock.calls[0][0] as { transport: (x: unknown) => Transport; transportOptions?: object };
  // What the core Client constructor does (client.js: `{ ...options.transportOptions, url }`).
  transportRef = o.transport({
    ...(o.transportOptions ?? {}),
    url: "https://o0.ingest.sentry.io/api/0/envelope/",
    recordDroppedEvent: () => undefined,
  });
  return { transport: transportRef, network, logError };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function sealedFileOnDisk(): Promise<string> {
  const dir = sealedQueueDir(userData);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${String(Date.now()).padStart(13, "0")}-${"b".repeat(32)}.sealed`);
  const s = serializeEnvelope(markerEnvelope(9));
  await files.encryptStreamToFile(Readable.from([Buffer.from(s as string)]), p);
  return p;
}

describe("G1 runtime guard: no plaintext under sentry/ (Q1)", () => {
  it("a failed send while the key is closed writes nothing; after it opens, only sealed files", async () => {
    const { transport } = loadInstallSentry();
    await transport.send(markerEnvelope(1));
    expect(walk(path.join(userData, "sentry"))).toEqual([]);

    await activateSentrySealedQueue(files);
    await transport.send(markerEnvelope(2));
    const all = walk(path.join(userData, "sentry"));
    expect(all.map(rel).every((r) => r.startsWith("sentry/sealed-queue/"))).toBe(true);
    expect(all).toHaveLength(2); // the held one + the new one
    expect(sentryDirViolations()).toEqual([]);
  });

  it("the guard sees a plaintext writer (positive control on the scanner)", () => {
    fs.mkdirSync(path.join(userData, "sentry", "queue"), { recursive: true });
    fs.writeFileSync(path.join(userData, "sentry", "queue", "d3619d68"), `{"message":"${MARKER_EMAIL}"}`);
    fs.writeFileSync(path.join(userData, "sentry", "scope_v3.json"), "{}");
    expect(sentryDirViolations()).toEqual(["sentry/queue/d3619d68: holds the marker", "sentry/queue/d3619d68: not KEPRENC"]);
  });
});

describe("G2: the plaintext queue from 2.41 / 2.42 is deleted", () => {
  function seedLegacy(): string {
    const q = path.join(userData, "sentry", "queue");
    fs.mkdirSync(q, { recursive: true });
    fs.writeFileSync(path.join(q, "d3619d6820c74192b363bf2adeecc146"), `{"message":"${MARKER_EMAIL}"}`);
    fs.writeFileSync(path.join(q, "queue-v2.json"), JSON.stringify([{ id: "d3619d6820c74192b363bf2adeecc146", date: new Date() }]));
    return q;
  }

  it("at install, before anything is sent", () => {
    const q = seedLegacy();
    loadInstallSentry();
    expect(fs.existsSync(q)).toBe(false);
    expect(sentryDirViolations()).toEqual([]);
  });

  it("also when Send crash reports is OFF", () => {
    const q = seedLegacy();
    loadInstallSentry({ crashReportingFile: JSON.stringify({ enabled: false }) });
    expect(fs.existsSync(q)).toBe(false);
  });

  it("scope_v3.json and session.json are left in place (redacted, not deleted)", () => {
    seedLegacy();
    fs.writeFileSync(path.join(userData, "sentry", "scope_v3.json"), "{}");
    fs.writeFileSync(path.join(userData, "sentry", "session.json"), "{}");
    loadInstallSentry();
    expect(walk(path.join(userData, "sentry")).map(rel).sort()).toEqual(["sentry/scope_v3.json", "sentry/session.json"]);
  });
});

describe("G3: while the key is closed, sealed files are kept", () => {
  it("the startup flush's shift() returns nothing and leaves a previous run's sealed file untouched", async () => {
    const p = await sealedFileOnDisk();
    const before = fs.readFileSync(p);
    const { transport, network } = loadInstallSentry();
    network.online = true;
    // flush() with no timeout = the wrapper's flushIn(100) → store.shift().
    await transport.flush();
    await new Promise((r) => setTimeout(r, 400));
    expect(network.sent).toHaveLength(0);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });

  it("a sealed file whose key is not held is kept even after the queue opens", async () => {
    const p = await sealedFileOnDisk();
    const otherKey: KeyResolver = {
      currentKey: async () => ({ keyId: "c".repeat(32), key: Buffer.alloc(32, 1) }),
      keyFor: async () => {
        throw new Error("No file-data key with that id is held on this computer");
      },
    };
    const { transport, network } = loadInstallSentry();
    network.online = true;
    await activateSentrySealedQueue(createFileCrypto(otherKey));
    await new Promise((r) => setTimeout(r, 400));
    expect(network.sent).toHaveLength(0);
    expect(fs.existsSync(p)).toBe(true);
    void transport;
  });
});

describe("G4: crash reporting still sends", () => {
  it("online: the event goes straight to the network and nothing is written", async () => {
    const { transport, network } = loadInstallSentry();
    network.online = true;
    await activateSentrySealedQueue(files);
    await transport.send(markerEnvelope(3));
    expect(network.sent).toHaveLength(1);
    expect(walk(path.join(userData, "sentry"))).toEqual([]);
  });

  it("offline, then the key opens and the network is back: the queued event is sent, unchanged, and its file removed", async () => {
    const { transport, network } = loadInstallSentry();
    const env = markerEnvelope(4);
    await transport.send(env); // offline, key closed: held in memory
    network.online = true;
    await activateSentrySealedQueue(files); // seals it, then asks the transport to flush
    await waitFor(() => network.sent.length === 1);
    const sent = network.sent[0];
    expect(sent[1]).toEqual(env[1]);
    expect(walk(sealedQueueDir(userData))).toEqual([]);
  });

  it("a report sealed by a previous run is sent after the key opens", async () => {
    const p = await sealedFileOnDisk();
    const { network } = loadInstallSentry();
    network.online = true;
    await activateSentrySealedQueue(files);
    await waitFor(() => network.sent.length === 1);
    expect(JSON.stringify(network.sent[0][1])).toContain(MARKER_EMAIL);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("round trip of the sealed format: serialize -> seal -> open -> parse", async () => {
    const p = await sealedFileOnDisk();
    const env = parseEnvelope(await files.readAllDecrypted(p, { requireEncrypted: true }));
    expect(env[1]).toEqual(markerEnvelope(9)[1]);
  });
});

describe("G5: every breadcrumb category is scrubbed before the scope holds it (scope_v3.json)", () => {
  const CATEGORIES = [
    { category: "console", message: `user ${MARKER_EMAIL} called ${MARKER_PHONE}` },
    { category: "electron.net", type: "http", data: { url: `https://x.example/a?e=${MARKER_EMAIL}`, method: "GET" } },
    { category: "electron-log", message: "sync", data: { who: MARKER_EMAIL, phone: MARKER_PHONE } },
    { category: "navigation", data: { from: `/c/${MARKER_EMAIL}`, to: `/t?p=${MARKER_PHONE}` } },
    { category: "keepr.custom", message: "x", data: { nested: { list: [MARKER_EMAIL, MARKER_PHONE] } } },
  ];

  it("through core addBreadcrumb with installSentry's beforeBreadcrumb, then persisted with the library's own Store", async () => {
    const init = jest.fn();
    jest.isolateModules(() => {
      jest.doMock("electron", () => ({ app: { isPackaged: true, getVersion: () => "0", getPath: () => userData } }));
      jest.doMock("@sentry/electron/main", () => ({
        init,
        makeElectronOfflineTransport: () => () => undefined,
        makeElectronTransport: () => undefined,
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../../bootstrap/installSentry");
    });
    jest.dontMock("electron");
    jest.dontMock("@sentry/electron/main");
    const { beforeBreadcrumb } = init.mock.calls[0][0] as { beforeBreadcrumb: (b: unknown) => unknown };

    getIsolationScope().clearBreadcrumbs();
    getCurrentScope().setClient({ getOptions: () => ({ beforeBreadcrumb, maxBreadcrumbs: 100 }), emit: () => undefined } as never);
    try {
      for (const b of CATEGORIES) addBreadcrumb(b);
      const data = getIsolationScope().getScopeData();
      expect(data.breadcrumbs).toHaveLength(CATEGORIES.length);
      // The minidump integration's own persistence (sentry-minidump/index.js:36-48).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Store } = require(REAL_STORE);
      await new Store(path.join(userData, "sentry"), "scope_v3", {}).set({ scope: data });
      const text = fs.readFileSync(path.join(userData, "sentry", "scope_v3.json"), "utf8");
      expect(text).toContain("keepr.custom"); // the file really holds the breadcrumbs
      expect(text).not.toContain(MARKER_EMAIL_LOCAL);
      expect(text).not.toContain(MARKER_PHONE_TAIL);
      expect(sentryDirViolations()).toEqual([]);
    } finally {
      getCurrentScope().setClient(undefined);
      getIsolationScope().clearBreadcrumbs();
    }
  });
});

describe("G6: the at-rest startup job opens the queue (and only with a key)", () => {
  type Job = { id: string; run: (ctx: { log: (l: string, m: string) => void }) => Promise<void> };

  type KeyErr = new (m: string) => Error;
  function loadJob(makeCurrentKey: (E: KeyErr) => () => Promise<unknown>): { job: Job; q: QueueModule } {
    let job: Job | undefined;
    let q!: QueueModule;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const real = jest.requireActual("../dataKeyService");
      const currentKey = makeCurrentKey(real.DataKeyUnavailableError);
      jest.doMock("../dataKeyService", () => ({
        ...real,
        getDataKeyService: () => ({ currentKey }),
        getAtRestFiles: () => files,
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const startup = require("../startup");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      q = require("../sentrySealedQueue");
      const jobs: Job[] = [];
      startup.registerDefaultJobs({ register: (j: Job) => jobs.push(j) });
      job = jobs.find((j) => j.id === "sentry-queue");
    });
    jest.dontMock("../dataKeyService");
    if (!job) throw new Error("no sentry-queue job");
    q.configureSentrySealedQueue(userData);
    return { job, q };
  }

  it("key opens -> the queue is sealed-on-disk from then on", async () => {
    const { job, q } = loadJob(() => async () => ({ keyId: "a".repeat(32), key: KEY }));
    expect(q.isSentrySealedQueueActive()).toBe(false);
    await job.run({ log: () => undefined });
    expect(q.isSentrySealedQueueActive()).toBe(true);
    q.resetSentrySealedQueueForTests();
  });

  it("key unavailable -> the queue stays in memory, nothing on disk, the job does not fail", async () => {
    const log = jest.fn();
    const { job, q } = loadJob((E) => async () => {
      throw new E("secure storage unavailable");
    });
    await job.run({ log });
    expect(q.isSentrySealedQueueActive()).toBe(false);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("sentry-queue: data key unavailable"));
    q.resetSentrySealedQueueForTests();
  });
});
