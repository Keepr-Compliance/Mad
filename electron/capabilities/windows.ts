/**
 * Delivery of a message to every open host window, as an interface
 * (BACKLOG-2962, seam 4 of 5).
 *
 * WHY THIS EXISTS
 * ---------------
 * BACKLOG-2961's compiler measurement (`pm_comments` `4c10fdb4` §4) enumerated
 * every Electron reach left in the extraction closure. Two of them WERE
 * `BrowserWindow.getAllWindows()` — `initializationBroadcaster.ts:167` and
 * `reviewStateService.ts:577` — and they were the ONLY reason those two modules
 * could not be loaded by a non-Electron shell. Both are push-only: the core
 * tells the renderer something happened. Nothing in the core reads a window
 * back, which is why one method is enough.
 *
 * Past tense on purpose: with this seam in place both modules load, and
 * `coreLoadsWithoutElectron.test.ts` asserts it.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a wrapper for `BrowserWindow`. That class has upwards of a hundred
 * members, and a seam exposing them would be describing Electron rather than
 * describing what the core needs — the rule `appPaths.ts` states for having a
 * single `userData()` accessor. Enumerated by the compiler across the whole
 * closure, the core's entire use of windows is: **send this channel and this
 * payload to every window that can still receive it.** So there is one method.
 *
 * WHY THE LOOP LIVES BEHIND THE SEAM AND THE `try` DOES NOT
 * ----------------------------------------------------------
 * Both call sites ran the identical five lines — `getAllWindows()`, skip a
 * window that `isDestroyed()` or has no `webContents`, then
 * `webContents.send(channel, payload)`. That duplicated loop IS the seam, and it
 * moves in here whole so a second shell writes it once.
 *
 * Their `catch` blocks are NOT identical and therefore stay where they are:
 * `initializationBroadcaster` logs the failure at debug level, `reviewStateService`
 * swallows it because the queue is already durable. Pulling the `try` in here
 * would have to pick one of those and silently change the other. Leaving it out
 * also preserves a subtler property: a `send` that throws part-way aborts the
 * remaining windows and surfaces at the call site, exactly as it did before.
 *
 * @module electron/capabilities/windows
 */

/**
 * The host's open windows, as far as the core is concerned.
 *
 * Implementations MUST be synchronous — both callers are — and MUST skip any
 * window that can no longer receive, rather than throwing on it.
 */
export interface Windows {
  /**
   * Send `payload` on `channel` to every window that can still receive it.
   *
   * `channel` is an IPC channel name the renderer is already listening on, so
   * an implementation must pass it through unaltered. `payload` is structured-
   * clonable data; it is forwarded by reference and never rebuilt.
   *
   * A host with no windows open does nothing, successfully: every caller treats
   * "nobody was listening" as ordinary.
   */
  broadcast(channel: string, payload: unknown): void;
}

/**
 * A {@link Windows} that delivers nothing.
 *
 * THIS ONE DOES NOT THROW, WHERE `UnavailableAppPaths` DOES — and the asymmetry
 * is forced by the call sites, not chosen for symmetry with the logger.
 * Both existing callers already wrap the broadcast in a `catch` that treats
 * undelivered as expected, because a window really can be absent during early
 * startup and after teardown. A throwing default would land inside those
 * `catch` blocks, be swallowed, and prove nothing to anybody — the failure mode
 * would be identical to this one while being harder to read.
 *
 * What notices a missing install is {@link isWindowsInstalled}, read by both
 * layers of the composition-root guard. That is the same split
 * `logger.ts`/`errorReporter.ts` record: a silent default is safe precisely
 * because the guard is not silent.
 */
export class SilentWindows implements Windows {
  broadcast(): void {
    // Intentionally nothing. See the class doc: the guard reports the missing
    // install; this must not throw from inside a caller's catch.
  }
}
