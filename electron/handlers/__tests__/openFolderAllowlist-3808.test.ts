/**
 * BACKLOG-3808 — `open-folder` opens only locations the main process wrote.
 *
 * Real files on disk (mkdtemp); electron.shell is mocked so nothing is opened.
 * Registration goes through the same export-side call the app uses
 * (rememberOpenablePath), and the handler is the one registerConversationHandlers
 * installs.
 */
import fs from "fs";
import os from "os";
import path from "path";

const mockOpenPath = jest.fn();
const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      registered.set(channel, fn);
    },
  },
  shell: { openPath: (...a: unknown[]) => mockOpenPath(...a) },
  BrowserWindow: jest.fn(),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  withScope: jest.fn(),
}));

const mockWarn = jest.fn();
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../services/contactsService", () => ({
  getContactNames: jest.fn(),
  resolveContactName: jest.fn(),
}));
jest.mock("../../services/db/messageDbService", () => ({
  getConversationsFromMessages: jest.fn(),
}));
jest.mock("../../services/db/readOnlySqlite", () => ({
  openSqliteReadOnly: jest.fn(),
}));

import { registerConversationHandlers } from "../conversationHandlers";
import {
  rememberOpenablePath,
  clearOpenablePathsForTests,
  OPEN_REFUSED_MESSAGE,
} from "../../services/openablePaths";

type OpenResult = { success: boolean; error?: string };

let root: string;
let exportDir: string;
let exportFile: string;
let outsideDir: string;

function openFolder(p: unknown): Promise<OpenResult> {
  const fn = registered.get("open-folder");
  if (!fn) throw new Error("open-folder not registered");
  return fn({}, p) as Promise<OpenResult>;
}

beforeAll(() => {
  registerConversationHandlers({} as never);
});

beforeEach(async () => {
  clearOpenablePathsForTests();
  mockOpenPath.mockReset();
  mockOpenPath.mockResolvedValue("");
  mockWarn.mockReset();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3808-")));
  exportDir = path.join(root, "downloads", "Audit 123 Main St");
  fs.mkdirSync(exportDir, { recursive: true });
  fs.writeFileSync(path.join(exportDir, "inside.txt"), "x");
  exportFile = path.join(root, "downloads", "Audit report.pdf");
  fs.writeFileSync(exportFile, "%PDF");
  outsideDir = path.join(root, "elsewhere");
  fs.mkdirSync(outsideDir);
  // What the export handlers do after writing.
  await rememberOpenablePath(exportDir);
  await rememberOpenablePath(exportFile);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function expectRefused(result: OpenResult, reason: string) {
  expect(result).toEqual({ success: false, error: OPEN_REFUSED_MESSAGE });
  expect(mockOpenPath).not.toHaveBeenCalled();
  expect(mockWarn).toHaveBeenCalledTimes(1);
  const [, , meta] = mockWarn.mock.calls[0];
  expect(meta).toEqual({ reason });
  // the log never carries the path
  expect(JSON.stringify(mockWarn.mock.calls[0])).not.toContain(root);
}

describe("open-folder (BACKLOG-3808)", () => {
  it("opens a folder export the app wrote", async () => {
    await expect(openFolder(exportDir)).resolves.toEqual({ success: true });
    expect(mockOpenPath).toHaveBeenCalledWith(exportDir);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("opens a single-file export the app wrote", async () => {
    await expect(openFolder(exportFile)).resolves.toEqual({ success: true });
    expect(mockOpenPath).toHaveBeenCalledWith(exportFile);
  });

  it("reports the OS opener's error instead of claiming success", async () => {
    mockOpenPath.mockResolvedValue("No application knows how to open this");
    await expect(openFolder(exportDir)).resolves.toEqual({
      success: false,
      error: "No application knows how to open this",
    });
  });

  it("refuses an existing path that the app did not write", async () => {
    expectRefused(await openFolder(outsideDir), "not_registered");
  });

  it("refuses a path inside an export (exact match only)", async () => {
    expectRefused(await openFolder(path.join(exportDir, "inside.txt")), "not_registered");
  });

  it("refuses a symlink inside an export that points outside", async () => {
    const link = path.join(exportDir, "link-out");
    fs.symlinkSync(outsideDir, link);
    expectRefused(await openFolder(link), "not_registered");
  });

  it("refuses '..' traversal out of a registered export", async () => {
    expectRefused(await openFolder(path.join(exportDir, "..", "..", "elsewhere")), "not_registered");
  });

  it("refuses a path that does not exist", async () => {
    expectRefused(await openFolder(path.join(root, "nope")), "not_found");
  });

  it("refuses a registered export that was deleted and replaced by a different kind", async () => {
    fs.rmSync(exportFile);
    fs.mkdirSync(exportFile);
    expectRefused(await openFolder(exportFile), "kind_changed");
  });

  it.each([
    ["empty string", ""],
    ["non-string", 42],
    ["NUL byte", `${exportDir}\0`],
  ])("refuses an invalid value (%s)", async (_label, value) => {
    expectRefused(await openFolder(value), "invalid");
  });

  it("refuses a relative path", async () => {
    expectRefused(await openFolder("downloads"), "not_absolute");
  });

  it("opens a registered export reached through a symlinked parent (resolved to the real path)", async () => {
    const aliasParent = path.join(root, "alias");
    fs.symlinkSync(path.join(root, "downloads"), aliasParent);
    const viaAlias = path.join(aliasParent, path.basename(exportDir));
    await expect(openFolder(viaAlias)).resolves.toEqual({ success: true });
    expect(mockOpenPath).toHaveBeenCalledWith(exportDir);
  });
});
