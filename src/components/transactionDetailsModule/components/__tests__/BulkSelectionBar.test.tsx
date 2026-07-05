/**
 * RTL Tests — BACKLOG-1719: BulkSelectionBar + BulkRemoveConfirmModal
 *
 * The lean floating bar that drives multi-select bulk Remove (active lists) and
 * bulk Restore (removed sections) on the transaction-details Emails/Texts tabs.
 * It mirrors the transaction-window BulkActionBar design but exposes ONE
 * parameterised action.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { BulkSelectionBar, BulkRemoveConfirmModal } from "../BulkSelectionBar";

// The bar renders BOTH a mobile and a desktop layout (CSS hides one; jsdom keeps
// both), so shared test-ids resolve to two nodes — always act on the first.
const first = (testId: string) => screen.getAllByTestId(testId)[0];

describe("BulkSelectionBar — BACKLOG-1719", () => {
  const baseProps = {
    selectedCount: 2,
    totalCount: 5,
    onSelectAll: jest.fn(),
    onDeselectAll: jest.fn(),
    onClose: jest.fn(),
    actionLabel: "Remove",
    onAction: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it("shows the selected/total counts and fires the primary action", async () => {
    render(<BulkSelectionBar {...baseProps} actionTestId="bar-action" />);

    // Count + total are shown (mobile + desktop → 2 each).
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("of 5").length).toBeGreaterThan(0);

    await userEvent.click(first("bar-action"));
    expect(baseProps.onAction).toHaveBeenCalledTimes(1);
  });

  it("wires Select All / Deselect All / Close", async () => {
    render(<BulkSelectionBar {...baseProps} />);

    await userEvent.click(screen.getAllByText("Select All")[0]);
    expect(baseProps.onSelectAll).toHaveBeenCalled();

    await userEvent.click(screen.getAllByText("Deselect All")[0]);
    expect(baseProps.onDeselectAll).toHaveBeenCalled();

    await userEvent.click(screen.getAllByTitle("Exit selection mode")[0]);
    expect(baseProps.onClose).toHaveBeenCalled();
  });

  it("disables the action while processing and shows the processing label", () => {
    render(
      <BulkSelectionBar
        {...baseProps}
        isActionProcessing
        actionProcessingLabel="Removing..."
        actionTestId="bar-action"
      />
    );
    expect(first("bar-action")).toBeDisabled();
    expect(screen.getAllByText("Removing...").length).toBeGreaterThan(0);
  });

  it("disables the action when nothing is selected", () => {
    render(<BulkSelectionBar {...baseProps} selectedCount={0} actionTestId="bar-action" />);
    expect(first("bar-action")).toBeDisabled();
  });

  it("renders a green (success) action for restore", () => {
    render(
      <BulkSelectionBar {...baseProps} actionLabel="Restore" actionVariant="success" actionTestId="bar-action" />
    );
    expect(first("bar-action").className).toContain("bg-green-600");
  });
});

describe("BulkRemoveConfirmModal — BACKLOG-1719", () => {
  it("summarises conversation + item counts and confirms", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <BulkRemoveConfirmModal
        conversationCount={2}
        itemCount={3}
        itemNoun="email"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    expect(screen.getByTestId("bulk-remove-confirm-title")).toHaveTextContent(
      "Remove 2 conversations (3 emails)?"
    );

    await userEvent.click(screen.getByTestId("bulk-remove-confirm-button"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("uses singular nouns for a single conversation / item", () => {
    render(
      <BulkRemoveConfirmModal
        conversationCount={1}
        itemCount={1}
        itemNoun="text"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    );
    expect(screen.getByTestId("bulk-remove-confirm-title")).toHaveTextContent(
      "Remove 1 conversation (1 text)?"
    );
  });
});
