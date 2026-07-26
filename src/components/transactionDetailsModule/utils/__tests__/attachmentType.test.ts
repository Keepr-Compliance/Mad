/**
 * BACKLOG-322 Phase A — exact bucket mapping for the Attachments tab type filter.
 */
import { getAttachmentTypeBucket } from "../attachmentType";

describe("getAttachmentTypeBucket", () => {
  it.each([
    ["image/jpeg", "image"],
    ["image/png", "image"],
    ["image/heic", "image"],
    ["application/pdf", "pdf"],
    ["video/quicktime", "video"],
    ["video/mp4", "video"],
    ["audio/x-caf", "audio"],
    ["audio/mpeg", "audio"],
    ["application/msword", "doc"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "doc"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "doc"],
    ["application/vnd.ms-excel", "doc"],
    ["text/plain", "doc"],
    ["text/csv", "doc"],
    ["application/zip", "other"],
    ["application/octet-stream", "other"],
  ])("maps %s → %s", (mime, expected) => {
    expect(getAttachmentTypeBucket(mime)).toBe(expected);
  });

  it("treats null/undefined/empty as 'other'", () => {
    expect(getAttachmentTypeBucket(null)).toBe("other");
    expect(getAttachmentTypeBucket(undefined)).toBe("other");
    expect(getAttachmentTypeBucket("")).toBe("other");
  });
});
