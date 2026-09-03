/**
 * The native-capability seam, asserted as a load-time property (BACKLOG-2962).
 *
 * Epic 9 is "one core, many shells". A core module that reaches `require("electron")`
 * at module scope cannot be loaded by any other shell, no matter what it does at runtime.
 * This test makes that property executable: it replaces `"electron"` with a module that
 * throws on load — the closest thing to "not running under Electron" that jest can give —
 * and then loads the modules that must survive it.
 *
 * `jest.doMock` with a factory takes precedence over the `moduleNameMapper` entry that
 * normally points `"electron"` at `tests/__mocks__/electron.js`, so the global mock cannot
 * mask the coupling.
 *
 * BEFORE BACKLOG-2962 this file FAILED: both modules opened with
 * `import { safeStorage } from "electron"`.
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

/** Load `id` in a fresh registry in which `"electron"` cannot be required. */
function loadWithoutElectron(id: string): unknown {
  let loaded: unknown;
  jest.isolateModules(() => {
    jest.doMock("electron", () => {
      throw new Error(NO_ELECTRON);
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require(id);
  });
  return loaded;
}

describe("core modules load without Electron (BACKLOG-2962)", () => {
  afterEach(() => {
    jest.dontMock("electron");
  });

  it("keychainGate loads with no Electron present", () => {
    expect(() => loadWithoutElectron("../../services/keychainGate")).not.toThrow();
  });

  it("tokenEncryptionService loads with no Electron present", () => {
    expect(() => loadWithoutElectron("../../services/tokenEncryptionService")).not.toThrow();
  });

  it("the probe itself is honest: a module that does import electron still fails", () => {
    // startupHealthCheck imports `dialog` and `app` — it is a SHELL module by nature and is
    // not claimed to be portable. It is here so that a broken probe (one that silently
    // stopped replacing "electron") cannot make the two assertions above pass vacuously.
    expect(() => loadWithoutElectron("../../services/startupHealthCheck")).toThrow(NO_ELECTRON);
  });
});
