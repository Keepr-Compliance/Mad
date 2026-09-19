/**
 * Application logging, as an interface (BACKLOG-2962, seam 1 of 5).
 *
 * WHY THIS EXISTS
 * ---------------
 * Epic 9 is "one core, many shells". BACKLOG-2961's compiler measurement
 * (`pm_comments` `4c10fdb4`) sized the extraction closure at 122 modules, of
 * which only 10 import Electron at all — and `electron-log` is one of the two
 * npm packages those 10 reach it through. `logService.ts` is the worst of them
 * by leverage: 11 otherwise-portable modules are coupled to Electron *solely*
 * because they import it. This interface is the cut.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a logging framework, and not a superset of `electron-log`. The four
 * methods below are exactly the four `electron-log` methods this codebase's
 * core calls — `log.debug`, `log.info`, `log.warn`, `log.error` — and the
 * signature is exactly the shape those 15 call sites already use: a message
 * plus zero or more extra values. Nothing was widened to look future-proof.
 * `verbose`, `silly`, `scope` and the `transports` object are deliberately
 * absent: no core module uses them, and the shell configures transports
 * directly (`main.ts`, `bootstrap/installAppDataPaths.ts`).
 *
 * THE VARIADIC TAIL IS NOT DECORATION. Four of the 15 call sites pass a second
 * argument — e.g. `databaseService.ts:310`,
 * `log.error("[DatabaseService] Migration FAILED:", message)`. `electron-log`
 * joins those with a space when it formats the line, so collapsing them into a
 * single template string here would change what lands in `main.log`. Passing
 * the tail through unchanged is what keeps the file byte-identical.
 *
 * @module electron/capabilities/logger
 */

/**
 * Structured-enough logging: a severity, a message, and optional extra values
 * the host's formatter appends.
 *
 * Implementations MUST be synchronous and MUST NOT throw. Every wrapped call
 * site in the core is either on a hot path or inside a `catch` (see
 * {@link SilentLogger}), and a logger that throws turns a handled failure into
 * an escaped one.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * The {@link Logger} in force before a host shell installs one: it drops
 * everything on the floor.
 *
 * WHY THIS DOES NOT THROW, WHEN `UnavailableSecretStore` DOES
 * -----------------------------------------------------------
 * The two capabilities fail differently and the difference is not stylistic.
 * A secret store that is missing cannot be substituted — returning a wrong
 * answer would mean writing plaintext where ciphertext was promised, so
 * throwing is the only honest response.
 *
 * A logger that is missing can be substituted, and the alternative is worse.
 * The call sites this seam wraps are dominated by error paths:
 * `databaseService.ts:310` is inside the migration-failure `catch`,
 * `:605`/`:682`/`:691` are inside the baseline-fence `catch`es, and
 * `initializationBroadcaster.ts:175` is inside the "the window is not ready
 * yet" `catch` that exists precisely because that call is expected to fail. A
 * throwing default converts every one of those handled failures into an
 * escaped exception, in the paths where the app is already in trouble, and no
 * happy-path test would see it.
 *
 * That is not a hole in the guard. What makes "nobody installed a logger"
 * impossible to reach in a shipped build is `isInstalled()` +
 * `assertNativeCapabilitiesInstalled()`, which stops the launch and names the
 * capability — not the default's behaviour. The default only decides how a
 * NON-shell context (a unit test that never composes a shell, a script) reads,
 * and there silence is right.
 */
export class SilentLogger implements Logger {
  debug(_message: string, ..._args: unknown[]): void {
    /* intentionally silent — see the class doc for why this is not a throw */
  }

  info(_message: string, ..._args: unknown[]): void {
    /* intentionally silent */
  }

  warn(_message: string, ..._args: unknown[]): void {
    /* intentionally silent */
  }

  error(_message: string, ..._args: unknown[]): void {
    /* intentionally silent */
  }
}
