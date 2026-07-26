/**
 * BACKLOG-322 Phase A — tests for the unified TransactionAttachmentsTab:
 * filter chips (source + mime-bucket type), sort orders, the not-downloaded
 * affordance, and the on-demand download-then-preview flow for email rows.
 *
 * AttachmentPreviewModal is stubbed (it pulls in react-pdf / mammoth).
 */
import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionAttachmentsTab } from "../TransactionAttachmentsTab";
import type { UnifiedAttachment } from "../../hooks/useTransactionAllAttachments";

jest.mock("../modals/AttachmentPreviewModal", () => ({
  AttachmentPreviewModal: ({
    attachment,
  }: {
    attachment: { filename: string };
  }) => <div data-testid="preview-modal">{attachment.filename}</div>,
}));

function att(overrides: Partial<UnifiedAttachment>): UnifiedAttachment {
  return {
    id: "x",
    filename: "file",
    mime_type: null,
    file_size_bytes: 100,
    storage_path: "/data/x",
    created_at: "2026-06-01T00:00:00.000Z",
    source: "email",
    source_date: "2026-06-01T00:00:00.000Z",
    direction: "inbound",
    context_subject: null,
    context_sender: null,
    email_id: null,
    message_id: null,
    ...overrides,
  };
}

// Six attachments, one per mime bucket, mixed source + downloaded state.
const ATTACHMENTS: UnifiedAttachment[] = [
  att({ id: "pdf1", filename: "contract.pdf", mime_type: "application/pdf", source: "email", email_id: "E1", storage_path: "/data/c.pdf", source_date: "2026-06-05T00:00:00.000Z", context_subject: "Purchase Agreement" }),
  att({ id: "img1", filename: "photo.jpg", mime_type: "image/jpeg", source: "email", email_id: "E1", storage_path: null, source_date: "2026-06-04T00:00:00.000Z", context_subject: "Photos" }),
  att({ id: "vid1", filename: "clip.mov", mime_type: "video/quicktime", source: "text", message_id: "M1", storage_path: "/data/clip.mov", source_date: "2026-06-03T00:00:00.000Z", context_sender: "+15551230000" }),
  att({ id: "aud1", filename: "voice.caf", mime_type: "audio/x-caf", source: "text", message_id: "M2", storage_path: "/data/voice.caf", source_date: "2026-06-02T00:00:00.000Z", context_sender: "+15559998888" }),
  att({ id: "doc1", filename: "disclosure.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", source: "email", email_id: "E2", storage_path: "/data/d.docx", source_date: "2026-06-01T00:00:00.000Z", context_subject: "Disclosure" }),
  att({ id: "oth1", filename: "archive.zip", mime_type: "application/zip", source: "text", message_id: "M3", storage_path: "/data/a.zip", source_date: "2026-05-31T00:00:00.000Z", context_sender: "+15551112222" }),
];

function cardIdsInOrder(): string[] {
  const grid = screen.getByTestId("attachments-grid");
  return within(grid)
    .getAllByTestId(/^attachment-card-/)
    .map((el) => el.getAttribute("data-testid")!.replace("attachment-card-", ""));
}

describe("TransactionAttachmentsTab (BACKLOG-322)", () => {
  const ensureEmailAttachmentDownloaded = jest.fn();
  const openAttachment = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (window as unknown as { api: unknown }).api = {
      transactions: { ensureEmailAttachmentDownloaded, openAttachment },
    };
  });

  it("renders one card per attachment with a total count", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);
    expect(cardIdsInOrder().sort()).toEqual(
      ["aud1", "doc1", "img1", "oth1", "pdf1", "vid1"],
    );
    expect(screen.getByTestId("attachments-count")).toHaveTextContent("6 of 6 attachments");
  });

  it("shows loading, error, and empty states", () => {
    const { rerender } = render(
      <TransactionAttachmentsTab attachments={[]} loading={true} error={null} />,
    );
    expect(screen.getByTestId("attachments-loading")).toBeInTheDocument();

    rerender(<TransactionAttachmentsTab attachments={[]} loading={false} error="Boom" />);
    expect(screen.getByTestId("attachments-error")).toHaveTextContent("Boom");

    rerender(<TransactionAttachmentsTab attachments={[]} loading={false} error={null} />);
    expect(screen.getByTestId("attachments-empty")).toBeInTheDocument();
  });

  it("filters by source", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);

    fireEvent.click(screen.getByTestId("filter-source-text"));
    expect(cardIdsInOrder().sort()).toEqual(["aud1", "oth1", "vid1"]);

    fireEvent.click(screen.getByTestId("filter-source-email"));
    expect(cardIdsInOrder().sort()).toEqual(["doc1", "img1", "pdf1"]);

    fireEvent.click(screen.getByTestId("filter-source-all"));
    expect(cardIdsInOrder()).toHaveLength(6);
  });

  it("derives type-filter chips from mime buckets and filters by them", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);

    // All six buckets are present in the fixture.
    for (const b of ["image", "pdf", "video", "audio", "doc", "other"]) {
      expect(screen.getByTestId(`filter-type-${b}`)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByTestId("filter-type-pdf"));
    expect(cardIdsInOrder()).toEqual(["pdf1"]);

    fireEvent.click(screen.getByTestId("filter-type-image"));
    expect(cardIdsInOrder()).toEqual(["img1"]);

    fireEvent.click(screen.getByTestId("filter-type-doc"));
    expect(cardIdsInOrder()).toEqual(["doc1"]);
  });

  it("only renders type chips for buckets that are present", () => {
    const onlyPdf = [ATTACHMENTS[0]];
    render(<TransactionAttachmentsTab attachments={onlyPdf} loading={false} error={null} />);
    expect(screen.getByTestId("filter-type-pdf")).toBeInTheDocument();
    expect(screen.queryByTestId("filter-type-image")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-type-video")).not.toBeInTheDocument();
  });

  it("sorts by date (default, newest first), name, and size", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);

    // Default: date desc by source_date.
    expect(cardIdsInOrder()).toEqual(["pdf1", "img1", "vid1", "aud1", "doc1", "oth1"]);

    fireEvent.change(screen.getByTestId("attachments-sort"), { target: { value: "name" } });
    // Alphabetical by filename: archive.zip, clip.mov, contract.pdf, disclosure.docx, photo.jpg, voice.caf
    expect(cardIdsInOrder()).toEqual(["oth1", "vid1", "pdf1", "doc1", "img1", "aud1"]);

    // Give sizes so the size sort is deterministic.
    const sized = ATTACHMENTS.map((a, i) => ({ ...a, file_size_bytes: (i + 1) * 10 }));
    render(<TransactionAttachmentsTab attachments={sized} loading={false} error={null} />);
    fireEvent.change(screen.getAllByTestId("attachments-sort")[1], { target: { value: "size" } });
    // largest first → oth1 (60) ... pdf1 (10)
    const grids = screen.getAllByTestId("attachments-grid");
    const ids = within(grids[1])
      .getAllByTestId(/^attachment-card-/)
      .map((el) => el.getAttribute("data-testid")!.replace("attachment-card-", ""));
    expect(ids).toEqual(["oth1", "doc1", "aud1", "vid1", "img1", "pdf1"]);
  });

  it("renders a not-downloaded affordance for metadata-only rows", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);
    // img1 has storage_path null.
    expect(screen.getByTestId("attachment-not-downloaded-img1")).toBeInTheDocument();
    // pdf1 is downloaded — no affordance.
    expect(screen.queryByTestId("attachment-not-downloaded-pdf1")).not.toBeInTheDocument();
  });

  it("shows a filtered-empty state when no attachment matches", () => {
    // Only email attachments → filter to Texts → none match.
    const emailsOnly = ATTACHMENTS.filter((a) => a.source === "email");
    render(<TransactionAttachmentsTab attachments={emailsOnly} loading={false} error={null} />);
    fireEvent.click(screen.getByTestId("filter-source-text"));
    expect(screen.getByTestId("attachments-filtered-empty")).toBeInTheDocument();
  });

  it("opens a downloaded attachment directly without an on-demand download", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);
    fireEvent.click(screen.getByTestId("attachment-card-pdf1"));
    expect(screen.getByTestId("preview-modal")).toHaveTextContent("contract.pdf");
    expect(ensureEmailAttachmentDownloaded).not.toHaveBeenCalled();
  });

  it("forces an on-demand download for a metadata-only EMAIL row, then previews it", async () => {
    ensureEmailAttachmentDownloaded.mockResolvedValue({
      success: true,
      data: [
        {
          id: "img1",
          filename: "photo.jpg",
          mime_type: "image/jpeg",
          file_size_bytes: 1024,
          storage_path: "/data/photo.jpg",
        },
      ],
    });
    const refresh = jest.fn();
    render(
      <TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} refresh={refresh} />,
    );

    fireEvent.click(screen.getByTestId("attachment-card-img1"));

    expect(ensureEmailAttachmentDownloaded).toHaveBeenCalledWith("E1");
    expect(await screen.findByTestId("preview-modal")).toHaveTextContent("photo.jpg");
    expect(refresh).toHaveBeenCalled();
  });

  it("surfaces a message when an on-demand download is blocked", async () => {
    ensureEmailAttachmentDownloaded.mockResolvedValue({
      success: true,
      data: [],
      downloadBlocked: true,
      reason: "Not on your plan.",
    });
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);

    fireEvent.click(screen.getByTestId("attachment-card-img1"));

    await waitFor(() =>
      expect(screen.getByTestId("attachments-download-message")).toHaveTextContent("Not on your plan."),
    );
    expect(screen.queryByTestId("preview-modal")).not.toBeInTheDocument();
  });
});
