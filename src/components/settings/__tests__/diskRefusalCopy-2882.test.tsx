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

/** Parse "only Y is available" back to bytes. */
function shownAvailable(text: string): number {
  const a = /Only ([\d.]+) (GB|MB) is available/.exec(text);
  if (!a) throw new Error(`unparseable refusal: ${text}`);
  return parseFloat(a[1]) * (a[2] === "GB" ? GB : MB);
}

describe("BACKLOG-2882 — the founder's case", () => {
  const ESTIMATE = 39 * MB;
  const AVAILABLE = 1.3 * GB;

  it("refuses, and the sentence is exactly the two short sentences with no separate total", () => {
    const { fits, text } = sentence(ESTIMATE, AVAILABLE);
    expect(fits).toBe(false);
    expect(ATTACHMENT_SPACE_HEADROOM_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(text).toBe(
      "Keepr needs 39 MB for the attachments plus 2.1 GB kept free so your Mac keeps working. Only 1.3 GB is available, so the import will not start."
    );
  });

  it("is NOT the two-number sentence the founder disproved, nor the draft with a total", () => {
    const { text } = sentence(ESTIMATE, AVAILABLE);
    expect(text).not.toMatch(/needs up to/);
    expect(text).not.toMatch(/2\.2 GB/);
    expect(text).not.toMatch(/It will not start/);
  });

  it("states available rounded down, and below the true requirement", () => {
    const v = evaluateAttachmentSpace(ESTIMATE, AVAILABLE);
    expect(v.requiredBytes).toBe(ESTIMATE + v.headroomBytes);
    const shown = shownAvailable(sentence(ESTIMATE, AVAILABLE).text);
    expect(shown).toBeLessThanOrEqual(AVAILABLE + 1);
    expect(shown).toBeLessThan(v.requiredBytes);
  });
});

describe("BACKLOG-2882 — the boundary", () => {
  const ESTIMATE = 500 * MB;
  const REQUIRED = ESTIMATE + ATTACHMENT_SPACE_HEADROOM_BYTES;

  it("fits at exactly the required figure", () => {
    expect(evaluateAttachmentSpace(ESTIMATE, REQUIRED).fits).toBe(true);
  });

  it("refuses one byte under it, and states the exact boundary sentence", () => {
    const { fits, text } = sentence(ESTIMATE, REQUIRED - 1);
    expect(fits).toBe(false);
    // REQUIRED - 1 = 2,647,483,647 bytes: floors to 2.6 GB.
    expect(text).toBe(
      "Keepr needs 0.5 GB for the attachments plus 2.1 GB kept free so your Mac keeps working. Only 2.6 GB is available, so the import will not start."
    );
  });

  it("every refusal across the band states an available figure at or below the true one", () => {
    // Swept, not sampled: 1 MB steps across the 400 MB below the boundary.
    let refusals = 0;
    for (let avail = REQUIRED - 400 * MB; avail < REQUIRED; avail += 1 * MB) {
      const { fits, text } = sentence(ESTIMATE, avail);
      expect(fits).toBe(false);
      const shown = shownAvailable(text);
      if (shown > avail + 1) throw new Error(`overstates available at ${avail}: ${text}`);
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
