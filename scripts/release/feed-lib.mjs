// BACKLOG-4245: pure rules for publishing to the update feed. No I/O here;
// feed-preflight.mjs and publish-feed.mjs run them against `gh` output.
//
// Kinds: "stable" (X.Y.Z) and "beta" (X.Y.Z-beta.N).
// Roles: "real" (the update feed every install reads) and "rehearsal" (a scratch
// feed named by the SCRATCH_FEED_REPO variable). The role comes from the ref,
// never from an input.

export const STABLE_RE = /^\d+\.\d+\.\d+$/;
export const BETA_RE = /^\d+\.\d+\.\d+-beta\.\d+$/;

/** The real feed's Latest must be at least this before any beta goes to it. */
export const REAL_FEED_BETA_FLOOR = "2.49.0";

/** Marks a withdrawn beta; a publish run refuses to resume one (see the release skill). */
export const WITHDRAWN_MARKER = "WITHDRAWN-4245:";

/** The notes text of today's stable mirror step, so every release reads the same. */
export const RELEASE_NOTES =
  "Download the Keepr desktop app. Visit [keeprcompliance.com](https://www.keeprcompliance.com) for more info.";

/** The seven upload globs of the stable mirror step, in its order. */
export const ASSET_GLOBS = [
  "artifacts/release-macos/*.dmg",
  "artifacts/release-macos/*.zip",
  "artifacts/release-macos/*.yml",
  "artifacts/release-macos/*.blockmap",
  "artifacts/release-windows/*.exe",
  "artifacts/release-windows/*.yml",
  "artifacts/release-windows/*.blockmap",
];

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text) {
  const m = SEMVER_RE.exec(String(text ?? "").trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** Semver precedence: -1, 0 or 1. Throws on a value that is not a version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

export function refKind(ref) {
  const r = String(ref ?? "");
  if (r === "refs/heads/main") return "main";
  if (r.startsWith("refs/heads/beta/")) return "beta";
  if (r.startsWith("refs/heads/rehearsal/")) return "rehearsal";
  return "other";
}

/**
 * Local checks only: ref, channel and version. No network, no secrets. Runs on
 * every build, main included.
 * Returns { errors, role, kind }: role/kind are null when nothing will publish
 * through the beta or rehearsal jobs.
 */
export function localPreflight({ ref, channel, version }) {
  const errors = [];
  const ch = channel ? String(channel) : "website";
  const v = String(version ?? "");
  const where = refKind(ref);
  if (!["website", "store", "beta"].includes(ch)) errors.push(`unknown channel "${ch}"`);

  if (where === "main") {
    if (!STABLE_RE.test(v)) {
      errors.push(`version ${v} cannot be released from main: main publishes only X.Y.Z versions (a beta is cut on a beta/ branch)`);
    }
    if (ch === "beta") errors.push("channel=beta cannot be dispatched from main");
    return { errors, role: null, kind: null };
  }

  if (where === "beta") {
    if (ch !== "beta") errors.push(`a beta/ branch builds only channel=beta (got ${ch})`);
    if (!BETA_RE.test(v)) errors.push(`version ${v} is not a beta version (X.Y.Z-beta.N)`);
    const expectedRef = `refs/heads/beta/${v}`;
    if (ref !== expectedRef) errors.push(`a beta branch must be named after its version: expected ${expectedRef}, got ${ref}`);
    return { errors, role: errors.length ? null : "real", kind: errors.length ? null : "beta" };
  }

  if (where === "rehearsal") {
    if (ch === "store") errors.push("a rehearsal/ branch cannot build channel=store");
    if (ch === "beta" && !BETA_RE.test(v)) errors.push(`version ${v} is not a beta version (X.Y.Z-beta.N)`);
    if (ch === "website" && !STABLE_RE.test(v)) errors.push(`version ${v} is not a stable version (X.Y.Z)`);
    const kind = ch === "beta" ? "beta" : "stable";
    return { errors, role: errors.length ? null : "rehearsal", kind: errors.length ? null : kind };
  }

  if (ch === "beta") errors.push(`channel=beta needs a beta/ or rehearsal/ branch (got ${ref})`);
  return { errors, role: null, kind: null };
}

/**
 * The feed target. `targetId` is the id GitHub returns for the target repo.
 * A rehearsal must never resolve to the real feed; a real publish must.
 */
export function targetIdErrors({ role, targetRepo, targetId, realFeedId }) {
  const errors = [];
  if (!realFeedId) errors.push("REAL_FEED_ID is not set");
  if (!targetRepo) {
    errors.push(role === "rehearsal"
      ? "SCRATCH_FEED_REPO is not set: create the repository variable before a rehearsal"
      : "the feed repository is not set");
  }
  if (errors.length) return errors;
  if (targetId === null || targetId === undefined || String(targetId) === "") {
    errors.push(`could not read the id of ${targetRepo}`);
  } else if (role === "rehearsal" && String(targetId) === String(realFeedId)) {
    errors.push(`${targetRepo} is the real update feed; a rehearsal must target a scratch repository`);
  } else if (role === "real" && String(targetId) !== String(realFeedId)) {
    errors.push(`${targetRepo} is not the real update feed (id mismatch)`);
  }
  return errors;
}

/**
 * Version against the target's Latest, before building anything.
 * `latest` is { tag_name, prerelease } or null when the feed has no Latest.
 */
export function latestPreflightErrors({ role, kind, version, latest }) {
  const errors = [];
  if (!latest) {
    if (role === "rehearsal" && kind === "stable") return errors;
    errors.push(role === "real"
      ? "the update feed has no Latest release"
      : "the scratch feed has no Latest release: publish a stable rehearsal first");
    return errors;
  }
  const tag = latest.tag_name;
  if (!parseVersion(tag)) {
    errors.push(`Latest is not a version: ${tag}`);
    return errors;
  }
  if (latest.prerelease) errors.push(`Latest ${tag} is a prerelease`);
  if (role === "real" && kind === "beta" && compareVersions(tag, REAL_FEED_BETA_FLOOR) < 0) {
    errors.push(`no beta goes to the update feed until Latest is v${REAL_FEED_BETA_FLOOR} or later (Latest is ${tag})`);
  }
  if (compareVersions(version, tag) <= 0) {
    errors.push(`version ${version} is not newer than Latest ${tag}`);
  }
  return errors;
}

/** The twelve file names one release carries, sorted. */
export function expectedAssetNames(version) {
  const v = version;
  return [
    `Keepr-${v}-arm64-mac.zip`,
    `Keepr-${v}-arm64-mac.zip.blockmap`,
    `Keepr-${v}-arm64.dmg`,
    `Keepr-${v}-arm64.dmg.blockmap`,
    `Keepr-${v}-mac.zip`,
    `Keepr-${v}-mac.zip.blockmap`,
    `Keepr-${v}.dmg`,
    `Keepr-${v}.dmg.blockmap`,
    `Keepr-Setup-${v}.exe`,
    `Keepr-Setup-${v}.exe.blockmap`,
    "latest-mac.yml",
    "latest.yml",
  ].sort();
}

/** Differences between two name lists, as messages. Empty = equal sets. */
export function assetSetErrors(actual, expected, label) {
  const a = [...new Set(actual)].sort();
  const missing = expected.filter((n) => !a.includes(n));
  const extra = a.filter((n) => !expected.includes(n));
  const errors = [];
  if (actual.length !== a.length) errors.push(`${label}: duplicate names`);
  if (missing.length) errors.push(`${label}: missing ${missing.join(", ")}`);
  if (extra.length) errors.push(`${label}: unexpected ${extra.join(", ")}`);
  return errors;
}

/** Releases whose tag is `tag` (the list endpoint shows drafts to a token that can push). */
export function releasesForTag(releases, tag) {
  return (Array.isArray(releases) ? releases : []).filter((r) => r && r.tag_name === tag);
}

function isWithdrawn(release) {
  return String(release.body ?? "").trimStart().startsWith(WITHDRAWN_MARKER);
}

/**
 * What a beta run does with the state it finds for its tag.
 * Returns { action, expect } or { refuse }.
 *  - create:  no release yet -> draft prerelease
 *  - resume:  a draft prerelease left by a failed run -> re-upload to it
 *  - repair:  a published prerelease (a re-run) -> re-assert flags, re-upload
 */
export function decideBetaStage(releases, tag) {
  const found = releasesForTag(releases, tag);
  if (found.length > 1) return { refuse: `${found.length} releases carry ${tag}; resolve by hand before publishing` };
  if (found.length === 0) return { action: "create", expect: { isDraft: true, isPrerelease: true } };
  const r = found[0];
  if (r.draft && isWithdrawn(r)) return { refuse: `${tag} was withdrawn; publish the fix as the next beta number` };
  if (r.draft && r.prerelease) return { action: "resume", expect: { isDraft: true, isPrerelease: true } };
  if (r.draft) return { refuse: `${tag} exists as a draft that is not a prerelease` };
  if (r.prerelease) return { action: "repair", expect: { isDraft: false, isPrerelease: true } };
  return { refuse: `${tag} is published as a stable release; this needs a manual repair with the founder's go` };
}

/** Before the beta is made public: it must still be one draft or published prerelease, never withdrawn. */
export function decideBetaFinish(releases, tag) {
  const found = releasesForTag(releases, tag);
  if (found.length !== 1) return { refuse: `expected one release for ${tag}, found ${found.length}` };
  const r = found[0];
  if (r.draft && isWithdrawn(r)) return { refuse: `${tag} was withdrawn; it is not published again` };
  if (!r.prerelease) return { refuse: `${tag} is not a prerelease` };
  return { ok: true };
}

/** A1 / A1': the release flags after a step. */
export function flagErrors(view, expect, label) {
  const errors = [];
  if (Boolean(view?.isDraft) !== expect.isDraft) errors.push(`${label}: isDraft is ${view?.isDraft}, expected ${expect.isDraft}`);
  if (Boolean(view?.isPrerelease) !== expect.isPrerelease) {
    errors.push(`${label}: isPrerelease is ${view?.isPrerelease}, expected ${expect.isPrerelease}`);
  }
  return errors;
}

/**
 * A4: an electron-builder update file (latest-mac.yml / latest.yml). Its
 * version must be this release's, and every url/path must be an asset of it.
 */
export function updateFileErrors(text, version, assetNames, label) {
  const errors = [];
  const lines = String(text ?? "").split(/\r?\n/);
  const versions = [];
  const refs = [];
  for (const line of lines) {
    const vm = /^version:\s*(.+?)\s*$/.exec(line);
    if (vm) versions.push(vm[1].replace(/^['"]|['"]$/g, ""));
    const rm = /^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/.exec(line);
    if (rm) refs.push(rm[1].replace(/^['"]|['"]$/g, ""));
  }
  if (versions.length !== 1 || versions[0] !== version) {
    errors.push(`${label}: version is ${versions.join(",") || "absent"}, expected ${version}`);
  }
  if (refs.length === 0) errors.push(`${label}: names no file`);
  for (const ref of refs) {
    if (!assetNames.includes(ref)) errors.push(`${label}: names ${ref}, which this release does not carry`);
  }
  return errors;
}

/**
 * A2 (beta, after it is public): Latest is still a stable, never this beta,
 * and no older than the Latest captured before publishing.
 */
export function betaLatestErrors({ latest, tag, previousTag }) {
  if (!latest) return ["the feed has no Latest after publishing the beta"];
  const errors = [];
  if (latest.tag_name === tag) errors.push(`Latest is the beta ${tag}`);
  if (latest.prerelease) errors.push(`Latest ${latest.tag_name} is a prerelease`);
  if (previousTag && parseVersion(latest.tag_name) && compareVersions(latest.tag_name, previousTag) < 0) {
    errors.push(`Latest moved back from ${previousTag} to ${latest.tag_name}`);
  }
  return errors;
}

/**
 * Stable (report-only on the real feed): Latest is a stable at least as new as
 * this tag. Equal is the normal case; newer is an old-line hotfix
 * (e.g. 2.48.1 published after 2.49.0), where Latest correctly stays put.
 */
export function stableLatestErrors({ latest, tag }) {
  if (!latest) return ["the feed has no Latest release"];
  const errors = [];
  if (latest.prerelease) errors.push(`Latest ${latest.tag_name} is a prerelease`);
  if (!parseVersion(latest.tag_name)) {
    errors.push(`Latest is not a version: ${latest.tag_name}`);
  } else if (compareVersions(latest.tag_name, tag) < 0) {
    errors.push(`Latest is ${latest.tag_name}, older than ${tag}`);
  }
  return errors;
}

/** A5: the app-update.yml electron-builder bakes into a packaged app. */
export function appUpdateConfigErrors(text, { owner, repo }, label) {
  const errors = [];
  const keys = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (m) keys[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  if (keys.provider !== "github") errors.push(`${label}: provider is ${keys.provider ?? "absent"}, expected github`);
  if (keys.owner !== owner) errors.push(`${label}: owner is ${keys.owner ?? "absent"}, expected ${owner}`);
  if (keys.repo !== repo) errors.push(`${label}: repo is ${keys.repo ?? "absent"}, expected ${repo}`);
  if ("channel" in keys) errors.push(`${label}: has a channel key (${keys.channel}); the app must read latest*.yml`);
  return errors;
}
