/**
 * BACKLOG-3662 — the transaction's Texts tab: Sync (re-link) + Attach
 * messages, the same buttons for iPhone, Mac and Android. The Import panel
 * (and its manual session / per-transaction Google Messages Sync) is gone;
 * texts from Google Messages arrive through the dashboard's Sync Android and
 * the phone auto-link, and the tab refetches when such a Sync is saved
 * (rcs-import:data-changed) or Force re-import cleared them.
 *
 * Mutations that turn this suite red:
 *   T1 the Import panel back on the tab                 → "Sync + Attach, no Import"
 *   T2 Sync not calling the re-link                     → "Sync + Attach, no Import"
 *   T3 the data-changed subscription dropped            → "refetches"
 *   T4 the data-cleared subscription dropped            → "refetches"
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import type { Communication } from "../../types";

let changed: (() => void) | null = null;
let cleared: (() => void) | null = null;

jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    onDataChanged: (cb: () => void) => {
      changed = cb;
      return () => {
        changed = null;
      };
    },
    onDataCleared: (cb: () => void) => {
      cleared = cb;
      return () => {
        cleared = null;
      };
    },
  },
}));

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        unlinkMessages: jest.fn().mockResolvedValue({ success: true }),
        getMessageContacts: jest.fn().mockResolvedValue({ success: true, contacts: [] }),
        getMessagesByContact: jest.fn().mockResolvedValue({ success: true, messages: [] }),
        linkMessages: jest.fn().mockResolvedValue({ success: true }),
      },
      contacts: {
        getNamesByPhones: jest.fn().mockResolvedValue({ success: true, names: {} }),
      },
    },
    writable: true,
  });
});

const oneMessage: Partial<Communication>[] = [
  {
    id: "msg-1",
    user_id: "user-1",
    channel: "sms",
    body_text: "Synthetic text",
    sent_at: "2026-09-20T13:05:00Z",
    direction: "inbound",
    thread_id: "gmweb2-aaaa",
    participants: JSON.stringify({ from: "+15555550101", to: ["me"] }),
    has_attachments: false,
    is_false_positive: false,
  },
];

function tab(messages: Partial<Communication>[], over: { onSyncMessages?: () => Promise<void>; onMessagesChanged?: () => void } = {}) {
  return (
    <TransactionMessagesTab
      messages={messages as Communication[]}
      loading={false}
      error={null}
      userId="user-1"
      transactionId="tx-1"
      hasContacts
      onSyncMessages={over.onSyncMessages ?? jest.fn(async () => undefined)}
      onMessagesChanged={over.onMessagesChanged ?? jest.fn()}
    />
  );
}

describe.each([
  ["empty", [] as Partial<Communication>[]],
  ["with texts", oneMessage],
])("Texts tab (%s)", (_label, messages) => {
  it("Sync + Attach, no Import (T1, T2)", () => {
    const onSyncMessages = jest.fn(async () => undefined);
    render(tab(messages, { onSyncMessages }));
    expect(screen.queryByTestId("rcs-import-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rcs-sync-button")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Import$/)).not.toBeInTheDocument();
    expect(screen.getByTestId("attach-messages-button")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sync-messages-button"));
    expect(onSyncMessages).toHaveBeenCalledTimes(1);
  });

  it("refetches when a Google Messages Sync was saved, and after Force re-import (T3, T4)", () => {
    const onMessagesChanged = jest.fn();
    render(tab(messages, { onMessagesChanged }));
    act(() => changed?.());
    expect(onMessagesChanged).toHaveBeenCalledTimes(1);
    act(() => cleared?.());
    expect(onMessagesChanged).toHaveBeenCalledTimes(2);
  });
});
