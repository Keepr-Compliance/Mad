/**
 * @jest-environment node
 */

/**
 * BACKLOG-2882 — an attachment-space refusal states numbers that can produce
 * its own verdict.
 *
 * The founder saw "This import needs up to 39 MB for attachments but only
 * 1.3 GB is available. It will not start." The guard compared estimate PLUS
 * the 2 GiB headroom against free space; the sentence showed the estimate
 * alone, so a user doing the subtraction concluded the app was broken.
 *
 * The REAL verdict function feeds the REAL sentence builder here: no expected
 * figure is computed by the test and echoed back.
 */

import {
  evaluateAttachmentSpace,
  ATTACHMENT_SPACE_HEADROOM_BYTES,
} from "../../../../electron/utils/diskSpace";
import { describeAttachmentSpaceRefusal } from "../ImportPlanDialog";

jest.mock("../../../../electron/services/logService", () => {
  const noop = jest.fn();
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

const MB = 1e6;
const GB = 1e9;

/** The sentence for a verdict, exactly as both surfaces build it. */
function sentence(estimated: number, available: number): { fits: boolean; text: string } {
  const v = evaluateAttachmentSpace(estimated, available);
  return {
    fits: v.fits,
    text: describeAttachmentSpaceRefusal({
      attachmentBytes: v.estimatedBytes,
      headroomBytes: v.headroomBytes,
      requiredBytes: v.requiredBytes,
      availableBytes: v.availableBytes as number,
    }),
  };
}

/** Parse "needs up to X of free space" and "but only Y is available" back to bytes. */
function shown(text: string): { required: number; available: number } {
  const toBytes = (n: string, unit: string) => parseFloat(n) * (unit === "GB" ? GB : MB);
  const r = /needs up to ([\d.]+) (GB|MB) of free space/.exec(text);
  const a = /but only ([\d.]+) (GB|MB) is available/.exec(text);
  if (!r || !a) throw new Error(`unparseable refusal: ${text}`);
  return { required: toBytes(r[1], r[2]), available: toBytes(a[1], a[2]) };
}

describe("BACKLOG-2882 — the founder's case", () => {
  const ESTIMATE = 39 * MB;
  const AVAILABLE = 1.3 * GB;

  it("refuses, and the sentence states all three quantities", () => {
    const { fits, text } = sentence(ESTIMATE, AVAILABLE);
    expect(fits).toBe(false);
    expect(ATTACHMENT_SPACE_HEADROOM_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(text).toContain("39 MB for attachments"); // the estimate
    expect(text).toContain("2.1 GB kept free"); // the headroom (2 GiB)
    expect(text).toContain("only 1.3 GB is available"); // free space
    expect(text).toContain("needs up to 2.2 GB of free space"); // estimate + headroom
    expect(text).toMatch(/It will not start\.$/);
  });

  it("is NOT the two-number sentence the founder disproved", () => {
    expect(sentence(ESTIMATE, AVAILABLE).text).not.toMatch(
      /needs up to 39 MB for attachments but only/
    );
  });

  it("shows required = estimate + headroom (rounded up), available rounded down, and below it", () => {
    const v = evaluateAttachmentSpace(ESTIMATE, AVAILABLE);
    expect(v.requiredBytes).toBe(ESTIMATE + v.headroomBytes);
    const s = shown(sentence(ESTIMATE, AVAILABLE).text);
    // Within one display step (0.1 GB) of the true figures, on the safe side.
    expect(s.required).toBeGreaterThanOrEqual(ESTIMATE + v.headroomBytes - 1);
    expect(s.required - (ESTIMATE + v.headroomBytes)).toBeLessThan(0.1 * GB);
    expect(s.available).toBeLessThanOrEqual(AVAILABLE + 1);
    expect(s.available).toBeLessThan(s.required);
  });
});

describe("BACKLOG-2882 — the boundary", () => {
  const ESTIMATE = 500 * MB;
  const REQUIRED = ESTIMATE + ATTACHMENT_SPACE_HEADROOM_BYTES;

  it("fits at exactly the required figure", () => {
    expect(evaluateAttachmentSpace(ESTIMATE, REQUIRED).fits).toBe(true);
  });

  it("refuses one byte under it, and still shows a shortfall", () => {
    const { fits, text } = sentence(ESTIMATE, REQUIRED - 1);
    expect(fits).toBe(false);
    const s = shown(text);
    expect(s.available).toBeLessThan(s.required);
  });

  it("every refusal across the band shows a required figure above the available one", () => {
    // Swept, not sampled: 1 MB steps across the 400 MB below the boundary,
    // which passes through every one-decimal rounding collision. Nearest
    // rounding failed this at 2,645,483,648 ("2.65 GB" vs "2.65 GB").
    let refusals = 0;
    for (let avail = REQUIRED - 400 * MB; avail < REQUIRED; avail += 1 * MB) {
      const { fits, text } = sentence(ESTIMATE, avail);
      expect(fits).toBe(false);
      const s = shown(text);
      if (!(s.available < s.required)) throw new Error(`disprovable at ${avail}: ${text}`);
      refusals++;
    }
    expect(refusals).toBe(400);
  });
});

describe("BACKLOG-2882 — the headroom alone never refuses", () => {
  it("a zero-byte copy fits even on a disk below the headroom (re-sync)", () => {
    expect(evaluateAttachmentSpace(0, 100 * MB).fits).toBe(true);
    expect(evaluateAttachmentSpace(-1, 100 * MB).fits).toBe(true);
  });
});
