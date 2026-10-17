/**
 * @jest-environment node
 */
/**
 * BACKLOG-3969 — the Android companion's Wi-Fi sync server and QR pairing are
 * removed. This guard keeps their IPC surface from coming back:
 *
 *  R1  none of the 8 channel names appears in electron/ production code (a
 *      handler cannot be registered, nor a bridge expose it, without the name);
 *  R2  the preload bridge exposes no `pairing` / `localSync` namespace.
 *
 * The compiler is the other half: WindowApi no longer declares either
 * namespace, so a renderer caller is a type error.
 *
 * Sources are read as text (comments stripped), the same way mainNetGuard-3799
 * reads them.
 */

import fs from "fs";
import path from "path";

const ELECTRON_DIR = path.join(__dirname, "..");

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__mocks__" || entry.name === "node_modules") continue;
      out.push(...productionFiles(full));
    } else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|spec)\.(ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Code with line and block comments removed. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const FILES = productionFiles(ELECTRON_DIR).map((f) => ({
  rel: path.relative(ELECTRON_DIR, f).split(path.sep).join("/"),
  code: code(fs.readFileSync(f, "utf8")),
}));

const REMOVED_CHANNELS = [
  "sync:start-server",
  "sync:stop-server",
  "sync:get-status",
  "sync:check-firewall",
  "sync:clear-android-data",
  "pairing:generate-qr",
  "pairing:get-status",
  "pairing:disconnect",
];

describe("BACKLOG-3969 the Android companion IPC surface is gone", () => {
  it("the scan sees the tree, including the handler and preload files", () => {
    const rels = FILES.map((f) => f.rel);
    expect(FILES.length).toBeGreaterThan(200);
    expect(rels).toContain("main.ts");
    expect(rels).toContain("preload.ts");
    expect(rels).toContain("handlers/rcsImportHandlers.ts");
  });

  it.each(REMOVED_CHANNELS)("no production file names the channel %s", (channel) => {
    const hits = FILES.filter((f) => f.code.includes(`"${channel}"`) || f.code.includes(`'${channel}'`)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it("the preload bridge exposes no pairing / localSync namespace", () => {
    const preload = FILES.find((f) => f.rel === "preload.ts")!.code;
    expect(preload).not.toMatch(/\bpairing\s*:/);
    expect(preload).not.toMatch(/\blocalSync\s*:/);
  });
});
