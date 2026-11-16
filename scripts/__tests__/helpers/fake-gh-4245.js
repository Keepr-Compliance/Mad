#!/usr/bin/env node
// BACKLOG-4245: a stand-in for `gh`, run by the feed scripts through FEED_GH_BIN.
// It never touches the network. State lives in the JSON file FAKE_GH_STATE; every
// call is appended to FAKE_GH_LOG as one JSON line.
//
// This is a MODEL of GitHub, not a transcript of it. What it models:
//  - drafts are listed by `api repos/X/releases` and resolved by tag;
//  - `create` on an existing tag fails with "already exists";
//  - Latest is automatic: the highest published non-prerelease, recomputed when a
//    release becomes published and non-prerelease, unless --latest=false is given;
//  - `--latest` (true) makes the release Latest even when it is a prerelease, so a
//    run that passes it is seen to move Latest.
// Which of these GitHub really does is what the scratch-feed rehearsal proves.
const fs = require("fs");
const path = require("path");

const STATE = process.env.FAKE_GH_STATE;
const LOG = process.env.FAKE_GH_LOG;
const args = process.argv.slice(2);
if (LOG) fs.appendFileSync(LOG, JSON.stringify({ args, token: process.env.GH_TOKEN || "" }) + "\n");
if (!STATE) {
  process.stderr.write("fake gh: FAKE_GH_STATE is not set\n");
  process.exit(4);
}
const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
state.repos = state.repos || {};
state.releases = state.releases || {};
state.latest = state.latest || {};
state.environments = state.environments || {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
const die = (msg, code = 1) => {
  process.stderr.write(msg + "\n");
  process.exit(code);
};

function semver(t) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(t);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || null] : null;
}
function cmp(a, b) {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}
function recomputeLatest(repo) {
  const published = (state.releases[repo] || []).filter((r) => !r.draft && !r.prerelease);
  published.sort((a, b) => cmp(b.tag_name, a.tag_name));
  state.latest[repo] = published.length ? published[0].tag_name : null;
}
function takeOpt(list, name) {
  const i = list.indexOf(name);
  if (i < 0) return undefined;
  const v = list[i + 1];
  list.splice(i, 2);
  return v;
}
function boolFlag(list, name) {
  // --name, --name=true, --name=false; returns undefined when absent
  for (let i = 0; i < list.length; i++) {
    if (list[i] === name || list[i] === `${name}=true`) {
      list.splice(i, 1);
      return true;
    }
    if (list[i] === `${name}=false`) {
      list.splice(i, 1);
      return false;
    }
  }
  return undefined;
}
function find(repo, tag) {
  return (state.releases[repo] || []).filter((r) => r.tag_name === tag);
}
function addFiles(rel, files) {
  rel.assets = rel.assets || [];
  rel.files = rel.files || {};
  for (const f of files) {
    if (!fs.existsSync(f)) die(`fake gh: no such file ${f}`);
    const name = path.basename(f);
    if (!rel.assets.includes(name)) rel.assets.push(name);
    if (name.endsWith(".yml")) rel.files[name] = fs.readFileSync(f, "utf8");
  }
}

const [cmd, sub, ...rest] = args;
if (cmd === "api") {
  const endpoint = sub;
  let m;
  if ((m = /^repos\/([^/]+\/[^/?]+)$/.exec(endpoint))) {
    const repo = state.repos[m[1]];
    if (!repo) die("gh: Not Found (HTTP 404)");
    out(repo);
  } else if ((m = /^repos\/([^/]+\/[^/]+)\/releases\?per_page=100$/.exec(endpoint))) {
    out((state.releases[m[1]] || []).map((r) => ({ tag_name: r.tag_name, draft: !!r.draft, prerelease: !!r.prerelease, body: r.body || "" })));
  } else if ((m = /^repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(endpoint))) {
    const tag = state.latest[m[1]];
    const rel = tag && find(m[1], tag)[0];
    if (!rel) die("gh: Not Found (HTTP 404)");
    out({ tag_name: rel.tag_name, prerelease: !!rel.prerelease, draft: !!rel.draft });
  } else if ((m = /^repos\/([^/]+\/[^/]+)\/environments\/(.+)$/.exec(endpoint))) {
    const env = state.environments[`${m[1]}/${decodeURIComponent(m[2])}`];
    if (!env) die("gh: Not Found (HTTP 404)");
    out(env);
  } else {
    die(`fake gh: unmodelled endpoint ${endpoint}`, 3);
  }
} else if (cmd === "release") {
  const list = [...rest];
  const tag = list.shift();
  const repo = takeOpt(list, "--repo");
  if (!state.repos[repo]) die("gh: Not Found (HTTP 404)");
  state.releases[repo] = state.releases[repo] || [];
  const existing = find(repo, tag);
  if (sub === "create") {
    if (existing.length) die("a release with the same tag name already exists: " + tag);
    const draft = boolFlag(list, "--draft") === true;
    const prerelease = boolFlag(list, "--prerelease") === true;
    const latest = boolFlag(list, "--latest");
    const title = takeOpt(list, "--title");
    const notes = takeOpt(list, "--notes");
    const rel = { tag_name: tag, draft, prerelease, body: notes, title };
    addFiles(rel, list);
    state.releases[repo].push(rel);
    if (latest === true) state.latest[repo] = tag;
    else if (latest === undefined && !draft && !prerelease) recomputeLatest(repo);
    save();
  } else if (sub === "upload") {
    if (!existing.length) die("release not found");
    boolFlag(list, "--clobber");
    addFiles(existing[0], list);
    save();
  } else if (sub === "edit") {
    if (!existing.length) die("release not found");
    const rel = existing[0];
    const draft = boolFlag(list, "--draft");
    const prerelease = boolFlag(list, "--prerelease");
    const latest = boolFlag(list, "--latest");
    const notes = takeOpt(list, "--notes");
    if (draft !== undefined) rel.draft = draft;
    if (prerelease !== undefined) rel.prerelease = prerelease;
    if (notes !== undefined) rel.body = notes;
    if (latest === true) state.latest[repo] = tag;
    else if (latest === undefined) recomputeLatest(repo);
    save();
  } else if (sub === "view") {
    if (!existing.length) die("release not found");
    const rel = existing[0];
    out({ isDraft: !!rel.draft, isPrerelease: !!rel.prerelease, assets: (rel.assets || []).map((name) => ({ name })) });
  } else if (sub === "download") {
    if (!existing.length) die("release not found");
    const dir = takeOpt(list, "-D");
    const patterns = [];
    let p;
    while ((p = takeOpt(list, "-p")) !== undefined) patterns.push(p);
    for (const name of patterns) {
      const text = (existing[0].files || {})[name];
      if (text !== undefined) fs.writeFileSync(path.join(dir, name), text);
    }
  } else {
    die(`fake gh: unmodelled release ${sub}`, 3);
  }
} else {
  die(`fake gh: unmodelled command ${cmd}`, 3);
}
