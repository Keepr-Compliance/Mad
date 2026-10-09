/**
 * BACKLOG-3785 repro branch ONLY (fix/BACKLOG-3785-repro, never merged).
 *
 * Dev fixture mode: active only when the build is UNPACKAGED and KEEPR_DEV_FIXTURE_MODE=1.
 * While active:
 *   - the SecretStore uses KEEPR_DEV_FIXTURE_KEY (AES-256-GCM) and never calls safeStorage,
 *     so the macOS Keychain is never touched;
 *   - every local personal-data source is refused: macOS Messages (chat.db), the Contacts
 *     address books, iPhone device detection, the Android local-sync server and the RCS bridge.
 * Every refusal logs one `[DEV_FIXTURE] refused <what>` line so a launch can be audited by grep.
 */
import { app } from "electron";

export function isDevFixtureMode(): boolean {
  return !app.isPackaged && process.env.KEEPR_DEV_FIXTURE_MODE === "1";
}

/** True (and logs) when the named local source must not be read in dev fixture mode. */
export function refuseLocalSource(what: string): boolean {
  if (!isDevFixtureMode()) return false;
  // eslint-disable-next-line no-console
  console.log(`[DEV_FIXTURE] refused ${what}`);
  return true;
}
