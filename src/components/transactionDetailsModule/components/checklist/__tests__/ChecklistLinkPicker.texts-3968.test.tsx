/**
 * BACKLOG-3968 U2 — the link picker's Texts tab.
 *
 * Reader rows are TRANSCRIBED (fixtures/textPage-3968.json): the real
 * `readTransactionTextPage` / `getTransactionTextThreads` output over the
 * BACKLOG-3884 paging fixture, captured under Electron. In that output a row's
 * `id` is `messages.id` ("m44") while its `communication_id` ("comm-thr-a")
 * and `thread_id` ("thr-a") differ — the three ids a wrong build could send.
 *
 * Wrong implementations this suite is here to catch:
 *   - linking by thread id or communication id instead of `messages.id`;
 *   - reading another deal's texts (the reader is asked for a different id);
 *   - two picked texts written as two groups (the set model: one group);
 *   - the outside-the-dates question ("Include it") asked about a text;
 *   - a refusal (locked deal) not shown, or the rows left looking linked;
 *   - the contact name or the snippet sent to main with the link;
 *   - the Texts tab unreachable by keyboard, Space/Enter not picking a text.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ChecklistLinkPicker } from "../ChecklistLinkPicker";
import type { ChecklistWriteApiResult } from "../../../../../services/checklistService";
import type { AddChecklistLinkResult, ChecklistLink } from "../../../../../../electron/types/checklist";
import { fixtureAttachments, fixtureDetail, fixtureEmailCommunications } from "./checklistFixture";
import captured from "./fixtures/textPage-3968.json";

const mockGetTextThreads = jest.fn();
const mockGetTextThreadPage = jest.fn();
jest.mock("../../../../../services/transactionService", () => ({
  transactionService: {
    getTextThreads: (...a: unknown[]) => mockGetTextThreads(...a),
    getTextThreadPage: (...a: unknown[]) => mockGetTextThreadPage(...a),
    findTextThread: jest.fn().mockResolvedValue(null),
  },
}));
const mockResolveHandles = jest.fn();
jest.mock("../../../../../services/contactService", () => ({
  contactService: { resolveHandles: (...a: unknown[]) => mockResolveHandles(...a) },
}));
jest.mock("../../modals/AttachmentPreviewModal", () => ({ AttachmentPreviewModal: () => null }));
jest.mock("../../modals/EmailThreadViewModal", () => ({ EmailThreadViewModal: () => null }));

const TXN = captured.rows[0].transaction_id;
const [ROW_A, ROW_B] = captured.rows;
const NAME = "Probe Buyer";
const detail = fixtureDetail();
const freshItem = detail.items[3];

type LinkResult = ChecklistWriteApiResult<AddChecklistLinkResult>;
const added: LinkResult = { success: true, data: { status: "added", linkId: "l-t", memberCount: 2 } };

beforeEach(() => {
  mockGetTextThreads.mockReset().mockResolvedValue({ success: true, threads: [captured.thread] });
  mockGetTextThreadPage.mockReset().mockResolvedValue({ success: true, rows: captured.rows, nextCursor: null });
  mockResolveHandles.mockReset().mockResolvedValue({ [ROW_A.sender]: NAME });
});

function renderPicker(opts: { onLinkTexts?: (ids: string[]) => Promise<LinkResult>; existingLinks?: ChecklistLink[] } = {}) {
  const onLinkTexts = jest.fn(opts.onLinkTexts ?? (async () => added));
  const onLink = jest.fn(async () => []);
  const props = { onClose: jest.fn(), onShowSuccess: jest.fn(), onShowError: jest.fn(), onRefreshTargets: jest.fn() };
  render(
    <ChecklistLinkPicker
      item={freshItem}
      templateName={detail.checklist.templateName}
      existingLinks={opts.existingLinks ?? []}
      attachments={fixtureAttachments()}
      attachmentsLoading={false}
      emailCommunications={fixtureEmailCommunications()}
      ensureEmailsLoaded={() => Promise.resolve()}
      onLink={onLink}
      texts={{ transactionId: TXN, userId: "u-3884", onLink: onLinkTexts }}
      {...props}
    />,
  );
  return { onLinkTexts, onLink, ...props };
}

async function openTexts() {
  fireEvent.click(screen.getByTestId("checklist-picker-tab-texts"));
  await screen.findByTestId(`checklist-picker-text-${ROW_A.id}`);
}

describe("Texts tab — data path", () => {
  it("precondition: the captured rows carry three different ids", () => {
    expect(ROW_A.id).toBe(ROW_A.message_id);
    expect(ROW_A.id).not.toBe(ROW_A.communication_id);
    expect(ROW_A.id).not.toBe(ROW_A.thread_id);
  });

  it("reads nothing until the Texts tab is opened, then this deal's conversations and one page", async () => {
    renderPicker();
    await act(async () => {});
    expect(mockGetTextThreads).not.toHaveBeenCalled();
    await openTexts();
    expect(mockGetTextThreads).toHaveBeenCalledWith(TXN, null);
    expect(mockGetTextThreadPage).toHaveBeenCalledTimes(1);
    const [txn, keys, window, cursor, limit] = mockGetTextThreadPage.mock.calls[0];
    expect(txn).toBe(TXN);
    expect(keys).toEqual([captured.thread.threadId]);
    expect(window).toBeNull();
    expect(cursor).toBeNull();
    expect(limit).toBeLessThanOrEqual(200);
    expect(mockResolveHandles.mock.calls[0][2]).toBe(TXN);
  });

  it("each row shows the contact name, the date and a snippet, with the TXT mark", async () => {
    renderPicker();
    await openTexts();
    const row = screen.getByTestId(`checklist-picker-text-${ROW_A.id}`);
    expect(row).toHaveTextContent(NAME);
    expect(row).toHaveTextContent(ROW_A.body_text as string);
    expect(row).toHaveTextContent("TXT");
    expect(row).toHaveTextContent(new Date(ROW_A.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  });

  it("a text hidden from the export is not offered (it would never be sent)", async () => {
    // The captured row with the reader's own flag set, as the reader reports a hidden text.
    mockGetTextThreadPage.mockResolvedValue({
      success: true,
      rows: [ROW_A, { ...ROW_B, hidden_from_export: 1 }],
      nextCursor: null,
    });
    renderPicker();
    await openTexts();
    expect(screen.queryByTestId(`checklist-picker-text-${ROW_B.id}`)).not.toBeInTheDocument();
  });

  it("Show more reads the next page with the cursor main gave", async () => {
    mockGetTextThreadPage.mockResolvedValueOnce({ success: true, rows: [ROW_A], nextCursor: captured.next });
    mockGetTextThreadPage.mockResolvedValueOnce({ success: true, rows: [ROW_B], nextCursor: null });
    renderPicker();
    await openTexts();
    expect(screen.queryByTestId(`checklist-picker-text-${ROW_B.id}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("checklist-picker-texts-more"));
    await screen.findByTestId(`checklist-picker-text-${ROW_B.id}`);
    expect(mockGetTextThreadPage.mock.calls[1][3]).toEqual(captured.next);
    expect(screen.queryByTestId("checklist-picker-texts-more")).not.toBeInTheDocument();
  });
});

describe("Texts tab — linking", () => {
  it("two picked texts are ONE write of their messages.id, and the button says so", async () => {
    const { onLinkTexts, onLink, onShowSuccess, onClose } = renderPicker();
    await openTexts();
    fireEvent.click(screen.getByTestId(`checklist-picker-text-${ROW_A.id}`));
    fireEvent.click(screen.getByTestId(`checklist-picker-text-${ROW_B.id}`));
    expect(screen.getByTestId("checklist-picker-link")).toHaveTextContent("Link 2 texts");
    await act(async () => {
      fireEvent.click(screen.getByTestId("checklist-picker-link"));
    });
    expect(onLinkTexts).toHaveBeenCalledTimes(1);
    expect(onLinkTexts).toHaveBeenCalledWith([ROW_A.id, ROW_B.id]);
    // Texts never go through the attachment/email request path.
    expect(onLink).not.toHaveBeenCalled();
    expect(onShowSuccess).toHaveBeenCalledWith("Linked to checklist item");
    expect(onClose).toHaveBeenCalled();
  });

  it("nothing but the ids leaves the renderer: no name, no snippet, no 'Include it'", async () => {
    const { onLinkTexts } = renderPicker();
    await openTexts();
    fireEvent.click(screen.getByTestId(`checklist-picker-text-${ROW_A.id}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId("checklist-picker-link"));
    });
    expect(onLinkTexts.mock.calls).toEqual([[[ROW_A.id]]]);
    const sent = JSON.stringify(onLinkTexts.mock.calls);
    expect(sent).not.toContain(NAME);
    expect(sent).not.toContain(ROW_A.body_text as string);
    expect(sent).not.toMatch(/includeOutsideDates/);
    expect(screen.queryByTestId("checklist-outside-dates-question")).not.toBeInTheDocument();
    expect(screen.queryByText(/Include it/)).not.toBeInTheDocument();
  });

  it("a text already linked to this item reads Linked and cannot be picked", async () => {
    const existing: ChecklistLink = {
      id: "l-old",
      itemId: freshItem.id,
      kind: "text",
      label: "Text · July 1, 2026",
      includeOutsideDates: false,
      members: [{ id: "mem-1", linkId: "l-old", kind: "text", attachmentId: null, emailId: null, messageId: ROW_A.id, inTransaction: true }],
    } as unknown as ChecklistLink;
    renderPicker({ existingLinks: [existing] });
    await openTexts();
    const row = screen.getByTestId(`checklist-picker-text-${ROW_A.id}`);
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("Linked");
  });

  it("shows the rows as linked while the write is in flight", async () => {
    let resolve!: (r: LinkResult) => void;
    renderPicker({ onLinkTexts: () => new Promise<LinkResult>((r) => (resolve = r)) });
    await openTexts();
    fireEvent.click(screen.getByTestId(`checklist-picker-text-${ROW_A.id}`));
    act(() => {
      fireEvent.click(screen.getByTestId("checklist-picker-link"));
    });
    expect(screen.getByTestId(`checklist-picker-text-${ROW_A.id}`)).toHaveTextContent("Linked");
    await act(async () => resolve(added));
  });

  it("a locked deal: main's reason is shown, the rows go back, the picker stays open", async () => {
    const reason = "This deal is with your broker, so it can't be changed.";
    const { onShowError, onClose, onShowSuccess } = renderPicker({
      onLinkTexts: async () => ({ success: false, error: reason, dealLocked: "submitted" }),
    });
    await openTexts();
    fireEvent.click(screen.getByTestId(`checklist-picker-text-${ROW_A.id}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId("checklist-picker-link"));
    });
    expect(onShowError).toHaveBeenCalledWith(reason);
    expect(onShowSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const row = screen.getByTestId(`checklist-picker-text-${ROW_A.id}`);
    expect(row).not.toHaveTextContent("Linked");
    expect(row).toHaveAttribute("aria-disabled", "false");
    expect(row).toHaveAttribute("aria-checked", "true");
  });

  it("texts main refuses as not on this deal are marked and deselected", async () => {
    const { onShowError } = renderPicker({
      onLinkTexts: async () => ({ success: true, data: { status: "targets_not_in_transaction", missing: [ROW_A.id] } as unknown as AddChecklistLinkResult }),
    });
    await openTexts();
    fireEvent.click(screen.getByTestId(`checklist-picker-text-${ROW_A.id}`));
    await act(async () => {
      fireEvent.click(screen.getByTestId("checklist-picker-link"));
    });
    expect(onShowError).toHaveBeenCalledWith(expect.stringMatching(/no longer on this deal/));
    expect(screen.getByTestId(`checklist-picker-text-${ROW_A.id}`)).toHaveTextContent("No longer on this transaction");
  });
});

describe("Texts tab — keyboard", () => {
  it("Tab reaches the tabs, arrow keys open Texts, Space and Enter pick a text, Enter on the button links", async () => {
    const user = userEvent.setup();
    const { onLinkTexts } = renderPicker();
    const tabs = screen.getByTestId("checklist-picker-tabs");
    // From the Close button, Tab lands on the selected tab: the one stop in the tab list.
    screen.getByLabelText("Close link picker").focus();
    await user.tab();
    const emails = within(tabs).getByRole("tab", { name: "Emails" });
    expect(emails).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    const textsTab = within(tabs).getByRole("tab", { name: "Texts" });
    expect(textsTab).toHaveFocus();
    expect(textsTab).toHaveAttribute("aria-selected", "true");
    await screen.findByTestId(`checklist-picker-text-${ROW_A.id}`);
    expect(screen.getByTestId("checklist-picker-texts")).toBeVisible();
    // Tab moves on from the tab list to the search box, Select all, then into the rows (hidden panels are skipped).
    await user.tab();
    expect(screen.getByTestId("checklist-picker-search")).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId("checklist-picker-select-all-texts")).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId(`checklist-picker-text-${ROW_A.id}`)).toHaveFocus();
    await user.keyboard(" ");
    await user.tab();
    expect(screen.getByTestId(`checklist-picker-text-${ROW_B.id}`)).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("checklist-picker-link")).toHaveTextContent("Link 2 texts");
    screen.getByTestId("checklist-picker-link").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onLinkTexts).toHaveBeenCalledWith([ROW_A.id, ROW_B.id]));
  });

  it("every tab has its panel, and only the open one is shown", async () => {
    renderPicker();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Emails", "Texts", "Attachments"]);
    expect(screen.getByTestId("checklist-picker-threads")).toBeVisible();
    expect(screen.getByTestId("checklist-picker-attachments")).not.toBeVisible();
    await openTexts();
    expect(screen.getByTestId("checklist-picker-texts")).toBeVisible();
    expect(screen.getByTestId("checklist-picker-threads")).not.toBeVisible();
  });
});
