/**
 * BACKLOG-3927: the release gate that keeps Apple's driver installer out of the
 * Microsoft Store build and in the website build. Runs the real script
 * (scripts/ci/check-packaged-drivers.mjs) against fixture app directories with
 * a real app.asar.
 */
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
const SCRIPT = path.resolve(__dirname, "..", "ci", "check-packaged-drivers.mjs");

let root: string;
let app: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "pkg-drivers-3927-"));
  app = path.join(root, "win-unpacked");
  mkdirSync(path.join(app, "resources"), { recursive: true });
});
afterEach(() => {
  // Under Electron's node mode, fs treats paths ending in ".asar" as archives, so
  // removing app.asar from this process fails (ENOTDIR on macOS, EPERM on
  // Windows CI; retries do not help, so it is not a transient handle). Remove the
  // tree in a child with process.noAsar set, as the script under test does.
  const code = `process.noAsar = true;
require("fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });`;
  const r = spawnSync(process.execPath, ["-e", code, root], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (r.status !== 0) throw new Error(`teardown failed: ${r.stderr}`);
});

const put = (rel: string, content = "x") => {
  mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
  writeFileSync(path.join(app, rel), content);
};

// Packed in a child process: createPackage resolves on the write stream's "finish",
// and in this process the handle on app.asar stayed open on Windows, so the file
// could not be removed (unlink succeeded, rmdir then failed ENOTEMPTY). A child's
// handles are gone when it exits.
const ASAR_PKG = path.resolve(__dirname, "..", "..", "node_modules", "@electron", "asar");
function packAsar(pkg: object) {
  const src = path.join(root, "asar-src");
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, "package.json"), JSON.stringify(pkg));
  const code = `require(${JSON.stringify(ASAR_PKG)}).createPackage(process.argv[1], process.argv[2]).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`;
  const r = spawnSync(process.execPath, ["-e", code, src, path.join(app, "resources", "app.asar")], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (r.status !== 0) throw new Error(`packing app.asar failed: ${r.stderr}`);
}

const run = (channel: string) => spawnSync(process.execPath, [SCRIPT, app, channel], { encoding: "utf8" });

/** What a website build contains (the shape release.yml produces). */
async function websiteBuild() {
  await packAsar({ name: "keepr", version: "2.41.0" });
  put("Keepr.exe");
  put("resources/win/apple-drivers/AppleMobileDeviceSupport64.msi", "msi bytes");
  put("resources/win/apple-drivers/version.txt", "19.4.0.10");
  put("resources/win/apple-drivers/README.md", "readme");
  put("resources/win/libimobiledevice/idevice_id.exe");
  put("resources/win/libimobiledevice/libimobiledevice-1.0.dll");
}

/** What a Store build contains. */
async function storeBuild() {
  await packAsar({ name: "keepr", version: "2.41.0", distributionChannel: "store" });
  put("Keepr.exe");
  // BACKLOG-3927 (2.41): no resources/win/apple-drivers/ at all.
  put("resources/win/libimobiledevice/idevice_id.exe");
  put("resources/win/libimobiledevice/libimobiledevice-1.0.dll");
}

describe("store", () => {
  it("passes a Store build", async () => {
    await storeBuild();
    const r = run("store");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("fails a website build checked as store (the MSI, and no store marker)", async () => {
    await websiteBuild();
    const r = run("store");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("driver payload in a Store build: resources/win/apple-drivers/AppleMobileDeviceSupport64.msi");
    expect(r.stderr).toContain('distributionChannel is undefined, expected "store"');
  });

  it.each([
    "resources/win/apple-drivers/AppleMobileDeviceSupport64.msi",
    "resources/win/anything.MSI",
    "resources/drivers/usbaapl64.sys",
    "resources/drivers/usbaapl64.inf",
    "resources/drivers/usbaapl64.cat",
    "AppleMobileDeviceSupport.exe",
  ])("fails a Store build carrying %s", async (rel) => {
    await storeBuild();
    put(rel);
    const r = run("store");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`driver payload in a Store build: ${rel}`);
  });

  it.each([
    "resources/win/apple-drivers/README.md",
    "resources/win/apple-drivers/version.txt",
  ])("fails a Store build that still ships %s (the folder must not ship)", async (rel) => {
    await storeBuild();
    put(rel);
    const r = run("store");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`Apple driver folder in a Store build: ${rel}`);
  });

  it("fails a Store build whose app.asar is not marked store", async () => {
    await storeBuild();
    await packAsar({ name: "keepr", version: "2.41.0" });
    const r = run("store");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('expected "store"');
  });

  it("fails when app.asar is missing", async () => {
    put("Keepr.exe");
    const r = run("store");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing resources/app.asar");
  });
});

describe("website", () => {
  it("passes a website build", async () => {
    await websiteBuild();
    const r = run("website");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("fails a Store build checked as website (no MSI, marked store)", async () => {
    await storeBuild();
    const r = run("website");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("website build is missing resources/win/apple-drivers/AppleMobileDeviceSupport64.msi");
    expect(r.stderr).toContain('website build is marked distributionChannel "store"');
  });

  it("fails a website build whose MSI is empty", async () => {
    await websiteBuild();
    put("resources/win/apple-drivers/AppleMobileDeviceSupport64.msi", "");
    const r = run("website");
    expect(r.status).toBe(1);
  });
});

describe("toPosixRelative", () => {
  // Run in a node child: the script is ESM and jest here is CommonJS.
  const normalise = (appDir: string, file: string, lib: "win32" | "posix") => {
    const code = `import path from "node:path";
import { toPosixRelative } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
process.stdout.write(toPosixRelative(${JSON.stringify(appDir)}, ${JSON.stringify(file)}, path.${lib}));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    return r.stdout;
  };

  it("turns a Windows relative path into forward slashes", () => {
    expect(
      normalise(
        "C:\\x\\win-unpacked",
        "C:\\x\\win-unpacked\\resources\\win\\apple-drivers\\AppleMobileDeviceSupport64.msi",
        "win32",
      ),
    ).toBe("resources/win/apple-drivers/AppleMobileDeviceSupport64.msi");
  });

  it("leaves a POSIX relative path unchanged", () => {
    expect(normalise("/x/app", "/x/app/resources/a.msi", "posix")).toBe("resources/a.msi");
  });
});

it("rejects an unknown channel", () => {
  const r = run("beta");
  expect(r.status).toBe(2);
});
