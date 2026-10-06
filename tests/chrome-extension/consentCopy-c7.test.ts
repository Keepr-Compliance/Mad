/**
 * SR clean-up C7 — the extension's own pages match the consent Keepr asks for,
 * and name Keepr's privacy policy.
 *
 * Mutations: the stale "Keepr explains there…" sentence back; the privacy link
 * missing from options.html or from the popup → red.
 */
import * as fs from "fs";
import * as path from "path";

const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f: string) => fs.readFileSync(path.join(EXT, f), "utf8");
const PRIVACY = "https://keeprcompliance.com/privacy";

describe("consent wording and the privacy link (C7)", () => {
  it("options.html: the consent line matches Keepr's (asked before the first sync, withdrawn in Settings)", () => {
    const html = read("options.html");
    expect(html).toContain("Before your first sync, Keepr asks you to agree. You can withdraw it in Keepr: Settings › Google Messages.");
    expect(html).not.toMatch(/Keepr explains there/);
  });

  it("options.html and the popup link Keepr's privacy policy (a new tab)", () => {
    expect(read("options.html")).toContain(`<a href="${PRIVACY}" target="_blank" rel="noopener noreferrer">Privacy policy</a>`);
    expect(read("popup.js")).toContain(`var PRIVACY_URL = "${PRIVACY}";`);
  });
});
