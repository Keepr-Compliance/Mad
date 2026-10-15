/**
 * BACKLOG-3790 — idevicebackup2's plist dumps (device properties, installed-app
 * bundle IDs) must never be written to main.log or Sentry, and genuine error lines
 * must still be.
 *
 * ## Fixture provenance
 *
 * - `<key>PasswordProtected</key>`, `<key>fm-activation-locked</key>` and the
 *   `<string>com.…</string>` shape are the three lines the founder reported on this
 *   item (2.40.0-beta.1, Windows, 2026-10-08). The real bundle ID was elided in the
 *   report and is the user's data; `com.example.trustwallet` STANDS IN for it, chosen
 *   to contain the trigger word "trust" so it would have warned under the old code.
 * - The trace header (`property_list_service.c:253 ... printing 433 bytes plist:`),
 *   the `<?xml` / `<!DOCTYPE` / `<plist>` envelope, tab indentation and the
 *   DLMessageProcessMessage body are copied from the TRANSCRIBED fixtures in
 *   `backupService.failureCause-2913.test.ts` (founder's main.log, 2026-08-27 22:44).
 * - The Windows trace lines and GENUINE_FAULTS are copied from
 *   `backupService.stderrClassification-2898.test.ts`.
 * - The `<data>` base64 lines are NOT transcribed: no captured dump contains one.
 *   They are the base64 of fixed ASCII strings, present to pin the `<data>` shape:
 *   a full-width line and a short wrapped tail.
 */

import { EventEmitter } from "events";
import type { BackupResult } from "../../types/backup";

const TEST_UDID = "a1b2c3d4e5f6789012345678901234567890abcd";

const STAND_IN_BUNDLE_ID = "com.example.trustwallet";

/** Lines whose text must never reach a log or Sentry. */
const PRIVATE_MARKERS = [
  STAND_IN_BUNDLE_ID,
  "PasswordProtected",
  "fm-activation-locked",
  "TrustedHostAttached",
];

/** A lockdown/installation-proxy style dump carrying the founder's three lines. */
const DEVICE_PROPERTIES_DUMP = `22:44:38.022 property_list_service.c:253 internal_plist_receive_timeout(): printing 433 bytes plist:
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PasswordProtected</key>
\t<false/>
\t<key>TrustedHostAttached</key>
\t<true/>
\t<key>fm-activation-locked</key>
\t<data>
\tZGlzayBzcGFjZSBzdG9yYWdlIGxvY2tlZA==
\tbG9ja2Vk
\t</data>
\t<key>Applications</key>
\t<array>
\t\t<string>${STAND_IN_BUNDLE_ID}</string>
\t\t<string>com.apple.mobilesafari</string>
\t</array>
</dict>
</plist>`;

/** TRANSCRIBED envelope — see backupService.failureCause-2913.test.ts. */
const DL_PROCESS_MESSAGE_208 = `22:44:38.022 property_list_service.c:253 internal_plist_receive_timeout(): printing 433 bytes plist:
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
\t<string>DLMessageProcessMessage</string>
\t<dict>
\t\t<key>ErrorCode</key>
\t\t<integer>208</integer>
\t\t<key>MessageName</key>
\t\t<string>Response</string>
\t</dict>
</array>
</plist>`;

/** Real faults — copied from backupService.stderrClassification-2898.test.ts. */
const GENUINE_FAULTS = [
  "ERROR: Device is locked, please unlock it and enter your passcode",
  "ERROR: Could not start service com.apple.mobilebackup2. Trust the computer first.",
  "ERROR: Backup password is incorrect",
  "ERROR: Not enough disk space on the target volume",
  "16:06:22 D:\\a\\1\\s\\libimobiledevice\\src\\userpref.c:412 userpref_read_pair_record(): could not read pair record",
];

const mockSpawn = jest.fn();

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      all: jest.fn().mockReturnValue([]),
      get: jest.fn().mockReturnValue(null),
      run: jest.fn(),
    }),
    close: jest.fn(),
    exec: jest.fn(),
  })),
);

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/mock/userData"),
    isPackaged: false,
  },
}));

jest.mock("electron-log", () => ({
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("fs", () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    access: jest.fn().mockRejectedValue(new Error("Not found")),
    readdir: jest.fn().mockResolvedValue([]),
    stat: jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("no"), { code: "ENOENT" })),
    rm: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue("<plist></plist>"),
  },
}));

jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn((name: string) => `/mock/${name}`),
  isMockMode: jest.fn().mockReturnValue(false),
}));

jest.mock("../backupDecryptionService", () => ({
  backupDecryptionService: {
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: jest.fn(),
  },
}));

import log from "electron-log";
import * as Sentry from "@sentry/electron/main";
import {
  BackupService,
  REDACTED_APP_ID,
  createIdeviceOutputLogFilterState,
  filterIdeviceOutputLineForLog,
  redactIdeviceOutputForLog,
} from "../backupService";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
}

function runBackup(script: (proc: FakeProcess) => void): Promise<BackupResult> {
  const service = new BackupService();
  mockSpawn.mockImplementation((cmd: string) => {
    const proc = new FakeProcess();
    if (cmd.includes("ideviceinfo")) {
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("false\n"));
        proc.emit("close", 0);
      });
    } else {
      setTimeout(() => script(proc), 0);
    }
    return proc;
  });
  return service.startBackup({ udid: TEST_UDID });
}

/** Drive the private per-line stderr classifier, as the stderr handler does. */
function classify(service: BackupService, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    (
      service as unknown as { classifyStderrLine(l: string): void }
    ).classifyStderrLine(line);
  }
}

/** Every string handed to electron-log (any level) or a Sentry breadcrumb. */
function everythingWritten(): string {
  const levels = ["info", "debug", "warn", "error"] as const;
  const logged = levels.flatMap((lvl) =>
    (log[lvl] as jest.Mock).mock.calls.map((c: unknown[]) =>
      c.map((a: unknown) => JSON.stringify(a)).join(" "),
    ),
  );
  const crumbs = (Sentry.addBreadcrumb as jest.Mock).mock.calls.map((c) =>
    JSON.stringify(c[0]),
  );
  return [...logged, ...crumbs].join("\n");
}

function warnedLines(): string[] {
  return (log.warn as jest.Mock).mock.calls
    .filter((c) => String(c[0]).includes("stderr (error pattern)"))
    .map((c) => String(c[1] ?? ""));
}

describe("BACKLOG-3790: idevicebackup2 output is logged without plist dumps or app IDs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("stderr classifier", () => {
    it("writes NOTHING from a device-properties dump to any log level or Sentry", () => {
      const service = new BackupService();
      classify(service, DEVICE_PROPERTIES_DUMP);
      expect(warnedLines()).toEqual([]);
      const written = everythingWritten();
      for (const marker of PRIVATE_MARKERS)
        expect(written).not.toContain(marker);
      expect(written).not.toContain("<key>");
      expect(written).not.toContain("ZGlzayBzcGFjZSBzdG9yYWdlIGxvY2tlZA");
      expect(written).not.toContain("bG9ja2Vk");
      expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
    });

    it("sweep: each plist line shape alone, with the dump head cut off, is not logged", () => {
      // The 64 KB stderr cap and chunk boundaries can drop `<?xml`/`<plist>`.
      // KNOWN LIMIT: a short base64 tail (`bG9ja2Vk`) is only recognisable INSIDE a
      // dump — alone it is indistinguishable from an ordinary word — so it is
      // excluded here and covered by the whole-dump test above.
      const bodyLines = DEVICE_PROPERTIES_DUMP.split("\n")
        .slice(4)
        .filter((l) => l.trim() !== "bG9ja2Vk");
      for (const line of bodyLines) {
        jest.clearAllMocks();
        const service = new BackupService();
        classify(service, line);
        expect({ line, written: everythingWritten() }).toEqual({
          line,
          written: "",
        });
      }
    });

    it("still warns on every genuine fault", () => {
      const service = new BackupService();
      for (const fault of GENUINE_FAULTS) classify(service, fault);
      expect(warnedLines()).toHaveLength(GENUINE_FAULTS.length);
    });

    it("still warns on every genuine fault that follows a dump which lost its </plist>", () => {
      const truncated = DEVICE_PROPERTIES_DUMP.split("\n")
        .slice(0, 12)
        .join("\n");
      expect(truncated).not.toContain("</plist>");
      for (const fault of GENUINE_FAULTS) {
        jest.clearAllMocks();
        const service = new BackupService();
        classify(service, truncated);
        classify(service, fault);
        expect({ fault, warned: warnedLines() }).toEqual({
          fault,
          warned: [fault],
        });
      }
    });

    it("redacts a third-party bundle ID on a non-plist line and keeps com.apple.*", () => {
      const service = new BackupService();
      classify(
        service,
        `ERROR: Could not start service com.apple.mobilebackup2 for ${STAND_IN_BUNDLE_ID}`,
      );
      // "trust" lived only inside the bundle ID, so once redacted it no longer warns:
      // the line goes to the unrecognised-line breadcrumb, redacted.
      expect(warnedLines()).toEqual([]);
      const crumbs = (Sentry.addBreadcrumb as jest.Mock).mock.calls.map(
        (c) => c[0].message,
      );
      expect(crumbs).toEqual([
        `ERROR: Could not start service com.apple.mobilebackup2 for ${REDACTED_APP_ID}`,
      ]);
    });
  });

  describe("filter function", () => {
    it("leaves file names, versions and addresses alone", () => {
      const state = createIdeviceOutputLogFilterState();
      const line =
        "16:06:22 D:\\a\\1\\s\\libimobiledevice\\src\\idevice.c:652 idevice_connection_receive_timeout(): SSL_read 4, received 0 Manifest.db 1.4.0 192.168.1.10";
      expect(filterIdeviceOutputLineForLog(line, state)).toBe(line);
    });

    it("drops the whole failure dump but keeps the header and error lines", () => {
      const stderr = `${DEVICE_PROPERTIES_DUMP}\n${DL_PROCESS_MESSAGE_208}\n${GENUINE_FAULTS[0]}`;
      const { text, suppressedLines } = redactIdeviceOutputForLog(stderr);
      expect(text.split("\n")).toEqual([
        DEVICE_PROPERTIES_DUMP.split("\n")[0],
        DL_PROCESS_MESSAGE_208.split("\n")[0],
        GENUINE_FAULTS[0],
      ]);
      expect(suppressedLines).toBeGreaterThan(20);
    });
  });

  describe("buffer cut mid-line (64 KB cap) and hex-dump rows", () => {
    // Shape of SR's probe dump: the founder-reported keys plus the stand-in bundle ID.
    const CUT_DUMP = `22:44:38.022 property_list_service.c:253 internal_plist_receive_timeout(): printing 433 bytes plist:
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>PasswordProtected</key>
\t<true/>
\t<key>Applications</key>
\t<array>
\t\t<string>${STAND_IN_BUNDLE_ID}</string>
\t</array>
</dict>
</plist>
${GENUINE_FAULTS[0]}`;

    it("no cut point of a dump lets a key, value, bundle ID or tag fragment through", () => {
      let checked = 0;
      for (let cut = 0; cut < CUT_DUMP.length; cut++) {
        for (const headTruncated of [false, true]) {
          const { text } = redactIdeviceOutputForLog(CUT_DUMP.slice(cut), {
            headTruncated,
          });
          checked++;
          expect({ cut, headTruncated, text }).toEqual({
            cut,
            headTruncated,
            text: expect.not.stringMatching(
              /PasswordProtected|Applications|trustwallet|xample|[<>]/,
            ),
          });
        }
      }
      expect(checked).toBe(CUT_DUMP.length * 2);
    });

    it("drops the first line of a buffer that hit the cap, even a bare fragment", () => {
      const out = redactIdeviceOutputForLog(
        "ple.trustwallet\nERROR: Device is locked",
        {
          headTruncated: true,
        },
      );
      expect(out.text).toBe("ERROR: Device is locked");
    });

    it("keeps the first line when nothing was truncated", () => {
      expect(
        redactIdeviceOutputForLog("ERROR: first", { headTruncated: false })
          .text,
      ).toBe("ERROR: first");
    });

    it("suppresses libimobiledevice packet-dump rows", () => {
      const state = createIdeviceOutputLogFilterState();
      for (const row of [
        '0000: 3c 3f 78 6d 6c 20 76 65 72 73 69 6f 6e 3d 22 31   | <?xml version="1',
        "0010: 63 6f 6d 2e 65 78 61 6d 70 6c 65 2e 74 72 75 73   | com.example.trus",
      ]) {
        expect(filterIdeviceOutputLineForLog(row, state)).toBeNull();
      }
    });

    it("leaves version strings and file names alone", () => {
      const state = createIdeviceOutputLogFilterState();
      for (const l of ["libimobiledevice v1.3.0", "Reading Status.plist.bak"]) {
        expect(filterIdeviceOutputLineForLog(l, state)).toBe(l);
      }
      expect(
        filterIdeviceOutputLineForLog(`Domain ${STAND_IN_BUNDLE_ID}`, state),
      ).toBe(`Domain ${REDACTED_APP_ID}`);
    });
  });

  describe("wiring through a real run", () => {
    it("a failed run logs no plist/app-ID text anywhere, keeps the error, and still reads the device's code", async () => {
      const result = await runBackup((proc) => {
        proc.stderr.emit("data", Buffer.from(`${DEVICE_PROPERTIES_DUMP}\n`));
        proc.stderr.emit("data", Buffer.from(`${DL_PROCESS_MESSAGE_208}\n`));
        proc.stderr.emit("data", Buffer.from(`${GENUINE_FAULTS[0]}\n`));
        proc.stdout.emit("data", Buffer.from(`${STAND_IN_BUNDLE_ID}\n`));
        proc.emit("close", 1);
      });

      const written = everythingWritten();
      for (const marker of PRIVATE_MARKERS)
        expect(written).not.toContain(marker);

      // The genuine error is still visible: as a warn, and in the failure dump.
      expect(warnedLines()).toEqual([GENUINE_FAULTS[0]]);
      const stderrDump = (log.error as jest.Mock).mock.calls.find(
        (c) => c[0] === "[BackupService] stderr:",
      );
      expect(String(stderrDump?.[1])).toContain(GENUINE_FAULTS[0]);

      // Suppressed lines are counted at debug.
      const debugLines = (log.debug as jest.Mock).mock.calls.map((c) =>
        String(c[0]),
      );
      expect(
        debugLines.some((l) => /\d+ stderr line\(s\) not logged/.test(l)),
      ).toBe(true);

      // The raw buffer is untouched: the device's own code still classifies the failure.
      expect(result.success).toBe(false);
      expect(result.failureCause?.deviceErrorCode).toBe(208);
    });
  });
});
