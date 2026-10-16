/**
 * PE import reader shared by the iPhone tools tests (BACKLOG-3812, BACKLOG-3927).
 * Reads the import and delay-import tables of a Windows PE file. Reads bytes only;
 * nothing is executed.
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";

/** Windows system DLLs: provided by the OS, never shipped in the tools folder. */
export const SYSTEM_DLL = /^(api-ms-win-[a-z0-9-]+|kernel32|advapi32|bcrypt|crypt32|ole32|shell32|user32|ws2_32)\.dll$/;

/** DLL names in a PE file's import and delay-import tables, lower-cased. */
export function peImports(file: string): string[] {
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
export function spawnedTools(servicesDir: string): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(servicesDir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    for (const m of readFileSync(path.join(servicesDir, f), "utf8").matchAll(/getCommand\("([^"]+)"\)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/** Lower-cased names of the tools and every non-system DLL they load, followed recursively in `dir`. */
export function importClosure(dir: string, tools: string[]): { closure: string[]; missing: string[] } {
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
  return { closure: [...seen].sort(), missing: [...missing].sort() };
}
