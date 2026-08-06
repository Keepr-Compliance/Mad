/**
 * BACKLOG-322 Phase A — tests for the unified TransactionAttachmentsTab:
 * grouped-dropdown filters (Source + mime-bucket Type), sort orders, the
 * conversations-style count heading, the not-downloaded affordance, and the
 * on-demand download-then-preview flow for email rows.
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
  att({ id: "pdf1", filename: "contract.pdf", mime_type: "application/pdf", source: "email", email_id: "E1", storage_path: "/data/c.pdf", file_size_bytes: 500, source_date: "2026-06-05T00:00:00.000Z", context_subject: "Purchase Agreement" }),
  att({ id: "img1", filename: "photo.jpg", mime_type: "image/jpeg", source: "email", email_id: "E1", storage_path: null, file_size_bytes: 400, source_date: "2026-06-04T00:00:00.000Z", context_subject: "Photos" }),
  att({ id: "vid1", filename: "clip.mov", mime_type: "video/quicktime", source: "text", message_id: "M1", storage_path: "/data/clip.mov", file_size_bytes: 300, source_date: "2026-06-03T00:00:00.000Z", context_sender: "+15551230000" }),
  att({ id: "aud1", filename: "voice.caf", mime_type: "audio/x-caf", source: "text", message_id: "M2", storage_path: "/data/voice.caf", file_size_bytes: 200, source_date: "2026-06-02T00:00:00.000Z", context_sender: "+15555550120" }),
  att({ id: "doc1", filename: "disclosure.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", source: "email", email_id: "E2", storage_path: "/data/d.docx", file_size_bytes: 100, source_date: "2026-06-01T00:00:00.000Z", context_subject: "Disclosure" }),
  att({ id: "oth1", filename: "archive.zip", mime_type: "application/zip", source: "text", message_id: "M3", storage_path: "/data/a.zip", file_size_bytes: 600, source_date: "2026-05-31T00:00:00.000Z", context_sender: "+15555550104" }),
];

function cardIdsInOrder(): string[] {
  const grid = screen.getByTestId("attachments-grid");
  return within(grid)
    .getAllByTestId(/^attachment-card-/)
    .map((el) => el.getAttribute("data-testid")!.replace("attachment-card-", ""));
}

/** Open a grouped-dropdown filter by clicking its trigger. */
function openFilter(testId: string): void {
  fireEvent.click(screen.getByTestId(`${testId}-trigger`));
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

  it("renders one card per attachment", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);
    expect(cardIdsInOrder().sort()).toEqual(
      ["aud1", "doc1", "img1", "oth1", "pdf1", "vid1"],
    );
  });

  it("shows a conversations-style count heading with a source breakdown", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);
    const heading = screen.getByTestId("attachments-count");
    expect(heading.tagName).toBe("H3");
    expect(heading).toHaveTextContent("6 attachments");
    // 3 emails (pdf/img/doc) + 3 texts (vid/aud/oth)
    expect(screen.getByTestId("attachments-breakdown")).toHaveTextContent(
      "3 from emails, 3 from texts",
    );
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

  it("filters by source via the Source dropdown", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);
    // Default trigger summary is "All".
    expect(screen.getByTestId("source-filter-summary")).toHaveTextContent("All");

    openFilter("source-filter");
    fireEvent.click(screen.getByTestId("source-filter-checkbox-text"));
    expect(cardIdsInOrder().sort()).toEqual(["aud1", "oth1", "vid1"]);
    expect(screen.getByTestId("source-filter-summary")).toHaveTextContent("1 selected");

    // Also selecting Emails → all sources selected → "All" again.
    fireEvent.click(screen.getByTestId("source-filter-checkbox-email"));
    expect(cardIdsInOrder()).toHaveLength(6);
    expect(screen.getByTestId("source-filter-summary")).toHaveTextContent("All");
  });

  it("renders a Type dropdown option per present mime bucket and filters by it", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);
    openFilter("type-filter");
    for (const b of ["image", "pdf", "video", "audio", "doc", "other"]) {
      expect(screen.getByTestId(`type-filter-checkbox-${b}`)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByTestId("type-filter-checkbox-pdf"));
    expect(cardIdsInOrder()).toEqual(["pdf1"]);
  });

  it("only offers Type options for buckets that are present", () => {
    const onlyPdf = [ATTACHMENTS[0]];
    render(<TransactionAttachmentsTab attachments={onlyPdf} loading={false} error={null} />);
    openFilter("type-filter");
    expect(screen.getByTestId("type-filter-checkbox-pdf")).toBeInTheDocument();
    expect(screen.queryByTestId("type-filter-checkbox-image")).not.toBeInTheDocument();
    expect(screen.queryByTestId("type-filter-checkbox-video")).not.toBeInTheDocument();
  });

  it("sorts by date (default), name, size, source, and type", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);
    const sort = screen.getByTestId("attachments-sort");

    // Default: date desc by source_date.
    expect(cardIdsInOrder()).toEqual(["pdf1", "img1", "vid1", "aud1", "doc1", "oth1"]);

    // Name: archive, clip, contract, disclosure, photo, voice
    fireEvent.change(sort, { target: { value: "name" } });
    expect(cardIdsInOrder()).toEqual(["oth1", "vid1", "pdf1", "doc1", "img1", "aud1"]);

    // Size desc: oth(600), pdf(500), img(400), vid(300), aud(200), doc(100)
    fireEvent.change(sort, { target: { value: "size" } });
    expect(cardIdsInOrder()).toEqual(["oth1", "pdf1", "img1", "vid1", "aud1", "doc1"]);

    // Source: emails first (date desc), then texts (date desc)
    fireEvent.change(sort, { target: { value: "source" } });
    expect(cardIdsInOrder()).toEqual(["pdf1", "img1", "doc1", "vid1", "aud1", "oth1"]);

    // Type: audio, doc, image, other, pdf, video
    fireEvent.change(sort, { target: { value: "type" } });
    expect(cardIdsInOrder()).toEqual(["aud1", "doc1", "img1", "oth1", "pdf1", "vid1"]);
  });

  it("renders a not-downloaded affordance for metadata-only rows", () => {
    render(<TransactionAttachmentsTab attachments={ATTACHMENTS} loading={false} error={null} />);
    // img1 has storage_path null.
    expect(screen.getByTestId("attachment-not-downloaded-img1")).toBeInTheDocument();
    // pdf1 is downloaded — no affordance.
    expect(screen.queryByTestId("attachment-not-downloaded-pdf1")).not.toBeInTheDocument();
  });

  it("shows a filtered-empty state when no attachment matches", () => {
    const emailsOnly = ATTACHMENTS.filter((a) => a.source === "email");
    render(<TransactionAttachmentsTab attachments={emailsOnly} loading={false} error={null} />);
    openFilter("source-filter");
    fireEvent.click(screen.getByTestId("source-filter-checkbox-text"));
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
