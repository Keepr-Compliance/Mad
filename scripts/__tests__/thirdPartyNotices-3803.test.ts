/**
 * BACKLOG-3803: third-party notices stay consistent with what Keepr ships.
 *
 * Runs the real checker (scripts/third-party/generate-notices.js --check) against
 * the repo, and against temp copies for the negative cases, so each guard is shown
 * to go red on the state it exists to catch.
 */
import { spawnSync } from "child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "third-party", "generate-notices.js");
const ROOT = path.join(REPO, "resources", "third-party");
const TOOLS = path.join(REPO, "resources", "win", "libimobiledevice");

const run = (args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, "--check", "--repo", REPO, ...args], { encoding: "utf8" });

interface Component {
  id: string;
  files?: string[];
  bundle?: string;
  licenses: string[];
}
interface Data {
  toolsDir: string;
  licenses: Record<string, { file?: string; external?: string }>;
  components: Component[];
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "notices-3803-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Copy of resources/third-party into the temp dir. */
function copyRoot(): string {
  const dst = path.join(tmp, "third-party");
  cpSync(ROOT, dst, { recursive: true });
  return dst;
}

/** A tools folder holding empty stand-ins named like the real files (the checker reads names only). */
function fakeTools(names: string[]): string {
  const dst = path.join(tmp, "tools");
  mkdirSync(dst);
  for (const n of names) writeFileSync(path.join(dst, n), "");
  return dst;
}

describe("third-party notices (BACKLOG-3803)", () => {
  it("passes on the repository as committed", () => {
    const r = run([]);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("THIRD_PARTY_NOTICES: OK");
    expect(r.status).toBe(0);
  });

  it("covers every .exe and .dll in the iPhone tools folder", () => {
    const data: Data = JSON.parse(readFileSync(path.join(ROOT, "components.json"), "utf8"));
    expect(path.join(REPO, data.toolsDir)).toBe(TOOLS);
    const listed = data.components.flatMap((c) => (c.bundle ? c.files ?? [] : []));
    const r = spawnSync("git", ["ls-files", "resources/win/libimobiledevice"], { cwd: REPO, encoding: "utf8" });
    const shipped = r.stdout
      .split("\n")
      .filter((f) => /\.(exe|dll)$/i.test(f))
      .map((f) => path.basename(f));
    // 27 .exe + 23 .dll measured at authoring time; identity, not just the count.
    expect(shipped).toHaveLength(50);
    expect([...listed].sort()).toEqual([...shipped].sort());
  });

  it("goes red when an unlisted .dll appears in the tools folder", () => {
    const name = "unlisted-3803.dll";
    // An ignored name would never reach a real package; make sure the fixture name is not ignored.
    const ignored = spawnSync("git", ["check-ignore", "-q", `resources/win/libimobiledevice/${name}`], { cwd: REPO });
    expect(ignored.status).toBe(1);
    const tools = fakeTools(readdirNames(TOOLS));
    writeFileSync(path.join(tools, name), "");
    const r = run(["--tools-dir", tools]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`unlisted file in tools folder: ${name}`);
  });

  it("goes red when a listed file is no longer shipped", () => {
    const tools = fakeTools(readdirNames(TOOLS).filter((n) => n !== "plist.dll"));
    const r = run(["--tools-dir", tools]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("component libplist lists plist.dll, which is not in the tools folder");
  });

  it("goes red when the notices drift from components.json", () => {
    const root = copyRoot();
    const p = path.join(root, "components.json");
    const data = JSON.parse(readFileSync(p, "utf8"));
    data.components[0].version = "9.9.9-drift";
    writeFileSync(p, JSON.stringify(data, null, 2));
    const r = run(["--root", root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("THIRD_PARTY_NOTICES.md is out of date");
    expect(r.stderr).toContain("THIRD_PARTY_NOTICES.txt is out of date");
  });

  it("goes red when a licence text is missing or altered", () => {
    const root = copyRoot();
    rmSync(path.join(root, "licenses", "GPL-3.0.txt"));
    appendFileSync(path.join(root, "licenses", "LGPL-2.1.txt"), "edited\n");
    const r = run(["--root", root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("licence GPL-3.0: file licenses/GPL-3.0.txt is missing");
    expect(r.stderr).toMatch(/licence LGPL-2\.1: licenses\/LGPL-2\.1\.txt sha256 \w+ != recorded/);
  });

  it("goes red when a component names a licence that is not defined", () => {
    const root = copyRoot();
    const p = path.join(root, "components.json");
    const data = JSON.parse(readFileSync(p, "utf8"));
    data.components[0].licenses = ["Not-A-Licence"];
    writeFileSync(p, JSON.stringify(data, null, 2));
    const r = run(["--root", root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`component ${data.components[0].id}: licence "Not-A-Licence" is not defined`);
  });

  it("names a licence for every component that is not attribution-only, and every licence file exists", () => {
    const data: Data = JSON.parse(readFileSync(path.join(ROOT, "components.json"), "utf8"));
    for (const c of data.components) {
      for (const k of c.licenses) {
        const e = data.licenses[k];
        expect(e).toBeDefined();
        const where = e.file ? path.join(ROOT, e.file) : path.join(REPO, e.external as string);
        // electron/dist is absent on an --ignore-scripts install (CI); see generate-notices.js
        if (e.external?.startsWith("node_modules/electron/dist/") && !existsSync(path.join(REPO, "node_modules/electron/dist"))) continue;
        expect(existsSync(where)).toBe(true);
      }
    }
  });

  it("is packaged: package.json copies resources/third-party to third-party on every platform", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
    const entry = (pkg.build.extraResources as Array<string | { from: string; to: string }>).find(
      (e) => typeof e === "object" && e.from === "resources/third-party",
    );
    expect(entry).toEqual(expect.objectContaining({ to: "third-party" }));
    const mac = (pkg.build.mac.extraResources ?? []) as Array<{ from: string; to: string }>;
    expect(mac).toEqual(
      expect.arrayContaining([
        { from: "node_modules/electron/dist/LICENSES.chromium.html", to: "third-party/LICENSES.chromium.html" },
        { from: "node_modules/electron/dist/LICENSE", to: "third-party/LICENSE.electron.txt" },
      ]),
    );
  });

  describe("licence labels match the attached licence texts", () => {
    interface Entry { file?: string }
    const data = JSON.parse(readFileSync(path.join(ROOT, "components.json"), "utf8")) as {
      licenses: Record<string, Entry>;
      components: (Component & { licenseExpression: string })[];
    };

    /** "LGPL-2.1" -> the heading and version the attached text must carry. */
    function textMatches(file: string, family: "LGPL" | "GPL", version: string): boolean {
      const lines = readFileSync(path.join(ROOT, file), "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const heading = lines[0].toUpperCase();
      const versionLine = lines[1];
      const headingOk =
        family === "GPL"
          ? heading === "GNU GENERAL PUBLIC LICENSE"
          : heading === "GNU LESSER GENERAL PUBLIC LICENSE" || (version === "2.0" && heading === "GNU LIBRARY GENERAL PUBLIC LICENSE");
      const versionOk = new RegExp("^Version " + version.replace(".", "\\.") + "(?![0-9.])|^Version " + version.split(".")[0] + ",").test(versionLine);
      return headingOk && versionOk;
    }

    function textFor(c: Component, family: "LGPL" | "GPL", version: string): boolean {
      return c.licenses.some((k) => {
        const f = data.licenses[k]?.file;
        return !!f && textMatches(f, family, version);
      });
    }

    const tokens = (expr: string) =>
      [...expr.matchAll(/\b(LGPL|GPL)-(\d\.\d)/g)].map((m) => ({ family: m[1] as "LGPL" | "GPL", version: m[2] }));

    it("every GPL/LGPL family and version in a licence expression has an attached text of that family and version", () => {
      const gpl = data.components.flatMap((c) => tokens(c.licenseExpression).map((t) => ({ c, t })));
      expect(gpl.length).toBeGreaterThan(10);
      const missing = gpl.filter(({ c, t }) => !textFor(c, t.family, t.version)).map(({ c, t }) => `${c.id}: ${t.family}-${t.version}`);
      expect(missing).toEqual([]);
    });

    it("an LGPL-3.0 component also attaches the GPL-3.0 text (LGPLv3 section 4)", () => {
      const v3 = data.components.filter((c) => /\bLGPL-3\.0/.test(c.licenseExpression));
      expect(v3.map((c) => c.id)).toEqual(expect.arrayContaining(["libusb-win32", "getopt-win32", "idevicerestore"]));
      const missing = v3.filter((c) => !textFor(c, "GPL", "3.0")).map((c) => c.id);
      expect(missing).toEqual([]);
    });

    it("the opening does not claim complete source for components without a pinned recipe", () => {
      const txt = readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
      expect(txt).not.toMatch(/complete source/i);
      expect(txt).toMatch(/outside the npm dependency tree/);
    });
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}
