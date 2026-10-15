/**
 * BACKLOG-3762 — the dependency manifest for the vendored @noble bundle.
 *
 * vendor-manifests/chrome-extension-noble/ declares the packages bundled in
 * chrome-extension/vendor/noble-p256.js so GitHub's dependency graph and
 * Dependabot see them. It is only useful while it names the SAME versions as
 * the bundle, which chrome-extension/vendor/SBOM.json records (and
 * vendorSbom-c5.test.ts pins to the bundle's sha256).
 *   Mutations: a version in package.json or in package-lock.json that differs
 *   from the SBOM → red; a dependency added or dropped → red; the folder moved
 *   under chrome-extension/ or made a root workspace → red.
 */
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const MANIFEST_DIR = path.join(ROOT, "vendor-manifests", "chrome-extension-noble");
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));

interface Sbom {
  components: Array<{ name: string; version: string }>;
}
const sbom = readJson(path.join(ROOT, "chrome-extension", "vendor", "SBOM.json")) as Sbom;
const sbomVersions = Object.fromEntries(sbom.components.map((c) => [c.name, c.version]));

describe("vendored @noble manifest matches the SBOM (BACKLOG-3762)", () => {
  const pkg = readJson(path.join(MANIFEST_DIR, "package.json"));
  const lock = readJson(path.join(MANIFEST_DIR, "package-lock.json"));

  it("package.json pins exactly the SBOM's packages and versions", () => {
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toEqual(sbomVersions);
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("package-lock.json resolves exactly the SBOM's versions", () => {
    expect(lock.packages[""].dependencies).toEqual(sbomVersions);
    const resolved = Object.fromEntries(
      Object.entries(lock.packages as Record<string, { version: string }>)
        .filter(([k]) => k.startsWith("node_modules/"))
        .map(([k, v]) => [k.slice("node_modules/".length), v.version]),
    );
    expect(resolved).toEqual(sbomVersions);
  });

  it("ships nowhere: outside chrome-extension/ and not a root workspace", () => {
    expect(path.relative(path.join(ROOT, "chrome-extension"), MANIFEST_DIR).startsWith("..")).toBe(true);
    const workspaces: string[] = readJson(path.join(ROOT, "package.json")).workspaces;
    for (const w of workspaces) expect(["vendor-manifests", "vendor-manifests/*", "vendor-manifests/chrome-extension-noble"]).not.toContain(w);
    const rootLock = readJson(path.join(ROOT, "package-lock.json"));
    expect(Object.keys(rootLock.packages).filter((k) => k.startsWith("vendor-manifests"))).toEqual([]);
  });
});
