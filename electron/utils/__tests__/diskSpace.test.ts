/**
 * @jest-environment node
 *
 * BACKLOG-2743 — the import space guard reads APP-AVAILABLE space.
 *
 * CONTROL 3. The central hazard is not "no check" but "the wrong check": macOS
 * reports a purgeable-inclusive free-space figure (what Finder and System
 * Settings show) alongside the real one (what `df` shows). The first can be
 * several times larger. A guard reading it would PASS, start the copy, and macOS
 * would free the difference by DELETING local Time Machine snapshots. Destroying
 * the user's restore points to make room for an import is strictly worse than
 * refusing.
 *
 * These tests pin the source to `statfs().bavail` and go RED if it is ever
 * switched to `bfree` (which counts superuser-reserved blocks the app cannot
 * use) or to any larger figure. `bavail` was verified equal to `df -k` Avail to
 * the byte on macOS.
 */

import * as fs from "fs";
import {
  getAvailableDiskBytes,
  evaluateAttachmentSpace,
  ATTACHMENT_SPACE_HEADROOM_BYTES,
} from "../diskSpace";

jest.mock("../../services/logService", () => {
  const noop = jest.fn();
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

const GB = 1024 * 1024 * 1024;

/**
 * A statfs result where bavail and bfree DIFFER.
 *
 * This gap is the whole point of the fixture: if the two were equal, the test
 * could not tell a bavail implementation from a bfree one, and control 3 would
 * be green for a guard that reads the wrong number. Real filesystems reserve
 * blocks for the superuser, so bfree > bavail is the normal shape, not a
 * contrived one.
 */
function statfsFixture({
  bsize = 4096,
  availGb,
  freeGb,
}: {
  bsize?: number;
  availGb: number;
  freeGb: number;
}): fs.StatsFs {
  return {
    type: 26,
    bsize,
    blocks: (500 * GB) / bsize,
    bfree: (freeGb * GB) / bsize,
    bavail: (availGb * GB) / bsize,
    files: 1000,
    ffree: 900,
  } as fs.StatsFs;
}

describe("getAvailableDiskBytes — the space source (BACKLOG-2743 control 3)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns bavail x bsize — NOT bfree (this is the anti-purgeable assertion)", async () => {
    // 48 GB available to the app, 60 GB "free" including superuser reserve.
    jest
      .spyOn(fs.promises, "statfs")
      .mockResolvedValue(statfsFixture({ availGb: 48, freeGb: 60 }));

    const result = await getAvailableDiskBytes("/some/path");

    expect(result).toBe(48 * GB);
    // Explicitly pin the failure mode: reading bfree would yield 60 GB and this
    // assertion is what goes red.
    expect(result).not.toBe(60 * GB);
  });

  it("scales by the filesystem block size rather than assuming 4096", async () => {
    jest
      .spyOn(fs.promises, "statfs")
      .mockResolvedValue(statfsFixture({ bsize: 512, availGb: 8, freeGb: 9 }));

    expect(await getAvailableDiskBytes("/some/path")).toBe(8 * GB);
  });

  it("returns null (unknown) when statfs fails, so callers fail OPEN", async () => {
    // Blocking every import because the sensor is unavailable is worse than the
    // risk; copyFile's own ENOSPC remains the final backstop.
    jest
      .spyOn(fs.promises, "statfs")
      .mockRejectedValue(new Error("ENOTSUP: statfs not supported"));

    expect(await getAvailableDiskBytes("/some/path")).toBeNull();
  });

  it("matches the real filesystem it is pointed at", async () => {
    // No mock: proves the real call path works on this platform and returns a
    // plausible positive number, not just that the mock was wired correctly.
    const real = await getAvailableDiskBytes(__dirname);
    expect(real).not.toBeNull();
    expect(real!).toBeGreaterThan(0);
  });
});

describe("evaluateAttachmentSpace — the single verdict (BACKLOG-2743)", () => {
  it("refuses when the estimate exceeds available space", () => {
    // The reported shape: the attachment set is larger than the disk.
    const verdict = evaluateAttachmentSpace(80 * GB, 48 * GB);

    expect(verdict.fits).toBe(false);
    expect(verdict.shortfallBytes).toBe(80 * GB + ATTACHMENT_SPACE_HEADROOM_BYTES - 48 * GB);
  });

  it("refuses when the estimate fits only by eating the headroom", () => {
    // 47 GB of attachments into 48 GB free "fits" arithmetically, but leaves
    // 1 GB for a DB that also grows with the message text. Headroom is what
    // stops a technically-passing import from running the volume to zero.
    const verdict = evaluateAttachmentSpace(47 * GB, 48 * GB);

    expect(verdict.fits).toBe(false);
    expect(verdict.availableBytes).toBe(48 * GB);
  });

  it("allows a comfortable import (control 4 — no friction for a small library)", () => {
    const verdict = evaluateAttachmentSpace(2 * GB, 200 * GB);

    expect(verdict.fits).toBe(true);
    expect(verdict.shortfallBytes).toBe(0);
  });

  it("allows an import when free space is UNKNOWN (fails open)", () => {
    const verdict = evaluateAttachmentSpace(80 * GB, null);

    expect(verdict.fits).toBe(true);
    expect(verdict.availableBytes).toBeNull();
  });

  it("allows a zero-byte copy even when free space is below the headroom", () => {
    // 0.2 GB free is BELOW the 2 GB headroom, so this goes red if the zero case
    // is not special-cased — the headroom alone would refuse an operation that
    // writes nothing. (A larger figure here would pass either way and prove
    // nothing.)
    expect(0.2 * GB).toBeLessThan(ATTACHMENT_SPACE_HEADROOM_BYTES);

    const verdict = evaluateAttachmentSpace(0, 0.2 * GB);

    expect(verdict.fits).toBe(true);
    expect(verdict.shortfallBytes).toBe(0);
  });

  it("allows the 'without attachments' escape hatch on a nearly-full disk", () => {
    // The escape hatch must never be blocked by the guard it exists to escape.
    expect(evaluateAttachmentSpace(0, 1024).fits).toBe(true);
  });
});
