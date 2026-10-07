/**
 * BACKLOG-3476 — the shared attachment-open flow (SR condition 7).
 *
 * The flow moved out of TransactionAttachmentsTab so the checklist chip and
 * the link picker open attachments the same way. These pin the hook itself:
 * a metadata-only EMAIL row is downloaded before it is previewed, and the
 * caller's list is refreshed exactly once after that download.
 */
import { act, renderHook } from "@testing-library/react";
import { ATTACHMENT_DOWNLOAD_FAILED, useAttachmentPreview } from "../useAttachmentPreview";
import type { UnifiedAttachment } from "../useTransactionAllAttachments";

const row = (overrides: Partial<UnifiedAttachment>): UnifiedAttachment => ({
  id: "a1",
  filename: "scan.pdf",
  mime_type: "application/pdf",
  file_size_bytes: 100,
  storage_path: null,
  created_at: "2026-06-01T00:00:00.000Z",
  source: "email",
  source_date: "2026-06-01T00:00:00.000Z",
  direction: "inbound",
  context_subject: null,
  context_sender: null,
  email_id: "e1",
  message_id: null,
  ...overrides,
});

const tx = () => window.api.transactions as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  tx().ensureEmailAttachmentDownloaded = jest.fn();
});

describe("useAttachmentPreview (BACKLOG-3476)", () => {
  it("a downloaded row previews directly, with no download", async () => {
    const { result } = renderHook(() => useAttachmentPreview());
    await act(async () => {
      await result.current.open(row({ storage_path: "/data/scan.pdf" }));
    });
    expect(result.current.preview?.storage_path).toBe("/data/scan.pdf");
    expect(tx().ensureEmailAttachmentDownloaded).not.toHaveBeenCalled();
  });

  it("a metadata-only email row is downloaded first, then the refreshed row previews, and refresh runs once", async () => {
    tx().ensureEmailAttachmentDownloaded.mockResolvedValue({
      success: true,
      data: [{ ...row({}), storage_path: "/data/scan.pdf" }],
    });
    const refresh = jest.fn();
    const { result } = renderHook(() => useAttachmentPreview(refresh));
    await act(async () => {
      await result.current.open(row({}));
    });
    expect(tx().ensureEmailAttachmentDownloaded).toHaveBeenCalledWith("e1");
    expect(result.current.preview?.storage_path).toBe("/data/scan.pdf");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a blocked download previews nothing and says why", async () => {
    tx().ensureEmailAttachmentDownloaded.mockResolvedValue({ success: true, data: [], downloadBlocked: true });
    const { result } = renderHook(() => useAttachmentPreview());
    await act(async () => {
      await result.current.open(row({}));
    });
    expect(result.current.preview).toBeNull();
    expect(result.current.message).toBe(ATTACHMENT_DOWNLOAD_FAILED);
  });
});
