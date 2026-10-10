/**
 * BACKLOG-3884 (2.40) — clicking an attachment in the single-email view
 * downloads it first when it is metadata-only, exactly like the Attachments tab.
 *
 * Before: the list came from `emails:get-attachments`, which downloads only for
 * an email with ZERO rows. Sync stores metadata-only rows (BACKLOG-1870), so the
 * row arrived with storage_path NULL and the click opened an empty preview.
 *
 * Fixtures are transcribed from the producers:
 *   - list row: EmailAttachmentService.getAttachmentsForEmail's return shape
 *     ({ id, filename, mime_type, file_size_bytes, storage_path }).
 *   - ensure reply: attachmentHandlers.ts "emails:ensure-attachment-downloaded"
 *     returns { success: true, data: <re-read rows> }.
 * Names synthesized.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EmailViewModal } from "../EmailViewModal";
import type { Communication } from "../../../types";

const EMAIL_ID = "email-3884";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const META_ROW = { id: "att-1", filename: "Offer terms.docx", mime_type: DOCX, file_size_bytes: 16691, storage_path: null as string | null };
const STORED_PATH = "/userData/attachments/abc.docx";

function makeEmail(): Communication {
  return {
    id: EMAIL_ID,
    user_id: "user-1",
    channel: "email",
    direction: "inbound",
    subject: "Offer",
    sender: "agent@example.test",
    recipients: "me@example.test",
    body_text: "See attached.",
    sent_at: "2026-06-01T00:00:00Z",
    has_attachments: true,
    is_false_positive: false,
    created_at: "2026-06-01T00:00:00Z",
  } as unknown as Communication;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let api: Record<string, jest.Mock>;

beforeEach(() => {
  api = {
    getEmailAttachments: jest.fn().mockResolvedValue({ success: true, data: [META_ROW] }),
    ensureEmailAttachmentDownloaded: jest.fn(),
    getAttachmentBuffer: jest.fn().mockResolvedValue({ success: false, error: "not in test" }),
    getAttachmentData: jest.fn().mockResolvedValue({ success: false }),
    openAttachment: jest.fn().mockResolvedValue({ success: true }),
  };
  Object.assign(window.api.transactions as unknown as Record<string, jest.Mock>, api);
});

async function renderAndExpand() {
  render(<EmailViewModal email={makeEmail()} onClose={() => undefined} />);
  await screen.findByText("1 attachment");
  fireEvent.click(screen.getByRole("button", { name: /1 attachment/ }));
  return screen.findByTestId("attachment-att-1");
}

describe("BACKLOG-3884 — EmailViewModal attachment click downloads first", () => {
  it("C1: a not-downloaded attachment downloads (Downloading…) and then opens", async () => {
    const d = deferred<unknown>();
    api.ensureEmailAttachmentDownloaded.mockReturnValue(d.promise);
    const button = await renderAndExpand();

    fireEvent.click(button);

    expect(api.ensureEmailAttachmentDownloaded).toHaveBeenCalledWith(EMAIL_ID);
    expect(await screen.findByText("Downloading…")).toBeInTheDocument();
    expect(screen.queryByTestId("attachment-preview-backdrop")).not.toBeInTheDocument();

    await act(async () => {
      d.resolve({ success: true, data: [{ ...META_ROW, storage_path: STORED_PATH }] });
    });

    expect(await screen.findByTestId("attachment-preview-backdrop")).toBeInTheDocument();
    // The preview reads the DOWNLOADED file, not a null path.
    await waitFor(() => expect(api.getAttachmentBuffer).toHaveBeenCalledWith(STORED_PATH));
    expect(screen.queryByText("Downloading…")).not.toBeInTheDocument();
  });

  it("C3a: a rejected download shows the error with Retry, and Retry downloads and opens", async () => {
    api.ensureEmailAttachmentDownloaded
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ success: true, data: [{ ...META_ROW, storage_path: STORED_PATH }] });
    fireEvent.click(await renderAndExpand());

    const alert = await screen.findByTestId("attachment-open-error");
    expect(alert).toHaveTextContent("This attachment could not be downloaded.");
    expect(screen.queryByTestId("attachment-preview-backdrop")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("attachment-open-retry"));

    expect(await screen.findByTestId("attachment-preview-backdrop")).toBeInTheDocument();
    expect(api.ensureEmailAttachmentDownloaded).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("attachment-open-error")).not.toBeInTheDocument();
  });

  it("C3b: a download that returns the row still without a path shows the error with Retry", async () => {
    api.ensureEmailAttachmentDownloaded.mockResolvedValue({ success: true, data: [META_ROW] });
    fireEvent.click(await renderAndExpand());

    expect(await screen.findByTestId("attachment-open-error")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-open-retry")).toBeInTheDocument();
    expect(screen.queryByTestId("attachment-preview-backdrop")).not.toBeInTheDocument();
  });

  it("C4: an already-downloaded attachment opens with no download", async () => {
    api.getEmailAttachments.mockResolvedValue({ success: true, data: [{ ...META_ROW, storage_path: STORED_PATH }] });
    fireEvent.click(await renderAndExpand());

    expect(await screen.findByTestId("attachment-preview-backdrop")).toBeInTheDocument();
    expect(api.ensureEmailAttachmentDownloaded).not.toHaveBeenCalled();
  });
});
