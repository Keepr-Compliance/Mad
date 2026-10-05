/**
 * @jest-environment node
 */
/**
 * SR clean-up C8 — the Chrome Web Store package (scripts/package-extension.mjs).
 *
 * The zip is read back here by its own small reader (central directory →
 * local entries → inflate, each CRC checked), independent of the writer.
 *
 * Mutations (each turns a test red):
 *   M1 manifest "key" kept                                   → "no key"
 *   M2 a dev-only file packaged (DEV_ONLY emptied)           → "dev-only"
 *   M3 a file's bytes changed / dropped                      → "same bytes"
 *   M4 dotfiles / maps packaged                              → "dotfiles"
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import * as zlib from "zlib";

const ROOT = path.join(__dirname, "..", "..");
const EXT = path.join(ROOT, "chrome-extension");
const SCRIPT = pathToFileURL(path.join(ROOT, "scripts", "package-extension.mjs")).href;

/** Build in a child Node (the script is an ES module): the zip of `dir`, base64. */
function build(dir: string = EXT): Buffer {
  const code = `import { buildExtensionZip } from ${JSON.stringify(SCRIPT)};
process.stdout.write(buildExtensionZip(${JSON.stringify(dir)}).bytes.toString("base64"));`;
  const out = execFileSync(process.execPath.includes("electron") ? "node" : process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  return Buffer.from(out, "base64");
}

const CRC_TABLE = Array.from({ length: 256 }, (_v, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const byte of b) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** name → bytes, every CRC verified. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central entry");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("bad local entry");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch: ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (sub: string) => {
    for (const n of fs.readdirSync(path.join(dir, sub))) {
      const rel = sub ? `${sub}/${n}` : n;
      if (fs.statSync(path.join(dir, rel)).isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

jest.setTimeout(60000);

describe("the Chrome Web Store package (C8)", () => {
  let files: Map<string, Buffer>;
  let bytes: Buffer;
  beforeAll(() => {
    bytes = build();
    files = unzip(bytes);
  });

  it("no key: the packaged manifest is the source's minus \"key\", same version", () => {
    const src = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
    expect(typeof src.key).toBe("string"); // the source keeps it (stable dev id)
    const packed = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    expect("key" in packed).toBe(false);
    const { key: _key, ...rest } = src;
    expect(packed).toEqual(rest);
    expect(packed.version).toBe(src.version);
  });

  it("dev-only: the build entry, the vendor notes and the SBOM are left out; the licence ships", () => {
    for (const dev of ["vendor/noble-p256.entry.mjs", "vendor/README.md", "vendor/SBOM.json"]) {
      expect([dev, files.has(dev)]).toEqual([dev, false]);
    }
    expect(files.has("vendor/LICENSE-noble.txt")).toBe(true);
    expect(files.has("vendor/noble-p256.js")).toBe(true);
  });

  it("same bytes: every other source file, unchanged", () => {
    const expected = sourceFiles(EXT).filter((f) => !["vendor/noble-p256.entry.mjs", "vendor/README.md", "vendor/SBOM.json"].includes(f));
    expect([...files.keys()].sort()).toEqual(expected);
    for (const f of expected) {
      if (f === "manifest.json") continue;
      expect([f, files.get(f)!.equals(fs.readFileSync(path.join(EXT, f)))]).toEqual([f, true]);
    }
    // Every file the manifest names is in the package.
    const m = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    const named: string[] = [
      m.background?.service_worker,
      m.action?.default_popup,
      m.options_ui?.page ?? m.options_page,
      ...Object.values((m.icons ?? {}) as Record<string, string>),
      ...((m.content_scripts ?? []) as Array<{ js?: string[] }>).flatMap((c) => c.js ?? []),
    ].filter(Boolean);
    for (const n of named) expect([n, files.has(n)]).toEqual([n, true]);
  });

  it("dotfiles and source maps never ship; the build is deterministic", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-ext-"));
    try {
      fs.cpSync(EXT, tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, ".DS_Store"), "x");
      fs.mkdirSync(path.join(tmp, ".git"));
      fs.writeFileSync(path.join(tmp, ".git", "HEAD"), "x");
      fs.writeFileSync(path.join(tmp, "job.js.map"), "{}");
      const names = [...unzip(build(tmp)).keys()];
      expect(names.filter((n) => n.startsWith(".") || n.includes("/.") || n.endsWith(".map"))).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    expect(build().equals(bytes)).toBe(true);
  });
});
