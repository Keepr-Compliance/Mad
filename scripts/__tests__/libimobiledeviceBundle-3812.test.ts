/**
 * BACKLOG-3812: the iPhone tools folder ships what the app runs, and nothing it removed.
 *
 * The four tools the app spawns are read from the getCommand(...) / getExecutablePath(...)
 * call sites anywhere under electron/ (either quote style; BACKLOG-3979 reuses the hardened
 * scanner from helpers/peImports). Their DLL dependencies are read from the real PE import and
 * delay-import tables of the shipped binaries, followed recursively. Nothing here is a
 * hand-written dependency list, so a new import or a new spawned tool is seen.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { peImports, spawnedTools as scanSpawnedTools, SYSTEM_DLL } from "./helpers/peImports";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..", "..");
const TOOLS = path.join(REPO, "resources", "win", "libimobiledevice");
const ELECTRON = path.join(REPO, "electron");

/** Removed in BACKLOG-3812: nothing the app runs loads them. */
const REMOVED = ["iproxy.exe", "usbmuxd.exe", "ideviceinstaller.exe", "ideviceactivation.exe", "readline.dll"];

/** Tools the app spawns, from the shared scanner (BACKLOG-3979). */
const spawnedTools = (): string[] => scanSpawnedTools(ELECTRON);

interface Report {
  closure: string[];
  missing: string[];
  removedPresent: string[];
}

/** Walk the import graph from the given tools inside `dir`. */
function inspect(dir: string, tools: string[]): Report {
  const present = new Map(readdirSync(dir).map((f) => [f.toLowerCase(), f]));
  const seen = new Set<string>();
  const missing = new Set<string>();
  const stack = tools.map((t) => `${t}.exe`.toLowerCase());
  while (stack.length) {
    const name = stack.pop() as string;
    if (seen.has(name)) continue;
    const real = present.get(name);
    if (!real) {
      missing.add(name);
      continue;
    }
    seen.add(name);
    for (const dep of peImports(path.join(dir, real))) if (!SYSTEM_DLL.test(dep)) stack.push(dep);
  }
  return {
    closure: [...seen].sort(),
    missing: [...missing].sort(),
    removedPresent: REMOVED.filter((r) => present.has(r.toLowerCase())),
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "imd-3812-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Temp copy of the files the four tools load, so a control can delete or add one. */
function copyClosure(report: Report): string {
  const present = new Map(readdirSync(TOOLS).map((f) => [f.toLowerCase(), f]));
  for (const f of report.closure) {
    const real = present.get(f) as string;
    copyFileSync(path.join(TOOLS, real), path.join(tmp, real));
  }
  return tmp;
}

describe("iPhone tools folder (BACKLOG-3812)", () => {
  it("the app spawns exactly these four tools", () => {
    expect(spawnedTools()).toEqual(["idevice_id", "idevicebackup2", "ideviceinfo", "idevicepair"]);
  });

  it("ships every DLL the four tools load, directly or through another DLL", () => {
    const r = inspect(TOOLS, spawnedTools());
    expect(r.missing).toEqual([]);
    expect(r.closure).toEqual([
      "getopt.dll",
      "idevice_id.exe",
      "idevicebackup2.exe",
      "ideviceinfo.exe",
      "idevicepair.exe",
      "imobiledevice.dll",
      "libcrypto-1_1-x64.dll",
      "libssl-1_1-x64.dll",
      "plist.dll",
      "usbmuxd.dll",
      "vcruntime140.dll",
    ]);
  });

  it("idevicepair.exe loads usbmuxd.dll directly", () => {
    expect(peImports(path.join(TOOLS, "idevicepair.exe"))).toContain("usbmuxd.dll");
  });

  it("does not ship the five removed files", () => {
    expect(inspect(TOOLS, spawnedTools()).removedPresent).toEqual([]);
  });

  it("goes red when a DLL the tools load is missing", () => {
    const dir = copyClosure(inspect(TOOLS, spawnedTools()));
    rmSync(path.join(dir, "usbmuxd.dll"));
    expect(inspect(dir, spawnedTools()).missing).toEqual(["usbmuxd.dll"]);
  });

  it("goes red when a removed file comes back", () => {
    const dir = copyClosure(inspect(TOOLS, spawnedTools()));
    writeFileSync(path.join(dir, "iproxy.exe"), "");
    expect(inspect(dir, spawnedTools()).removedPresent).toEqual(["iproxy.exe"]);
  });
});
