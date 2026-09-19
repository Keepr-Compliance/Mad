/**
 * The native-capability seam, asserted as a load-time property (BACKLOG-2962).
 *
 * Epic 9 is "one core, many shells". A core module that reaches `require("electron")`
 * at module scope cannot be loaded by any other shell, no matter what it does at runtime.
 * This test makes that property executable: it replaces the platform with modules that
 * throw on load — the closest thing to "not running under Electron" that jest can give —
 * and then loads the modules that must survive it.
 *
 * `jest.doMock` with a factory takes precedence over the `moduleNameMapper` entries that
 * normally point these specifiers at `tests/__mocks__/*.js`, so the global mocks cannot
 * mask the coupling.
 *
 * BEFORE BACKLOG-2962 this file FAILED: both of the original two modules opened with
 * `import { safeStorage } from "electron"`.
 *
 * THE COUPLING CLASS IS THREE SPECIFIERS, NOT ONE — AND THIS PROBE ONLY SAW ONE
 * ----------------------------------------------------------------------------
 * BACKLOG-2961's compiler measurement (`pm_comments` `4c10fdb4` §2) defines Electron
 * coupling as `electron` **plus** `@sentry/electron/**` **plus** `electron-*`: of the 10
 * modules in the extraction closure that touch Electron at all, four reach it only through
 * `electron-log` and six only through `@sentry/electron/main`. Until the seams PR, this
 * probe `doMock`ed `"electron"` alone — so a module that had swapped `import { app } from
 * "electron"` for `import log from "electron-log"` would have loaded GREEN here while being
 * exactly as unportable. Measured, not assumed: `electron-log` resolves through
 * `jest.config.js`'s `moduleNameMapper` and loads without complaint.
 *
 * All three are now replaced, and each specifier has its own honesty case below so a
 * silently-broken replacement cannot make the portability assertions pass vacuously.
 *
 * WHAT THIS CONTROL CANNOT SEE, AND WHAT COVERS IT
 * ------------------------------------------------
 * Measured by mutation while this was written. Re-adding
 * `import { app } from "electron"` to `keychainGate.ts` and leaving `app`
 * UNUSED left this suite green: TypeScript elides an import whose bindings are
 * never referenced, so no `require` is emitted and there is nothing to throw.
 * The same mutation with `app` actually used turns this suite red.
 *
 * So a re-coupling arrives here only once it is load-bearing. The static gate,
 * `scripts/ci/check-native-capabilities.mjs`, reads the source and caught BOTH
 * shapes. Neither instrument is redundant: the gate cannot see a dynamic
 * `await import("electron")`, and this cannot see an import the compiler
 * removes.
 */

const NO_ELECTRON = "Electron is not available in this shell";

/**
 * The Electron coupling class, verbatim from BACKLOG-2961's §2 definition.
 *
 * `@sentry/electron/main` is listed by its exact specifier because that is what the ten
 * closure modules import; `jest.config.js` maps the whole `@sentry/electron*` family to one
 * mock, and `doMock` on the specifier the source actually uses is what overrides it.
 */
const COUPLING_CLASS = ["electron", "electron-log", "@sentry/electron/main"] as const;

/** Load `id` in a fresh registry in which `specifiers` cannot be required. */
function loadWithout(specifiers: readonly string[], id: string): unknown {
  let loaded: unknown;
  jest.isolateModules(() => {
    for (const specifier of specifiers) {
      jest.doMock(specifier, () => {
        throw new Error(NO_ELECTRON);
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require(id);
  });
  return loaded;
}

/** Load `id` with the ENTIRE coupling class made to throw. */
function loadWithoutElectron(id: string): unknown {
  return loadWithout(COUPLING_CLASS, id);
}

describe("core modules load without Electron (BACKLOG-2962)", () => {
  afterEach(() => {
    for (const specifier of COUPLING_CLASS) {
      jest.dontMock(specifier);
    }
  });

  it("keychainGate loads with no Electron present", () => {
    expect(() => loadWithoutElectron("../../services/keychainGate")).not.toThrow();
  });

  it("tokenEncryptionService loads with no Electron present", () => {
    expect(() => loadWithoutElectron("../../services/tokenEncryptionService")).not.toThrow();
  });

  it("secretStoreProvider loads with no Electron present", () => {
    // BACKLOG-2962: the provider's own header claims it "imports no platform:
    // it holds an interface". That claim shipped in PR #2487 with no control.
    expect(() => loadWithoutElectron("../secretStoreProvider")).not.toThrow();
  });

  it("nativeCapabilities loads with no Electron present", () => {
    // Same claim, same file-header wording, in the registry that both halves of
    // the composition-root guard read. If it ever reaches the platform, the
    // static guard's own dependency does.
    expect(() => loadWithoutElectron("../nativeCapabilities")).not.toThrow();
  });

  it("loggerProvider loads with no Electron present", () => {
    // The Logger seam's own interface side. It must hold the same property the
    // SecretStore seam holds, or the seam is decorative.
    expect(() => loadWithoutElectron("../loggerProvider")).not.toThrow();
  });

  it("logService loads with no Electron present", () => {
    // THE POINT OF THE LOGGER SEAM. Before it, this module opened with
    // `import log from "electron-log"`, and BACKLOG-2961 measured 11 otherwise
    // platform-free modules coupled to Electron for that single reason —
    // `contactsService`, `contactIngestionFunnel`, `addressBookDiscovery`,
    // `tokenEncryptionService`, `readOnlySqlite`, `contactWorkerPool`,
    // `hybridExtractorService` and the four `llm/*` services.
    expect(() => loadWithoutElectron("../../services/logService")).not.toThrow();
  });

  it("errorReporterProvider loads with no Electron present", () => {
    // The ErrorReporter seam's own interface side.
    expect(() => loadWithoutElectron("../errorReporterProvider")).not.toThrow();
  });

  it("schemas/validate loads with no Electron present", () => {
    // It reached BOTH packages — `electron-log` at :13 and `@sentry/electron/main`
    // at :14 — and neither `electron` itself. It is the module that proves the
    // coupling class matters: under the old single-specifier probe it would have
    // loaded green while being completely unportable.
    expect(() => loadWithoutElectron("../../schemas/validate")).not.toThrow();
  });

  it("appPathsProvider loads with no Electron present", () => {
    expect(() => loadWithoutElectron("../appPathsProvider")).not.toThrow();
  });

  it("db/core/dbConnection loads with no Electron present", () => {
    // THE ONE-LINE CUT. `app.getPath("userData")` at :163 was this module's only
    // Electron reach, and BACKLOG-2961 measured 19 modules held in the coupled
    // set by it alone — every `db/*DbService.ts` in the extraction closure, plus
    // `messageMatchingService` and `llm/llmConfigService`. They are released by
    // this line and not one PR earlier.
    expect(() => loadWithoutElectron("../../services/db/core/dbConnection")).not.toThrow();
  });

  it("databaseEncryptionService loads with no Electron present", () => {
    // It reached the platform three ways — `app.getPath` twice and
    // `@sentry/electron/main` seven times — so it is the module that proves the
    // three seams compose rather than merely coexist.
    expect(() =>
      loadWithoutElectron("../../services/databaseEncryptionService"),
    ).not.toThrow();
  });

  it("db/maintenanceDbService loads with no Electron present", () => {
    expect(() => loadWithoutElectron("../../services/db/maintenanceDbService")).not.toThrow();
  });

  it("autoLinkService loads with no Electron present", () => {
    // An extraction candidate whose own coupling was 12 `Sentry.*` calls and
    // nothing else.
    //
    // HISTORY, because this case is the tree's record of why two instruments are
    // kept. After the Logger/ErrorReporter/AppPaths seams (PR #2523) it LOADED
    // here while BACKLOG-2961's closure still classified it as transitively
    // coupled — its only remaining path to Electron was
    // `await import("./reviewStateService")` at `:544` and `:915`, which the
    // compiler counts as an edge and a load-time probe cannot reach. Seams PR B
    // freed `reviewStateService`, so that path is gone and the closure now reads
    // it as platform-free too (63 modules, 0 coupled).
    //
    // The instruments AGREE at this head. They still MEASURE DIFFERENT THINGS,
    // and neither is the other's substitute: this one cannot see an import the
    // compiler elides, and the closure cannot see a `require` reached only at
    // runtime. Do not delete one because they currently return the same answer.
    expect(() => loadWithoutElectron("../../services/autoLinkService")).not.toThrow();
  });

  it("emailDeduplicationService loads with no Electron present — PR B's remainder, closed", () => {
    // PR A left this case asserting a THROW, with the reason written down:
    // `emailDeduplicationService.ts:21` statically imports `databaseService`,
    // which kept `import { app, dialog } from "electron"`. That import is gone,
    // so this case reds as a throw and is flipped here — which is the point of
    // having written the boundary as an assertion rather than an absence.
    expect(() =>
      loadWithoutElectron("../../services/emailDeduplicationService"),
    ).not.toThrow();
  });

  it("windowsProvider loads with no Electron present", () => {
    // The Windows seam's own interface side (BACKLOG-2962, seams PR B).
    expect(() => loadWithoutElectron("../windowsProvider")).not.toThrow();
  });

  it("initializationBroadcaster loads with no Electron present", () => {
    // It reached the platform ONE way after PR A: `BrowserWindow.getAllWindows()`
    // at :167, inside the broadcast every renderer surface listens to. It also
    // named `BrowserWindow` as the TYPE of a write-only field, which a type-only
    // import would have hidden from both this probe and the static gate; that
    // type is now opaque, so the module compiles as well as loads without
    // Electron.
    expect(() =>
      loadWithoutElectron("../../services/initializationBroadcaster"),
    ).not.toThrow();
  });

  it("reviewStateService loads with no Electron present", () => {
    // `BrowserWindow.getAllWindows()` at :577 was its ONLY Electron reach, and
    // BACKLOG-2961's closure held `autoLinkService` in the transitively-coupled
    // set for it alone — through the `await import("./reviewStateService")` at
    // `autoLinkService.ts:544` and `:915` that a load-time probe cannot see and
    // the compiler can.
    expect(() => loadWithoutElectron("../../services/reviewStateService")).not.toThrow();
  });

  it("dialogProvider loads with no Electron present", () => {
    // The Dialog seam's own interface side (BACKLOG-2962, seams PR B).
    expect(() => loadWithoutElectron("../dialogProvider")).not.toThrow();
  });

  it("appLifecycleProvider loads with no Electron present", () => {
    // The AppLifecycle seam's own interface side (BACKLOG-2962, seams PR B).
    expect(() => loadWithoutElectron("../appLifecycleProvider")).not.toThrow();
  });

  it("databaseService loads with no Electron present", () => {
    // THE LAST ONE. It was the only module left in BACKLOG-2961's extraction
    // closure importing `electron`, and it held all four of the closure's
    // transitively-coupled modules. 3 `dialog.showMessageBox` and 7
    // `app.isPackaged`/`isReady`/`whenReady`/`quit`, on the terminal database
    // paths where the app tells the user why it is about to stop.
    expect(() => loadWithoutElectron("../../services/databaseService")).not.toThrow();
  });

  it("messageMatchingService loads with no Electron present", () => {
    // A (b) module, coupled by nothing of its own — it was held only through
    // `dbConnection` and `logService`. That it loads now is the transitive half
    // of the payoff, and it would not have moved for any one of the three seams
    // alone.
    expect(() => loadWithoutElectron("../../services/messageMatchingService")).not.toThrow();
  });

  describe("the probe is honest — one case per specifier in the coupling class", () => {
    // Without these, a replacement that silently stopped applying would make
    // every assertion above pass by doing nothing.

    it("electron itself throws inside the isolate", () => {
      expect(() => loadWithout(["electron"], "electron")).toThrow(NO_ELECTRON);
    });

    it("electron-log itself throws inside the isolate", () => {
      expect(() => loadWithout(["electron-log"], "electron-log")).toThrow(NO_ELECTRON);
    });

    it("@sentry/electron/main itself throws inside the isolate", () => {
      expect(() => loadWithout(["@sentry/electron/main"], "@sentry/electron/main")).toThrow(
        NO_ELECTRON,
      );
    });

    it("a module that imports electron still fails", () => {
      // startupHealthCheck imports `dialog` and `app` — it is a SHELL module by nature and is
      // not claimed to be portable.
      expect(() => loadWithoutElectron("../../services/startupHealthCheck")).toThrow(NO_ELECTRON);
    });

    it("a module whose ONLY platform import is electron-log still fails", () => {
      // `electron/utils/rateLimit.ts` imports `electron-log` and nothing else from the
      // coupling class, and calls `log.debug` at :178/:187/:199 so the import is
      // load-bearing rather than elided. Only the `electron-log` replacement can red this,
      // which is what makes it a control for that specifier specifically.
      expect(() => loadWithout(["electron-log"], "../../utils/rateLimit")).toThrow(NO_ELECTRON);
    });
  });
});
