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

/** Functions that turn a tool name into a path or command; every call site is a spawn. */
const TOOL_RESOLVERS = ["getCommand", "getExecutablePath"];
/** The file that defines the resolvers; its own definitions and delegation (getCommand -> getExecutablePath) are not spawn sites. */
const RESOLVER_FILE = "libimobiledeviceService.ts";

/** Non-test .ts/.tsx source files under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Tools the app spawns: the string-literal argument of every getCommand(...) / getExecutablePath(...)
 * call in non-test sources under `electronDir` (recursive, either quote style). Throws when a call's
 * argument is not a plain string literal, since the tool it names cannot be known.
 */
export function spawnedTools(electronDir: string): string[] {
  const names = new Set<string>();
  const nonLiteral: string[] = [];
  const call = new RegExp(`\\b(${TOOL_RESOLVERS.join("|")})\\s*\\(\\s*([^)]*)\\)`, "g");
  const literal = /^(["'])([A-Za-z0-9_-]+)\1$/;
  for (const f of sourceFiles(electronDir)) {
    const src = readFileSync(f, "utf8");
    const isResolverFile = path.basename(f) === RESOLVER_FILE;
    for (const m of src.matchAll(call)) {
      const before = src.slice(Math.max(0, (m.index as number) - 20), m.index as number);
      if (/function\s+$/.test(before)) continue; // the definition
      const arg = m[2].trim();
      const lit = literal.exec(arg);
      if (lit) {
        names.add(lit[2]);
      } else if (!isResolverFile) {
        const line = src.slice(0, m.index).split("\n").length;
        nonLiteral.push(`${path.relative(electronDir, f)}:${line} ${m[1]}(${arg})`);
      }
    }
  }
  if (nonLiteral.length) throw new Error(`tool resolver called with a non-literal argument:\n${nonLiteral.join("\n")}`);
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
