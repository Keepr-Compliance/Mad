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
  "It is removed from this computer and from Keepr Cloud. You can restore it for 30 days from Settings › Keepr Cloud. After that it is deleted for good.";
const MANY =
  "They are removed from this computer and from Keepr Cloud. You can restore them for 30 days from Settings › Keepr Cloud. After that they are deleted for good.";

describe("delete dialogs — Keepr Cloud users (PR-6)", () => {
  it("the texts are the accepted ones, word for word", () => {
    expect(`${CLOUD_DELETE_COPY.oneTitle} ${CLOUD_DELETE_COPY.one}`).toBe(
      "Delete this deal? It is removed from this computer and from Keepr Cloud. You can restore it for 30 days from Settings › Keepr Cloud. After that it is deleted for good.",
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
    expect((await screen.findByTestId("delete-transaction-cloud-text")).textContent).toBe(ONE);
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
    expect((await screen.findByTestId("bulk-delete-cloud-text")).textContent).toBe(MANY);
    expect(screen.getByText("Delete 3 deals?")).toBeInTheDocument();
    expect(screen.queryByText("This action cannot be undone.")).toBeNull();
    rerender(<BulkDeleteConfirmModal selectedCount={2} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByTestId("bulk-delete-cloud-text").textContent).toBe(MANY);
    rerender(<BulkDeleteConfirmModal selectedCount={1} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByTestId("bulk-delete-cloud-text").textContent).toBe(ONE);
  });

  it("bulk: the Delete button waits for main's answer", async () => {
    let answer: (v: { on: boolean; online: boolean }) => void = () => undefined;
    svc.localState.mockReturnValue(new Promise((r) => (answer = r)));
    render(<BulkDeleteConfirmModal selectedCount={3} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByTestId("bulk-delete-confirm")).toBeDisabled();
    answer({ on: false, online: true });
    await waitFor(() => expect(screen.getByTestId("bulk-delete-confirm")).not.toBeDisabled());
  });

  it("bulk, Keepr Cloud off: today's dialog, unchanged", async () => {
    svc.localState.mockResolvedValue({ on: false, online: true });
    render(<BulkDeleteConfirmModal selectedCount={3} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId("bulk-delete-confirm")).not.toBeDisabled());
    expect(screen.getByText("Delete 3 Transactions?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  // BACKLOG-4263: the confirm buttons say "deal" when the title does; Keepr Cloud off keeps today's buttons.
  it("BACKLOG-4263: one-deal dialog, Keepr Cloud on: the button reads Delete deal", async () => {
    svc.localState.mockResolvedValue({ on: true, online: true });
    render(<DeleteConfirmModal propertyAddress="12 Oak Street" onCancel={jest.fn()} onDelete={jest.fn()} />);
    await screen.findByTestId("delete-transaction-cloud-text");
    expect(screen.getByTestId("delete-transaction-confirm")).toHaveTextContent(/^Delete deal$/);
  });

  it("BACKLOG-4263: one-deal dialog, Keepr Cloud off and still loading: the button reads Delete Transaction", async () => {
    let answer: (v: { on: boolean; online: boolean }) => void = () => undefined;
    svc.localState.mockReturnValue(new Promise((r) => (answer = r)));
    render(<DeleteConfirmModal propertyAddress="12 Oak Street" onCancel={jest.fn()} onDelete={jest.fn()} />);
    expect(screen.getByTestId("delete-transaction-confirm")).toHaveTextContent(/^Delete Transaction$/);
    answer({ on: false, online: true });
    await waitFor(() => expect(screen.getByTestId("delete-transaction-confirm")).not.toBeDisabled());
    expect(screen.getByTestId("delete-transaction-confirm")).toHaveTextContent(/^Delete Transaction$/);
  });

  it.each([
    [0, "Delete 0 deals"],
    [1, "Delete 1 deal"],
    [2, "Delete 2 deals"],
    [3, "Delete 3 deals"],
  ])("BACKLOG-4263: bulk, Keepr Cloud on, %i selected: the button reads %s", async (n, label) => {
    svc.localState.mockResolvedValue({ on: true, online: true });
    render(<BulkDeleteConfirmModal selectedCount={n} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    await screen.findByTestId("bulk-delete-cloud-text");
    expect(screen.getByTestId("bulk-delete-confirm").textContent).toBe(label);
  });

  it.each([
    [0, "Delete 0 Transaction"],
    [1, "Delete 1 Transaction"],
    [2, "Delete 2 Transactions"],
    [3, "Delete 3 Transactions"],
  ])("BACKLOG-4263: bulk, Keepr Cloud off, %i selected: the button reads %s, as today", async (n, label) => {
    svc.localState.mockResolvedValue({ on: false, online: true });
    render(<BulkDeleteConfirmModal selectedCount={n} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId("bulk-delete-confirm")).not.toBeDisabled());
    expect(screen.getByTestId("bulk-delete-confirm").textContent).toBe(label);
  });

  it("BACKLOG-4263: bulk, deleting: the button reads Deleting... whether Keepr Cloud is on or off", async () => {
    svc.localState.mockResolvedValue({ on: true, online: true });
    render(<BulkDeleteConfirmModal selectedCount={2} isDeleting onConfirm={jest.fn()} onCancel={jest.fn()} />);
    await screen.findByTestId("bulk-delete-cloud-text");
    expect(screen.getByTestId("bulk-delete-confirm").textContent).toBe("Deleting...");
  });

  it.each([
    [1, "Delete 1 Transaction"],
    [3, "Delete 3 Transactions"],
  ])("BACKLOG-4263: bulk, Keepr Cloud still loading, %i selected: the button reads %s, as today", (n, label) => {
    svc.localState.mockReturnValue(new Promise(() => undefined));
    render(<BulkDeleteConfirmModal selectedCount={n} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByTestId("bulk-delete-confirm")).toBeDisabled();
    expect(screen.getByTestId("bulk-delete-confirm").textContent).toBe(label);
  });
});
