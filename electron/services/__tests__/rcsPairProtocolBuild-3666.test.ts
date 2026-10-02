/**
 * @jest-environment node
 */
/**
 * BACKLOG-3666 SR S2 — the main process never loads code from the extension
 * folder (resources/chrome-extension, or the Downloads copy: outside the
 * asar's integrity and code signing). The pairing protocol is bundled into
 * the main-process build at BUILD time from the SAME source files.
 *
 * Mutations that turn this red:
 *   G1 a main-process file loading pair-protocol.js / the vendored noble at runtime → "never loads"
 *   G2 build:electron no longer building the bundle                             → "build"
 *   G3 the bundle not interoperating with the extension's file                  → "same source"
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..", "..");

function mainProcessSources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__" && e.name !== "node_modules") mainProcessSources(p, out);
    } else if (/\.(ts|js|cjs|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("the main process and the pairing protocol (SR S2)", () => {
  it("never loads pair-protocol.js or the vendored noble from the extension folder (G1)", () => {
    const offenders = mainProcessSources(path.join(ROOT, "electron")).filter((f) =>
      // A string literal naming the files = code that loads them (comments may mention them).
      /["'`][^"'`\n]*(pair-protocol\.js|noble-p256)[^"'`\n]*["'`]/.test(fs.readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    // The loader's CODE (comments stripped): a path next to the compiled file, nothing else.
    const loader = fs
      .readFileSync(path.join(ROOT, "electron", "services", "rcsPairProtocol.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(loader).toMatch(/path\.join\(__dirname, "\.\.", "pair-protocol\.cjs"\)/);
    expect(loader).not.toMatch(/resourcesPath|extensionSourceDir|appPath|Downloads/);
  });

  it("build:electron builds the bundle from the extension's own source into dist-electron (inside the asar) (G2)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["build:electron"]).toMatch(/npm run build:pair/);
    expect(pkg.scripts["build:pair"]).toMatch(/chrome-extension\/pair-protocol\.js .*--outfile=dist-electron\/pair-protocol\.cjs/);
    expect(pkg.build.files).toContain("dist-electron/**/*");
  });

  it("the bundle IS the extension's protocol: they pair with each other (G3)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require("esbuild") as typeof import("esbuild");
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keepr-pair-")), "pair-protocol.cjs");
    esbuild.buildSync({ entryPoints: [path.join(ROOT, "chrome-extension", "pair-protocol.js")], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent" });
    /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
    const keepr = require(out) as Record<string, any>;
    const ext = require(path.join(ROOT, "chrome-extension", "pair-protocol.js")) as Record<string, any>;
    /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
    const code = keepr.newCode();
    const a = ext.startA(code);
    const b = keepr.respondB(code, a.pA);
    const f = ext.finishA(a.state, b.pB, b.cB);
    expect(f.cA).toBe(b.expectCA);
    expect(keepr.sessionKey(b.ke, "p")).toBe(ext.sessionKey(f.ke, "p"));
  });
});
