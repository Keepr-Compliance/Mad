/**
 * Install the secret-storage capability for a jest "shell" (BACKLOG-2962).
 *
 * WHAT A JEST RUN IS, IN EPIC 9'S TERMS
 * -------------------------------------
 * BACKLOG-2962 puts OS secret storage behind the `SecretStore` interface, so a
 * core service no longer imports `safeStorage` — it is handed one. Every host
 * therefore has to say which implementation the core gets: Electron does it in
 * `electron/bootstrap/installNativeCapabilities.ts`. A jest run is just another
 * host, and this is where it says so.
 *
 * WHAT IT INSTALLS, AND WHY THAT AND NOT `ElectronSecretStore`
 * -----------------------------------------------------------
 * It installs the mocked `electron.safeStorage` object itself. That object
 * already has exactly the three methods `SecretStore` declares, so it satisfies
 * the interface structurally — and, crucially, it is the SAME object identity
 * the calling suite configured, so `mockReturnValue` / `mockImplementation` and
 * every `expect(mockEncryptString).toHaveBeenCalledWith(...)` keep working
 * untouched.
 *
 * Installing the shipped `ElectronSecretStore` instead would not work here: it
 * binds `safeStorage` when *its* module is first loaded, which for most suites
 * is during `tests/setup.js` — before the suite's own
 * `jest.mock("electron", ...)` factory is registered. It would forward to the
 * wrong mock.
 *
 * The consequence, stated rather than hidden: **no suite in this repository
 * exercises `ElectronSecretStore` by installing it here.** That class has its
 * own suite, `electron/capabilities/electron/__tests__/electronSecretStore.test.ts`,
 * and that suite is the only thing standing between a broken forwarder and a
 * green build. It was verified by mutation, not by assumption.
 *
 * WHEN A SUITE MUST CALL THIS ITSELF
 * ----------------------------------
 * `tests/setup.js` calls it once per test file, which covers every suite that
 * never resets its module registry. `jest.resetModules()` throws that registry
 * away, so the next `require` of the capability provider returns a BRAND NEW
 * module whose installed store is the throwing `UnavailableSecretStore` again.
 * No jest hook fires after an in-test `resetModules()`, so suites that reset
 * call this immediately afterwards.
 *
 * The alternative — parking the installed store on `globalThis` so it survives
 * a registry reset — was rejected: it would make the capability a hidden global
 * rather than an injected dependency, which is the coupling BACKLOG-2962 exists
 * to remove.
 */

function installTestSecretStore() {
  const {
    installSecretStore,
  } = require("../../electron/capabilities/secretStoreProvider");
  const { safeStorage } = require("electron");

  if (!safeStorage) {
    throw new Error(
      "installTestSecretStore(): the `electron` mock in force has no `safeStorage`. " +
        "A suite that mocks `electron` with its own factory must include one, or " +
        "install a SecretStore of its own via installSecretStore().",
    );
  }
  installSecretStore(safeStorage);
}

module.exports = { installTestSecretStore };
