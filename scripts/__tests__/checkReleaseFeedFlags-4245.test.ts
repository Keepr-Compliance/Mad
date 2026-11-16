/**
 * @jest-environment node
 */

/**
 * BACKLOG-4245 — check-release-feed-flags.mjs passes on the repo's release.yml
 * and fails on each way the stable, beta or rehearsal publish path could drift.
 * Each case edits one exact string of a copy of release.yml; the edit is
 * asserted to have applied before the check runs.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const ROOT = path.join(__dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/ci/check-release-feed-flags.mjs");
const WORKFLOW = readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "keepr-4245-flags-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (file?: string) =>
  spawnSync(process.execPath, file ? [SCRIPT, "--workflow", file] : [SCRIPT], { encoding: "utf8" });

/** Replace exactly `count` occurrences of `from`; throws when the text does not contain them. */
function mutate(from: string, to: string, count = 1, source = WORKFLOW): string {
  const found = source.split(from).length - 1;
  if (found !== count) throw new Error(`mutation did not apply: found ${found} of ${count}: ${from.slice(0, 60)}`);
  return source.split(from).join(to);
}
function check(body: string) {
  expect(body).not.toBe(WORKFLOW);
  const file = path.join(dir, `release-${Math.random().toString(36).slice(2)}.yml`);
  writeFileSync(file, body);
  return run(file);
}

const SCRATCH = "${{ secrets.SCRATCH_FEED_TOKEN }}";
const BETA = "${{ secrets.FEED_BETA_TOKEN }}";

describe("BACKLOG-4245 check-release-feed-flags", () => {
  it("passes on the repo's release.yml", () => {
    const r = run();
    expect(r.stdout).toMatch(/check-release-feed-flags: OK/);
    expect(r.status).toBe(0);
  });

  it.each([
    [
      "the stable mirror passes --latest=false",
      () => mutate('            --title "Keepr ${VERSION}" \\\n            --notes "Download', '            --title "Keepr ${VERSION}" \\\n            --latest=false \\\n            --notes "Download'),
      /stable mirror passes --latest|differs from its reviewed text/,
    ],
    [
      "the stable mirror passes --prerelease",
      () => mutate('            --title "Keepr ${VERSION}" \\\n            --notes "Download', '            --title "Keepr ${VERSION}" \\\n            --prerelease \\\n            --notes "Download'),
      /stable mirror passes --prerelease/,
    ],
    [
      "create-release's if: is edited",
      () => mutate("      always() && github.ref == 'refs/heads/main' &&\n", "      always() &&\n"),
      /create-release differs from its reviewed text/,
    ],
    [
      "the Latest step can fail the job",
      () => mutate("      - name: Check which release is Latest (report only, BACKLOG-4245)\n        continue-on-error: true\n", "      - name: Check which release is Latest (report only, BACKLOG-4245)\n"),
      /must be continue-on-error: true/,
    ],
    [
      "the local preflight step is skipped on main",
      () => mutate(
        "      - name: Refuse a version or channel this ref cannot release (BACKLOG-4245)\n        env:",
        "      - name: Refuse a version or channel this ref cannot release (BACKLOG-4245)\n        if: inputs.channel == 'beta' || startsWith(github.ref, 'refs/heads/rehearsal/')\n        env:",
        2,
      ),
      /local preflight step must not have an if:/,
    ],
    [
      "the rehearsal job reads the stable feed token",
      () => mutate(`          GH_TOKEN: ${SCRATCH}\n          REPO_TOKEN:`, "          GH_TOKEN: ${{ secrets.PUBLIC_RELEASE_TOKEN }}\n          REPO_TOKEN:"),
      /rehearse-feed: reads PUBLIC_RELEASE_TOKEN/,
    ],
    [
      "the rehearsal job reads the beta token",
      () => mutate(`          GH_TOKEN: ${SCRATCH}\n          REPO_TOKEN:`, `          GH_TOKEN: ${BETA}\n          REPO_TOKEN:`),
      /rehearse-feed: reads FEED_BETA_TOKEN without environment: feed-beta/,
    ],
    [
      "publish-beta drops its Environment",
      () => mutate("    environment: feed-beta\n", ""),
      /reads FEED_BETA_TOKEN without environment: feed-beta/,
    ],
    [
      "a token is chosen by && / ||",
      () => mutate(`          GH_TOKEN: ${SCRATCH}\n          REPO_TOKEN:`, "          GH_TOKEN: ${{ startsWith(github.ref, 'refs/heads/rehearsal/') && secrets.SCRATCH_FEED_TOKEN || secrets.FEED_BETA_TOKEN }}\n          REPO_TOKEN:"),
      /mixes a secret with && or \|\|/,
    ],
    [
      "a build job reads the scratch token (not just its presence)",
      () => mutate("          HAS_SCRATCH_TOKEN: ${{ secrets.SCRATCH_FEED_TOKEN != '' }}\n", `          HAS_SCRATCH_TOKEN: ${SCRATCH}\n`, 2),
      /release-macos: reads SCRATCH_FEED_TOKEN/,
    ],
    [
      "publish-beta loses its finish step",
      () => {
        const t = WORKFLOW;
        const start = t.indexOf("  publish-beta:");
        const end = t.indexOf("  rehearse-feed:");
        const job = t.slice(start, end);
        const step = job.slice(job.indexOf("      - name: Publish and check Latest"));
        return t.slice(0, start) + mutate(step, "", 1, job) + t.slice(end);
      },
      /publish-beta and rehearse-feed steps differ/,
    ],
    [
      "publish-beta no longer needs the Windows build to succeed",
      () => mutate("      startsWith(github.ref, 'refs/heads/beta/') &&\n      needs.release-macos.result == 'success' &&\n      needs.release-windows.result == 'success'\n", "      startsWith(github.ref, 'refs/heads/beta/') &&\n      needs.release-macos.result == 'success'\n"),
      /publish-beta if: differs/,
    ],
    [
      "rehearse-feed admits store",
      () => mutate("      (inputs.channel == 'website' || inputs.channel == 'beta') &&\n", "      (inputs.channel == 'website' || inputs.channel == 'beta' || inputs.channel == 'store') &&\n"),
      /rehearse-feed if: differs|admits store/,
    ],
    [
      "the copied integrity step loses the strict gate",
      () => {
        const t = WORKFLOW;
        const start = t.indexOf("  publish-beta:");
        const end = t.indexOf("  rehearse-feed:");
        const job = mutate('          strict_verify_repo "${PUBLIC_REPO}" "${GH_TOKEN}" "public" "true"\n', "", 1, t.slice(start, end));
        return t.slice(0, start) + job + t.slice(end);
      },
      /integrity step differs from create-release's/,
    ],
    [
      "the dispatch has no beta option",
      () => mutate("        options: [website, store, beta]\n", "        options: [website, store]\n"),
      /options must be \[website, store, beta\]/,
    ],
  ])("FAILS when %s", (_label, make, why) => {
    const r = check(make());
    expect(r.stderr).toMatch(why);
    expect(r.status).toBe(1);
  });

  it("FAILS when the rehearsal's stable commands differ from the mirror's (title changed in the mirror only)", () => {
    const r = check(mutate('            --title "Keepr ${VERSION}" \\\n            --notes "Download', '            --title "Keepr release ${VERSION}" \\\n            --notes "Download'));
    expect(r.stderr).toMatch(/rehearsal stable create differs from the mirror's/);
    expect(r.status).toBe(1);
  });
});
