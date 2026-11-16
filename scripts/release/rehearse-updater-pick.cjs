#!/usr/bin/env node
// BACKLOG-4245: what the real updater picks from a live feed. Rehearsal only:
// run it by hand against the scratch feed after a rehearsal step. Not run in
// CI and not a jest test (it reads the network).
//
// Real code: electron-updater's AppUpdater + GitHubProvider (deep-imported, as
// in electron/services/__tests__/updateChannelLibrary-4245.test.ts), Keepr's
// updateChannelPolicy (loaded through ts-node), and a plain https executor
// (builder-util's NodeHttpExecutor). Nothing is downloaded or installed.
//
//   node scripts/release/rehearse-updater-pick.cjs --self-check
//   node scripts/release/rehearse-updater-pick.cjs --owner O --repo R --stage r2|r3|r4
//        [--mutant channel-latest]
//
// --owner/--repo have no default. The real feed is refused by name; the
// rehearsal's own guards are what keep the publish off it.
"use strict";
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

function loadPolicy() {
  require(path.join(ROOT, "node_modules/ts-node")).register({
    transpileOnly: true,
    compilerOptions: { module: "commonjs" },
  });
  // logService is the only import of the policy that is not pure; stand it in.
  const logPath = require.resolve(path.join(ROOT, "electron/services/logService.ts"));
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { __esModule: true, default: quiet } };
  return require(path.join(ROOT, "electron/services/updateChannelPolicy.ts"));
}

const { AppUpdater } = require(path.join(ROOT, "node_modules/electron-updater/out/AppUpdater"));
const { GitHubProvider } = require(path.join(ROOT, "node_modules/electron-updater/out/providers/GitHubProvider"));
const policy = loadPolicy();

// pii-allow-uuid: invented, not from any live row
const USER = "00000000-0000-4000-8000-000000000009";
// pii-allow-uuid: invented, not from any live row
const STAGING_ID = "00000000-0000-4000-8000-000000000001";

const mutant = opt("--mutant");

/** The same two inputs the app uses; or, under --mutant channel-latest, the assignment the policy must never make. */
function applyBetaUpdates(on, updater) {
  if (mutant === "channel-latest") {
    updater.channel = "latest";
    return;
  }
  policy.resetBetaUpdatesStateForTests();
  if (!on) {
    policy.applyBetaUpdatesOff(updater);
    return;
  }
  policy.recordStoredBetaUpdates(USER, true, updater);
  policy.recordBetaEligibility(USER, "allowed", updater);
}

class PickUpdater extends AppUpdater {
  constructor(version) {
    const app = {
      version,
      name: "keepr",
      isPackaged: true,
      appUpdateConfigPath: "/nonexistent/app-update.yml",
      userDataPath: "/nonexistent",
      baseCachePath: "/nonexistent",
      whenReady: () => Promise.resolve(),
      quit: () => undefined,
      relaunch: () => undefined,
      onQuit: () => undefined,
    };
    super(null, app);
    this.logger = null;
    this.autoDownload = false;
  }
  doDownloadUpdate() {
    return Promise.resolve([]);
  }
  quitAndInstall() {}
}

function makeUpdater(version, on, platform, executor, owner, repo) {
  const u = new PickUpdater(version);
  applyBetaUpdates(on, u);
  const provider = new GitHubProvider({ provider: "github", owner, repo }, u, { isUseMultipleRangeRequest: false, platform, executor });
  u.clientPromise = Promise.resolve(provider);
  u.stagingUserIdPromise = { value: Promise.resolve(STAGING_ID) };
  return u;
}

async function pick(version, on, platform, owner, repo) {
  const { NodeHttpExecutor } = require(path.join(ROOT, "node_modules/builder-util/out/nodeHttpExecutor"));
  const u = makeUpdater(version, on, platform, new NodeHttpExecutor(), owner, repo);
  const r = await u.doCheckForUpdates();
  return { update: r.isUpdateAvailable ? r.updateInfo.version : null };
}

async function firstAtomEntry(owner, repo) {
  const res = await fetch(`https://github.com/${owner}/${repo}/releases.atom`);
  const xml = await res.text();
  const m = /<entry>[\s\S]*?\/releases\/tag\/([^"<]+)"/.exec(xml);
  return m ? m[1] : null;
}

// Expected picks per rehearsal stage. update: the version installed, or null.
const STAGES = {
  r2: {
    atomFirst: "v90.1.0-beta.1",
    cases: [
      ["1 stable build, betas off", "90.0.0", false, "darwin", null],
      ["2 stable build, betas on: takes the beta", "90.0.0", true, "darwin", "90.1.0-beta.1"],
      ["8 Windows: stable build, betas on: takes the beta via latest.yml", "90.0.0", true, "win32", "90.1.0-beta.1"],
    ],
  },
  r3: {
    atomFirst: "v90.0.1",
    cases: [
      ["3 stable build, betas off: the newer stable", "90.0.0", false, "darwin", "90.0.1"],
      ["4 stable build, betas on: the newer stable, not the beta", "90.0.0", true, "darwin", "90.0.1"],
      ["5 beta build, betas on: no downgrade to the lower stable", "90.1.0-beta.1", true, "darwin", null],
      ["6 beta build, betas off: stays", "90.1.0-beta.1", false, "darwin", null],
    ],
  },
  r4: {
    atomFirst: "v90.0.1",
    cases: [["7 withdrawn beta: stable build, betas on: the next entry, no error", "90.0.0", true, "darwin", "90.0.1"]],
  },
};

async function runStage(stageName) {
  const owner = opt("--owner");
  const repo = opt("--repo");
  if (!owner || !repo) throw new Error("--owner and --repo are required (no default)");
  if (`${owner}/${repo}`.toLowerCase() === "keepr-compliance/keepr-releases") throw new Error("refusing the real update feed");
  const stage = STAGES[stageName];
  if (!stage) throw new Error("--stage must be r2, r3 or r4");
  let failed = 0;
  let ran = 0;
  const first = await firstAtomEntry(owner, repo);
  ran++;
  if (first !== stage.atomFirst) failed++;
  console.log(`${first === stage.atomFirst ? "PASS" : "FAIL"} Atom first entry: want ${stage.atomFirst}, got ${first}`);
  for (const [label, version, on, platform, want] of stage.cases) {
    ran++;
    let got;
    try {
      got = (await pick(version, on, platform, owner, repo)).update;
    } catch (e) {
      got = `error: ${e.code || ""} ${e.message.split("\n")[0]}`;
    }
    const ok = got === want;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} case ${label}: want ${want ?? "no update"}, got ${got ?? "no update"}`);
  }
  console.log(`${ran} checks ran, ${failed} failed${mutant ? ` (mutant ${mutant})` : ""}`);
  return failed || ran === 0 ? 1 : 0;
}

/** Offline: the policy and the library load, and the policy sets what the cases rely on. */
function selfCheck() {
  const results = [];
  for (const [version, on, wantPre] of [["90.0.0", false, false], ["90.0.0", true, true], ["90.1.0-beta.1", false, false], ["90.1.0-beta.1", true, true]]) {
    const u = makeUpdater(version, on, "darwin", { request: () => Promise.reject(new Error("offline")) }, "example", "example");
    const ok = u.allowPrerelease === wantPre && u.allowDowngrade === false;
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${version} betas ${on ? "on" : "off"}: allowPrerelease ${u.allowPrerelease}, allowDowngrade ${u.allowDowngrade}`);
  }
  const failed = results.filter((r) => !r).length;
  console.log(`${results.length} checks ran, ${failed} failed${mutant ? ` (mutant ${mutant})` : ""}`);
  return failed || results.length === 0 ? 1 : 0;
}

(async () => {
  try {
    process.exitCode = args.includes("--self-check") ? selfCheck() : await runStage(opt("--stage"));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
})();
