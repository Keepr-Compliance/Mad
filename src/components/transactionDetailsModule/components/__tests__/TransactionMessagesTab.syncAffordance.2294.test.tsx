/**
 * BACKLOG-2294 — the Texts "Sync" / re-sync button must show the SAME active
 * affordance (spinner + "Syncing…", disabled) whenever a BACKGROUND messages
 * sync is in flight, not only when the user clicked it themselves.
 *
 * The button's active state is now driven by
 *   syncActive = syncingMessages || globalSyncRunning || messagesSyncInFlight
 * so a background audit-date-change import, the orchestrator's post-login sync,
 * or the 2293 re-sync expansion all read "working" rather than a dead disabled
 * gray. These tests must FAIL on the old `syncingMessages`-only gate.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionMessagesTab } from "../TransactionMessagesTab";
import type { Communication } from "../../types";

const mockUnlinkMessages = jest.fn();
const mockGetMessageContacts = jest.fn();
const mockGetMessagesByContact = jest.fn();
const mockLinkMessages = jest.fn();
const mockGetNamesByPhones = jest.fn();

beforeAll(() => {
  Object.defineProperty(window, "api", {
    value: {
      transactions: {
        unlinkMessages: mockUnlinkMessages,
        getMessageContacts: mockGetMessageContacts,
        getMessagesByContact: mockGetMessagesByContact,
        linkMessages: mockLinkMessages,
      },
      contacts: {
        getNamesByPhones: mockGetNamesByPhones,
      },
    },
    writable: true,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUnlinkMessages.mockResolvedValue({ success: true });
  mockGetMessageContacts.mockResolvedValue({ success: true, contacts: [] });
  mockGetMessagesByContact.mockResolvedValue({ success: true, messages: [] });
  mockLinkMessages.mockResolvedValue({ success: true });
  mockGetNamesByPhones.mockResolvedValue({ success: true, names: {} });
});

const threadMessages: Partial<Communication>[] = [
  {
    id: "msg-1",
    user_id: "user-456",
    channel: "sms",
    body_text: "Got your message about the property!",
    sent_at: "2024-01-16T11:00:00Z",
    direction: "inbound",
    thread_id: "thread-1",
    participants: JSON.stringify({ from: "+14155550100", to: ["+14155550101"] }),
    has_attachments: false,
    is_false_positive: false,
  },
];

/** Read the Import button and whether it currently shows a spinner. */
function readImportButton(): { button: HTMLElement; spinning: boolean } {
  const button = screen.getByTestId("rcs-import-button");
  return { button, spinning: button.querySelector(".animate-spin") !== null };
}

/** Import stands in for Sync on this branch: it is enabled, plain "Import", and Sync is gone. */
function expectImportIdle(): void {
  const { button, spinning } = readImportButton();
  expect(button).not.toBeDisabled();
  expect(button).toHaveTextContent("Import");
  expect(spinning).toBe(false);
  expect(screen.queryByTestId("sync-messages-button")).toBeNull();
}

describe("TransactionMessagesTab — Import replaces Sync on this branch (BACKLOG-3619); background-sync props do not affect it", () => {
  describe("header (messages present)", () => {
    it("shows Import (enabled, no spinner, no Sync button) while a BACKGROUND messages sync is in flight", () => {
      render(
        <TransactionMessagesTab
          transactionId="tx-1"
          messages={threadMessages as Communication[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          syncingMessages={false}
          messagesSyncInFlight
        />
      );

      expectImportIdle();
    });

    it("shows Import (enabled, no spinner, no Sync button) while the orchestrator's global sync is running", () => {
      render(
        <TransactionMessagesTab
          transactionId="tx-1"
          messages={threadMessages as Communication[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          syncingMessages={false}
          globalSyncRunning
        />
      );

      expectImportIdle();
    });

    it("shows Import (enabled, no spinner, no Sync button) while a user-initiated sync runs", () => {
      render(
        <TransactionMessagesTab
          transactionId="tx-1"
          messages={threadMessages as Communication[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          syncingMessages
        />
      );

      expectImportIdle();
    });

    it("shows Import (enabled, no spinner, no Sync button) when nothing is syncing", () => {
      render(
        <TransactionMessagesTab
          transactionId="tx-1"
          messages={threadMessages as Communication[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          syncingMessages={false}
          globalSyncRunning={false}
          messagesSyncInFlight={false}
        />
      );

      expectImportIdle();
    });
  });

  describe("empty state (no messages linked yet)", () => {
    it("shows Import (enabled, no spinner, no Sync button) while a BACKGROUND messages sync is in flight, without contacts", () => {
      render(
        <TransactionMessagesTab
          transactionId="tx-1"
          messages={[]}
          loading={false}
          error={null}
          hasContacts={false}
          onSyncMessages={jest.fn()}
          syncingMessages={false}
          messagesSyncInFlight
        />
      );

      expectImportIdle();
    });

    it("shows Import (enabled, no spinner, no Sync button) when nothing is syncing", () => {
      render(
        <TransactionMessagesTab
          transactionId="tx-1"
          messages={[]}
          loading={false}
          error={null}
          hasContacts
          onSyncMessages={jest.fn()}
          messagesSyncInFlight={false}
        />
      );

      expectImportIdle();
    });
  });
});
