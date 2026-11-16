// BACKLOG-4245: the one place feed-preflight.mjs and publish-feed.mjs call `gh`.
// argv arrays only, never a shell. FEED_GH_BIN replaces `gh` with a node script
// (the tests' stand-in); it is refused inside GitHub Actions.
import { spawnSync } from "node:child_process";

export function ghRunner() {
  const stub = process.env.FEED_GH_BIN;
  if (stub && process.env.GITHUB_ACTIONS === "true") {
    throw new Error("FEED_GH_BIN is set inside GitHub Actions; refusing to run");
  }
  return (args, { token } = {}) => {
    const [cmd, argv] = stub ? [process.execPath, [stub, ...args]] : ["gh", args];
    const env = token === undefined ? process.env : { ...process.env, GH_TOKEN: token };
    const r = spawnSync(cmd, argv, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`could not run gh: ${r.error.message}`);
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

export function isNotFound(result) {
  return result.status !== 0 && /HTTP 404|Not Found/i.test(result.stderr + result.stdout);
}

/** `gh ...` that must succeed; returns stdout. */
export function ghOk(gh, args, what) {
  const r = gh(args);
  if (r.status !== 0) throw new Error(`${what} failed (gh exit ${r.status}): ${r.stderr.trim()}`);
  return r.stdout;
}

export function ghJson(gh, args, what) {
  const out = ghOk(gh, args, what);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`${what}: gh did not return JSON`);
  }
}

/** The repo's numeric id, or throws. */
export function repoId(gh, repo) {
  const data = ghJson(gh, ["api", `repos/${repo}`], `reading ${repo}`);
  return data?.id ?? null;
}

/** { tag_name, prerelease } of the repo's Latest, or null when it has none (404). */
export function readLatest(gh, repo) {
  const r = gh(["api", `repos/${repo}/releases/latest`]);
  if (isNotFound(r)) return null;
  if (r.status !== 0) throw new Error(`reading the Latest release of ${repo} failed: ${r.stderr.trim()}`);
  const data = JSON.parse(r.stdout);
  return { tag_name: data.tag_name, prerelease: Boolean(data.prerelease), draft: Boolean(data.draft) };
}

/** Every release including drafts (drafts are listed to a token that can push). */
export function listReleases(gh, repo) {
  const data = ghJson(gh, ["api", `repos/${repo}/releases?per_page=100`], `listing releases of ${repo}`);
  if (!Array.isArray(data)) throw new Error(`listing releases of ${repo}: not a list`);
  return data.map((r) => ({ tag_name: r.tag_name, draft: Boolean(r.draft), prerelease: Boolean(r.prerelease), body: r.body ?? "" }));
}

export function fail(errors) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
