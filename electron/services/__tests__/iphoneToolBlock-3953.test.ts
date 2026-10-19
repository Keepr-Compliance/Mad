/**
 * BACKLOG-3953: what counts as "an iPhone tool never started" on Windows.
 *
 * The founder ruled false positives worse than misses, so most of this file is the
 * look-alikes that must NOT count. The most likely wrong implementation is "any
 * non-zero exit = blocked"; the exit-code cases below are what catch it.
 */
import fs from "fs";

const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  addBreadcrumb: jest.fn(),
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("electron", () => ({ app: { isPackaged: false } }));

let mockToolsDir = "";
jest.mock("../libimobiledeviceService", () => ({
  ...jest.requireActual("../libimobiledeviceService"),
  getLibimobiledevicePath: () => mockToolsDir,
}));

import {
  detectToolBlock,
  checkToolFilesForBlock,
  findMissingToolFiles,
  __resetToolBlockReportForTests,
} from "../iphoneToolBlock";
import { REQUIRED_IPHONE_TOOL_FILES } from "../libimobiledeviceService";
import { formatToolBlockedError, SUPPORT_CLOSING_LINE } from "../diagnostics/userFacingErrors";
import { makeToolsFolder, type ToolsFolder } from "./helpers/iphoneToolsFolder-3953";
import {
  thrownSpawnError,
  emittedSpawnError,
  DLL_NOT_FOUND_SIGNED,
  DLL_NOT_FOUND_UNSIGNED,
} from "./fixtures/windowsSpawnErrors-3953";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: string) =>
  Object.defineProperty(process, "platform", { value, configurable: true });

let tools: ToolsFolder;

beforeEach(() => {
  jest.clearAllMocks();
  __resetToolBlockReportForTests();
  setPlatform("win32");
  tools = makeToolsFolder(REQUIRED_IPHONE_TOOL_FILES);
  mockToolsDir = tools.dir;
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  tools.cleanup();
  jest.restoreAllMocks();
});

const exe = () => `${mockToolsDir}\\idevicebackup2.exe`;

describe("counts as a block", () => {
  it("spawn THROWS EPERM / UNKNOWN with every file present -> spawn-<code>", () => {
    expect(detectToolBlock("idevicebackup2", { error: thrownSpawnError("EPERM") })?.kind).toBe("spawn-eperm");
    expect(detectToolBlock("idevicebackup2", { error: thrownSpawnError("UNKNOWN") })?.kind).toBe("spawn-unknown");
  });

  it("spawn EMITS EACCES -> spawn-eacces", () => {
    expect(detectToolBlock("idevicebackup2", { error: emittedSpawnError("EACCES", exe()) })?.kind).toBe("spawn-eacces");
  });

  it("spawn ENOENT with the exe gone from an existing folder -> file-missing naming it", () => {
    tools.remove("idevicebackup2.exe");
    const block = detectToolBlock("idevicebackup2", { error: emittedSpawnError("ENOENT", exe()) });
    expect(block).toMatchObject({ kind: "file-missing", missingFiles: ["idevicebackup2.exe"] });
  });

  it("DLL-not-found exit (both forms) WITH a DLL missing -> dll-missing", () => {
    tools.remove("imobiledevice.dll");
    for (const exitCode of [DLL_NOT_FOUND_UNSIGNED, DLL_NOT_FOUND_SIGNED]) {
      expect(detectToolBlock("idevice_id", { exitCode })).toMatchObject({
        kind: "dll-missing",
        missingFiles: ["imobiledevice.dll"],
      });
    }
  });

  it("a zero-byte required file counts as missing", () => {
    tools.empty("plist.dll");
    expect(checkToolFilesForBlock("pre-flight")).toMatchObject({ kind: "file-missing", missingFiles: ["plist.dll"] });
  });
});

describe("C4: look-alikes that must NOT count", () => {
  it.each([0, 1, -1, 255, 3221225477 /* access violation: started, then crashed */])(
    "exit code %p after a normal start, all files present -> not a block",
    (exitCode) => {
      expect(detectToolBlock("idevice_id", { exitCode })).toBeNull();
    },
  );

  it("exit code 1 / -1 is not a block EVEN when a file is missing (a started tool is never a block)", () => {
    tools.remove("idevicepair.exe");
    expect(detectToolBlock("idevice_id", { exitCode: -1 })).toBeNull();
    expect(detectToolBlock("idevicebackup2", { exitCode: 1 })).toBeNull();
  });

  it("DLL-not-found exit (both forms) with every file present -> not a block", () => {
    expect(detectToolBlock("idevice_id", { exitCode: DLL_NOT_FOUND_UNSIGNED })).toBeNull();
    expect(detectToolBlock("idevice_id", { exitCode: DLL_NOT_FOUND_SIGNED })).toBeNull();
  });

  it.each(["EMFILE", "ENFILE", "EAGAIN"] as const)("spawn %s (out of handles/processes) -> not a block", (code) => {
    expect(detectToolBlock("idevicebackup2", { error: emittedSpawnError(code, exe()) })).toBeNull();
    tools.remove("idevicebackup2.exe");
    expect(detectToolBlock("idevicebackup2", { error: emittedSpawnError(code, exe()) })).toBeNull();
  });

  it("spawn ENOENT with every file present -> not a block", () => {
    expect(detectToolBlock("idevicebackup2", { error: emittedSpawnError("ENOENT", exe()) })).toBeNull();
  });

  it("the whole tools folder absent (broken install) -> not a block, for every signal", () => {
    tools.cleanup();
    expect(findMissingToolFiles()).toBeNull();
    expect(checkToolFilesForBlock("pre-flight")).toBeNull();
    expect(detectToolBlock("idevicebackup2", { error: emittedSpawnError("ENOENT", exe()) })).toBeNull();
    expect(detectToolBlock("idevicebackup2", { error: thrownSpawnError("EPERM") })).toBeNull();
    expect(detectToolBlock("idevice_id", { exitCode: DLL_NOT_FOUND_UNSIGNED })).toBeNull();
  });

  it("no Sentry event for any look-alike", () => {
    detectToolBlock("idevice_id", { exitCode: -1 });
    detectToolBlock("idevicebackup2", { error: emittedSpawnError("EMFILE", exe()) });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe("C7: macOS is untouched", () => {
  it("returns null and never stats a file", () => {
    setPlatform("darwin");
    tools.remove("idevicebackup2.exe");
    const stat = jest.spyOn(fs, "statSync");
    const exists = jest.spyOn(fs, "existsSync");
    expect(detectToolBlock("idevicebackup2", { error: emittedSpawnError("ENOENT", "idevicebackup2") })).toBeNull();
    expect(detectToolBlock("idevicebackup2", { error: thrownSpawnError("EPERM") })).toBeNull();
    expect(checkToolFilesForBlock("pre-flight")).toBeNull();
    expect(stat).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe("C8: one Sentry event per session", () => {
  it("five detections send one event, tagged with the kind and the tool", () => {
    tools.remove("idevice_id.exe");
    for (let i = 0; i < 5; i++) {
      expect(detectToolBlock("idevice_id", { error: emittedSpawnError("ENOENT", "idevice_id.exe") })).not.toBeNull();
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0][1]).toMatchObject({
      tags: { component: "libimobiledevice", iphone_tool_block: "file-missing", tool: "idevice_id" },
    });
  });
});

describe("C5: the message", () => {
  it("ends exactly with the contact-support line and names no vendor", () => {
    const e = formatToolBlockedError("C:\\Program Files\\Keepr");
    const lines = e.actionSuggestion.split("\n");
    expect(lines[lines.length - 1]).toBe("If this keeps happening, contact support.");
    expect(SUPPORT_CLOSING_LINE).toBe("If this keeps happening, contact support.");
    expect(e.title).toBe("Your antivirus blocked Keepr's iPhone tools");
    expect(lines.slice(0, -1)).toEqual([
      "1. Open your antivirus program.",
      "2. Open its Quarantine list.",
      "3. Restore Keepr's files from there.",
      "4. Add an exception for the Keepr folder: C:\\Program Files\\Keepr",
      "5. Close Keepr and open it again.",
    ]);
    expect(e.code).toBe("SECURITY_SOFTWARE_BLOCKED");
    expect(`${e.title} ${e.description} ${e.actionSuggestion}`).not.toMatch(/iTunes|Install|https?:/i);
  });
});
