/**
 * @jest-environment node
 *
 * BACKLOG-2743 — the attachment size estimate.
 *
 * The estimate is only useful if it applies EXACTLY the gates the copy loop
 * applies. If the two drift, the number shown to the user stops describing the
 * import, and the pre-flight guard either refuses imports that would have fit or
 * waves through ones that overrun the disk.
 *
 * The cap boundary is swept rather than sampled: `storeAttachments` skips on
 * `total_bytes > MAX_ATTACHMENT_SIZE`, so a file of EXACTLY the cap is copied.
 * One sample either side of that line cannot catch an off-by-one; these tests
 * pin cap-1, cap, and cap+1.
 */

import {
  summarizeAttachmentEstimate,
  type AttachmentSizeRow,
} from "../macOSMessagesImportService/importHelpers";
import { MAX_ATTACHMENT_SIZE } from "../macOSMessagesImportService/types";

function row(
  overrides: Partial<AttachmentSizeRow> & { total_bytes: number },
): AttachmentSizeRow {
  return {
    filename: "/Users/someone/Library/Messages/Attachments/ab/cd/photo.jpg",
    transfer_name: "photo.jpg",
    ...overrides,
  };
}

describe("summarizeAttachmentEstimate (BACKLOG-2743)", () => {
  it("sums eligible attachments", () => {
    const result = summarizeAttachmentEstimate([
      row({ total_bytes: 1000 }),
      row({ total_bytes: 2500, transfer_name: "clip.mov" }),
      row({ total_bytes: 400, transfer_name: "contract.pdf" }),
    ]);

    expect(result.eligibleBytes).toBe(3900);
    expect(result.eligibleCount).toBe(3);
  });

  describe("the per-file cap boundary", () => {
    it("INCLUDES a file of exactly MAX_ATTACHMENT_SIZE (the copy loop copies it)", () => {
      const result = summarizeAttachmentEstimate([
        row({ total_bytes: MAX_ATTACHMENT_SIZE }),
      ]);

      expect(result.eligibleCount).toBe(1);
      expect(result.eligibleBytes).toBe(MAX_ATTACHMENT_SIZE);
      expect(result.skippedOversizeCount).toBe(0);
    });

    it("INCLUDES a file one byte under the cap", () => {
      const result = summarizeAttachmentEstimate([
        row({ total_bytes: MAX_ATTACHMENT_SIZE - 1 }),
      ]);

      expect(result.eligibleCount).toBe(1);
      expect(result.skippedOversizeCount).toBe(0);
    });

    it("EXCLUDES a file one byte over the cap", () => {
      const result = summarizeAttachmentEstimate([
        row({ total_bytes: MAX_ATTACHMENT_SIZE + 1 }),
      ]);

      expect(result.eligibleCount).toBe(0);
      expect(result.eligibleBytes).toBe(0);
      expect(result.skippedOversizeCount).toBe(1);
    });
  });

  it("excludes unsupported file types, which are never copied", () => {
    const result = summarizeAttachmentEstimate([
      row({ total_bytes: 5000, transfer_name: "pluginPayloadAttachment" }),
      row({ total_bytes: 7000, transfer_name: "data.bin" }),
      row({ total_bytes: 100, transfer_name: "photo.png" }),
    ]);

    expect(result.eligibleBytes).toBe(100);
    expect(result.skippedUnsupportedCount).toBe(2);
  });

  it("falls back to filename when transfer_name is absent, as the copy loop does", () => {
    // storeAttachments uses `transfer_name || filename`; an estimate that only
    // read transfer_name would drop these rows and under-count the import.
    const result = summarizeAttachmentEstimate([
      row({ total_bytes: 900, transfer_name: null, filename: "/tmp/img.heic" }),
    ]);

    expect(result.eligibleCount).toBe(1);
    expect(result.eligibleBytes).toBe(900);
  });

  it("skips rows with no usable name at all", () => {
    const result = summarizeAttachmentEstimate([
      { filename: null, transfer_name: null, total_bytes: 1234 },
    ]);

    expect(result.eligibleCount).toBe(0);
    expect(result.skippedUnsupportedCount).toBe(1);
  });

  it("treats a null/NaN byte count as zero rather than poisoning the total", () => {
    // A single NaN would make the whole estimate NaN, and NaN comparisons are
    // false — the guard would silently stop refusing anything.
    const result = summarizeAttachmentEstimate([
      row({ total_bytes: null as unknown as number }),
      row({ total_bytes: 500 }),
    ]);

    expect(Number.isFinite(result.eligibleBytes)).toBe(true);
    expect(result.eligibleBytes).toBe(500);
  });

  it("returns zero for an empty set", () => {
    const result = summarizeAttachmentEstimate([]);

    expect(result.eligibleBytes).toBe(0);
    expect(result.eligibleCount).toBe(0);
  });

  it("stays exact across a large set (no floating-point drift)", () => {
    // 70,000 attachments is the real order of magnitude; the total must be an
    // exact integer, because a drifting sum is a guard that refuses arbitrarily.
    const rows = Array.from({ length: 70_000 }, () => row({ total_bytes: 1_000_003 }));

    const result = summarizeAttachmentEstimate(rows);

    expect(result.eligibleBytes).toBe(70_000 * 1_000_003);
    expect(Number.isSafeInteger(result.eligibleBytes)).toBe(true);
  });
});
