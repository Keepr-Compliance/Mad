/**
 * BACKLOG-3812: the iPhone tools folder ships what the app runs, and nothing it removed.
 *
 * The four tools the app spawns are read from the getCommand("...") call sites in
 * electron/services. Their DLL dependencies are read from the real PE import and
 * delay-import tables of the shipped binaries, followed recursively. Nothing here is a
 * hand-written dependency list, so a new import or a new spawned tool is seen.
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..", "..");
const TOOLS = path.join(REPO, "resources", "win", "libimobiledevice");
const SERVICES = path.join(REPO, "electron", "services");

/** Removed in BACKLOG-3812: nothing the app runs loads them. */
const REMOVED = ["iproxy.exe", "usbmuxd.exe", "ideviceinstaller.exe", "ideviceactivation.exe", "readline.dll"];

/** Windows system DLLs: provided by the OS, never shipped in the tools folder. */
const SYSTEM_DLL = /^(api-ms-win-[a-z0-9-]+|kernel32|advapi32|bcrypt|crypt32|ole32|shell32|user32|ws2_32)\.dll$/;

/** DLL names in a PE file's import and delay-import tables, lower-cased. */
function peImports(file: string): string[] {
  const d = readFileSync(file);
  const pe = d.readUInt32LE(0x3c);
  if (d.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error(`not a PE file: ${file}`);
  const coff = pe + 4;
  const nSections = d.readUInt16LE(coff + 2);
  const optSize = d.readUInt16LE(coff + 16);
  const opt = coff + 20;
  const dataDirs = opt + (d.readUInt16LE(opt) === 0x20b ? 112 : 96);
  const sections: Array<{ va: number; size: number; raw: number }> = [];
  for (let i = 0; i < nSections; i++) {
    const s = opt + optSize + 40 * i;
    sections.push({ va: d.readUInt32LE(s + 12), size: Math.max(d.readUInt32LE(s + 8), d.readUInt32LE(s + 16)), raw: d.readUInt32LE(s + 20) });
  }
  const off = (rva: number): number => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`RVA 0x${rva.toString(16)} outside every section of ${file}`);
    return rva - s.va + s.raw;
  };
  const cstr = (o: number): string => d.toString("latin1", o, d.indexOf(0, o)).toLowerCase();
  const out = new Set<string>();
  // Import directory (index 1): 20-byte descriptors, name RVA at +12, all-zero terminator.
  const imp = d.readUInt32LE(dataDirs + 8);
  if (imp) {
    for (let o = off(imp); ; o += 20) {
      if (d.readUInt32LE(o) === 0 && d.readUInt32LE(o + 12) === 0 && d.readUInt32LE(o + 16) === 0) break;
      out.add(cstr(off(d.readUInt32LE(o + 12))));
    }
  }
  // Delay-load import directory (index 13): 32-byte descriptors, name RVA at +4.
  const delay = d.readUInt32LE(dataDirs + 8 * 13);
  if (delay) {
    for (let o = off(delay); ; o += 32) {
      if (d.subarray(o, o + 32).every((b) => b === 0)) break;
      out.add(cstr(off(d.readUInt32LE(o + 4))));
    }
  }
  return [...out];
}

/** Tools the app spawns: every getCommand("name") in non-test electron/services sources. */
function spawnedTools(): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(SERVICES)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    for (const m of readFileSync(path.join(SERVICES, f), "utf8").matchAll(/getCommand\("([^"]+)"\)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

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
