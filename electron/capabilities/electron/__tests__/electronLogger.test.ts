/**
 * `ElectronLogger` — the Electron shell's Logger (BACKLOG-2962, seams PR A).
 *
 * WHY THIS SUITE CARRIES MORE WEIGHT THAN ITS SIZE SUGGESTS
 * ---------------------------------------------------------
 * `tests/helpers/installTestCapabilities.js` installs a call-time forwarder for
 * the jest shell, NOT this class — for the same reason
 * `installTestSecretStore` installs the mocked `safeStorage` object rather than
 * `ElectronSecretStore`: a suite's own `jest.mock("electron-log", …)` factory is
 * registered after `tests/setup.js` has run, so a binding captured then would
 * forward to the wrong mock.
 *
 * The consequence, stated rather than hidden: **no other suite in this
 * repository exercises `ElectronLogger`.** This file is the only thing standing
 * between a broken forwarder and a green build, so it asserts the two
 * properties that would actually break `main.log` — the method mapping, and the
 * variadic tail — rather than merely that the class constructs.
 */

import log from "electron-log";

import { ElectronLogger } from "../electronLogger";

const mockLog = log as unknown as {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
};

describe("ElectronLogger (BACKLOG-2962)", () => {
  beforeEach(() => {
    mockLog.debug.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  it("maps each level to the SAME electron-log method, not a renamed one", () => {
    const logger = new ElectronLogger();
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(mockLog.debug).toHaveBeenCalledWith("d");
    expect(mockLog.info).toHaveBeenCalledWith("i");
    expect(mockLog.warn).toHaveBeenCalledWith("w");
    expect(mockLog.error).toHaveBeenCalledWith("e");
  });

  it("passes the variadic tail through unchanged", () => {
    // Four call sites depend on this. `databaseService.ts:310` is
    // `hostLogger.error("[DatabaseService] Migration FAILED:", message)`, and
    // electron-log joins the two with a space when it formats the line.
    // Collapsing them here would silently change what lands in main.log.
    const logger = new ElectronLogger();
    logger.error("[DatabaseService] Migration FAILED:", "disk full");
    logger.warn("[BaselineFence] readonly open failed:", "SQLITE_CANTOPEN", 14);

    expect(mockLog.error).toHaveBeenCalledWith(
      "[DatabaseService] Migration FAILED:",
      "disk full",
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      "[BaselineFence] readonly open failed:",
      "SQLITE_CANTOPEN",
      14,
    );
  });

  it("passes the tail through on info and debug too, which no live site exercises yet", () => {
    // SR measured this gap on PR #2523 (control SR-4): dropping `...args` from
    // `info` passed every suite in the tree, because all four tail-passing call
    // sites today are `error` x1 (databaseService.ts:311) and `warn` x3 (:606,
    // :692, :770). LATENT, not live — no production path could observe it.
    //
    // Pinned rather than removed. The tail is load-bearing on two of the four
    // methods, so deleting it from the other two would make the interface
    // asymmetric for no runtime gain, and the first person to write
    // `hostLogger.info(msg, err)` would meet a compile error on `info` and none
    // on `warn`. Two assertions close the gap instead.
    const logger = new ElectronLogger();
    logger.info("[Precache] warmed", 12, "threads");
    logger.debug("[InitBroadcaster] stage", { stage: "db-opening" });

    expect(mockLog.info).toHaveBeenCalledWith("[Precache] warmed", 12, "threads");
    expect(mockLog.debug).toHaveBeenCalledWith("[InitBroadcaster] stage", {
      stage: "db-opening",
    });
  });

  it("calls with no tail reach electron-log with exactly one argument", () => {
    // `logService.writeToConsole` passes one string and nothing else. Spreading
    // an empty tail must not turn that into a second `undefined` argument,
    // which electron-log would render.
    const logger = new ElectronLogger();
    logger.info("2026-08-31T00:52:00.585Z INFO  [Transactions] one arg only");
    expect(mockLog.info.mock.calls[0]).toHaveLength(1);
  });

  it("adds no prefix, no scope and no level tag of its own", () => {
    // Everything in a main.log line is decided by logService.formatLogEntry and
    // by electron-log's own formatter. If this class ever starts decorating,
    // every line in the file shifts.
    const logger = new ElectronLogger();
    const line = "2026-08-30T16:50:27.981Z INFO  [SessionHandlers] Supabase session restored";
    logger.info(line);
    expect(mockLog.info).toHaveBeenCalledWith(line);
  });
});
