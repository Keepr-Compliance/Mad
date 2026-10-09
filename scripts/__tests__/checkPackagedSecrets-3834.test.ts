/**
 * BACKLOG-3834: the release gate that fails when a packaged app ships a Google
 * Maps key. Runs the real script (scripts/ci/check-packaged-secrets.mjs)
 * against fixture directories, and the repo's own .env.production.
 *
 * Key-shaped values are built at runtime so no such literal sits in the repo.
 */
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.resolve(__dirname, "..", "ci", "check-packaged-secrets.mjs");
const REPO_ENV_PRODUCTION = path.resolve(__dirname, "..", "..", ".env.production");

const FAKE_KEY = "AIza" + "x".repeat(35);
const MAPS_VAR = ["GOOGLE", "MAPS", "API", "KEY"].join("_");
const CLEAN_ENV = "SUPABASE_URL=https://proj.supabase.test\nSUPABASE_ANON_KEY=anon\nSENTRY_DSN=https://x@o.ingest.test/1\n";

const RES = { mac: "Contents/Resources", win: "resources" } as const;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pkg-secrets-3834-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const put = (rel: string, content: string) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
};
const run = (platform: string) => spawnSync(process.execPath, [SCRIPT, platform, dir], { encoding: "utf8" });

describe.each([["mac"], ["win"]] as const)("check-packaged-secrets %s", (platform) => {
  const res = RES[platform];
  const clean = () => {
    put(`${res}/.env.production`, CLEAN_ENV);
    put(`${res}/app.asar`, "bundle code without secrets");
  };

  it("passes a clean package", () => {
    clean();
    const r = run(platform);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("fails when .env.production carries a key-shaped value, without printing it", () => {
    clean();
    put(`${res}/.env.production`, `${CLEAN_ENV}SOME_VALUE=${FAKE_KEY}\n`);
    const r = run(platform);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("key-shaped value");
    expect(r.stdout + r.stderr).not.toContain(FAKE_KEY);
  });

  it("fails when .env.production names the Maps variable even with an empty value", () => {
    clean();
    put(`${res}/.env.production`, `${CLEAN_ENV}${MAPS_VAR}=\n`);
    const r = run(platform);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(MAPS_VAR);
  });

  it("fails when app.asar embeds a key-shaped value", () => {
    clean();
    put(`${res}/app.asar`, `\u0000header\u0000const k="${FAKE_KEY}";`);
    expect(run(platform).status).toBe(1);
  });

  it("fails when another .env file under resources carries a key", () => {
    clean();
    put(`${res}/nested/.env.local`, `X=${FAKE_KEY}\n`);
    expect(run(platform).status).toBe(1);
  });

  it("fails when there is nothing to scan (wrong directory)", () => {
    put(`${res}/icon.icns`, "x");
    const r = run(platform);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nothing scanned");
  });
});

describe("repo .env.production (the file electron-builder packages)", () => {
  it("does not mention the Maps key variable", () => {
    const text = readFileSync(REPO_ENV_PRODUCTION, "utf8");
    expect(text).not.toContain(MAPS_VAR);
    expect(/AIza[0-9A-Za-z_-]{35}/.test(text)).toBe(false);
  });
});
