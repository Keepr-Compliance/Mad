/**
 * BACKLOG-3619 — the Messages tab's Import panel.
 */

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { RcsImportPanel, useRcsImportSession } from "../RcsImportPanel";

function Harness({ transactionId, onImported }: { transactionId: string; onImported?: () => void }) {
  const controller = useRcsImportSession(transactionId, onImported);
  return <RcsImportPanel controller={controller} />;
}
import type { RcsChatReceivedEvent, RcsImportStatus } from "../../../../services/rcsImportService";

type Listener = (e: RcsChatReceivedEvent) => void;
let listener: Listener | null = null;

const mockStart = jest.fn();
const mockEnd = jest.fn();

jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    startSession: (...a: unknown[]) => mockStart(...a),
    endSession: (...a: unknown[]) => mockEnd(...a),
    getStatus: jest.fn(),
    onChatReceived: (cb: Listener) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  },
}));

function status(bridge: RcsImportStatus["bridge"], reason?: string): RcsImportStatus {
  return {
    bridge,
    port: 38619,
    ...(reason ? { reason } : {}),
    session: {
      sessionId: "s-1",
      transactionId: "tx-1",
      chatsReceived: 0,
      messagesReceived: 0,
      messagesStored: 0,
      startedAt: "2026-09-29T00:00:00.000Z",
    },
  };
}

function chatEvent(sessionId: string, chats: number): RcsChatReceivedEvent {
  return {
    sessionId,
    transactionId: "tx-1",
    conversationTitle: "Test Contact A",
    received: 3,
    stored: 3,
    alreadyPresent: 0,
    linked: 3,
    reactions: 0,
    reactionsStored: 0,
    session: { ...(status("listening").session as NonNullable<RcsImportStatus["session"]>), sessionId, chatsReceived: chats, messagesReceived: 3 * chats, messagesStored: 3 * chats },
  };
}

beforeEach(() => {
  listener = null;
  mockStart.mockReset();
  mockEnd.mockReset().mockResolvedValue({ success: true });
});

it("opens a session, refreshes on each chat for THIS session, and closes on Done", async () => {
  mockStart.mockResolvedValue({ success: true, data: status("listening") });
  const onImported = jest.fn();
  render(<Harness transactionId="tx-1" onImported={onImported} />);

  fireEvent.click(screen.getByTestId("rcs-import-button"));
  await waitFor(() => expect(screen.getByTestId("rcs-import-status")).toHaveTextContent("Waiting for chats from Chrome"));
  expect(mockStart).toHaveBeenCalledWith("tx-1");

  act(() => listener?.(chatEvent("some-other-session", 1)));
  expect(onImported).not.toHaveBeenCalled();

  act(() => listener?.(chatEvent("s-1", 1)));
  expect(onImported).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("rcs-import-status")).toHaveTextContent("1 chat received (3 messages, 3 new)");

  fireEvent.click(screen.getByTestId("rcs-import-done"));
  await waitFor(() => expect(mockEnd).toHaveBeenCalledWith("s-1"));
  expect(screen.getByTestId("rcs-import-button")).toBeInTheDocument();
});

it("says the bridge is unavailable when the port was taken", async () => {
  mockStart.mockResolvedValue({ success: true, data: status("unavailable", "Port 38619 is already in use") });
  render(<Harness transactionId="tx-1" />);
  fireEvent.click(screen.getByTestId("rcs-import-button"));
  await waitFor(() =>
    expect(screen.getByTestId("rcs-import-bridge-unavailable")).toHaveTextContent(
      "Import bridge unavailable: Port 38619 is already in use.",
    ),
  );
});

it("shows the error when the session cannot start", async () => {
  mockStart.mockResolvedValue({ success: false, error: "Transaction not found" });
  render(<Harness transactionId="tx-1" />);
  fireEvent.click(screen.getByTestId("rcs-import-button"));
  await waitFor(() => expect(screen.getByTestId("rcs-import-error")).toHaveTextContent("Transaction not found"));
});

it("closes an open session when it unmounts", async () => {
  mockStart.mockResolvedValue({ success: true, data: status("listening") });
  const { unmount } = render(<Harness transactionId="tx-1" />);
  fireEvent.click(screen.getByTestId("rcs-import-button"));
  await waitFor(() => expect(screen.getByTestId("rcs-import-session")).toBeInTheDocument());
  unmount();
  expect(mockEnd).toHaveBeenCalledWith("s-1");
});

it("closes a session that finishes starting after the tab unmounted", async () => {
  let resolveStart: (v: unknown) => void = () => {};
  mockStart.mockReturnValue(new Promise((r) => (resolveStart = r)));
  const { unmount } = render(<Harness transactionId="tx-1" />);
  fireEvent.click(screen.getByTestId("rcs-import-button"));
  await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));
  unmount();
  expect(mockEnd).not.toHaveBeenCalled();
  await act(async () => {
    resolveStart({ success: true, data: status("listening") });
  });
  expect(mockEnd).toHaveBeenCalledWith("s-1");
});

it("closes a session that finishes starting after the transaction changed", async () => {
  let resolveStart: (v: unknown) => void = () => {};
  mockStart.mockReturnValue(new Promise((r) => (resolveStart = r)));
  const { rerender } = render(<Harness transactionId="tx-1" />);
  fireEvent.click(screen.getByTestId("rcs-import-button"));
  await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));
  rerender(<Harness transactionId="tx-2" />);
  await act(async () => {
    resolveStart({ success: true, data: status("listening") });
  });
  expect(mockEnd).toHaveBeenCalledWith("s-1");
  expect(screen.queryByTestId("rcs-import-session")).not.toBeInTheDocument();
});
