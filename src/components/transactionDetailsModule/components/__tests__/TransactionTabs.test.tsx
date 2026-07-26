/**
 * BACKLOG-322 Phase A — the Attachments tab is restored (was hidden) and shows a
 * unified attachment count badge.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionTabs } from "../TransactionTabs";

describe("TransactionTabs (BACKLOG-322)", () => {
  const baseProps = {
    activeTab: "overview" as const,
    conversationCount: 0,
    emailCount: 0,
    onTabChange: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it("renders the Attachments tab and fires onTabChange", () => {
    const onTabChange = jest.fn();
    render(<TransactionTabs {...baseProps} onTabChange={onTabChange} attachmentCount={0} />);
    const tab = screen.getByTestId("tab-attachments");
    expect(tab).toBeInTheDocument();
    fireEvent.click(tab);
    expect(onTabChange).toHaveBeenCalledWith("attachments");
  });

  it("shows the count badge when there are attachments", () => {
    render(<TransactionTabs {...baseProps} attachmentCount={7} />);
    expect(screen.getByTestId("tab-attachments-badge")).toHaveTextContent("7");
  });

  it("hides the badge when the count is zero", () => {
    render(<TransactionTabs {...baseProps} attachmentCount={0} />);
    expect(screen.queryByTestId("tab-attachments-badge")).not.toBeInTheDocument();
  });
});
