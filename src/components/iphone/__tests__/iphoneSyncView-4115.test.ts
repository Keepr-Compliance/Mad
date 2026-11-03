/**
 * BACKLOG-4115 C1 (D4): the shared view resolver, over EVERY combination of
 * syncStatus x syncLocked x progress x appleEncryptedBackup (4 x 2 x 2 x 2 = 32).
 * The expected column is the pre-extraction expression (IPhoneSyncFlow.tsx
 * :98-107 at f82ae3681), written out by hand as a table, not recomputed.
 */
import { resolveIPhoneSyncView, type IPhoneSyncView } from "../iphoneSyncView";
import type { BackupProgress, SyncStatus } from "../../../types/iphone";

const P: BackupProgress = { phase: "backing_up", percent: 42 } as BackupProgress;

// [syncStatus, syncLocked, hasProgress, appleEncrypted, expected]
const TABLE: Array<[SyncStatus, boolean, boolean, boolean, IPhoneSyncView]> = [
  ["idle", false, false, false, "connection"],
  ["idle", false, false, true, "connection"],
  ["idle", false, true, false, "connection"],
  ["idle", false, true, true, "connection"],
  ["idle", true, false, false, "lockBanner"],
  ["idle", true, false, true, "lockBanner"],
  ["idle", true, true, false, "progress"],
  ["idle", true, true, true, "progress"],
  ["syncing", false, false, false, "progress"],
  ["syncing", false, false, true, "progress"],
  ["syncing", false, true, false, "progress"],
  ["syncing", false, true, true, "progress"],
  ["syncing", true, false, false, "progress"],
  ["syncing", true, false, true, "progress"],
  ["syncing", true, true, false, "progress"],
  ["syncing", true, true, true, "progress"],
  ["complete", false, false, false, "connection"],
  ["complete", false, false, true, "connection"],
  ["complete", false, true, false, "success"],
  ["complete", false, true, true, "success"],
  ["complete", true, false, false, "lockBanner"],
  ["complete", true, false, true, "lockBanner"],
  ["complete", true, true, false, "progress"],
  ["complete", true, true, true, "progress"],
  ["error", false, false, false, "error"],
  ["error", false, false, true, "appleEncrypted"],
  ["error", false, true, false, "error"],
  ["error", false, true, true, "appleEncrypted"],
  ["error", true, false, false, "lockBanner"],
  ["error", true, false, true, "lockBanner"],
  ["error", true, true, false, "error"],
  ["error", true, true, true, "appleEncrypted"],
];

describe("resolveIPhoneSyncView (BACKLOG-4115 C1)", () => {
  it("the table covers all 32 combinations once", () => {
    const keys = new Set(TABLE.map(([s, l, p, a]) => `${s}|${l}|${p}|${a}`));
    expect(keys.size).toBe(32);
  });

  it.each(TABLE)("syncStatus=%s locked=%s progress=%s appleEncrypted=%s -> %s", (syncStatus, syncLocked, hasProgress, appleEncryptedBackup, expected) => {
    expect(
      resolveIPhoneSyncView({ syncStatus, syncLocked, progress: hasProgress ? P : null, appleEncryptedBackup }),
    ).toBe(expected);
  });
});
