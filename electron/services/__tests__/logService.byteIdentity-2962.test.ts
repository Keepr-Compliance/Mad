/**
 * The Logger seam changes WHERE a log line goes, and nothing about WHAT IT SAYS
 * (BACKLOG-2962, seams PR A).
 *
 * `logService` used to call `electron-log` directly; it now calls `hostLogger`.
 * That is a refactor only if the bytes are unchanged, and "unchanged" is not
 * something a reviewer can eyeball across a 2,200-line diff. This suite pins it
 * with real lines.
 *
 * THE FIXTURES ARE TRANSCRIBED, NOT INVENTED
 * ------------------------------------------
 * Every expected string below is the tail of a real line read out of
 * `~/Library/Logs/keepr/main.log` on the founder's machine (8,721 lines, written
 * 2026-08-30). The leading `[2026-08-30 18:52:00.585] [info]  ` on each real
 * line is electron-log's own file-transport prefix and is NOT this module's
 * output; what `logService` hands the Logger is everything after it, and that is
 * what is asserted.
 *
 * ONE SUBSTITUTION, AND IT IS DECLARED: the `transaction=` UUID in the
 * CACHE-HITMISS line is replaced with a synthetic all-zero v4 UUID. This
 * repository is public and that identifier is live customer data. Nothing else
 * is altered — not a space, not the level padding, not the bracket placement.
 *
 * WHY THE PADDING IS THE INTERESTING PART
 * ---------------------------------------
 * `formatLogEntry` writes `entry.level.toUpperCase().padEnd(5)` followed by a
 * space. So INFO and WARN (4 letters) are followed by TWO spaces before the
 * context bracket, and ERROR (5 letters) by ONE. Both shapes appear in the real
 * file and both are asserted, so a one-character change to that `padEnd` reds
 * this suite — which is the control this file exists to make possible.
 */

import { LogService } from "../logService";
import type { Logger } from "../../capabilities/logger";
import { installLogger } from "../../capabilities/loggerProvider";
import { DatabaseError } from "../../types/database";
import { redactLogHook } from "../../config/logFileConfig";

/**
 * The `transaction=` id in the transcribed CACHE-HITMISS line, replaced.
 *
 * The real line carried a live transaction id. This repository is public, so the
 * value is substituted while the SHAPE — a v4 UUID in that position, that many
 * characters wide — is preserved, which is the only property the byte-identity
 * assertion depends on.
 */
// The waiver must be the line IMMEDIATELY above, or on the value's own line —
// a two-line comment put a line between them and the guard rejected it, which
// is the guard reading its own rule rather than a nearby mention. Fixed here.
// pii-allow-uuid: invented, not from any live row — it stands in for the real line's transaction id
const SYNTHETIC_TRANSACTION_ID = "00000000-0000-4000-8000-000000000000";

/** Everything the core hands the Logger, in order. */
let received: Array<{ level: keyof Logger; line: string; tail: unknown[] }>;

function captureLogger(): Logger {
  const record =
    (level: keyof Logger) =>
    (line: string, ...tail: unknown[]) => {
      received.push({ level, line, tail });
    };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/**
 * Freeze the clock at the instant the transcribed line was written, so the
 * ISO-8601 timestamp in the expected string is the real one rather than a
 * regular expression standing in for it.
 */
function at(iso: string): void {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(iso));
}

describe("logService line bytes are unchanged by the Logger seam (BACKLOG-2962)", () => {
  beforeEach(() => {
    received = [];
    installLogger(captureLogger());
  });

  afterEach(() => {
    jest.useRealTimers();
    // Put the jest shell's logger back, so no later case in this file — or any
    // module this file leaves loaded — inherits the capture logger.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  });

  it("the default config this suite exercises is the singleton's config", () => {
    // Guards against the suite proving byte identity for a configuration
    // production never uses.
    return new LogService().getConfig().then((config) => {
      expect(config).toEqual({
        logToFile: false,
        logToConsole: true,
        minLevel: "info",
        maxLogFiles: 10,
      });
    });
  });

  it("INFO with a context and a bracketed telemetry payload — [CACHE-HITMISS]", async () => {
    at("2026-08-31T00:52:00.585Z");
    await new LogService().info(
      `[CACHE-HITMISS] transaction=${SYNTHETIC_TRANSACTION_ID} reason=auto ` +
        "fetched=0 hits=0 misses=0 hitRate=0.000",
      "Transactions",
    );

    expect(received).toEqual([
      {
        level: "info",
        line:
          "2026-08-31T00:52:00.585Z INFO  [Transactions] [CACHE-HITMISS] " +
          `transaction=${SYNTHETIC_TRANSACTION_ID} reason=auto ` +
          "fetched=0 hits=0 misses=0 hitRate=0.000",
        tail: [],
      },
    ]);
  });

  it("INFO with a plain sentence — [SessionHandlers]", async () => {
    at("2026-08-30T16:50:27.981Z");
    await new LogService().info(
      "Supabase session restored for returning user",
      "SessionHandlers",
    );

    expect(received[0].line).toBe(
      "2026-08-30T16:50:27.981Z INFO  [SessionHandlers] Supabase session restored for returning user",
    );
  });

  it("WARN pads to the same width as INFO — [FeatureGateHandlers]", async () => {
    at("2026-08-30T16:50:21.651Z");
    await new LogService().warn(
      "[FeatureGate] No active Supabase session, cannot resolve org",
      "FeatureGateHandlers",
    );

    expect(received[0].line).toBe(
      "2026-08-30T16:50:21.651Z WARN  [FeatureGateHandlers] [FeatureGate] No active Supabase session, cannot resolve org",
    );
  });

  it("ERROR is five letters, so it gets ONE space, not two — [ConnectionStatus]", async () => {
    at("2026-08-30T16:50:58.007Z");
    await new LogService().error(
      "[ConnectionStatus] Error checking Google connection:",
      "ConnectionStatus",
    );

    expect(received[0].line).toBe(
      "2026-08-30T16:50:58.007Z ERROR [ConnectionStatus] [ConnectionStatus] Error checking Google connection:",
    );
  });

  it("metadata is still appended as pretty-printed JSON on its own lines", async () => {
    // The one shape the transcribed lines above do not cover, and the only other
    // branch in formatLogEntry.
    at("2026-08-31T00:52:00.585Z");
    await new LogService().info("Initializing database", "DatabaseService", {
      path: "/tmp/test-user-data/mad.db",
    });

    expect(received[0].line).toBe(
      "2026-08-31T00:52:00.585Z INFO  [DatabaseService] Initializing database\n" +
        '{\n  "path": "/tmp/test-user-data/mad.db"\n}',
    );
  });

  it("a level below minLevel still reaches nothing — the seam did not open a new path", async () => {
    at("2026-08-31T00:52:00.585Z");
    await new LogService().debug("not emitted", "Transactions");
    expect(received).toEqual([]);
  });

  it("logToConsole:false still reaches nothing", async () => {
    at("2026-08-31T00:52:00.585Z");
    await new LogService({ logToConsole: false }).info("not emitted", "Transactions");
    expect(received).toEqual([]);
  });
});

/**
 * An Error in metadata keeps its message (BACKLOG-4072).
 *
 * `message` and `stack` are own NON-enumerable properties of an Error, so a bare
 * `JSON.stringify` drops both: `new Error("why")` serialised as `{}`, and a
 * DatabaseError as `{ "name": "DatabaseError" }` only (its constructor assigns
 * `this.name`, which is enumerable). The call shape these cases use is the live
 * one at electron/handlers/licenseHandlers.ts — `logService.error(msg, ctx, { error })`.
 */
describe("logService keeps an Error's name and message, and not its stack (BACKLOG-4072)", () => {
  beforeEach(() => {
    received = [];
    installLogger(captureLogger());
  });

  afterEach(() => {
    jest.useRealTimers();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../../../tests/helpers/installTestCapabilities").installTestCapabilities();
  });

  it("P1: the message of a plain Error appears in the written line", async () => {
    at("2026-08-31T00:52:00.585Z");
    await new LogService().error("[License] Failed to get license:", "License", {
      error: new Error("why"),
    });

    expect(received).toHaveLength(1);
    expect(received[0].line).toContain('"message": "why"');
    expect(received[0].line).toContain('"name": "Error"');
  });

  it("P1b: a DatabaseError keeps its name, message, and own fields", async () => {
    at("2026-08-31T00:52:00.585Z");
    await new LogService().error("[License] Failed to get license:", "License", {
      error: new DatabaseError("no such table: licenses", "SQLITE_ERROR"),
    });

    const line = received[0].line;
    expect(line).toContain('"name": "DatabaseError"');
    expect(line).toContain('"message": "no such table: licenses"');
    expect(line).toContain('"code": "SQLITE_ERROR"');
  });

  it("P2: an email in the message is raw before the sink hook and redacted after it", async () => {
    at("2026-08-31T00:52:00.585Z");
    await new LogService().error("[License] Failed to get license:", "License", {
      error: new Error("no row for jane.doe@example.com"),
    });

    const line = received[0].line;
    // logService itself does not redact: the email reaches the line raw...
    expect(line).toContain("jane.doe@example.com");
    // ...and the electron-log sink hook is what redacts it.
    const hooked = redactLogHook({
      data: [line],
      level: "error",
      date: new Date(),
    } as unknown as Parameters<typeof redactLogHook>[0]);
    const out = String((hooked as { data: unknown[] }).data[0]);
    expect(out).toContain("j***@example.com");
    expect(out).not.toContain("jane.doe@example.com");
  });

  it("P3: a newline in the message cannot forge a second log line", async () => {
    at("2026-08-31T00:52:00.585Z");
    const forged = "2026-08-31T00:52:00.585Z ERROR [Forged] fake";
    await new LogService().error("[License] Failed to get license:", "License", {
      error: new Error(`real failure\n${forged}`),
    });

    const lines = received[0].line.split(/\r?\n/);
    expect(lines.some((l) => l.startsWith(forged))).toBe(false);
  });

  it("P4: the stack is left out — no stack frames in the line", async () => {
    at("2026-08-31T00:52:00.585Z");
    await new LogService().error("[License] Failed to get license:", "License", {
      error: new Error("why"),
    });

    // "    at " matches a frame whether it is written raw or JSON-escaped after "\n".
    expect(received[0].line).not.toContain("    at ");
    expect(received[0].line).not.toContain('"stack"');
  });
});
