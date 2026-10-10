/**
 * BACKLOG-3884 — the Texts tab in paged mode: it shows a conversation list from
 * `getTextThreads` (counts from main) and reads a conversation a page at a time
 * when it is opened. It never holds every linked text.
 *
 * Fixtures: the list rows are `buildTextThreadSummaries` output
 * (../../../../components/__tests__/helpers/textThreadSummary3884.ts); the page rows
 * carry the columns of `getCommunicationsWithMessages`' text arm, which the paged
 * reader projects unchanged (transactionTextPagingDb.ts TEXT_ROW_COLUMNS).
 *
 * The most likely wrong fix — a single page with no way to reach older texts —
 * is the "older in-window texts are reachable" case below.
 */
import React from "react";
import { render as rtlRender, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../../../contexts/NotificationContext";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import { textThreadSummary } from "../../../__tests__/helpers/textThreadSummary3884";
import type { Communication } from "../../types";

const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: NotificationProvider });

const TXN = "txn-3884";
const START = "2026-03-01";
const END = "2026-06-30";

const busy = textThreadSummary({
  threadId: "thread-busy",
  phone: "+14155550100",
  lastSentAt: "2026-09-01T10:00:00.000Z",
  totalCount: 500,
  inWindowCount: 250,
});
const quiet = textThreadSummary({
  threadId: "thread-quiet",
  phone: "+14155550150",
  lastSentAt: "2025-01-01T10:00:00.000Z",
  totalCount: 3,
  inWindowCount: 0,
});

function pageRow(id: string, sentAt: string): Communication {
  return {
    id,
    communication_id: "c-busy-thread",
    user_id: "user-1",
    transaction_id: TXN,
    message_id: id,
    email_id: null,
    link_source: "auto",
    link_confidence: null,
    match_reason: null,
    linked_at: "2026-03-01 10:00:00",
    created_at: "2026-03-01 10:00:00",
    channel: "imessage",
    communication_type: "imessage",
    body_text: `text ${id}`,
    body_plain: `text ${id}`,
    body: null,
    subject: null,
    sender: "+14155550100",
    recipients: "me",
    sent_at: sentAt,
    received_at: sentAt,
    has_attachments: 0,
    thread_id: "thread-busy",
    participants: JSON.stringify({ from: "+14155550100", to: ["me"] }),
    thread_display_name: null,
    direction: "inbound",
    external_id: `ext-${id}`,
    associated_message_type: null,
    associated_message_guid: null,
    hidden_from_export: 0,
    source: null,
    cc: null,
    bcc: null,
    attachment_count: null,
  } as unknown as Communication;
}

const t = () => window.api.transactions as unknown as Record<string, jest.Mock>;

beforeAll(() => {
  // jsdom has no layout; the highlight scrolls the card into view.
  Element.prototype.scrollIntoView = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).unlinkMessages = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.contacts as any).resolveHandles = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  (window.api.contacts.resolveHandles as jest.Mock).mockResolvedValue({ success: true, names: {} });
  t().unlinkMessages.mockResolvedValue({ success: true });
  t().unlinkTextThreads.mockResolvedValue({ success: true, removed: 500, messageIds: ["m-1", "m-2"] });
  t().findTextThread.mockResolvedValue({ success: true, threadKey: "thread-busy" });
  t().getTextThreadPage.mockImplementation(async (_txn: string, _keys: string[], _w: unknown, cursor: unknown) =>
    cursor === null
      ? {
          success: true,
          rows: [pageRow("m-newest", "2026-06-20T10:00:00.000Z"), pageRow("m-mid", "2026-05-01T10:00:00.000Z")],
          nextCursor: { sk: "2026-05-01T10:00:00.000Z", afterId: null },
        }
      : { success: true, rows: [pageRow("m-oldest", "2026-03-02T10:00:00.000Z")], nextCursor: null },
  );
});

function renderTab(extra: Partial<React.ComponentProps<typeof TransactionMessagesTab>> = {}) {
  return render(
    <TransactionMessagesTab
      messages={[]}
      threads={[busy, quiet]}
      threadsVersion={1}
      loading={false}
      error={null}
      userId="user-1"
      transactionId={TXN}
      auditStartDate={START}
      auditEndDate={END}
      {...extra}
    />,
  );
}

describe("TransactionMessagesTab — paged conversations (BACKLOG-3884)", () => {
  it("shows main's counts: the audit window by default, all history when the toggle is off", async () => {
    renderTab();
    expect(await screen.findByText(/1 conversation\b/)).toBeInTheDocument();
    expect(screen.getByText(/250 text messages/)).toBeInTheDocument();
    expect(screen.getByText(/of 2 conversations \(503 messages\)/)).toBeInTheDocument();
    expect(screen.getAllByTestId("message-thread-card")).toHaveLength(1);
    // No text was read to draw the list.
    expect(t().getTextThreadPage).not.toHaveBeenCalled();
  });

  it("older in-window texts are reachable: the open conversation loads earlier pages on request", async () => {
    renderTab();
    await act(async () => {
      await userEvent.click(await screen.findByTestId("toggle-thread-button"));
    });
    await screen.findByText("text m-newest");
    expect(t().getTextThreadPage).toHaveBeenCalledWith(
      TXN,
      ["thread-busy"],
      expect.objectContaining({ startMs: expect.any(Number), endMs: expect.any(Number) }),
      null,
      200,
    );
    expect(screen.queryByText("text m-oldest")).not.toBeInTheDocument();
    // The header says how much is left; nothing is cut off silently.
    expect(screen.getByTestId("conversation-count")).toHaveTextContent(/2 messages\s*of 250/);
    await act(async () => {
      await userEvent.click(screen.getByTestId("load-earlier-messages"));
    });
    expect(await screen.findByText("text m-oldest")).toBeInTheDocument();
    expect(t().getTextThreadPage).toHaveBeenLastCalledWith(
      TXN,
      ["thread-busy"],
      expect.anything(),
      { sk: "2026-05-01T10:00:00.000Z", afterId: null },
      200,
    );
    await waitFor(() => expect(screen.queryByTestId("load-earlier-messages")).not.toBeInTheDocument());
  });

  it("removing a conversation goes to main by thread, not by held message ids", async () => {
    const onMessagesChanged = jest.fn();
    renderTab({ onMessagesChanged });
    await act(async () => {
      await userEvent.click(await screen.findByTestId("unlink-thread-button"));
    });
    // The confirmation counts every text of the conversation (main's count).
    expect(screen.getByText(/500 messages/)).toBeInTheDocument();
    await act(async () => {
      await userEvent.click(screen.getByTestId("unlink-confirm-button"));
    });
    await waitFor(() => expect(t().unlinkTextThreads).toHaveBeenCalledWith(TXN, ["thread-busy"]));
    expect(t().unlinkMessages).not.toHaveBeenCalled();
    await waitFor(() => expect(onMessagesChanged).toHaveBeenCalled());
  });

  it("a search hit is located through main, not through held rows", async () => {
    renderTab({ highlightTarget: { type: "text", communicationId: "m-deep" } });
    await waitFor(() => expect(t().findTextThread).toHaveBeenCalledWith(TXN, "m-deep"));
    await waitFor(() =>
      expect(document.querySelector('[data-thread-id="thread-busy"]')?.className ?? "").toContain("ring-4"),
    );
  });

  it("thread-less texts of two people are two cards; removing one removes only that person's (SR B4)", async () => {
    const p1 = { ...textThreadSummary({ threadId: "__nothread__:participants-2065550101", phone: "+12065550101", lastSentAt: "2026-04-02T10:00:00.000Z", totalCount: 2 }) };
    const p2 = { ...textThreadSummary({ threadId: "__nothread__:participants-2065550102", phone: "+12065550102", lastSentAt: "2026-04-01T10:00:00.000Z", totalCount: 1 }) };
    for (const t of [p1, p2]) t.samples = t.samples.map((r) => ({ ...r, thread_id: null }));
    renderTab({ threads: [p1, p2] });
    await waitFor(() => expect(screen.getAllByTestId("message-thread-card")).toHaveLength(2));
    const card = document.querySelector('[data-thread-id="__nothread__:participants-2065550102"]') as HTMLElement;
    expect(card).not.toBeNull();
    await act(async () => {
      await userEvent.click(card.querySelector('[data-testid="unlink-thread-button"]') as HTMLElement);
    });
    await act(async () => {
      await userEvent.click(screen.getByTestId("unlink-confirm-button"));
    });
    await waitFor(() =>
      expect(t().unlinkTextThreads).toHaveBeenCalledWith(TXN, ["__nothread__:participants-2065550102"]),
    );
  });
});
