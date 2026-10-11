/**
 * BACKLOG-3884 (2.40) — clicking an attachment in the thread view's attachment
 * list downloads it first when it is metadata-only, exactly like the
 * Attachments tab. The list stays open while it downloads ("Downloading…", or
 * the error with Retry) and closes once the preview opens.
 *
 * Fixtures transcribed from the producers (see the EmailViewModal sibling):
 * getAttachmentsForEmail row shape; ensure reply { success: true, data: rows }.
 * Names synthesized.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EmailThreadViewModal } from "../EmailThreadViewModal";
import type { EmailThread } from "../../EmailThreadCard";
import type { Communication } from "../../../types";

const EMAIL_ID = "email-3884t";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const META_ROW = { id: "att-1", filename: "Offer terms.docx", mime_type: DOCX, file_size_bytes: 16691, storage_path: null as string | null };
const STORED_PATH = "/userData/attachments/abc.docx";

function makeThread(): EmailThread {
  const email = {
    id: EMAIL_ID,
    subject: "Offer",
    sender: "agent@example.test",
    recipients: "me@example.test",
    body_text: "See attached.",
    sent_at: "2026-06-01T00:00:00.000Z",
    communication_type: "email",
    has_attachments: true,
  } as unknown as Communication;
  return {
    id: "thr-3884",
    subject: "Offer",
    participants: ["agent@example.test", "me@example.test"],
    emailCount: 1,
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    endDate: new Date("2026-06-01T00:00:00.000Z"),
    emails: [email],
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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
  (window as unknown as { api: unknown }).api = { transactions: api };
});

async function openList() {
  render(
    <EmailThreadViewModal thread={makeThread()} onClose={() => undefined} userEmail="me@example.test" />,
  );
  fireEvent.click(await screen.findByTestId(`attachment-pill-${EMAIL_ID}`));
  const list = await screen.findByTestId("thread-attachment-list-backdrop");
  return { list, row: await within(list).findByTestId("thread-attachment-att-1") };
}

describe("BACKLOG-3884 — EmailThreadViewModal attachment click downloads first", () => {
  it("C2: a not-downloaded attachment downloads (Downloading…) and then opens; the list closes", async () => {
    const d = deferred<unknown>();
    api.ensureEmailAttachmentDownloaded.mockReturnValue(d.promise);
    const { list, row } = await openList();

    fireEvent.click(row);

    expect(api.ensureEmailAttachmentDownloaded).toHaveBeenCalledWith(EMAIL_ID);
    expect(await within(list).findByText("Downloading…")).toBeInTheDocument();
    expect(screen.queryByTestId("attachment-preview-backdrop")).not.toBeInTheDocument();

    await act(async () => {
      d.resolve({ success: true, data: [{ ...META_ROW, storage_path: STORED_PATH }] });
    });

    expect(await screen.findByTestId("attachment-preview-backdrop")).toBeInTheDocument();
    await waitFor(() => expect(api.getAttachmentBuffer).toHaveBeenCalledWith(STORED_PATH));
    expect(screen.queryByTestId("thread-attachment-list-backdrop")).not.toBeInTheDocument();
  });

  it("C3: a failed download shows the error with Retry in the list, and Retry downloads and opens", async () => {
    api.ensureEmailAttachmentDownloaded
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ success: true, data: [{ ...META_ROW, storage_path: STORED_PATH }] });
    const { list, row } = await openList();

    fireEvent.click(row);

    const alert = await within(list).findByTestId("attachment-open-error");
    expect(alert).toHaveTextContent("This attachment could not be downloaded.");
    expect(screen.queryByTestId("attachment-preview-backdrop")).not.toBeInTheDocument();

    fireEvent.click(within(list).getByTestId("attachment-open-retry"));

    expect(await screen.findByTestId("attachment-preview-backdrop")).toBeInTheDocument();
    expect(api.ensureEmailAttachmentDownloaded).toHaveBeenCalledTimes(2);
  });

  it("C4: an already-downloaded attachment opens with no download", async () => {
    api.getEmailAttachments.mockResolvedValue({ success: true, data: [{ ...META_ROW, storage_path: STORED_PATH }] });
    const { row } = await openList();

    fireEvent.click(row);

    expect(await screen.findByTestId("attachment-preview-backdrop")).toBeInTheDocument();
    expect(api.ensureEmailAttachmentDownloaded).not.toHaveBeenCalled();
  });
});
