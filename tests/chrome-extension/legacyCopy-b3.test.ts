/**
 * Live (B3, founder 2026-10-03): no stale message of the old pairing (a code
 * Keepr showed, typed into the page) is left anywhere — the extension says
 * "Not linked. Click the Keepr icon in Chrome's toolbar to link."
 * Mutation: an old message brought back → red.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..");
const STALE = [
  /type it into the Keepr box/i,
  /Pair with Keepr/i,
  /8-character/i,
  /Settings › Google Messages for the code/i,
  /Pair the extension with Keepr/i,
  /pairing code/i,
  /Show a new pairing code/i,
];
const FILES = [
  "chrome-extension/background.js", "chrome-extension/job.js", "chrome-extension/content.js", "chrome-extension/eyes.js",
  "chrome-extension/popup.js", "chrome-extension/popup.html", "chrome-extension/welcome.js", "chrome-extension/welcome.html",
  "chrome-extension/options.js", "chrome-extension/options.html",
];
/** String literals only (comments may tell the history). */
function literals(src: string): string[] {
  return Array.from(src.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)).map((m) => m[0]);
}

describe("no stale pairing copy (B3)", () => {
  it("none in the extension's user-facing text", () => {
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      const text = f.endsWith(".html") ? src.replace(/<!--[\s\S]*?-->/g, "") : literals(src).join("\n");
      for (const re of STALE) expect([f, re.source, re.test(text)]).toEqual([f, re.source, false]);
    }
  });

  it("the one 'not linked' line, the same in Keepr and the extension", () => {
    const line = "Not linked. Click the Keepr icon in Chrome's toolbar to link.";
    expect(fs.readFileSync(path.join(ROOT, "chrome-extension/background.js"), "utf8")).toContain(`const NOT_PAIRED = "${line}";`);
    expect(fs.readFileSync(path.join(ROOT, "electron/services/rcsPairingAuth.ts"), "utf8")).toContain(`const NOT_PAIRED_MESSAGE = "${line}";`);
  });
});
