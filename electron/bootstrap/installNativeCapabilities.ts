/**
 * The Electron shell's composition root for native capabilities (BACKLOG-2962).
 *
 * Imported for its side effect from `main.ts`, in the same style as
 * `installAppDataPaths` — this is the single place where the Electron shell
 * declares which implementation of each capability the core will get.
 *
 * Import position matters less here than it does for `installAppDataPaths`,
 * because `hostSecretStore` forwards at call time and nothing calls the store
 * during module construction. It still belongs near the top: the rule is
 * "install before anything can call", and the cheapest way to keep that true as
 * the codebase changes is to install first.
 *
 * @module electron/bootstrap/installNativeCapabilities
 */

import { installSecretStore } from "../capabilities/secretStoreProvider";
import { ElectronSecretStore } from "../capabilities/electron/electronSecretStore";

installSecretStore(new ElectronSecretStore());
