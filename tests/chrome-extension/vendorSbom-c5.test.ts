/**
 * SR clean-up C5 (CASA hardening).
 *
 * N19 — the vendored @noble bundle is recorded in chrome-extension/vendor/
 * SBOM.json: the versions, and the bundle's sha256. A rebuild or an upgrade
 * that is not recorded there fails here.
 *   Mutations: one byte of noble-p256.js changed → red; a version in the
 *   README / LICENSE / entry that differs from the SBOM → red.
 *
 * N20 — regression: the link key is created non-extractable (importKey
 * extractable=false, "sign" only) and is never exported or written anywhere
 * but the key store. The live check (a real link) is workerPairing's W4.
 *   Mutations: extractable true, or an exportKey call → red.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const VENDOR = path.join(EXT, "vendor");
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

interface Sbom {
  bomFormat: string;
  components: Array<{ name: string; version: string; purl: string; licenses: Array<{ license: { id: string } }> }>;
  files: Array<{ path: string; sha256: string; bundles: string[] }>;
}
const sbom = JSON.parse(read(path.join(VENDOR, "SBOM.json"))) as Sbom;

describe("vendored code is recorded (N19)", () => {
  it("the SBOM lists @noble/curves 1.9.7 and @noble/hashes 1.8.0 (MIT)", () => {
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.components.map((c) => [c.name, c.version, c.licenses[0].license.id])).toEqual([
      ["@noble/curves", "1.9.7", "MIT"],
      ["@noble/hashes", "1.8.0", "MIT"],
    ]);
    for (const c of sbom.components) expect(c.purl).toBe(`pkg:npm/${c.name.replace("@", "%40")}@${c.version}`);
  });

  it("every vendored script is in the SBOM, with its sha256", () => {
    const scripts = fs.readdirSync(VENDOR).filter((f) => f.endsWith(".js"));
    expect(scripts.sort()).toEqual(sbom.files.map((f) => f.path).sort());
    for (const f of sbom.files) {
      const actual = crypto.createHash("sha256").update(read(path.join(VENDOR, f.path))).digest("hex");
      expect([f.path, actual]).toEqual([f.path, f.sha256]);
    }
  });

  it("the README, LICENSE and build entry name the SBOM's versions", () => {
    for (const file of ["README.md", "LICENSE-noble.txt", "noble-p256.entry.mjs"]) {
      const text = read(path.join(VENDOR, file));
      for (const c of sbom.components) expect([file, text.includes(`${c.name} ${c.version}`) || text.includes(`${c.name}@${c.version}`)]).toEqual([file, true]);
      // No other version of these packages named anywhere.
      const named = [...text.matchAll(/@noble\/(curves|hashes)[ @](\d+\.\d+\.\d+)/g)].map((m) => `@noble/${m[1]} ${m[2]}`);
      for (const n of named) expect(sbom.components.map((c) => `${c.name} ${c.version}`)).toContain(n);
    }
  });
});

describe("the link key is never extractable (N20 regression)", () => {
  const bg = read(path.join(EXT, "background.js"));

  it("imported non-extractable, sign only — and never exported", () => {
    const imports = [...bg.matchAll(/crypto\.subtle\.importKey\(([^;]*)\)/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const args of imports) expect(args).toMatch(/,\s*false,\s*\["sign"\]\s*$/);
    for (const file of fs.readdirSync(EXT).filter((f) => f.endsWith(".js"))) {
      expect([file, /exportKey|wrapKey/.test(read(path.join(EXT, file)))]).toEqual([file, false]);
    }
  });

  it("the key store holds the pairing (id + CryptoKey) only; chrome.storage never gets it", () => {
    expect(bg).toMatch(/await keyStore\(\)\.put\(pairing\)/);
    const sets = [...bg.matchAll(/chrome\.storage\.local\.set\(([^;]*)\)/g)].map((m) => m[1]);
    for (const s of sets) expect(s).not.toMatch(/pairing|pairId|keyHex|\.key\b|cryptoKey/i);
  });
});
