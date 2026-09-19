/**
 * The native-capability registry and the composition root's runtime self-check
 * (BACKLOG-2962).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * PR #2487 put secret storage behind an interface. Reviewing it, SR deleted the
 * one wiring line that installs the implementation —
 * `electron/main.ts:12`, `import "./bootstrap/installNativeCapabilities";` —
 * and **nothing in the repository went red**: 72 suites, the SQL gate and `tsc`
 * all passed, and the app would have launched and never shown a window. The
 * composition root had no guard. Reproduced on this branch before writing a
 * line of it: 41 affected suites / 815 tests identical green with the import
 * deleted, `tsc -p tsconfig.electron.json` exit 0,
 * `check:native-capabilities` exit 0.
 *
 * THE TWO LAYERS, AND WHY NEITHER IS ENOUGH ALONE
 * ------------------------------------------------
 * | mutation                                                | static | runtime |
 * |---------------------------------------------------------|--------|---------|
 * | `main.ts`'s import of the composition root deleted       | RED    | green   |
 * | an install call deleted from the composition root        | RED    | RED     |
 * | install call present but installs nothing at runtime     | green  | RED     |
 * | a capability registered here with no installer           | RED    | RED     |
 * | `main.ts`'s import of the app-data override deleted      | RED    | n/a     |
 * | that import moved out of first position                  | RED    | n/a     |
 *
 * The last two rows are {@link REQUIRED_ENTRY_IMPORTS}, added by the follow-up
 * PR to this one. Their runtime column is `n/a`, not `green`: no runtime layer
 * was built for them, and the reason is recorded on that list rather than left
 * for the next reader to guess.
 *
 * The static layer is `electron/capabilities/__tests__/compositionRootGuard.test.ts`;
 * it reads {@link NATIVE_CAPABILITIES} and matches each `installFunction` in the
 * composition root's AST. The runtime layer is
 * {@link assertNativeCapabilitiesInstalled}, called as the last statement of the
 * composition root. A test only protects against a break someone runs tests
 * for; the assertion protects the launch.
 *
 * THIS MODULE IMPORTS NO PLATFORM. It holds names and predicates, so it stays
 * loadable by any shell — which is the whole point of epic 9.
 *
 * @module electron/capabilities/nativeCapabilities
 */

import { isAppLifecycleInstalled } from "./appLifecycleProvider";
import { isAppPathsInstalled } from "./appPathsProvider";
import { isDialogInstalled } from "./dialogProvider";
import { isErrorReporterInstalled } from "./errorReporterProvider";
import { isLoggerInstalled } from "./loggerProvider";
import { isSecretStoreInstalled } from "./secretStoreProvider";
import { isWindowsInstalled } from "./windowsProvider";

/**
 * One native capability the core depends on and a host shell must supply.
 *
 * The three string fields are what the STATIC guard matches on; `isInstalled`
 * is what the RUNTIME guard calls. Both read this one array, so there is no
 * second list to drift out of step with it.
 */
export interface NativeCapability {
  /** Stable name. Appears verbatim in the thrown error and in guard failures. */
  readonly name: string;
  /**
   * Repo-relative, extensionless, POSIX-separated path of the module that
   * exports {@link installFunction}. The static guard RESOLVES the composition
   * root's import specifiers to this path — it does not string-compare them —
   * so any spelling that resolves here satisfies the guard.
   */
  readonly providerModule: string;
  /** The named export a shell calls to supply an implementation. */
  readonly installFunction: string;
  /** True once a host shell has installed a real implementation. */
  isInstalled(): boolean;
}

/**
 * Every capability the Electron shell must install before the core runs.
 *
 * A capability joins this list when it has an interface, not before; adding a
 * name here with no installer takes both guards red, by design and by planted
 * control.
 *
 * WHAT IS HERE AND WHAT IS NOT
 * ----------------------------
 * `secretStore` shipped in PR #2487. `logger`, `errorReporter` and `appPaths`
 * are the first three of the five seams BACKLOG-2961's compiler measurement
 * (`pm_comments` `4c10fdb4`) named — Logger, ErrorReporter, AppPaths, Dialog,
 * Window — which the founder assigned to this item on 2026-09-05. That
 * measurement is also why they arrived in that order: enumerating all 31 subsets
 * of the five showed four of them free ZERO modules on their own, and the
 * 34-module payoff lands only at the conjunction of Logger + ErrorReporter +
 * AppPaths. They shipped as one PR (#2523) for that reason.
 *
 * `windows`, `dialog` and `appLifecycle` are the remainder, and there are THREE
 * of them where the founder's decision named two. The reason is the twelve call
 * expressions left after #2523, enumerated by the compiler: three
 * `dialog.showMessageBox`, two `BrowserWindow.getAllWindows`, and SEVEN
 * `app.isPackaged`/`isReady`/`whenReady`/`quit` in `databaseService.ts` that are
 * neither a dialog nor a window. `4c10fdb4` §5 had them as one row named
 * "AppLifecycle" covering `app.*` AND `dialog.showMessageBox`; splitting that row
 * is what lets each interface describe one thing. Leaving the seven out would
 * leave `import { app } from "electron"` in place and the extraction closure
 * reading 1 rather than 0.
 *
 * Still absent, and still deliberately: the filesystem seam (SR endorsed
 * deferring it — its 42 files are eleven distinct concerns, not one
 * capability), message ingestion, and notifications/update.
 */
export const NATIVE_CAPABILITIES: readonly NativeCapability[] = [
  {
    name: "secretStore",
    providerModule: "electron/capabilities/secretStoreProvider",
    installFunction: "installSecretStore",
    isInstalled: isSecretStoreInstalled,
  },
  {
    name: "logger",
    providerModule: "electron/capabilities/loggerProvider",
    installFunction: "installLogger",
    isInstalled: isLoggerInstalled,
  },
  {
    name: "errorReporter",
    providerModule: "electron/capabilities/errorReporterProvider",
    installFunction: "installErrorReporter",
    isInstalled: isErrorReporterInstalled,
  },
  {
    name: "appPaths",
    providerModule: "electron/capabilities/appPathsProvider",
    installFunction: "installAppPaths",
    isInstalled: isAppPathsInstalled,
  },
  {
    name: "windows",
    providerModule: "electron/capabilities/windowsProvider",
    installFunction: "installWindows",
    isInstalled: isWindowsInstalled,
  },
  {
    name: "dialog",
    providerModule: "electron/capabilities/dialogProvider",
    installFunction: "installDialog",
    isInstalled: isDialogInstalled,
  },
  {
    name: "appLifecycle",
    providerModule: "electron/capabilities/appLifecycleProvider",
    installFunction: "installAppLifecycle",
    isInstalled: isAppLifecycleInstalled,
  },
];

/** Repo-relative, extensionless path of the Electron shell's composition root. */
export const COMPOSITION_ROOT = "electron/bootstrap/installNativeCapabilities";

/** Repo-relative path of the Electron shell's entry module. */
export const SHELL_ENTRY = "electron/main.ts";

/**
 * A module the shell's ENTRY imports for its side effect, in its own right.
 *
 * Not a capability: nothing installs an implementation, no core module depends
 * on an interface it satisfies, and there is no `isInstalled()` to call. It is
 * a bootstrap step the entry performs before the rest of the entry runs — the
 * composition root is the other one, and it is deliberately NOT on this list
 * (see {@link REQUIRED_ENTRY_IMPORTS}).
 */
export interface RequiredEntryImport {
  /** Name used in guard failures. A description, not an identifier. */
  readonly name: string;
  /**
   * Repo-relative, extensionless, POSIX-separated path of the module the entry
   * must import. RESOLVED from the entry's specifier, not string-compared, so
   * any spelling that resolves here satisfies the rule.
   */
  readonly module: string;
  /**
   * True when the import must be the entry's FIRST statement, not merely
   * present. Only set this where a comment in the entry already says so and
   * gives the reason — the rule exists to keep that comment enforceable, not to
   * impose a house style.
   */
  readonly mustBeFirstStatement: boolean;
  /** Why the entry needs it, quoted into the guard's failure message. */
  readonly why: string;
}

/**
 * Side-effect imports `electron/main.ts` must make, beyond the composition root.
 *
 * WHY THIS LIST EXISTS SEPARATELY FROM THE COMPOSITION ROOT'S RULE
 * ----------------------------------------------------------------
 * Reviewing PR #2515, SR ran the same mutation one line up: delete
 * `electron/main.ts:6` — `import "./bootstrap/installAppDataPaths";` — and
 * NOTHING went red. Re-measured at `b2cc5cbf7` before this list was written:
 * 10 affected suites / 160 tests identically green, `tsc -p
 * tsconfig.electron.json` exit 0. Same hazard class as the composition root's,
 * one line apart, and the composition root's rule could not express it:
 *
 *   - There is no install function to match. C1 matches a CALL the composition
 *     root makes; this module is imported by the ENTRY and calls nothing out.
 *   - Its contract is STRICTER, not looser. The composition root's E1
 *     deliberately asserts no ordering, because a top-level import runs before
 *     `ready` whatever its statement index. `installAppDataPaths` must run
 *     before `app.requestSingleInstanceLock()` writes inside userData and
 *     before the first `electron-log` write picks a path — so for this one,
 *     position IS the contract, and `main.ts:1-5` says so in prose. This list
 *     makes that prose enforceable.
 *
 * The composition root is not listed here on purpose. It is covered by E1 with
 * different (ordering-free) semantics, and listing it twice would red two tests
 * for one mutation — which says less about what broke than one precisely-named
 * failure does.
 *
 * WHY THERE IS NO RUNTIME LAYER FOR THIS ONE
 * ------------------------------------------
 * Both reasons were measured, not traced, while this list was written:
 *
 *   1. The hazard is development-only. In a packaged build with no
 *      `KEEPR_USER_DATA_DIR`, `applyAppDataPaths()` returns `null` and the
 *      module is a no-op — deleting its import changes nothing a shipped user
 *      sees. What it costs is a developer machine writing to the founder's real
 *      database, which is the BACKLOG-2709 incident. That exposure is
 *      repo-visible, and the static layer is where repo-visible defects belong.
 *   2. A hard ordering assert in the composition root reds two currently-green
 *      tests. Adding a `hasRunAppDataPaths()` predicate and throwing on it in
 *      `installNativeCapabilities.ts` took `nativeCapabilities.test.ts` to
 *      2 failed / 9 passed of 11: `loads without throwing and leaves an
 *      ElectronSecretStore installed` and `the outer registry is untouched by
 *      the isolate`. Both load the real composition root inside
 *      `jest.isolateModules`, where the bootstrap module has not run. Making
 *      them pass would need real `fs.mkdirSync` side effects inside an isolate,
 *      or a test-only escape hatch in the guard. Both are worse than the gap.
 *
 * So this one is single-layer, and says so, rather than claiming a second layer
 * it does not have.
 */
export const REQUIRED_ENTRY_IMPORTS: readonly RequiredEntryImport[] = [
  {
    name: "the app-data path override",
    module: "electron/bootstrap/installAppDataPaths",
    mustBeFirstStatement: true,
    why:
      "it repoints userData before `app.requestSingleInstanceLock()` writes " +
      "SingletonLock inside it and before the first electron-log write picks a " +
      "log path, so a dev launch cannot open the installed app's database " +
      "(BACKLOG-2709)",
  },
];

/**
 * Calls the composition root must make BEYOND installing each capability.
 *
 * Exactly one: the runtime self-check itself. Without this entry, deleting
 * {@link assertNativeCapabilitiesInstalled}'s single call site would silently
 * remove the runtime layer — the very defect this item exists to close, one
 * level up. The guard that does not guard its own guard is the shape SR found.
 */
export const REQUIRED_COMPOSITION_ROOT_CALLS: readonly {
  readonly name: string;
  readonly providerModule: string;
  readonly installFunction: string;
}[] = [
  {
    name: "the runtime self-check",
    providerModule: "electron/capabilities/nativeCapabilities",
    installFunction: "assertNativeCapabilitiesInstalled",
  },
];

/** Thrown when the composition root finishes without installing a capability. */
export class MissingNativeCapabilityError extends Error {
  /** The uninstalled capability names, in registry order. */
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    // THIS TEXT REACHES THE FOUNDER, in the "Keepr cannot start" box, so it may
    // only say what is true of EVERY registered capability.
    //
    // It used to end "each capability's provider throws on first use, so this
    // fails during startup". That was true when `secretStore` was the only
    // entry. It stopped being true the moment `logger` and `errorReporter` were
    // registered: their defaults are silent BY DESIGN, because every call site
    // they wrap sits inside a `catch` and a throwing default would escape from
    // inside an error handler (see logger.ts / errorReporter.ts).
    //
    // The old sentence also inverted its own argument. For the two silent
    // capabilities this check is not a nicety on top of a provider that would
    // have thrown anyway — it is the ONLY thing that can notice they are
    // missing. Whoever edits this next: if a future capability changes how its
    // default behaves, nothing here needs to change, because the sentence no
    // longer claims anything about defaults.
    super(
      `Native capability not installed: ${missing.join(", ")}. The host shell's ` +
        "composition root ran without supplying an implementation " +
        `(Electron's is ${COMPOSITION_ROOT}.ts). This check runs during startup — ` +
        "before the window opens — so a missing capability is named here rather " +
        "than surfacing later at whatever call site happens to reach it first. " +
        "Some providers throw on first use and some are silent by design, which " +
        "is why this check exists rather than being left to the first caller.",
    );
    this.name = "MissingNativeCapabilityError";
    this.missing = [...missing];
  }
}

/**
 * Throw unless every registered capability has a real implementation installed.
 *
 * Called as the LAST statement of the composition root, so it runs during
 * `main.ts` module evaluation: before `app.whenReady()`, before the
 * `process.on("uncaughtException")` handler registered further down `main.ts`,
 * and therefore before `createWindow()`.
 *
 * WHO HANDLES THE THROW — the Electron shell's composition root does, now.
 * `electron/bootstrap/installNativeCapabilities.ts` calls this inside a `try`
 * and, on failure, shows an error box carrying the message below verbatim and
 * then calls `app.exit(1)`. Read that file for the sequence; this module holds
 * no platform and cannot do either thing itself.
 *
 * WHAT HAPPENED BEFORE THAT CATCH EXISTED — kept because it is why the catch
 * exists, and because it is the only MEASURED account of an escaped throw.
 * SR ran this repo's own Electron binary for PR #2515 (probes A/B/C):
 *
 *   1. Electron installs exactly ONE default `uncaughtException` listener
 *      before the main script loads, and it never calls `process.exit`. This
 *      app's own handler is registered at `main.ts:259`, AFTER the import at
 *      line 12, so the default handler was the only one in play.
 *   2. stderr got `App threw an error during load` plus the stack.
 *   3. A modal error box appeared — "A JavaScript error occurred in the main
 *      process" — carrying the `MissingNativeCapabilityError` message
 *      verbatim, capability named. It lagged the throw by several seconds:
 *      Electron's default handler reaches `dialog` via an async
 *      `import("electron")`. Visually confirmed by screen capture.
 *   4. The process then did NOT exit. It stayed alive with no window, before
 *      and after `OK` was clicked, until it was force-quit.
 *
 * So the launch was stopped and the process was not, which is the windowless
 * hang the founder ruled against. The trap that shape teaches is still live and
 * is why the catch orders its two statements the way it does: exiting FIRST
 * would suppress the box entirely, trading a loud failure for a silent one.
 *
 * Measured on macOS (darwin 24.6.0). The mechanism is platform-independent, so
 * Windows is INFERRED, not measured.
 *
 * @param capabilities injected by tests so a dummy registry can be checked;
 *   production always uses {@link NATIVE_CAPABILITIES}.
 */
export function assertNativeCapabilitiesInstalled(
  capabilities: readonly NativeCapability[] = NATIVE_CAPABILITIES,
): void {
  const missing = capabilities.filter((c) => !c.isInstalled()).map((c) => c.name);
  if (missing.length > 0) {
    throw new MissingNativeCapabilityError(missing);
  }
}
