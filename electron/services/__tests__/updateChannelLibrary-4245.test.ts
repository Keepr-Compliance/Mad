/**
 * @jest-environment node
 */

/**
 * BACKLOG-4245: what electron-updater 6.8.9 itself does with the values
 * updateChannelPolicy sets, for a stable build and a beta build with the
 * preference off and on.
 *
 * Real: electron-updater's AppUpdater (check + version compare) and
 * GitHubProvider (release pick + channel file), deep-imported so jest's
 * `^electron-updater$` stand-in does not apply. Stand-in: the HTTP executor,
 * serving a releases feed whose entry shape is transcribed from the public
 * keepr-releases `releases.atom` and whose `latest-mac.yml` shape is
 * transcribed from the v2.48.0 asset (read 2026-11-15). Hashes and sizes are
 * placeholders.
 *
 * Library lines relied on (node_modules/electron-updater/out/):
 * - AppUpdater.js:218   allowPrerelease defaults to "version has a prerelease part"
 * - AppUpdater.js:138   allowDowngrade defaults to false
 * - AppUpdater.js:44    the channel setter sets allowDowngrade = true (the only
 *                        `allowDowngrade = true` in out/)
 * - AppUpdater.js:339-362 update only when newer, or older with allowDowngrade
 * - providers/GitHubProvider.js:51-91 allowPrerelease: first eligible feed entry
 * - providers/GitHubProvider.js:92-105,158-176 otherwise GitHub's /releases/latest
 * - providers/GitHubProvider.js:131-140 prerelease tag: beta-mac.yml, then latest-mac.yml
 */

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { AppUpdater } from "electron-updater/out/AppUpdater";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider";
import { HttpError } from "builder-util-runtime";
import { applyBetaUpdates } from "../updateChannelPolicy";

const OWNER = "Keepr-Compliance";
const REPO = "keepr-releases";
// pii-allow-uuid: invented, not from any live row
const STAGING_ID = "00000000-0000-4000-8000-000000000001";

interface Release {
  tag: string;
  /** GitHub's "Latest" (never a prerelease). */
  latest?: boolean;
}

function atomEntry(tag: string): string {
  return `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <updated>2026-11-14T01:28:01Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/${OWNER}/${REPO}/releases/tag/${tag}"/>
    <title>Keepr ${tag}</title>
    <content type="html">&lt;p&gt;Download the Keepr desktop app.&lt;/p&gt;</content>
    <author>
      <name>release</name>
    </author>
  </entry>`;
}

/** `releases` newest-published first, as the Atom feed orders them. */
function feedXml(releases: Release[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/${OWNER}/${REPO}/releases</id>
  <title>Release notes from ${REPO}</title>
  <updated>2026-11-14T01:28:01Z</updated>
${releases.map((r) => atomEntry(r.tag)).join("\n")}
</feed>`;
}

function latestMacYml(version: string): string {
  return `version: ${version}
files:
  - url: Keepr-${version}-arm64-mac.zip
    sha512: AAAA
    size: 191134946
path: Keepr-${version}-arm64-mac.zip
sha512: AAAA
releaseDate: '2026-11-14T01:26:20.403Z'
`;
}

/** Serves the feed, /releases/latest and each tag's latest-mac.yml; beta-mac.yml is a 404 (electron-builder names it latest-mac.yml for the GitHub provider). */
function makeExecutor(releases: Release[]) {
  const requested: string[] = [];
  const executor = {
    requested,
    request: async (opts: { path?: string }) => {
      const p = opts.path ?? "";
      requested.push(p);
      if (p === `/${OWNER}/${REPO}/releases.atom`) return feedXml(releases);
      if (p === `/${OWNER}/${REPO}/releases/latest`) {
        const latest = releases.find((r) => r.latest);
        return JSON.stringify({ tag_name: latest?.tag });
      }
      const m = /^\/.+\/releases\/download\/(v[^/]+)\/(.+)$/.exec(p);
      if (m && m[2] === "latest-mac.yml" && releases.some((r) => r.tag === m[1])) {
        return latestMacYml(m[1].replace(/^v/, ""));
      }
      throw new HttpError(404);
    },
  };
  return executor;
}

class TestUpdater extends AppUpdater {
  constructor(version: string) {
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
    super(null, app as never);
    this.logger = null;
    this.autoDownload = false;
  }
  protected doDownloadUpdate(): Promise<string[]> {
    return Promise.resolve([]);
  }
  quitAndInstall(): void {
    /* not used */
  }
}

type CheckOutcome = { updateAvailable: boolean; version: string; requested: string[] };

/** One real check (AppUpdater.doCheckForUpdates) against the stand-in feed. */
async function check(updater: TestUpdater, releases: Release[]): Promise<CheckOutcome> {
  const executor = makeExecutor(releases);
  const provider = new GitHubProvider(
    { provider: "github", owner: OWNER, repo: REPO },
    updater,
    { isUseMultipleRangeRequest: false, platform: "darwin", executor: executor as never },
  );
  const internals = updater as unknown as {
    clientPromise: Promise<unknown>;
    stagingUserIdPromise: { value: Promise<string> };
    doCheckForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>;
  };
  internals.clientPromise = Promise.resolve(provider);
  internals.stagingUserIdPromise = { value: Promise.resolve(STAGING_ID) };
  const result = await internals.doCheckForUpdates();
  return { updateAvailable: result.isUpdateAvailable, version: result.updateInfo.version, requested: executor.requested };
}

const STABLE = "2.49.0";
const BETA = "2.50.0-beta.1";
/** A beta published after the current stable. */
const FEED_BETA_NEWEST: Release[] = [{ tag: "v2.50.0-beta.2" }, { tag: "v2.50.0-beta.1" }, { tag: "v2.49.0", latest: true }];

describe("library defaults (before Keepr sets anything)", () => {
  it("stable build: allowPrerelease false, allowDowngrade false, channel null", () => {
    const u = new TestUpdater(STABLE);
    expect([u.allowPrerelease, u.allowDowngrade, u.channel]).toEqual([false, false, null]);
  });

  it("beta build: allowPrerelease TRUE by default", () => {
    const u = new TestUpdater(BETA);
    expect([u.allowPrerelease, u.allowDowngrade, u.channel]).toEqual([true, false, null]);
  });

  it("assigning channel turns downgrades on", () => {
    const u = new TestUpdater(BETA);
    u.channel = "latest";
    expect(u.allowDowngrade).toBe(true);
  });
});

describe("the four combinations, with applyBetaUpdates on the real updater", () => {
  it("stable build, preference off: GitHub Latest only; no update to the beta", async () => {
    const u = new TestUpdater(STABLE);
    applyBetaUpdates(false, u);
    const r = await check(u, FEED_BETA_NEWEST);
    expect(r).toEqual(expect.objectContaining({ updateAvailable: false, version: "2.49.0" }));
    expect(r.requested).toContain(`/${OWNER}/${REPO}/releases/latest`);
  });

  it("stable build, preference on: the newest feed entry (the beta), via the latest-mac.yml fallback", async () => {
    const u = new TestUpdater(STABLE);
    applyBetaUpdates(true, u);
    const r = await check(u, FEED_BETA_NEWEST);
    expect(r).toEqual(expect.objectContaining({ updateAvailable: true, version: "2.50.0-beta.2" }));
    expect(r.requested).not.toContain(`/${OWNER}/${REPO}/releases/latest`);
    expect(r.requested).toEqual(
      expect.arrayContaining([
        `/${OWNER}/${REPO}/releases/download/v2.50.0-beta.2/beta-mac.yml`,
        `/${OWNER}/${REPO}/releases/download/v2.50.0-beta.2/latest-mac.yml`,
      ]),
    );
  });

  it("beta build, preference off: GitHub Latest (older stable) is NOT installed: never downgraded", async () => {
    const u = new TestUpdater(BETA);
    applyBetaUpdates(false, u);
    expect(u.allowPrerelease).toBe(false);
    const r = await check(u, FEED_BETA_NEWEST);
    expect(r).toEqual(expect.objectContaining({ updateAvailable: false, version: "2.49.0" }));
  });

  it("beta build, preference on: the next beta", async () => {
    const u = new TestUpdater(BETA);
    applyBetaUpdates(true, u);
    const r = await check(u, FEED_BETA_NEWEST);
    expect(r).toEqual(expect.objectContaining({ updateAvailable: true, version: "2.50.0-beta.2" }));
  });
});

describe("leaving and staying on beta", () => {
  it("beta build, preference off: the next stable that is newer is installed", async () => {
    const u = new TestUpdater(BETA);
    applyBetaUpdates(false, u);
    const r = await check(u, [{ tag: "v2.50.0", latest: true }, { tag: "v2.50.0-beta.1" }, { tag: "v2.49.0" }]);
    expect(r).toEqual(expect.objectContaining({ updateAvailable: true, version: "2.50.0" }));
  });

  it("beta build, preference on: a lower stable hotfix published after the beta is not installed", async () => {
    const u = new TestUpdater(BETA);
    applyBetaUpdates(true, u);
    const r = await check(u, [{ tag: "v2.49.1", latest: true }, { tag: "v2.50.0-beta.1" }, { tag: "v2.49.0" }]);
    expect(r).toEqual(expect.objectContaining({ updateAvailable: false, version: "2.49.1" }));
  });
});

describe("library behaviour without applyBetaUpdates", () => {
  it("beta build, nothing applied: takes the next beta although nobody turned betas on", async () => {
    const u = new TestUpdater(BETA);
    const r = await check(u, FEED_BETA_NEWEST);
    expect(r).toEqual(expect.objectContaining({ updateAvailable: true, version: "2.50.0-beta.2" }));
  });

  it("beta build with channel assigned and betas off: DOWNGRADES to the older stable", async () => {
    const u = new TestUpdater(BETA);
    u.channel = "latest";
    u.allowPrerelease = false;
    const r = await check(u, FEED_BETA_NEWEST);
    expect(r).toEqual(expect.objectContaining({ updateAvailable: true, version: "2.49.0" }));
  });

  it("the same, after applyBetaUpdates: downgrade is forced back off", async () => {
    const u = new TestUpdater(BETA);
    u.channel = "latest";
    applyBetaUpdates(false, u);
    const r = await check(u, FEED_BETA_NEWEST);
    expect(r).toEqual(expect.objectContaining({ updateAvailable: false, version: "2.49.0" }));
  });
});
