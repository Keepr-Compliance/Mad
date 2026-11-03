/**
 * BACKLOG-4115 PR-3: the title-bar sync pill's derivation, one producer-shaped
 * fixture per shipped state (syncPillFixtures.ts), the precedence pairs the SR
 * named (B1 / sweep (ii)), the "Sync now" only-in sweep, B2, and the Q1 flip.
 */
import {
  ANDROID_CONNECTED_STATES,
  deriveAndroidPill,
  deriveCompanionPill,
  deriveIPhonePill,
  relativeAgo,
  seenWithin,
  type SyncPillState,
} from "../syncPillState";
import { orchestratorStepFor } from "../../../hooks/googleMessagesSyncStatus";
import { resolveIphoneSyncEnabled } from "../../../utils/iphoneSyncEnabled";
import { NOW, IPHONE_BASE, IPHONE_STATES, EXT_BASE, ext, job, LISTENING, UNAVAILABLE } from "./syncPillFixtures";
import type { RcsExtensionState, RcsJobInfo } from "../../../../electron/types/ipc/window-api-rcs-import";
import type { BrowserLinkView } from "../../../components/settings/android/browserLinkState";

type Expect = Pick<SyncPillState, "label" | "tooltip" | "tone" | "canStart">;
const pick = (p: SyncPillState): Expect => ({ label: p.label, tooltip: p.tooltip, tone: p.tone, canStart: p.canStart });

const IPHONE_EXPECTED: Record<keyof typeof IPHONE_STATES, Expect> = {
  syncing: { label: "Syncing 42%", tooltip: "Backing up · 42%", tone: "arc", canStart: false },
  passcode: { label: "iPhone", tooltip: "Enter the passcode on your iPhone", tone: "warning", canStart: false },
  complete: { label: "iPhone", tooltip: "Synced just now", tone: "success", canStart: false },
  appleEncrypted: { label: "iPhone", tooltip: "Turn off backup encryption to sync", tone: "warning", canStart: false },
  errorCooldown: { label: "Sync failed", tooltip: "Sync failed · Try again in 30 s", tone: "danger", canStart: false },
  errorNoHold: { label: "Sync failed", tooltip: "Sync failed · Try again", tone: "danger", canStart: false },
  trust: { label: "iPhone", tooltip: "Tap Trust on your iPhone", tone: "warning", canStart: false },
  driverMissing: { label: "iPhone", tooltip: "Install Apple Devices to sync", tone: "warning", canStart: false },
  toolsMissing: { label: "iPhone", tooltip: "Install Apple Devices to sync", tone: "warning", canStart: false },
  locked: { label: "iPhone", tooltip: "Cleaning up the unfinished iPhone backup", tone: "neutral", canStart: false },
  detectionOff: { label: "iPhone", tooltip: "iPhone sync is off in Settings", tone: "neutral", canStart: false },
  connectedIdle: { label: "iPhone · Sync now", tooltip: "Click to sync your iPhone · connected", tone: "success", canStart: true },
  syncedBefore: { label: "iPhone", tooltip: "Synced 2 hours ago", tone: "neutral", canStart: false },
  notConnected: { label: "iPhone", tooltip: "Connect your iPhone by USB", tone: "neutral", canStart: false },
};

describe("iPhone pill: one fixture per shipped state", () => {
  it.each(Object.keys(IPHONE_STATES))("%s", (name) => {
    const f = IPHONE_STATES[name];
    expect(pick(deriveIPhonePill(f.sync, f.enabled, NOW))).toEqual(IPHONE_EXPECTED[name]);
  });

  it("toolsMissing on macOS uses the hook's own Mac wording", () => {
    const f = IPHONE_STATES.toolsMissing;
    expect(deriveIPhonePill(f.sync, true, NOW, { isMacOS: true }).tooltip).toBe("iPhone sync tools not installed");
  });

  it("syncing carries the percent for the arc", () => {
    const f = IPHONE_STATES.syncing;
    expect(deriveIPhonePill(f.sync, true, NOW).progressPercent).toBe(42);
  });
});

describe("iPhone precedence (SR B1, sweep ii)", () => {
  const P = { phase: "backing_up" as const, percent: 10 };
  it.each([
    ["syncing + error -> Sync failed", { syncStatus: "error" as const, progress: P, isConnected: true }, "Sync failed · Try again"],
    ["trust + passcode while syncing -> passcode", { syncStatus: "syncing" as const, progress: P, isWaitingForPasscode: true, needsTrust: true }, "Enter the passcode on your iPhone"],
    ["syncing + passcode -> passcode refinement", { syncStatus: "syncing" as const, progress: P, isWaitingForPasscode: true }, "Enter the passcode on your iPhone"],
    ["error + appleEncrypted -> encrypted", { syncStatus: "error" as const, appleEncryptedBackup: true }, "Turn off backup encryption to sync"],
    ["error + locked (no progress) -> lock", { syncStatus: "error" as const, syncLocked: true, lockReason: "Cleaning up the unfinished iPhone backup" }, "Cleaning up the unfinished iPhone backup"],
    ["locked + progress -> syncing", { syncLocked: true, progress: P, lockReason: "x" }, "Backing up · 10%"],
    ["trust idle (no sync) -> trust", { needsTrust: true, isWaitingForPasscode: true }, "Tap Trust on your iPhone"],
    ["trust + detection off -> trust", { needsTrust: true }, "Tap Trust on your iPhone"],
  ])("%s", (_n, over, tooltip) => {
    const enabled = !_n.includes("detection off");
    expect(deriveIPhonePill({ ...IPHONE_BASE, ...over }, enabled, NOW).tooltip).toBe(tooltip);
  });
});

describe("B2: detection off from the real enablement rule", () => {
  it("resolveIphoneSyncEnabled(false, platform, 'iphone-sync') -> 'off in Settings', never Sync now", () => {
    for (const platform of ["macos", "windows"] as const) {
      const enabled = resolveIphoneSyncEnabled(false, platform, "iphone-sync");
      expect(enabled).toBe(false);
      const p = deriveIPhonePill({ ...IPHONE_BASE, isConnected: true }, enabled, NOW);
      expect(p.tooltip).toBe("iPhone sync is off in Settings");
      expect(p.label).not.toMatch(/Sync now/);
      expect(p.canStart).toBe(false);
    }
  });
});

const step = (j: RcsJobInfo | null) => (j ? orchestratorStepFor(j) : null);
type AndroidCase = { ext: RcsExtensionState | null; status: typeof LISTENING | null; job: RcsJobInfo | null; link: BrowserLinkView };
const A = (over: Partial<AndroidCase>): AndroidCase => ({ ext: EXT_BASE, status: LISTENING, job: null, link: "linked", ...over });

const ANDROID_STATES: Record<string, AndroidCase> = {
  importing: A({ job: job({ state: "running", stage: "Saving your recent chats" }) }),
  importingCounted: A({ job: job({ state: "running", stage: "Reading chat 3 of 12" }) }), // literal shape: chrome-extension/job.js:2425
  saving: A({ job: job({ state: "finished", stage: "Done", finishedAt: new Date(NOW).toISOString() }) }),
  failed: A({ job: job({ state: "failed", stage: "Failed", error: { code: "page_gone", message: "The Messages tab was closed." } }) }),
  failedToSave: A({ job: job({ state: "finished", stage: "Done", saved: null }) }),
  cantListen: A({ status: UNAVAILABLE }),
  update: A({ ext: ext({ extensionUpdateReady: true }) }),
  notInstalled: A({ ext: ext({ extensionVersion: null, extensionSeenAt: null, extensionPaired: false, pairingSaved: false }), link: "notLinked" }),
  notLinked: A({ ext: ext({ extensionPaired: false, pairingSaved: false }), link: "notLinked" }),
  checking: A({ ext: ext({ extensionPaired: false }), link: "checking" }),
  consent: A({ ext: ext({ optedIn: false, consentVersion: null, consentAt: null }) }),
  synced: A({ ext: ext({ lastCacheFinishedAt: new Date(NOW - 2 * 3600_000).toISOString() }) }),
  syncedThisSession: A({
    ext: ext({ lastCacheFinishedAt: new Date(NOW - 60_000).toISOString() }),
    job: job({ state: "finished", stage: "Done", saved: { chats: 2, messages: 10, newMessages: 3 } }),
  }),
  cancelled: A({ job: job({ state: "cancelled", stage: "Cancelled" }) }),
  ready: A({}),
};

const ANDROID_EXPECTED: Record<keyof typeof ANDROID_STATES, Expect> = {
  importing: { label: "Importing", tooltip: "Saving your recent chats", tone: "arc", canStart: false },
  importingCounted: { label: "Importing", tooltip: "chat 3 of 12", tone: "arc", canStart: false },
  saving: { label: "Importing", tooltip: "Saving your recent chats", tone: "arc", canStart: false },
  failed: { label: "Sync failed", tooltip: "Sync failed · Try again", tone: "danger", canStart: false },
  failedToSave: { label: "Sync failed", tooltip: "Sync failed · Try again", tone: "danger", canStart: false },
  cantListen: { label: "Android", tooltip: "Keepr can't listen for the extension (port in use)", tone: "warning", canStart: false },
  update: { label: "Android", tooltip: "Update the Keepr extension", tone: "warning", canStart: false },
  notInstalled: { label: "Android", tooltip: "Install the Keepr extension", tone: "neutral", canStart: false },
  notLinked: { label: "Android", tooltip: "Link the extension to Keepr", tone: "neutral", canStart: false },
  checking: { label: "Android", tooltip: "Checking the browser…", tone: "neutral", canStart: false },
  consent: { label: "Android", tooltip: "Accept the sync consent to continue", tone: "warning", canStart: false },
  synced: { label: "Android · Sync now", tooltip: "Last sync 2 hours ago · click to sync again", tone: "neutral", canStart: true },
  syncedThisSession: { label: "Android · Sync now", tooltip: "Last sync 1 minute ago · click to sync again", tone: "neutral", canStart: true },
  cancelled: { label: "Android · Sync now", tooltip: "Click to sync your Android", tone: "neutral", canStart: true },
  ready: { label: "Android · Sync now", tooltip: "Click to sync your Android", tone: "neutral", canStart: true },
};

const android = (c: AndroidCase, connectedStates?: boolean) =>
  deriveAndroidPill(c.ext, c.status, step(c.job), c.link, NOW, connectedStates === undefined ? {} : { connectedStates });

describe("Android pill: one fixture per shipped state (B3: jobs through orchestratorStepFor)", () => {
  it.each(Object.keys(ANDROID_STATES))("%s", (name) => {
    expect(pick(android(ANDROID_STATES[name]))).toEqual(ANDROID_EXPECTED[name]);
  });

  it("the Android Companion source: Sync now, plain dot", () => {
    expect(pick(deriveCompanionPill())).toEqual({ label: "Android · Sync now", tooltip: "Click to sync your Android", tone: "neutral", canStart: true });
  });

  it("a non-cache job is ignored", () => {
    const j = job({ state: "running", kind: undefined });
    expect(android(A({ job: j })).label).toBe("Android · Sync now");
  });
});

describe('"Sync now" appears ONLY where a sync can start (sweep i)', () => {
  const all: Array<[string, SyncPillState]> = [
    ...Object.entries(IPHONE_STATES).map(([n, f]) => [`iphone:${n}`, deriveIPhonePill(f.sync, f.enabled, NOW)] as [string, SyncPillState]),
    ...Object.entries(IPHONE_STATES).map(([n, f]) => [`iphone-mac:${n}`, deriveIPhonePill(f.sync, f.enabled, NOW, { isMacOS: true })] as [string, SyncPillState]),
    ...Object.entries(ANDROID_STATES).map(([n, c]) => [`android:${n}`, android(c)] as [string, SyncPillState]),
    ...Object.entries(ANDROID_STATES).map(([n, c]) => [`android-q1:${n}`, android(c, true)] as [string, SyncPillState]),
    ...Object.entries(ANDROID_STATES).map(([n, c]) => [`android-q1-stale:${n}`, android({ ...c, ext: c.ext && { ...c.ext, extensionSeenAt: new Date(NOW - 3600_000).toISOString() } }, true)] as [string, SyncPillState]),
    ["companion", deriveCompanionPill()],
  ];
  it("covers every fixture (incl. detection-off and saving)", () => {
    expect(all.length).toBe(2 * Object.keys(IPHONE_STATES).length + 3 * Object.keys(ANDROID_STATES).length + 1);
    expect(all.map(([n]) => n)).toEqual(expect.arrayContaining(["iphone:detectionOff", "android:saving"]));
  });
  it.each(all)("%s: label says Sync now <=> canStart", (_n, p) => {
    expect(/Sync now/.test(p.label)).toBe(p.canStart);
  });
  it("the startable set is exactly connected-idle iPhone, synced / ready Android, companion", () => {
    const startable = all.filter(([, p]) => p.canStart).map(([n]) => n).filter((n) => !n.startsWith("android-q1") && !n.startsWith("iphone-mac"));
    expect(startable).toEqual(["iphone:connectedIdle", "android:synced", "android:syncedThisSession", "android:cancelled", "android:ready", "companion"]);
  });
});

describe("Q1 flip: ANDROID_CONNECTED_STATES (A9/A10)", () => {
  it("defaults to false (PM D1: interim in 2.45)", () => {
    expect(ANDROID_CONNECTED_STATES).toBe(false);
  });
  const seen = (ms: number) => A({ ext: ext({ extensionSeenAt: new Date(NOW - ms).toISOString() }) });
  it("flipped, seen 9 min ago -> green dot, connected tooltip", () => {
    expect(pick(android(seen(9 * 60_000), true))).toEqual({ label: "Android · Sync now", tooltip: "Click to sync your Android · extension connected", tone: "success", canStart: true });
  });
  it("flipped, seen exactly 10 min ago -> still connected (boundary inclusive)", () => {
    expect(android(seen(10 * 60_000), true).tone).toBe("success");
    expect(seenWithin(new Date(NOW - 10 * 60_000).toISOString(), NOW)).toBe(true);
    expect(seenWithin(new Date(NOW - 10 * 60_000 - 1).toISOString(), NOW)).toBe(false);
  });
  it("flipped, seen 11 min ago -> 'Last seen … · open Chrome', no Sync now", () => {
    expect(pick(android(seen(11 * 60_000), true))).toEqual({ label: "Android", tooltip: "Last seen 11 minutes ago · open Chrome", tone: "neutral", canStart: false });
  });
  it("flipped, synced and seen -> A11 with the green dot", () => {
    const c = A({ ext: ext({ lastCacheFinishedAt: new Date(NOW - 2 * 3600_000).toISOString() }) });
    expect(pick(android(c, true))).toEqual({ label: "Android · Sync now", tooltip: "Last sync 2 hours ago · click to sync again", tone: "success", canStart: true });
  });
  it.each([9, 10, 11, 600])("default (false): seen %i min ago -> interim regardless", (min) => {
    expect(pick(android(seen(min * 60_000)))).toEqual(ANDROID_EXPECTED.ready);
  });
});

describe("relativeAgo", () => {
  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [60_000, "1 minute ago"],
    [59 * 60_000, "59 minutes ago"],
    [3600_000, "1 hour ago"],
    [23 * 3600_000, "23 hours ago"],
    [24 * 3600_000, "yesterday"],
    [3 * 24 * 3600_000, "3 days ago"],
  ])("%i ms -> %s", (ms, s) => {
    expect(relativeAgo(NOW - ms, NOW)).toBe(s);
  });
});
