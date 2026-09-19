/**
 * The Electron shell's {@link AppPaths}: `app.getPath` (BACKLOG-2962, seam 3).
 *
 * WHY `getPath` IS CALLED INSIDE THE METHOD AND NOT CACHED
 * --------------------------------------------------------
 * `electron/bootstrap/installAppDataPaths.ts` calls `app.setPath("userData", …)`
 * for development builds, so "the userData directory" is not a constant — it is
 * whatever `app` currently says. Caching it here would reintroduce the
 * BACKLOG-2709 failure the whole override exists to prevent, in a place nothing
 * would think to look. `app.getPath` is a cheap synchronous read; there is no
 * reason to cache it and one very good reason not to.
 *
 * The key string is `"userData"`, unchanged from the four call sites this
 * replaces (`db/core/dbConnection.ts:163`, `databaseEncryptionService.ts:59`
 * and `:386`, `databaseService.ts:203`) — all four passed exactly that, and
 * `electronAppPaths.test.ts` pins the literal so a change to it reds.
 *
 * @module electron/capabilities/electron/electronAppPaths
 */

import { app } from "electron";

import type { AppPaths } from "../appPaths";

/** {@link AppPaths} backed by Electron's `app.getPath`. */
export class ElectronAppPaths implements AppPaths {
  userData(): string {
    return app.getPath("userData");
  }
}
