/**
 * The composition seam for {@link SecretStore} (BACKLOG-2962).
 *
 * WHY A PROVIDER AND NOT A DIRECT IMPORT
 * --------------------------------------
 * Core services are singletons with many importers (`sessionService` alone has
 * 14 non-test importers). If each one imported the Electron implementation to
 * construct its own default export, the file would still be unloadable without
 * Electron and nothing would have been decoupled — the import IS the coupling.
 *
 * So the classes take a `SecretStore` as a **constructor parameter** — that is
 * the injection, and it is what tests and a future Android shell use — and
 * their default-export singletons bind {@link hostSecretStore}, a forwarder
 * that resolves to whatever the host shell installed. This module imports no
 * platform: it holds an interface.
 *
 * ORDERING
 * --------
 * {@link hostSecretStore} forwards at CALL time, not at bind time, so a module
 * may be imported before {@link installSecretStore} runs. That is not an excuse
 * to install late: `electron/bootstrap/installNativeCapabilities` is a
 * side-effect import near the top of `main.ts`. Verified when this was written:
 * none of the five consumers touches the store at module-construction time, so
 * no current path can observe the uninstalled default.
 *
 * @module electron/capabilities/secretStoreProvider
 */

import { UnavailableSecretStore, type SecretStore } from "./secretStore";

let installed: SecretStore = new UnavailableSecretStore();

/**
 * Install the host shell's implementation. Called once, from the shell's
 * composition root. Calling it again replaces the implementation, which is what
 * lets a test swap in a fake.
 */
export function installSecretStore(store: SecretStore): void {
  installed = store;
}

/**
 * Drop back to the throwing {@link UnavailableSecretStore}.
 *
 * For tests that need to assert the uninstalled behaviour. Production code has
 * no reason to call this.
 */
export function resetSecretStore(): void {
  installed = new UnavailableSecretStore();
}

/** The currently installed implementation. */
export function getSecretStore(): SecretStore {
  return installed;
}

/**
 * A {@link SecretStore} that forwards each call to the installed
 * implementation at the moment of the call.
 *
 * Method dispatch happens per call and the underlying function is never
 * captured, so a test that reconfigures its fake between cases still sees the
 * new behaviour.
 */
export const hostSecretStore: SecretStore = {
  isEncryptionAvailable: () => installed.isEncryptionAvailable(),
  encryptString: (plaintext: string) => installed.encryptString(plaintext),
  decryptString: (encrypted: Buffer) => installed.decryptString(encrypted),
};
