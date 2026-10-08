/**
 * BACKLOG-3823 — the production guard of runLegacySweep, reached through its
 * REAL inputs (no injected deps): app.isPackaged, the appDataPaths override
 * lookup (KEEPR_USER_DATA_DIR / dev dir) and app.commandLine.hasSwitch
 * ("user-data-dir"). Every target is inside one mkdtemp fixture root.
 */

let mockRoot = "";
const mockApp = {
  isPackaged: true,
  getPath: jest.fn((name: string) => {
    if (name === "appData") return `${mockRoot}/appData`;
    if (name === "userData") return `${mockRoot}/appData/keepr`;
    if (name === "home") return `${mockRoot}/home`;
    return `${mockRoot}/other`;
  }),
  commandLine: { hasSwitch: jest.fn((_s: string) => false) },
};
jest.mock("electron", () => ({ app: mockApp }));

jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockApplied = jest.fn((): unknown => null);
jest.mock("../../../bootstrap/appDataPaths", () => ({
  getAppliedAppDataPaths: () => mockApplied(),
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runLegacySweep } from "../legacySweep";

function write(rel: string): void {
  const p = path.join(mockRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
}

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of fs.readdirSync(d)) {
      const r = rel ? `${rel}/${name}` : name;
      out.push(r);
      const st = fs.lstatSync(path.join(d, name));
      if (st.isDirectory() && !st.isSymbolicLink()) walk(path.join(d, name), r);
    }
  };
  walk(dir, "");
  return out.sort();
}

beforeEach(() => {
  mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s6-legacy-guard-"));
  mockApp.isPackaged = true;
  mockApp.commandLine.hasSwitch.mockImplementation(() => false);
  mockApplied.mockImplementation(() => null);
  write("appData/magic-audit/Backups/UDID/Manifest.db");
  write("appData/magic-audit/message-attachments/a.png");
  write("appData/magic-audit/mad.db");
});

afterEach(() => {
  fs.rmSync(mockRoot, { recursive: true, force: true });
});

describe("runLegacySweep production guard, real inputs (BACKLOG-3823)", () => {
  it("skips when the appData override lookup returns a path (KEEPR_USER_DATA_DIR / dev dir)", async () => {
    mockApplied.mockImplementation(() => ({
      dir: `${mockRoot}/appData/keepr-dev`,
      previousDir: `${mockRoot}/appData/keepr`,
      isFirstRun: false,
      isExplicitOverride: true,
    }));
    const before = listTree(mockRoot);
    const result = await runLegacySweep();
    expect(result).toMatchObject({ ran: false, skipReason: "profile-override" });
    expect(listTree(mockRoot)).toEqual(before);
  });

  it("skips when --user-data-dir is on the command line", async () => {
    mockApp.commandLine.hasSwitch.mockImplementation((s: string) => s === "user-data-dir");
    const before = listTree(mockRoot);
    const result = await runLegacySweep();
    expect(result).toMatchObject({ ran: false, skipReason: "profile-override" });
    expect(mockApp.commandLine.hasSwitch).toHaveBeenCalledWith("user-data-dir");
    expect(listTree(mockRoot)).toEqual(before);
  });

  it("skips when the build is not packaged", async () => {
    mockApp.isPackaged = false;
    const before = listTree(mockRoot);
    const result = await runLegacySweep();
    expect(result).toMatchObject({ ran: false, skipReason: "not-packaged" });
    expect(listTree(mockRoot)).toEqual(before);
  });

  it("runs on the fixture tree when packaged with no override", async () => {
    const result = await runLegacySweep();
    expect(result.ran).toBe(true);
    expect(result.rootsFound).toBe(1);
    expect(listTree(path.join(mockRoot, "appData/magic-audit"))).toEqual(["mad.db"]);
  });
});
