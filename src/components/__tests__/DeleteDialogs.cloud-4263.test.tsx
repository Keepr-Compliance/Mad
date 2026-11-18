/**
 * BACKLOG-4263 PR-6 (plan §14, F10, Q7) — both delete dialogs: for a Keepr Cloud user the deleted deal is kept 30
 * days, so the dialog says so; everyone else keeps today's dialog. The answer is main's LOCAL read
 * (`cloud-sync:local-state`): an offline Keepr Cloud user's delete is still kept, so the text must not depend on
 * being online.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DeleteConfirmModal, CLOUD_DELETE_COPY } from "../transactionDetailsModule/components/modals/DeleteConfirmModal";
import { BulkDeleteConfirmModal } from "../BulkActionBar";

jest.mock("@/services/cloudSyncService", () => ({ __esModule: true, default: { localState: jest.fn() } }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const svc = require("@/services/cloudSyncService").default as { localState: jest.Mock };

const ONE =
  "It is removed from this computer and from Keepr Cloud. You can restore it, with its people, todos and linked emails and texts, for 30 days from Settings › Keepr Cloud. After that it is deleted for good.";
const MANY =
  "They are removed from this computer and from Keepr Cloud. You can restore them, with their people, todos and linked emails and texts, for 30 days from Settings › Keepr Cloud. After that they are deleted for good.";

describe("delete dialogs — Keepr Cloud users (PR-6)", () => {
  it("the texts are the accepted ones, word for word", () => {
    expect(`${CLOUD_DELETE_COPY.oneTitle} ${CLOUD_DELETE_COPY.one}`).toBe(
      "Delete this deal? It is removed from this computer and from Keepr Cloud. You can restore it, with its people, todos and linked emails and texts, for 30 days from Settings › Keepr Cloud. After that it is deleted for good.",
    );
    expect(CLOUD_DELETE_COPY.many).toBe(MANY);
  });

  it.each([
    ["online", { on: true, online: true }],
    ["offline", { on: true, online: false }],
  ])("Keepr Cloud on (%s): the one-deal dialog says it can be restored for 30 days, and never that it cannot be undone", async (_l, state) => {
    svc.localState.mockResolvedValue(state);
    const onDelete = jest.fn();
    render(<DeleteConfirmModal propertyAddress="12 Oak Street" onCancel={jest.fn()} onDelete={onDelete} />);
    expect(await screen.findByTestId("delete-transaction-cloud-text")).toHaveTextContent(ONE);
    expect(screen.getByText("Delete this deal?")).toBeInTheDocument();
    expect(screen.queryByText("This action cannot be undone.")).toBeNull();
    fireEvent.click(screen.getByTestId("delete-transaction-confirm"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("Keepr Cloud off: today's dialog, unchanged", async () => {
    svc.localState.mockResolvedValue({ on: false, online: true });
    render(<DeleteConfirmModal propertyAddress="12 Oak Street" onCancel={jest.fn()} onDelete={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId("delete-transaction-confirm")).not.toBeDisabled());
    expect(screen.getByText("Delete Transaction?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
    expect(screen.queryByTestId("delete-transaction-cloud-text")).toBeNull();
  });

  it("the Delete button waits for main's answer", async () => {
    let answer: (v: { on: boolean; online: boolean }) => void = () => undefined;
    svc.localState.mockReturnValue(new Promise((r) => (answer = r)));
    render(<DeleteConfirmModal propertyAddress="12 Oak Street" onCancel={jest.fn()} onDelete={jest.fn()} />);
    expect(screen.getByTestId("delete-transaction-confirm")).toBeDisabled();
    answer({ on: true, online: true });
    await waitFor(() => expect(screen.getByTestId("delete-transaction-confirm")).not.toBeDisabled());
  });

  it("bulk, Keepr Cloud on: several deals get the plural text, one deal the single text", async () => {
    svc.localState.mockResolvedValue({ on: true, online: false });
    const { rerender } = render(<BulkDeleteConfirmModal selectedCount={3} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(await screen.findByTestId("bulk-delete-cloud-text")).toHaveTextContent(MANY);
    expect(screen.getByText("Delete 3 deals?")).toBeInTheDocument();
    expect(screen.queryByText("This action cannot be undone.")).toBeNull();
    rerender(<BulkDeleteConfirmModal selectedCount={1} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByTestId("bulk-delete-cloud-text")).toHaveTextContent(ONE);
  });

  it("bulk, Keepr Cloud off: today's dialog, unchanged", async () => {
    svc.localState.mockResolvedValue({ on: false, online: true });
    render(<BulkDeleteConfirmModal selectedCount={3} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId("bulk-delete-confirm")).not.toBeDisabled());
    expect(screen.getByText("Delete 3 Transactions?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });
});
