/**
 * `Sentry.init` RUNS BEFORE THE COMPOSITION ROOT, AND ITS OPTIONS DID NOT MOVE
 * (BACKLOG-2962).
 *
 * The init call was cut from `electron/main.ts:223` and pasted into
 * `electron/bootstrap/installSentry.ts`, which `main.ts` imports between the
 * app-data override and the composition root. Two things can go wrong with a
 * cut-and-paste that `tsc` cannot see: an option drifts (a key dropped, a
 * branch inverted), or the import lands in the wrong place. The first block
 * pins every option on both `app.isPackaged` branches; the last case pins the
 * position in the real `main.ts` and that `main.ts` no longer calls `init`
 * itself.
 *
 * The dotenv block moved with the init because `dsn` reads `SENTRY_DSN`, and
 * dotenv is what sets it. Moving it one directory deeper changed the relative
 * path, so the paths are pinned against the REPOSITORY ROOT, not against
 * `__dirname` — a test that repeated the module's own `../../` would pass
 * with the depth wrong.
 */

import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const MAIN_TS = path.join(REPO_ROOT, "electron", "main.ts");
const INSTALL_SENTRY_TS = path.join(REPO_ROOT, "electron", "bootstrap", "installSentry.ts");

const PINNED_VERSION = "7.7.7-pin";

interface Loaded {
  init: jest.Mock;
  dotenvConfig: jest.Mock;
  scrub: jest.Mock;
  logError: jest.Mock;
  makeOffline: jest.Mock;
  makeNetwork: jest.Mock;
  networkSend: jest.Mock;
  pref: typeof import("../../services/crashReportingPreference");
}

type ProcessWithResources = { resourcesPath?: string };

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Evaluate `installSentry.ts` in a fresh registry with every input controlled.
 *
 * @param options.dsn `undefined` removes SENTRY_DSN from the environment; a
 *   string sets it. dotenv is mocked and sets nothing, so whatever the module
 *   sees is exactly this.
 */
function load(options: {
  isPackaged: boolean;
  dsn?: string;
  resourcesPath?: string;
  scrubThrows?: boolean;
  /** BACKLOG-3668: the updater scrub hands the event on unchanged (so the RCS scrub after it is seen). */
  scrubPassThrough?: boolean;
  /** BACKLOG-3801: contents of userData/crash-reporting.json; undefined = no file. */
  crashReportingFile?: string;
}): Loaded {
  const init = jest.fn();
  const dotenvConfig = jest.fn();
  const scrub = jest.fn((event: unknown) => {
    if (options.scrubThrows) throw new Error("scrub failed");
    if (options.scrubPassThrough) return event;
    return { scrubbed: event };
  });
  const logError = jest.fn();
  const networkSend = jest.fn(async () => ({ statusCode: 200 }));
  const makeNetwork = jest.fn(() => ({ send: networkSend, flush: async () => true }));
  // Identity: hands back the (gated) base factory it was given, so a test can
  // build the network transport exactly as the offline wrapper would.
  const makeOffline = jest.fn((base: unknown) => base);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3801-is-"));
  tempDirs.push(userData);
  if (options.crashReportingFile !== undefined) {
    fs.writeFileSync(path.join(userData, "crash-reporting.json"), options.crashReportingFile);
  }
  let pref!: Loaded["pref"];

  const previousDsn = process.env.SENTRY_DSN;
  if (options.dsn === undefined) {
    delete process.env.SENTRY_DSN;
  } else {
    process.env.SENTRY_DSN = options.dsn;
  }
  const proc = process as unknown as ProcessWithResources;
  const hadResourcesPath = Object.prototype.hasOwnProperty.call(process, "resourcesPath");
  const previousResourcesPath = proc.resourcesPath;
  Object.defineProperty(process, "resourcesPath", {
    value: options.resourcesPath ?? "/unused-resources",
    configurable: true,
    writable: true,
  });

  try {
    jest.isolateModules(() => {
      jest.doMock("electron", () => ({
        app: {
          isPackaged: options.isPackaged,
          getVersion: () => PINNED_VERSION,
          getPath: (name: string) => (name === "userData" ? userData : `/unused-${name}`),
        },
      }));
      jest.doMock("dotenv", () => {
        const mock = { config: dotenvConfig };
        return { ...mock, default: mock };
      });
      jest.doMock("electron-log", () => {
        const mock = { error: logError };
        return { ...mock, default: mock };
      });
      jest.doMock("@sentry/electron/main", () => ({
        init,
        makeElectronOfflineTransport: makeOffline,
        makeElectronTransport: makeNetwork,
      }));
      jest.doMock("../../services/updateDiagnostics", () => ({
        scrubUpdaterEventPII: scrub,
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../installSentry");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pref = require("../../services/crashReportingPreference");
    });
  } finally {
    if (previousDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = previousDsn;
    }
    if (hadResourcesPath) {
      Object.defineProperty(process, "resourcesPath", {
        value: previousResourcesPath,
        configurable: true,
        writable: true,
      });
    } else {
      delete proc.resourcesPath;
    }
    jest.dontMock("electron");
    jest.dontMock("dotenv");
    jest.dontMock("electron-log");
    jest.dontMock("@sentry/electron/main");
    jest.dontMock("../../services/updateDiagnostics");
  }

  return { init, dotenvConfig, scrub, logError, makeOffline, makeNetwork, networkSend, pref };
}

type InitOptions = {
  dsn: string | undefined;
  environment: string;
  release: string;
  enabled: boolean;
  transport: unknown;
  beforeBreadcrumb: (breadcrumb: unknown) => unknown;
  beforeSend: (event: unknown) => unknown;
};

function initOptions(loaded: Loaded): InitOptions {
  expect(loaded.init).toHaveBeenCalledTimes(1);
  return loaded.init.mock.calls[0][0] as InitOptions;
}

describe("installSentry: the init call transcribed from main.ts (BACKLOG-2962)", () => {
  it("passes exactly the five options main.ts passed, plus transport (BACKLOG-3801) and beforeBreadcrumb (BACKLOG-3768), in order", () => {
    const options = initOptions(load({ isPackaged: false }));
    // `Object.keys` order is insertion order — a dropped, added or reordered
    // key reds here before any value is looked at.
    expect(Object.keys(options)).toEqual(["dsn", "environment", "release", "enabled", "transport", "beforeBreadcrumb", "beforeSend"]);
  });

  it("BACKLOG-3768: beforeBreadcrumb drops the query from an electron.net breadcrumb", () => {
    const options = initOptions(load({ isPackaged: false }));
    // Shape measured from @sentry/electron main (scratchpad 3768-eng/probe-bc.js).
    const out = options.beforeBreadcrumb({
      category: "electron.net",
      type: "http",
      data: { url: "https://x.supabase.co/rest/v1/users?email=eq.jane@example.com", method: "GET", status_code: 200 },
    }) as { data: { url: string } };
    expect(out.data.url).toBe("https://x.supabase.co/rest/v1/users");
  });

  it("development without SENTRY_DSN: disabled, no dsn, environment development, release from app.getVersion()", () => {
    const options = initOptions(load({ isPackaged: false, dsn: undefined }));
    expect(options.dsn).toBeUndefined();
    expect(options.environment).toBe("development");
    expect(options.release).toBe(PINNED_VERSION);
    expect(options.enabled).toBe(false);
  });

  it("development WITH SENTRY_DSN (the founder's .env.development): enabled, dsn passed through", () => {
    const dsn = "https://public@o0.ingest.sentry.io/0";
    const options = initOptions(load({ isPackaged: false, dsn }));
    expect(options.dsn).toBe(dsn);
    expect(options.environment).toBe("development");
    expect(options.enabled).toBe(true);
  });

  it("packaged: enabled even without a DSN in the environment, environment production", () => {
    // dotenv is mocked and sets nothing, so this is the `app.isPackaged`
    // half of the `enabled` expression on its own.
    const options = initOptions(load({ isPackaged: true, dsn: undefined }));
    expect(options.dsn).toBeUndefined();
    expect(options.environment).toBe("production");
    expect(options.release).toBe(PINNED_VERSION);
    expect(options.enabled).toBe(true);
  });

  it("beforeSend hands the event to scrubUpdaterEventPII and returns its result", () => {
    const loaded = load({ isPackaged: false });
    const { beforeSend } = initOptions(loaded);
    const event = { message: "raw" };

    const result = beforeSend(event);

    expect(loaded.scrub).toHaveBeenCalledTimes(1);
    expect(loaded.scrub).toHaveBeenCalledWith(event);
    expect(result).toEqual({ scrubbed: event });
    expect(loaded.logError).not.toHaveBeenCalled();
  });

  it("beforeSend returns the event UNSCRUBBED and logs when the scrub throws — never drops it", () => {
    const loaded = load({ isPackaged: false, scrubThrows: true });
    const { beforeSend } = initOptions(loaded);
    const event = { message: "raw" };

    const result = beforeSend(event);

    expect(result).toBe(event);
    expect(loaded.logError).toHaveBeenCalledTimes(1);
    expect(loaded.logError.mock.calls[0][0]).toContain("[Sentry] beforeSend PII scrub failed");
    expect(loaded.logError.mock.calls[0][1]).toBeInstanceOf(Error);
  });
});

// BACKLOG-3668 L3. Mutations: the RCS scrub not called in beforeSend, or run
// on every event → red.
describe("installSentry: RCS events are scrubbed after the updater scrub", () => {
  it("an RCS-tagged event loses phone numbers and emails; an untagged one is untouched", () => {
    const loaded = load({ isPackaged: false, scrubPassThrough: true });
    const { beforeSend } = initOptions(loaded);
    const rcs = beforeSend({ tags: { component: "rcs" }, message: "chat with +1 (555) 555-0199 sam@example.com failed" }) as { message: string };
    expect(loaded.scrub).toHaveBeenCalledTimes(1);
    expect(rcs.message).not.toContain("555");
    expect(rcs.message).not.toContain("sam@");
    const other = { tags: { component: "sync" }, message: "chat with +1 (555) 555-0199 failed" };
    expect(beforeSend(other)).toBe(other);
  });
});

describe("installSentry: the dotenv block that moved with it", () => {
  it("packaged: loads .env.production from process.resourcesPath, and nothing else", () => {
    const { dotenvConfig } = load({ isPackaged: true, resourcesPath: "/Applications/Keepr.app/Contents/Resources" });

    expect(dotenvConfig).toHaveBeenCalledTimes(1);
    expect(dotenvConfig).toHaveBeenCalledWith({
      path: path.join("/Applications/Keepr.app/Contents/Resources", ".env.production"),
    });
  });

  it("development: loads .env.development then .env.local from the REPOSITORY ROOT — the block is one directory deeper than it was", () => {
    const { dotenvConfig } = load({ isPackaged: false });

    expect(dotenvConfig).toHaveBeenCalledTimes(2);
    // Pinned against the repository root, not against the module's own
    // `__dirname`: the move changed `../` to `../../`, and a test that
    // repeated the module's arithmetic would pass with the depth wrong.
    expect(dotenvConfig.mock.calls[0][0]).toEqual({ path: path.join(REPO_ROOT, ".env.development") });
    expect(dotenvConfig.mock.calls[1][0]).toEqual({ path: path.join(REPO_ROOT, ".env.local") });
  });

  it("loads the environment BEFORE calling init, so dsn can see SENTRY_DSN", () => {
    const { dotenvConfig, init } = load({ isPackaged: false });

    expect(dotenvConfig.mock.invocationCallOrder[1]).toBeLessThan(init.mock.invocationCallOrder[0]);
  });
});

describe("installSentry: where main.ts imports it", () => {
  /** Specifiers of every top-level `import` in `main.ts`, in source order. */
  function topLevelImportSpecifiers(): string[] {
    const source = ts.createSourceFile(MAIN_TS, fs.readFileSync(MAIN_TS, "utf8"), ts.ScriptTarget.Latest, true);
    return source.statements
      .filter((s): s is ts.ImportDeclaration => ts.isImportDeclaration(s))
      .map((s) => (s.moduleSpecifier as ts.StringLiteral).text);
  }

  it("after the app-data override and before the composition root — the two placements its header traces", () => {
    const specifiers = topLevelImportSpecifiers();
    const appData = specifiers.indexOf("./bootstrap/installAppDataPaths");
    const sentry = specifiers.indexOf("./bootstrap/installSentry");
    const compositionRoot = specifiers.indexOf("./bootstrap/installNativeCapabilities");

    expect(appData).toBeGreaterThanOrEqual(0);
    expect(sentry).toBeGreaterThanOrEqual(0);
    expect(compositionRoot).toBeGreaterThanOrEqual(0);
    // The offline transport reads `userData` at init: after the override.
    expect(sentry).toBeGreaterThan(appData);
    // The fatal path captures: before the composition root.
    expect(sentry).toBeLessThan(compositionRoot);
  });

  it("main.ts no longer calls Sentry.init itself, and installSentry.ts calls it exactly once", () => {
    const main = fs.readFileSync(MAIN_TS, "utf8");
    const installSentry = fs.readFileSync(INSTALL_SENTRY_TS, "utf8");

    expect(main.includes("Sentry.init({")).toBe(false);
    expect(installSentry.split("Sentry.init({").length - 1).toBe(1);
  });
});

// BACKLOG-3801: the "Send crash reports" switch. installSentry is the only
// place it can act before anything is sent: it runs before app ready, and
// every main AND renderer envelope leaves through the transport built here.
describe("installSentry: the crash reporting switch (BACKLOG-3801)", () => {
  type Net = { send: (env: unknown) => Promise<unknown> };

  /** The network transport installSentry hands to the offline wrapper. */
  function networkTransport(loaded: Loaded): Net {
    const options = initOptions(loaded);
    expect(loaded.makeOffline).toHaveBeenCalledTimes(1);
    // The offline wrapper must be the transport, built from a base factory —
    // NOT given a `shouldSend` option, which queues to disk when false.
    expect(options.transport).toBe(loaded.makeOffline.mock.results[0].value);
    const baseFactory = loaded.makeOffline.mock.calls[0][0] as (o: unknown) => Net;
    return baseFactory({});
  }

  it("packaged, no saved choice: ON — enabled, and an envelope reaches the network", async () => {
    const loaded = load({ isPackaged: true });
    expect(initOptions(loaded).enabled).toBe(true);
    await networkTransport(loaded).send({});
    expect(loaded.networkSend).toHaveBeenCalledTimes(1);
  });

  it("packaged, saved OFF: Sentry starts disabled", () => {
    const loaded = load({ isPackaged: true, crashReportingFile: JSON.stringify({ enabled: false }) });
    expect(initOptions(loaded).enabled).toBe(false);
  });

  it("packaged, saved OFF: the transport still built for the old offline queue sends nothing", async () => {
    const loaded = load({ isPackaged: true, crashReportingFile: JSON.stringify({ enabled: false }) });
    await networkTransport(loaded).send({});
    expect(loaded.networkSend).not.toHaveBeenCalled();
  });

  it("the choice is read BEFORE init — nothing is initialised from a not-yet-loaded setting", () => {
    // A file saying OFF must already be honoured by the options init receives.
    const loaded = load({ isPackaged: true, dsn: "https://public@o0.ingest.sentry.io/0", crashReportingFile: JSON.stringify({ enabled: false }) });
    expect(initOptions(loaded).enabled).toBe(false);
  });

  it("turned OFF mid-session: beforeSend drops the event and the transport sends nothing", async () => {
    const loaded = load({ isPackaged: true, scrubPassThrough: true });
    const options = initOptions(loaded);
    const net = networkTransport(loaded);
    const event = { message: "boom" };
    expect(options.beforeSend(event)).toBe(event);

    loaded.pref.setCrashReportingEnabled(false);

    expect(options.beforeSend(event)).toBeNull();
    expect(loaded.scrub).toHaveBeenCalledTimes(1); // not even scrubbed once off
    await net.send({});
    expect(loaded.networkSend).not.toHaveBeenCalled();
  });
});

// BACKLOG-3801: the main-process gate covers the renderer only because the
// renderer has no network transport of its own — @sentry/electron/renderer's
// transport hands every envelope to main over IPC. A renderer `Sentry.init`
// given its own `dsn` or `transport` would send around the switch.
describe("renderer Sentry.init cannot send around the switch (BACKLOG-3801)", () => {
  it("src/main.tsx passes neither dsn nor transport", () => {
    const file = path.join(REPO_ROOT, "src", "main.tsx");
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const keys: string[][] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "Sentry.init" &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        keys.push(node.arguments[0].properties.map((p) => p.name?.getText(source) ?? ""));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("dsn");
    expect(keys[0]).not.toContain("transport");
  });
});
