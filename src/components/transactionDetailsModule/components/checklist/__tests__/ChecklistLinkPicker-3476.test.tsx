/**
 * BACKLOG-3476 — the link picker (mock state 3).
 *
 * Wrong implementations this suite is here to catch:
 *   C-L  offering what main refuses — the legacy fallback attachment, texts as
 *        email threads, emails outside the Emails tab's Linked list.
 *   C-M  a thread linked as one email, or grouped differently from the Emails
 *        tab (thread_id first, normalized subject when it is NULL).
 *   C-N  Link enabled with nothing selected.
 *   SR 2 Select all selecting disabled (already-linked / refused) rows.
 *   SR 9 an `AddChecklistLinkResult` variant counted as a success.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChecklistLinkPicker } from "../ChecklistLinkPicker";
import type { ChecklistLinkOutcome, ChecklistLinkRequest } from "../../../hooks/useTransactionChecklist";
import type { Communication } from "../../../types";
import {
  fixtureAttachments,
  fixtureDetail,
  fixtureEmailCommunications,
} from "./checklistFixture";

jest.mock("../../modals/AttachmentPreviewModal", () => ({
  AttachmentPreviewModal: ({ attachment }: { attachment: { filename: string } }) => (
    <div data-testid="preview-open">{attachment.filename}</div>
  ),
}));
jest.mock("../../modals/EmailThreadViewModal", () => ({
  EmailThreadViewModal: ({ thread }: { thread: { subject: string } }) => (
    <div data-testid="thread-view-open">{thread.subject}</div>
  ),
}));

const detail = fixtureDetail();
// Item 4 (index 3) has one fully-stale group; nothing current is linked to it.
const freshItem = detail.items[3];

const added = (n = 1): ChecklistLinkOutcome["result"] => ({
  success: true,
  data: { status: "added", linkId: "l", memberCount: n },
});

function renderPicker(opts: {
  onLink?: (r: ChecklistLinkRequest[]) => Promise<ChecklistLinkOutcome[]>;
  existingLinks?: typeof detail.linksByItemId[string];
  emails?: Communication[];
} = {}) {
  const onLink = jest.fn(
    opts.onLink ??
      (async (reqs: ChecklistLinkRequest[]) => reqs.map((request) => ({ request, result: added() }))),
  );
  const props = {
    onClose: jest.fn(),
    onShowSuccess: jest.fn(),
    onShowError: jest.fn(),
    onRefreshTargets: jest.fn(),
  };
  render(
    <ChecklistLinkPicker
      item={freshItem}
      templateName={detail.checklist.templateName}
      existingLinks={opts.existingLinks ?? []}
      attachments={fixtureAttachments()}
      attachmentsLoading={false}
      emailCommunications={opts.emails ?? fixtureEmailCommunications()}
      ensureEmailsLoaded={() => Promise.resolve()}
      onLink={onLink}
      {...props}
    />,
  );
  return { onLink, ...props };
}

const settle = () => act(async () => {});

describe("C-L — only what main would accept", () => {
  it("offers email and text attachments, not the legacy fallback row", async () => {
    renderPicker();
    await settle();
    expect(screen.getByTestId("checklist-picker-attachment-att-1")).toBeInTheDocument();
    expect(screen.getByTestId("checklist-picker-attachment-att-2")).toBeInTheDocument();
    expect(screen.getByTestId("checklist-picker-attachment-att-text")).toBeInTheDocument();
    expect(screen.queryByTestId("checklist-picker-attachment-att-legacy")).not.toBeInTheDocument();
  });

  it("offers no text messages as threads, and drops all-address_missing threads (Needs review)", async () => {
    const emails = fixtureEmailCommunications();
    const review = emails.map((e) =>
      e.thread_id === "thr-probe" ? ({ ...e, match_reason: "address_missing" } as Communication) : e,
    );
    const texty = [...review, { ...emails[0], id: "m-text", channel: "imessage", communication_type: "imessage" } as Communication];
    renderPicker({ emails: texty });
    await settle();
    expect(screen.queryByTestId("checklist-picker-thread-thread-thr-probe")).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^checklist-picker-thread-/)).toHaveLength(1);
  });
});

describe("C-M — a conversation is linked whole, grouped as the Emails tab groups it", () => {
  it("thread_id group → one email group with both ids", async () => {
    const { onLink } = renderPicker();
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-thread-thread-thr-probe"));
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(onLink).toHaveBeenCalledTimes(1));
    const [req] = onLink.mock.calls[0][0];
    expect(req.kind).toBe("email");
    expect([...req.targetIds].sort()).toEqual(["e-thread-1", "e-thread-2"]);
  });

  it("NULL thread_id, subjects differing by Re:/Fwd: → one group by normalized subject", async () => {
    const { onLink } = renderPicker();
    await settle();
    const row = screen.getByTestId(/^checklist-picker-thread-subject-/);
    fireEvent.click(row);
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(onLink).toHaveBeenCalledTimes(1));
    expect([...onLink.mock.calls[0][0][0].targetIds].sort()).toEqual(["e-solo-2", "e-solo-3"]);
  });

  it("an attachment is its own group of one", async () => {
    const { onLink } = renderPicker();
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-1"));
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(onLink).toHaveBeenCalledTimes(1));
    expect(onLink.mock.calls[0][0]).toEqual([{ kind: "attachment", targetIds: ["att-1"] }]);
  });
});

describe("C-N — nothing selected, nothing sent", () => {
  it("Link is disabled at 0 and a click sends nothing", async () => {
    const { onLink } = renderPicker();
    await settle();
    const btn = screen.getByTestId("checklist-picker-link");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onLink).not.toHaveBeenCalled();
  });
});

describe("SR condition 2 — Select all", () => {
  it("selects only enabled rows: an already-linked attachment is not counted", async () => {
    // att-1 already linked to THIS item (the fixture's item-1 group).
    renderPicker({ existingLinks: detail.linksByItemId[detail.items[0].id] });
    await settle();
    expect(screen.getByTestId("checklist-picker-attachment-att-1")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByTestId("checklist-picker-select-all-attachments"));
    // att-2 and att-text; att-1 is linked, att-legacy is not offered.
    expect(screen.getByTestId("checklist-picker-link")).toHaveTextContent("Link 2 items");
    expect(screen.getByTestId("checklist-picker-count")).toHaveTextContent("2 selected");
  });

  it("threads have their own Select all", async () => {
    renderPicker();
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-select-all-threads"));
    expect(screen.getByTestId("checklist-picker-link")).toHaveTextContent("Link 2 items");
  });
});

describe("View opens without selecting", () => {
  it("attachment View opens the preview, selection unchanged", async () => {
    renderPicker();
    await settle();
    // probe-document.pdf is a metadata-only email attachment (no storage_path
    // in the fixture), so View downloads it first — the Attachments tab's flow
    // (BACKLOG-3476, W5). Before 3476 the picker previewed it directly.
    const att = fixtureAttachments().find((a) => a.id === "att-1")!;
    expect(att.storage_path).toBeNull();
    const ensure = jest.fn().mockResolvedValue({
      success: true,
      data: [{ ...att, storage_path: "/data/probe-document.pdf" }],
    });
    (window.api.transactions as unknown as Record<string, jest.Mock>).ensureEmailAttachmentDownloaded = ensure;
    fireEvent.click(screen.getByLabelText("View probe-document.pdf"));
    expect(await screen.findByTestId("preview-open")).toHaveTextContent("probe-document.pdf");
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith("e-solo-2");
    expect(screen.getByTestId("checklist-picker-link")).toBeDisabled();
  });
});

describe("SR condition 9 — every result variant is handled", () => {
  it("a refused group stays open, is marked, and the others count as added", async () => {
    const { onShowError, onClose, onRefreshTargets } = renderPicker({
      onLink: async (reqs) =>
        reqs.map((request) => ({
          request,
          result:
            request.kind === "attachment"
              ? added()
              : { success: true, data: { status: "targets_not_in_transaction", rejectedIds: request.targetIds } },
        })),
    });
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-1"));
    fireEvent.click(screen.getByTestId("checklist-picker-thread-thread-thr-probe"));
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(onShowError).toHaveBeenCalledWith("1 of 2 links added."));
    expect(onClose).not.toHaveBeenCalled();
    expect(onRefreshTargets).toHaveBeenCalled();
    expect(screen.getByTestId("checklist-picker-thread-thread-thr-probe")).toHaveTextContent(
      "No longer on this transaction",
    );
  });

  it("no_targets is a refusal, never a success", async () => {
    const { onShowSuccess, onShowError } = renderPicker({
      onLink: async (reqs) => reqs.map((request) => ({ request, result: { success: true, data: { status: "no_targets" } } })),
    });
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-1"));
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(onShowError).toHaveBeenCalledWith("0 of 1 link added."));
    expect(onShowSuccess).not.toHaveBeenCalled();
  });

  it("no_item closes the picker with an explanation", async () => {
    const { onClose, onShowError } = renderPicker({
      onLink: async (reqs) => reqs.map((request) => ({ request, result: { success: true, data: { status: "no_item" } } })),
    });
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-1"));
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onShowError).toHaveBeenCalled();
  });

  it("all added closes with a success", async () => {
    const { onClose, onShowSuccess } = renderPicker();
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-1"));
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onShowSuccess).toHaveBeenCalledWith("Linked to checklist item");
  });
});
