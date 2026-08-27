/**
 * Local APFS/Time Machine snapshot inspection (BACKLOG-2870)
 *
 * ============================================================================
 * WHY A DISK-SPACE MESSAGE NEEDS THIS AT ALL
 * ============================================================================
 *
 * `getAvailableDiskBytes` reports `statfs().f_bavail` — the bytes a process can
 * actually write right now (see the long note in `diskSpace.ts` for why any
 * purgeable-inclusive figure is forbidden). Finder reports something else:
 * `NSURLVolumeAvailableCapacityForImportantUsageKey`, which ADDS purgeable
 * space, most of it held by local Time Machine snapshots.
 *
 * On the founder's Mac, 2026-08-25, the two numbers were 17 GB and ~176 GB.
 *
 * So a refusal reading "only 17 GB is available", shown to a user whose Finder
 * window says 176 GB, reads as a bug in Keepr. It happened: he ran a force
 * re-import, it died with a raw `database or disk is full`, and his reaction was
 * "but my disk isn't full". The guard is right and looks wrong, and a guard that
 * looks wrong gets disbelieved and worked around.
 *
 * Naming the reason is the whole job of this module.
 *
 * ============================================================================
 * WHY A COUNT AND NOT BYTES — THIS IS A MEASURED LIMIT, NOT A SHORTCUT
 * ============================================================================
 *
 * The obvious message would quote the bytes snapshots are holding. macOS does
 * not expose that figure. Enumerated on 2026-08-25, on the machine that hit the
 * bug:
 *
 *   - `diskutil info -plist /System/Volumes/Data` — every key it emits was
 *     listed. It has `APFSContainerFree`, `APFSContainerSize`, `CapacityInUse`,
 *     `FreeSpace` and `IOKitSize`. There is NO purgeable key and NO
 *     snapshot-held key.
 *   - `tmutil listlocalsnapshots /` — snapshot names. No sizes.
 *   - `tmutil listlocalsnapshotdates /` — dates. No sizes.
 *   - `diskutil apfs listSnapshots /System/Volumes/Data` — UUID, Name, XID and
 *     `Purgeable: Yes` per snapshot. No sizes.
 *
 * The one arithmetic that WOULD produce a byte figure is
 * `importantUsageCapacity - bavail`, i.e. subtracting the number this module
 * exists to explain from a number we would have to reach into AppKit to read.
 * That is a derived number wearing a measurement's clothes, and quoting it to a
 * user as "about 159 GB is held by snapshots" would be an invention: it also
 * absorbs caches, trash and every other purgeable class.
 *
 * So this returns a COUNT, which is genuinely read, and the message names the
 * count. A number that is honest and less specific beats a number that is
 * specific and made up — the entire failure being fixed here is a person losing
 * trust in a figure the app showed him.
 *
 * @module utils/localSnapshots
 */

import { execFile } from "child_process";
import logService from "../services/logService";

const SERVICE_NAME = "LocalSnapshots";

/**
 * Hard ceiling on the `tmutil` call.
 *
 * This runs on the refusal path, in front of a user who is being told their
 * import cannot start. A hung `tmutil` must not turn a refusal into a hang, and
 * the message is strictly better WITH the clause than without it — never
 * required for correctness. Two seconds is generous for a command that reads a
 * volume's snapshot list.
 */
const TMUTIL_TIMEOUT_MS = 2000;

/** Line shape `tmutil listlocalsnapshots` prints per snapshot. */
const SNAPSHOT_LINE = /^com\.apple\.TimeMachine\./;

/**
 * How many local Time Machine snapshots are holding space on the boot volume.
 *
 * @returns the count, or `null` when it cannot be read — not darwin, `tmutil`
 *   missing or slow, Full Disk Access refused, or output in a shape this does
 *   not recognise. **Callers MUST drop the snapshot clause entirely on `null`
 *   rather than substituting a guess.**
 *
 * Deliberately called only when a shortfall message is being BUILT, never on the
 * path of an import that fits: an import that is about to succeed must not pay
 * for a subprocess.
 */
export async function readLocalSnapshotCount(): Promise<number | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "/usr/bin/tmutil",
        ["listlocalsnapshots", "/"],
        { timeout: TMUTIL_TIMEOUT_MS, encoding: "utf8" },
        (error, out) => (error ? reject(error) : resolve(out))
      );
    });

    // The first line is a header ("Snapshots for volume group containing disk /:"),
    // so count the snapshot lines rather than the lines.
    const count = stdout
      .split("\n")
      .filter((line) => SNAPSHOT_LINE.test(line.trim())).length;

    // Zero is a real, meaningful answer — this Mac holds no local snapshots, so
    // the clause is correctly omitted by the caller. It is NOT the same as null.
    return count;
  } catch (error) {
    // Fail soft and stay quiet-ish. A missing snapshot clause costs the user a
    // sentence of explanation; a thrown error here would cost them the refusal
    // message that sentence was decorating.
    logService.warn(
      "Could not read local Time Machine snapshots; the disk-space message will omit the snapshot explanation",
      SERVICE_NAME,
      { error: error instanceof Error ? error.message : String(error) }
    );
    return null;
  }
}
