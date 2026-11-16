/**
 * @jest-environment node
 */

/**
 * BACKLOG-4245 — the release path for beta versions: the build-job refusals
 * (feed-preflight.mjs) and the beta / rehearsal publish (publish-feed.mjs).
 *
 * `gh` is replaced by scripts/__tests__/helpers/fake-gh-4245.js through
 * FEED_GH_BIN. Every child also gets a dummy GH_TOKEN and an empty
 * GH_CONFIG_DIR, so a call that reached a real `gh` would be unauthenticated.
 * The fake is a model of GitHub (see its header); the rehearsal on a scratch
 * repository is what checks the model.
 *
 * Asset names: the twelve the v2.48.0 release carries, with the version
 * substituted. Update-file shape: as in updateChannelLibrary-4245.test.ts
 * (transcribed from the v2.48.0 latest-mac.yml); hashes are placeholders.
 */

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const ROOT = path.join(__dirname, "../..");
const PREFLIGHT = path.join(ROOT, "scripts/release/feed-preflight.mjs");
const PUBLISH = path.join(ROOT, "scripts/release/publish-feed.mjs");
const LIB = path.join(ROOT, "scripts/release/feed-lib.mjs");
const FAKE_GH = path.join(__dirname, "helpers/fake-gh-4245.js");

// Invented names and ids; none is a real repository.
const REAL = "Example-Org/update-feed";
const REAL_ID = 111111;
const SCRATCH = "Example-Org/scratch-feed";
const SCRATCH_ID = 222222;
const ALIAS = "Other-Owner/update-feed"; // a second name that resolves to the real feed
const MAD = "Example-Org/app";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "keepr-4245-feed-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fresh(name: string): string {
  const d = path.join(dir, `${name}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

interface Rel {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string;
  assets?: string[];
  files?: Record<string, string>;
}
interface State {
  repos?: Record<string, unknown>;
  releases?: Record<string, Rel[]>;
  latest?: Record<string, string | null>;
  environments?: Record<string, unknown>;
}

const REVIEWED_ENV = {
  name: "feed-beta",
  protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "reviewer" } }] }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};
/** The shape GitHub gives an Environment it created because a job named it. */
const AUTO_CREATED_ENV = { name: "feed-beta", protection_rules: [], deployment_branch_policy: null };

function baseState(): State {
  return {
    repos: {
      [REAL]: { id: REAL_ID, full_name: REAL, permissions: { push: true } },
      [ALIAS]: { id: REAL_ID, full_name: REAL, permissions: { push: false } },
      [SCRATCH]: { id: SCRATCH_ID, full_name: SCRATCH, permissions: { push: true } },
    },
    releases: {
      [REAL]: [{ tag_name: "v2.49.0", assets: [] }],
      [SCRATCH]: [{ tag_name: "v90.0.0", assets: [] }],
    },
    latest: { [REAL]: "v2.49.0", [SCRATCH]: "v90.0.0" },
    environments: { [`${MAD}/feed-beta`]: REVIEWED_ENV },
  };
}

function names(v: string): string[] {
  return [
    `Keepr-${v}-arm64-mac.zip`, `Keepr-${v}-arm64-mac.zip.blockmap`, `Keepr-${v}-arm64.dmg`, `Keepr-${v}-arm64.dmg.blockmap`,
    `Keepr-${v}-mac.zip`, `Keepr-${v}-mac.zip.blockmap`, `Keepr-${v}.dmg`, `Keepr-${v}.dmg.blockmap`,
    `Keepr-Setup-${v}.exe`, `Keepr-Setup-${v}.exe.blockmap`, "latest-mac.yml", "latest.yml",
  ];
}

function macYml(v: string, fileVersion = v): string {
  return `version: ${fileVersion}
files:
  - url: Keepr-${v}-arm64-mac.zip
    sha512: AAAA
    size: 191134946
  - url: Keepr-${v}-arm64.dmg
    sha512: AAAA
    size: 195311223
  - url: Keepr-${v}-mac.zip
    sha512: AAAA
    size: 197234101
  - url: Keepr-${v}.dmg
    sha512: AAAA
    size: 201554390
path: Keepr-${v}-arm64-mac.zip
sha512: AAAA
releaseDate: '2026-11-14T01:26:20.403Z'
`;
}
function winYml(v: string, fileVersion = v): string {
  return `version: ${fileVersion}
files:
  - url: Keepr-Setup-${v}.exe
    sha512: AAAA
    size: 160100200
path: Keepr-Setup-${v}.exe
sha512: AAAA
releaseDate: '2026-11-14T01:40:02.118Z'
`;
}

/** artifacts/release-macos + artifacts/release-windows as the build jobs upload them. */
function artifacts(v: string, opts: { drop?: string; winVersion?: string } = {}): string {
  const root = fresh("art");
  const mac = path.join(root, "artifacts/release-macos");
  const win = path.join(root, "artifacts/release-windows");
  mkdirSync(mac, { recursive: true });
  mkdirSync(win, { recursive: true });
  for (const n of names(v)) {
    if (n === opts.drop) continue;
    if (n === "latest-mac.yml") writeFileSync(path.join(mac, n), macYml(v));
    else if (n === "latest.yml") writeFileSync(path.join(win, n), winYml(v, opts.winVersion ?? v));
    else writeFileSync(path.join(/Setup|\.exe/.test(n) ? win : mac, n), `binary ${n}`);
  }
  return root;
}

interface Run {
  status: number | null;
  out: string;
  log: { args: string[]; token: string }[];
  state: State;
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_ACTIONS; // CI runs jest inside Actions; the stand-in is refused there
  for (const k of Object.keys(env)) if (/^(FEED_|SCRATCH_|REAL_FEED|HAS_SCRATCH|ENVIRONMENT_NAME|REPO_TOKEN|CHANNEL$)/.test(k)) delete env[k];
  return { ...env, GH_TOKEN: "dummy-not-a-token", GH_CONFIG_DIR: fresh("ghcfg"), ...extra };
}

function run(script: string, argv: string[], state: State | null, env: Record<string, string>, cwd = ROOT): Run {
  const d = fresh("gh");
  const statePath = path.join(d, "state.json");
  const logPath = path.join(d, "log.jsonl");
  writeFileSync(statePath, JSON.stringify(state ?? baseState()));
  writeFileSync(logPath, "");
  const r = spawnSync(process.execPath, [script, ...argv], {
    cwd,
    encoding: "utf8",
    env: childEnv({ FEED_GH_BIN: FAKE_GH, FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath, ...env }),
  });
  const log = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, out: `${r.stdout}${r.stderr}`, log, state: JSON.parse(readFileSync(statePath, "utf8")) };
}

const writes = (r: Run) => r.log.filter((c) => c.args[0] === "release" && ["create", "upload", "edit"].includes(c.args[1]));

// ── feed-lib: version order ──────────────────────────────────────────────

function lib(expr: string): unknown {
  const code = `import * as L from ${JSON.stringify("file://" + LIB.replace(/\\/g, "/"))}; console.log(JSON.stringify(${expr}));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe("BACKLOG-4245 version order (semver precedence)", () => {
  const pairs: [string, string, number][] = [
    ["2.49.0", "2.49.0", 0],
    ["2.49.1-beta.1", "2.49.0", 1],
    ["2.49.1-beta.1", "2.49.1", -1],
    ["2.49.0-beta.9", "2.49.0", -1],
    ["2.49.1-beta.2", "2.49.1-beta.1", 1],
    ["2.49.1-beta.10", "2.49.1-beta.9", 1],
    ["2.49.10", "2.49.9", 1],
    ["2.50.0", "2.49.99", 1],
    ["v2.49.0", "2.49.0", 0],
    ["2.48.1", "2.49.0", -1],
    ["90.0.1", "90.1.0-beta.1", -1],
  ];
  it.each(pairs)("%s vs %s = %d (and the reverse is the negation)", (a, b, want) => {
    expect(lib(`[L.compareVersions(${JSON.stringify(a)}, ${JSON.stringify(b)}), L.compareVersions(${JSON.stringify(b)}, ${JSON.stringify(a)})]`)).toEqual([want, -want || 0]);
  });
});

// ── feed-preflight --local ───────────────────────────────────────────────

function pkg(version: string): string {
  const d = fresh("pkg");
  writeFileSync(path.join(d, "package.json"), JSON.stringify({ version }));
  return path.join(d, "package.json");
}
const local = (ref: string, channel: string, version: string) =>
  run(PREFLIGHT, ["--local", "--package", pkg(version)], null, { GITHUB_REF: ref, CHANNEL: channel });

describe("BACKLOG-4245 feed-preflight --local (every build, before signing)", () => {
  it.each([
    ["refs/heads/main", "", "2.49.0"],
    ["refs/heads/main", "website", "2.49.0"],
    ["refs/heads/main", "website", "2.49.10"],
    ["refs/heads/beta/2.49.1-beta.1", "beta", "2.49.1-beta.1"],
    ["refs/heads/rehearsal/4245-s1", "website", "90.0.0"],
    ["refs/heads/rehearsal/4245-b1", "beta", "90.1.0-beta.1"],
    ["refs/heads/feature/x", "website", "2.49.0"],
    ["refs/heads/feature/x", "store", "2.49.0"],
    ["refs/heads/develop", "", "2.49.0"],
  ])("accepts %s channel=%s version=%s", (ref, channel, version) => {
    const r = local(ref, channel, version);
    expect(r.out).toMatch(/OK/);
    expect(r.status).toBe(0);
    expect(r.log).toEqual([]); // no gh call, ever
  });

  it.each([
    ["refs/heads/main", "", "2.49.1-beta.1", /cannot be released from main/],
    ["refs/heads/main", "website", "2.49.0-rc.1", /cannot be released from main/],
    ["refs/heads/main", "beta", "2.49.0", /channel=beta cannot be dispatched from main/],
    ["refs/heads/develop", "beta", "2.49.1-beta.1", /needs a beta\/ or rehearsal\/ branch/],
    ["refs/heads/feature/x", "beta", "2.49.1-beta.1", /needs a beta\/ or rehearsal\/ branch/],
    ["refs/heads/beta/2.49.1-beta.1", "website", "2.49.1-beta.1", /builds only channel=beta/],
    ["refs/heads/beta/2.49.1-beta.1", "store", "2.49.1-beta.1", /builds only channel=beta/],
    ["refs/heads/beta/2.49.1-beta.1", "beta", "2.49.1", /not a beta version/],
    ["refs/heads/beta/2.49.1-beta.1", "beta", "2.49.1-beta.2", /must be named after its version/],
    ["refs/heads/rehearsal/x", "store", "90.0.0", /cannot build channel=store/],
    ["refs/heads/rehearsal/x", "website", "90.1.0-beta.1", /not a stable version/],
    ["refs/heads/rehearsal/x", "beta", "90.1.0", /not a beta version/],
  ])("refuses %s channel=%s version=%s", (ref, channel, version, why) => {
    const r = local(ref, channel, version);
    expect(r.out).toMatch(why);
    expect(r.status).toBe(1);
  });
});

// ── feed-preflight --remote ──────────────────────────────────────────────

const remote = (ref: string, channel: string, version: string, env: Record<string, string>, state?: State) =>
  run(PREFLIGHT, ["--remote", "--package", pkg(version)], state ?? null, {
    GITHUB_REF: ref, CHANNEL: channel, REAL_FEED_REPO: REAL, REAL_FEED_ID: String(REAL_ID), ...env,
  });
const BETA_REF = "refs/heads/beta/2.49.1-beta.1";

describe("BACKLOG-4245 feed-preflight --remote (beta and rehearsal builds)", () => {
  it("accepts a beta to the real feed once Latest is v2.49.0", () => {
    const r = remote(BETA_REF, "beta", "2.49.1-beta.1", {});
    expect(r.out).toMatch(/real feed .*Latest v2\.49\.0: OK/);
    expect(r.status).toBe(0);
    expect(writes(r)).toEqual([]);
  });

  it("refuses a beta while the real feed's Latest is below v2.49.0", () => {
    const s = baseState();
    s.releases![REAL] = [{ tag_name: "v2.48.0" }];
    s.latest![REAL] = "v2.48.0";
    const r = run(PREFLIGHT, ["--remote", "--package", pkg("2.48.1-beta.1")], s, {
      GITHUB_REF: "refs/heads/beta/2.48.1-beta.1", CHANNEL: "beta", REAL_FEED_REPO: REAL, REAL_FEED_ID: String(REAL_ID),
    });
    expect(r.out).toMatch(/until Latest is v2\.49\.0 or later/);
    expect(r.status).toBe(1);
  });

  it("refuses a beta that is not newer than Latest", () => {
    const r = run(PREFLIGHT, ["--remote", "--package", pkg("2.49.0-beta.3")], null, {
      GITHUB_REF: "refs/heads/beta/2.49.0-beta.3", CHANNEL: "beta", REAL_FEED_REPO: REAL, REAL_FEED_ID: String(REAL_ID),
    });
    expect(r.out).toMatch(/not newer than Latest v2\.49\.0/);
    expect(r.status).toBe(1);
  });

  it("refuses a real-feed name whose id is not the real feed's", () => {
    const r = remote(BETA_REF, "beta", "2.49.1-beta.1", { REAL_FEED_ID: "999" });
    expect(r.out).toMatch(/is not the real update feed/);
    expect(r.status).toBe(1);
  });

  it.each([
    ["another owner's name", ALIAS],
    ["the real name in other letter case", REAL.toUpperCase()],
  ])("refuses a rehearsal whose target is the real feed under %s", (_label, target) => {
    const s = baseState();
    s.repos![REAL.toUpperCase()] = { id: REAL_ID, full_name: REAL };
    const r = remote("refs/heads/rehearsal/b1", "beta", "90.1.0-beta.1", { SCRATCH_FEED_REPO: target, HAS_SCRATCH_TOKEN: "true" }, s);
    expect(r.out).toMatch(/is the real update feed/);
    expect(r.status).toBe(1);
  });

  it("refuses a rehearsal when SCRATCH_FEED_REPO is not set", () => {
    const r = remote("refs/heads/rehearsal/s1", "website", "90.0.0", { SCRATCH_FEED_REPO: "", HAS_SCRATCH_TOKEN: "true" });
    expect(r.out).toMatch(/SCRATCH_FEED_REPO is not set/);
    expect(r.status).toBe(1);
    expect(r.log).toEqual([]);
  });

  it("refuses a rehearsal when the SCRATCH_FEED_TOKEN secret is not set", () => {
    const r = remote("refs/heads/rehearsal/s1", "website", "90.0.0", { SCRATCH_FEED_REPO: SCRATCH, HAS_SCRATCH_TOKEN: "false" });
    expect(r.out).toMatch(/SCRATCH_FEED_TOKEN repository secret is not set/);
    expect(r.status).toBe(1);
    expect(r.log).toEqual([]);
  });

  it("accepts the first stable rehearsal on an empty scratch feed, and refuses a beta there", () => {
    const s = baseState();
    s.releases![SCRATCH] = [];
    s.latest![SCRATCH] = null;
    const env = { SCRATCH_FEED_REPO: SCRATCH, HAS_SCRATCH_TOKEN: "true" };
    const ok = remote("refs/heads/rehearsal/s1", "website", "90.0.0", env, s);
    expect(ok.out).toMatch(/Latest none: OK/);
    expect(ok.status).toBe(0);
    const beta = remote("refs/heads/rehearsal/b1", "beta", "90.1.0-beta.1", env, s);
    expect(beta.out).toMatch(/publish a stable rehearsal first/);
    expect(beta.status).toBe(1);
  });
});

// ── feed-preflight --app-update (A5) ─────────────────────────────────────

describe("BACKLOG-4245 feed-preflight --app-update", () => {
  const cfg = (body: string) => {
    const f = path.join(fresh("au"), "app-update.yml");
    writeFileSync(f, body);
    return f;
  };
  const good = `owner: ${REAL.split("/")[0]}\nrepo: ${REAL.split("/")[1]}\nprovider: github\nupdaterCacheDirName: keepr-updater\n`;
  it("accepts the real feed with no channel key", () => {
    const r = run(PREFLIGHT, ["--app-update", cfg(good), cfg(good)], null, { REAL_FEED_REPO: REAL });
    expect(r.out).toMatch(/2 file\(s\)/);
    expect(r.status).toBe(0);
  });
  it.each([
    ["a channel key", `${good}channel: beta\n`, /has a channel key/],
    ["another repo", good.replace(/repo: .*/, "repo: scratch-feed"), /repo is scratch-feed/],
    ["a missing file", null, /not found/],
  ])("refuses %s", (_l, body, why) => {
    const file = body === null ? path.join(dir, "nope", "app-update.yml") : cfg(body as string);
    const r = run(PREFLIGHT, ["--app-update", file], null, { REAL_FEED_REPO: REAL });
    expect(r.out).toMatch(why);
    expect(r.status).toBe(1);
  });
});

// ── publish-feed --phase target ──────────────────────────────────────────

const realEnv = (extra: Record<string, string> = {}) => ({
  FEED_ROLE: "real", FEED_REPO: REAL, REAL_FEED_REPO: REAL, REAL_FEED_ID: String(REAL_ID),
  ENVIRONMENT_NAME: "feed-beta", REPO_TOKEN: "dummy-repo-token", GITHUB_REPOSITORY: MAD, GH_TOKEN: "dummy-feed-token", ...extra,
});
const rehearsalEnv = (extra: Record<string, string> = {}) => ({
  FEED_ROLE: "rehearsal", FEED_REPO: SCRATCH, REAL_FEED_REPO: REAL, REAL_FEED_ID: String(REAL_ID), GH_TOKEN: "dummy-scratch-token", ...extra,
});
const target = (env: Record<string, string>, state?: State) => run(PUBLISH, ["--phase", "target", "--execute"], state ?? null, env);

describe("BACKLOG-4245 publish-feed --phase target", () => {
  it("real: passes with the token and a reviewed Environment", () => {
    const r = target(realEnv());
    expect(r.out).toMatch(/target: .* \(real\) checked: OK/);
    expect(r.status).toBe(0);
    const envCall = r.log.find((c) => c.args[1].includes("/environments/"));
    expect(envCall?.token).toBe("dummy-repo-token");
  });

  it("real: refuses when the Environment's token secret is empty", () => {
    const r = target(realEnv({ GH_TOKEN: "" }));
    expect(r.out).toMatch(/feed token is empty: the token secret of the feed-beta Environment is not set/);
    expect(r.status).toBe(1);
    expect(r.log).toEqual([]);
  });

  it("real: refuses an Environment that does not exist", () => {
    const s = baseState();
    s.environments = {};
    const r = target(realEnv(), s);
    expect(r.out).toMatch(/could not read the feed-beta Environment/);
    expect(r.status).toBe(1);
  });

  it("real: refuses an Environment GitHub created empty (no reviewer, every branch)", () => {
    const s = baseState();
    s.environments = { [`${MAD}/feed-beta`]: AUTO_CREATED_ENV };
    const r = target(realEnv(), s);
    expect(r.out).toMatch(/has no required reviewer/);
    expect(r.out).toMatch(/admits every branch/);
    expect(r.status).toBe(1);
  });

  it("rehearsal: passes when the scratch token cannot push to the real feed", () => {
    const s = baseState();
    s.repos![REAL] = { id: REAL_ID, full_name: REAL, permissions: { push: false } };
    const r = target(rehearsalEnv(), s);
    expect(r.out).toMatch(/\(rehearsal\) checked: OK/);
    expect(r.status).toBe(0);
  });

  it("rehearsal: refuses a token that can push to the real feed", () => {
    const r = target(rehearsalEnv());
    expect(r.out).toMatch(/must not be able to push/);
    expect(r.status).toBe(1);
  });

  it("rehearsal: refuses when SCRATCH_FEED_REPO is empty or the token secret is empty", () => {
    const a = target(rehearsalEnv({ FEED_REPO: "" }));
    expect(a.out).toMatch(/SCRATCH_FEED_REPO repository variable is not set/);
    expect(a.status).toBe(1);
    const b = target(rehearsalEnv({ GH_TOKEN: "" }));
    expect(b.out).toMatch(/SCRATCH_FEED_TOKEN repository secret is not set/);
    expect(b.status).toBe(1);
    expect([...a.log, ...b.log]).toEqual([]);
  });

  it("rehearsal: refuses a scratch target that resolves to the real feed", () => {
    const r = target(rehearsalEnv({ FEED_REPO: ALIAS }));
    expect(r.out).toMatch(/is the real update feed/);
    expect(r.status).toBe(1);
  });
});

// ── publish-feed beta: stage + finish ────────────────────────────────────

const BV = "2.49.1-beta.1";
const BTAG = `v${BV}`;
const stage = (state: State | null, root: string, v = BV, env: Record<string, string> = realEnv()) =>
  run(PUBLISH, ["--phase", "stage", "--kind", "beta", "--version", v, "--root", root, "--execute"], state, env);
const finish = (state: State, v = BV, env: Record<string, string> = realEnv()) =>
  run(PUBLISH, ["--phase", "finish", "--kind", "beta", "--version", v, "--retry-delay-ms", "0", "--execute"], state, env);
const rel = (s: State, repo: string, tag: string) => s.releases![repo].find((r) => r.tag_name === tag);

describe("BACKLOG-4245 beta publish on the real-feed model", () => {
  it("fresh: draft prerelease with 12 assets, then public prerelease; Latest stays v2.49.0", () => {
    const a = stage(null, artifacts(BV));
    expect(a.out).toMatch(/stage: .*: create/);
    expect(a.out).toMatch(/is a draft prerelease with its 12 assets: OK/);
    expect(a.status).toBe(0);
    const create = writes(a)[0].args;
    expect(create.slice(0, 7)).toEqual(["release", "create", BTAG, "--repo", REAL, "--draft", "--prerelease"]);
    expect(rel(a.state, REAL, BTAG)).toMatchObject({ draft: true, prerelease: true });
    expect(a.state.latest![REAL]).toBe("v2.49.0");

    const b = finish(a.state);
    expect(b.out).toMatch(/is a public prerelease; Latest is still v2\.49\.0: OK/);
    expect(b.status).toBe(0);
    expect(writes(b).map((c) => c.args)).toEqual([["release", "edit", BTAG, "--repo", REAL, "--draft=false", "--prerelease", "--latest=false"]]);
    expect(rel(b.state, REAL, BTAG)).toMatchObject({ draft: false, prerelease: true });
    expect(b.state.latest![REAL]).toBe("v2.49.0");
  });

  it("a failed earlier run's draft is resumed with an upload, never a second create", () => {
    const first = stage(null, artifacts(BV));
    const again = stage(first.state, artifacts(BV));
    expect(again.out).toMatch(/: resume/);
    expect(again.status).toBe(0);
    expect(writes(again).map((c) => c.args[1])).toEqual(["upload"]);
    expect(again.state.releases![REAL].filter((r) => r.tag_name === BTAG)).toHaveLength(1);
  });

  it("a re-run on a published prerelease re-asserts the flags before uploading, and its assertions still run", () => {
    const pub = finish(stage(null, artifacts(BV)).state).state;
    const r = stage(pub, artifacts(BV));
    expect(r.out).toMatch(/: repair/);
    expect(r.status).toBe(0);
    expect(writes(r).map((c) => c.args.slice(1, 2).concat(c.args.slice(5)))).toEqual([
      ["edit", "--prerelease", "--latest=false"],
      ["upload", "--clobber", ...writes(r)[1].args.slice(6)],
    ]);
  });

  it("a re-run on a published prerelease that someone flipped to stable is refused with no write", () => {
    const pub = finish(stage(null, artifacts(BV)).state).state;
    rel(pub, REAL, BTAG)!.prerelease = false;
    const r = stage(pub, artifacts(BV));
    expect(r.out).toMatch(/published as a stable release/);
    expect(r.status).toBe(1);
    expect(writes(r)).toEqual([]);
  });

  it("a withdrawn beta is refused by stage and by finish", () => {
    const pub = finish(stage(null, artifacts(BV)).state).state;
    Object.assign(rel(pub, REAL, BTAG)!, { draft: true, body: "WITHDRAWN-4245: bad build" });
    const s = stage(pub, artifacts(BV));
    expect(s.out).toMatch(/was withdrawn/);
    expect(s.status).toBe(1);
    const f = finish(pub);
    expect(f.out).toMatch(/was withdrawn/);
    expect(f.status).toBe(1);
    expect([...writes(s), ...writes(f)]).toEqual([]);
  });

  it("two releases on one tag are refused", () => {
    const s = baseState();
    s.releases![REAL].push({ tag_name: BTAG, draft: true, prerelease: true }, { tag_name: BTAG, draft: true, prerelease: true });
    const r = stage(s, artifacts(BV));
    expect(r.out).toMatch(/2 releases carry/);
    expect(r.status).toBe(1);
  });

  it("a build missing the Windows installer is refused before any write", () => {
    const r = stage(null, artifacts(BV, { drop: `Keepr-Setup-${BV}.exe` }));
    expect(r.out).toMatch(/no file matches artifacts\/release-windows\/\*\.exe/);
    expect(r.status).toBe(1);
    expect(writes(r)).toEqual([]);
  });

  it("a stray extra file in the build is refused before any write", () => {
    const root = artifacts(BV);
    writeFileSync(path.join(root, "artifacts/release-macos/Keepr-2.49.0.dmg"), "stale");
    const r = stage(null, root);
    expect(r.out).toMatch(/built files: unexpected Keepr-2\.49\.0\.dmg/);
    expect(r.status).toBe(1);
    expect(writes(r)).toEqual([]);
  });

  it("an update file from another version is refused at A4, while the release is still a draft", () => {
    const r = stage(null, artifacts(BV, { winVersion: "2.49.0" }));
    expect(r.out).toMatch(/A4 latest\.yml: version is 2\.49\.0, expected 2\.49\.1-beta\.1/);
    expect(r.status).toBe(1);
    expect(rel(r.state, REAL, BTAG)).toMatchObject({ draft: true });
  });

  it("finish refuses when there is no release to publish", () => {
    const r = finish(baseState());
    expect(r.out).toMatch(/expected one release for v2\.49\.1-beta\.1, found 0/);
    expect(r.status).toBe(1);
  });
});

// ── rehearsal: stable then beta then a lower stable ──────────────────────

describe("BACKLOG-4245 rehearsal sequence on the scratch model", () => {
  const stableStage = (s: State | null, v: string) =>
    run(PUBLISH, ["--phase", "stage", "--kind", "stable", "--version", v, "--root", artifacts(v), "--execute"], s, rehearsalEnv());
  const stableFinish = (s: State, v: string) =>
    run(PUBLISH, ["--phase", "finish", "--kind", "stable", "--version", v, "--retry-delay-ms", "0", "--execute"], s, rehearsalEnv());

  it("stable 90.0.0 on an empty feed, beta 90.1.0-beta.1, then stable 90.0.1: Latest 90.0.0, 90.0.0, 90.0.1", () => {
    const empty = baseState();
    empty.releases![SCRATCH] = [];
    empty.latest![SCRATCH] = null;

    const s1 = stableStage(empty, "90.0.0");
    expect(s1.status).toBe(0);
    expect(writes(s1)[0].args.slice(0, 9)).toEqual(["release", "create", "v90.0.0", "--repo", SCRATCH, "--title", "Keepr v90.0.0", "--notes", expect.any(String)]);
    expect(writes(s1)[0].args.some((a) => /^--(draft|prerelease|latest)/.test(a))).toBe(false);
    const s1f = stableFinish(s1.state, "90.0.0");
    expect(s1f.out).toMatch(/Latest is v90\.0\.0 for v90\.0\.0: OK/);
    expect(s1f.status).toBe(0);

    const b1 = stage(s1f.state, artifacts("90.1.0-beta.1"), "90.1.0-beta.1", rehearsalEnv());
    expect(b1.status).toBe(0);
    const b1f = finish(b1.state, "90.1.0-beta.1", rehearsalEnv());
    expect(b1f.status).toBe(0);
    expect(b1f.state.latest![SCRATCH]).toBe("v90.0.0");

    const s2 = stableStage(b1f.state, "90.0.1");
    expect(s2.status).toBe(0);
    const s2f = stableFinish(s2.state, "90.0.1");
    expect(s2f.out).toMatch(/Latest is v90\.0\.1 for v90\.0\.1: OK/);
    expect(s2f.status).toBe(0);
  });

  it("a stable re-run whose tag exists uploads with --clobber and changes no flag", () => {
    const s1 = stableStage(null, "90.0.5");
    const again = stableStage(s1.state, "90.0.5");
    expect(again.out).toMatch(/already exists — uploading/);
    expect(again.status).toBe(0);
    expect(writes(again).map((c) => c.args[1])).toEqual(["create", "upload"]);
  });

  it("refuses kind=stable on the real feed (that publish is the create-release job)", () => {
    const r = run(PUBLISH, ["--phase", "stage", "--kind", "stable", "--version", "2.49.1", "--root", artifacts("2.49.1"), "--execute"], null, realEnv());
    expect(r.out).toMatch(/the real stable publish is the create-release job/);
    expect(r.status).toBe(1);
    expect(r.log).toEqual([]);
  });
});

// ── stable Latest check (report only on the real feed) ───────────────────

describe("BACKLOG-4245 stable Latest check", () => {
  const check = (tag: string, latest: string | null, opts: { report?: boolean; prerelease?: boolean; env?: Record<string, string> } = {}) => {
    const s = baseState();
    s.releases![REAL] = latest ? [{ tag_name: latest, prerelease: !!opts.prerelease }] : [];
    s.latest![REAL] = latest;
    const argv = ["--phase", "check-latest", "--kind", "stable", "--version", tag, "--retries", "1", "--execute"];
    if (opts.report !== false) argv.push("--report-only");
    return run(PUBLISH, argv, s, { FEED_ROLE: "real", FEED_REPO: REAL, ...opts.env });
  };

  it("OK when Latest is this tag", () => {
    const r = check("2.49.0", "v2.49.0");
    expect(r.out).toMatch(/Latest is v2\.49\.0 for v2\.49\.0: OK/);
    expect(r.out).not.toMatch(/::warning::/);
    expect(r.status).toBe(0);
  });

  it("OK for an old-line hotfix: 2.48.1 published while Latest is v2.49.0", () => {
    const r = check("2.48.1", "v2.49.0");
    expect(r.out).toMatch(/Latest is v2\.49\.0 for v2\.48\.1: OK/);
    expect(r.out).not.toMatch(/::warning::/);
    expect(r.status).toBe(0);
  });

  it.each([
    ["Latest older than this tag", "2.49.1", "v2.49.0", false, /older than v2\.49\.1/],
    ["Latest a prerelease", "2.49.0", "v2.49.1-beta.1", true, /is a prerelease/],
    ["no Latest at all", "2.49.0", null, false, /has no Latest release/],
  ])("warns and exits 0 when %s", (_l, tag, latest, pre, why) => {
    const r = check(tag, latest, { prerelease: pre });
    expect(r.out).toMatch(/::warning::/);
    expect(r.out).toMatch(why);
    expect(r.status).toBe(0);
  });

  it("exits 0 even when it cannot run at all (no feed set)", () => {
    const r = check("2.49.0", "v2.49.0", { env: { FEED_REPO: "" } });
    expect(r.out).toMatch(/::warning::/);
    expect(r.status).toBe(0);
  });

  it("without --report-only the same finding fails", () => {
    const r = check("2.49.1", "v2.49.0", { report: false, env: { FEED_ROLE: "rehearsal" } });
    expect(r.out).toMatch(/::error::.*older than v2\.49\.1/);
    expect(r.status).toBe(1);
  });
});

// ── dry run is the default ───────────────────────────────────────────────

describe("BACKLOG-4245 publish-feed without --execute", () => {
  it.each([
    ["target", ["--phase", "target"]],
    ["stage", ["--phase", "stage", "--kind", "beta", "--version", BV]],
    ["finish", ["--phase", "finish", "--kind", "beta", "--version", BV]],
  ])("%s calls nothing", (_l, argv) => {
    const r = run(PUBLISH, argv, null, realEnv());
    expect(r.status).toBe(0);
    expect(r.log).toEqual([]);
  });
});
