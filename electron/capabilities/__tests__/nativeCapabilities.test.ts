/**
 * THE COMPOSITION-ROOT GUARD, runtime half (BACKLOG-2962).
 *
 * The static guard (`compositionRootGuard.test.ts`) reads source: it answers
 * "is the install call written down". This answers the different question
 * "did the capability actually end up installed", which source cannot:
 * an install call guarded by a branch that never runs, or a factory that hands
 * back the throwing stub, is textually present and functionally absent.
 *
 * It also runs where no test does — a developer's launch, a locally-merged
 * branch, a packaged build. SR's words on why a test alone is not enough:
 * *"A test only protects against a break someone runs tests for; the assertion
 * protects the launch."*
 *
 * WHERE THE ASSERTION FIRES, AND WHY THAT IS BEFORE THE WINDOW
 * ------------------------------------------------------------
 * It is the last statement of `electron/bootstrap/installNativeCapabilities.ts`,
 * which `main.ts` side-effect-imports at top level. tsconfig.electron.json emits
 * CommonJS, so that import executes during `main.ts` module evaluation — before
 * `app.whenReady()` is even called, and therefore before `createWindow()`.
 * It is also before `process.on("uncaughtException")` is registered further
 * down `main.ts`, so the throw is not swallowed by this app's own handler.
 *
 * WHAT IS **NOT** COVERED HERE, stated rather than implied
 * --------------------------------------------------------
 *   - What the shell DOES with the throw. It no longer escapes: the
 *     composition root catches it, shows an error box naming the capability
 *     and calls `app.exit(1)`. That is asserted in
 *     `electron/bootstrap/__tests__/installNativeCapabilities.startupFailure.test.ts`,
 *     with `dialog` and `app` mocked — not here.
 *   - What Electron's runtime does with a module-scope throw that DOES escape.
 *     No test in this repository launches Electron. SR measured it on the real
 *     binary for PR #2515 — stderr, then a late modal, then a process that kept
 *     running windowless until force-quit — and that measurement is why the
 *     catch exists. See `nativeCapabilities.ts` for the full sequence.
 *   - Whether the installed implementation works. That is
 *     `electron/capabilities/electron/__tests__/electronSecretStore.test.ts`.
 *   - `installAppDataPaths`, which has the same shape. It is a path override,
 *     not a capability behind an interface, so this RUNTIME layer still does
 *     not cover it — but it is no longer unguarded: rule E2 in
 *     `compositionRootGuard.test.ts`, fed by `REQUIRED_ENTRY_IMPORTS`, now
 *     asserts `main.ts` imports it and that it stays the first statement.
 *     Static only, deliberately; the measurements behind that choice are on
 *     `REQUIRED_ENTRY_IMPORTS` in `../nativeCapabilities`.
 *   - The case where `main.ts` never imports the composition root: nothing here
 *     loads, so nothing here throws. That case is the STATIC guard's, and it is
 *     exactly the mutation SR found unguarded.
 */

import {
  MissingNativeCapabilityError,
  NATIVE_CAPABILITIES,
  assertNativeCapabilitiesInstalled,
  type NativeCapability,
} from "../nativeCapabilities";
import {
  getSecretStore,
  installSecretStore,
  isSecretStoreInstalled,
  resetSecretStore,
} from "../secretStoreProvider";
import { ElectronSecretStore } from "../electron/electronSecretStore";

/** A registry entry whose installed-ness this test controls outright. */
function fakeCapability(name: string, installed: boolean): NativeCapability {
  return {
    name,
    providerModule: `electron/capabilities/${name}Provider`,
    installFunction: `install${name[0].toUpperCase()}${name.slice(1)}`,
    isInstalled: () => installed,
  };
}

/** Something structurally a SecretStore, so the real registry reads installed. */
const stubStore = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};

describe("assertNativeCapabilitiesInstalled — injected registry", () => {
  it("passes when every capability is installed", () => {
    expect(() =>
      assertNativeCapabilitiesInstalled([
        fakeCapability("alpha", true),
        fakeCapability("beta", true),
      ]),
    ).not.toThrow();
  });

  it("throws MissingNativeCapabilityError naming the ONE that is missing", () => {
    const call = () =>
      assertNativeCapabilitiesInstalled([
        fakeCapability("alpha", true),
        fakeCapability("beta", false),
      ]);

    expect(call).toThrow(MissingNativeCapabilityError);
    expect(call).toThrow(/beta/);
    // A guard that says "something is missing" is a name-matcher for the one
    // case it was built against. It must NOT accuse the installed one.
    expect(call).not.toThrow(/alpha/);
  });

  it("the message points at the composition root by name", () => {
    expect(() => assertNativeCapabilitiesInstalled([fakeCapability("beta", false)])).toThrow(
      /installNativeCapabilities/,
    );
  });

  it("names EVERY missing capability, as an exact set, not a count", () => {
    try {
      assertNativeCapabilitiesInstalled([
        fakeCapability("alpha", false),
        fakeCapability("beta", true),
        fakeCapability("gamma", false),
      ]);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingNativeCapabilityError);
      expect((error as MissingNativeCapabilityError).missing).toEqual(["alpha", "gamma"]);
    }
  });

  it("an empty registry passes — recorded as a LIMIT, not a feature", () => {
    // Which is why compositionRootGuard.test.ts asserts NATIVE_CAPABILITIES is
    // non-empty: an emptied registry would silently disarm both layers.
    expect(() => assertNativeCapabilitiesInstalled([])).not.toThrow();
  });
});

describe("assertNativeCapabilitiesInstalled — the REAL registry", () => {
  afterEach(() => {
    // tests/setup.js installed one for this file; put a real one back so no
    // later suite inherits an uninstalled provider.
    installSecretStore(stubStore);
  });

  it("throws, naming secretStore, when nothing is installed", () => {
    // The probe that keeps the two cases below honest: if NATIVE_CAPABILITIES'
    // isInstalled were wired to a constant `true`, this would pass silently and
    // the whole runtime layer would be decorative.
    resetSecretStore();
    expect(isSecretStoreInstalled()).toBe(false);

    expect(() => assertNativeCapabilitiesInstalled()).toThrow(MissingNativeCapabilityError);
    expect(() => assertNativeCapabilitiesInstalled()).toThrow(/secretStore/);
  });

  it("passes once a store is installed", () => {
    resetSecretStore();
    installSecretStore(stubStore);
    expect(() => assertNativeCapabilitiesInstalled()).not.toThrow();
  });

  it("reads the live provider, not a value captured at registry-construction time", () => {
    resetSecretStore();
    expect(NATIVE_CAPABILITIES[0].isInstalled()).toBe(false);
    installSecretStore(stubStore);
    expect(NATIVE_CAPABILITIES[0].isInstalled()).toBe(true);
  });
});

describe("the real composition root, loaded as main.ts loads it", () => {
  afterEach(() => {
    installSecretStore(stubStore);
  });

  it("loads without throwing and leaves an ElectronSecretStore installed", () => {
    // This is the test that control 5 mutates: delete the `installSecretStore(...)`
    // line from the composition root and this reds, because the module's own
    // last statement throws while it is being required.
    //
    // Every reference is captured INSIDE the isolate. `jest.isolateModules`
    // builds a fresh registry, so the `ElectronSecretStore` class loaded in
    // there is a different constructor from the one this file imported at the
    // top — an `instanceof` across that boundary answers `false` for an object
    // that genuinely is one.
    let loadError: unknown = null;
    let installedInIsolate: unknown;
    let isElectronStore = false;

    jest.isolateModules(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../../bootstrap/installNativeCapabilities");
      } catch (error) {
        loadError = error;
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const provider = require("../secretStoreProvider");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const impl = require("../electron/electronSecretStore");
      installedInIsolate = provider.getSecretStore();
      isElectronStore = installedInIsolate instanceof impl.ElectronSecretStore;
    });

    expect(loadError).toBeNull();
    expect(isElectronStore).toBe(true);
  });

  it("the isolate is honest: a registry with nothing installed still fails inside it", () => {
    // Without this, a broken `isolateModules` (one that silently reused the
    // outer registry, where tests/setup.js already installed a store) would
    // make the assertion above pass vacuously.
    let threw = false;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const caps = require("../nativeCapabilities");
      try {
        caps.assertNativeCapabilitiesInstalled();
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(true);
  });

  it("the outer registry is untouched by the isolate", () => {
    installSecretStore(stubStore);
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../../bootstrap/installNativeCapabilities");
    });
    expect(getSecretStore()).toBe(stubStore);
    expect(getSecretStore()).not.toBeInstanceOf(ElectronSecretStore);
  });
});
