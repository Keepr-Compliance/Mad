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
import { describeAttachmentsSkippedForSpace } from "../../../utils/diskSpaceCopy";

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

/** A printed "1.3 GB" / "39 MB" figure back to bytes, as a reader would take it. */
function figureBytes(n: string, unit: string): number {
  return parseFloat(n) * (unit === "GB" ? GB : MB);
}

/** Parse "only Y is available" back to bytes. */
function shownAvailable(text: string): number {
  const a = /Only ([\d.]+) (GB|MB) is available/.exec(text);
  if (!a) throw new Error(`unparseable refusal: ${text}`);
  return figureBytes(a[1], a[2]);
}

/** Parse the two printed parts (attachments, headroom) back to bytes. */
function shownParts(text: string): { attachments: number; headroom: number } {
  const m = /needs ([\d.]+) (GB|MB) for the attachments plus ([\d.]+) (GB|MB) kept free/.exec(text);
  if (!m) throw new Error(`unparseable refusal: ${text}`);
  return { attachments: figureBytes(m[1], m[2]), headroom: figureBytes(m[3], m[4]) };
}

describe("BACKLOG-2882 — the founder's case", () => {
  const ESTIMATE = 39 * MB;
  const AVAILABLE = 1.3 * GB;

  it("refuses, and the sentence is exactly the two short sentences with no separate total", () => {
    const { fits, text } = sentence(ESTIMATE, AVAILABLE);
    expect(fits).toBe(false);
    expect(ATTACHMENT_SPACE_HEADROOM_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(text).toBe(
      "Keepr needs 39 MB for the attachments plus 2.2 GB kept free so your Mac keeps working. Only 1.3 GB is available, so the import will not start."
    );
  });

  it("is NOT the two-number sentence the founder disproved, nor the draft with a total", () => {
    const { text } = sentence(ESTIMATE, AVAILABLE);
    expect(text).not.toMatch(/needs up to/);
    expect(text).not.toMatch(/\btotal\b/i);
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
    // REQUIRED - 1 = 2,647,483,647 bytes: available floors to 2.6 GB; the
    // parts round up (500 MB -> 0.5 GB, 2 GiB = 2.147 GB -> 2.2 GB), so they
    // print as 2.7 against 2.6.
    expect(text).toBe(
      "Keepr needs 0.5 GB for the attachments plus 2.2 GB kept free so your Mac keeps working. Only 2.6 GB is available, so the import will not start."
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

describe("BACKLOG-2882 — the printed figures add up", () => {
  it("on every refusal the printed parts, added as a reader would, exceed the printed available space", () => {
    // Attachments 1..5000 MB (1 MB steps) x available from 0.3 GB below the
    // requirement up to the refusal boundary (0.001 GB steps). The first
    // inversion under nearest rounding is at 54 MB, so the sweep must reach
    // well past it. Parts and available are parsed back out of the rendered
    // sentence: the test adds what the user sees.
    let refusals = 0;
    let incoherent = 0;
    const samples: string[] = [];
    for (let att = 1; att <= 5000; att++) {
      const attachmentBytes = att * MB;
      const required = attachmentBytes + ATTACHMENT_SPACE_HEADROOM_BYTES;
      for (let avail = required - 0.3 * GB; avail < required; avail += 0.001 * GB) {
        const { fits, text } = sentence(attachmentBytes, Math.floor(avail));
        if (fits) continue;
        refusals++;
        const parts = shownParts(text);
        if (!(parts.attachments + parts.headroom > shownAvailable(text) + 1e-6)) {
          incoherent++;
          if (samples.length < 3) samples.push(`${att} MB @ ${Math.floor(avail)}: ${text}`);
        }
      }
    }
    expect(refusals).toBeGreaterThan(1_000_000);
    expect({ incoherent, samples }).toEqual({ incoherent: 0, samples: [] });
  });
});

describe("BACKLOG-2882 — the post-import warning prints no total that can disagree", () => {
  it("states exactly three figures and the parts, added as a reader would, exceed the free space", () => {
    // Attachments 1..5000 MB, free space 1 MB below the requirement: the
    // hardest refusal for every size. A printed total here disagreed with its
    // parts in 2,647 of 5,000 cases.
    let bad = 0;
    const samples: string[] = [];
    for (let att = 1; att <= 5000; att++) {
      const attachmentBytes = att * MB;
      const v = evaluateAttachmentSpace(attachmentBytes, attachmentBytes + ATTACHMENT_SPACE_HEADROOM_BYTES - MB);
      const text = describeAttachmentsSkippedForSpace({
        attachmentBytes: v.estimatedBytes,
        headroomBytes: v.headroomBytes,
        requiredBytes: v.requiredBytes,
        availableBytes: v.availableBytes as number,
      });
      const figures = [...text.matchAll(/([\d.]+) (GB|MB)/g)].map((m) => figureBytes(m[1], m[2]));
      const ok =
        v.fits === false && figures.length === 3 && figures[0] + figures[1] > figures[2] + 1e-6;
      if (!ok) {
        bad++;
        if (samples.length < 3) samples.push(`${att} MB: ${text}`);
      }
    }
    expect({ bad, samples }).toEqual({ bad: 0, samples: [] });
  });
});

describe("BACKLOG-2882 — the headroom alone never refuses", () => {
  it("a zero-byte copy fits even on a disk below the headroom (re-sync)", () => {
    expect(evaluateAttachmentSpace(0, 100 * MB).fits).toBe(true);
    expect(evaluateAttachmentSpace(-1, 100 * MB).fits).toBe(true);
  });
});
