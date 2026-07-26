/**
 * BACKLOG-322 Phase A — the Attachments tab is restored (was hidden). The count
 * badge was removed per founder feedback; only the tab button remains.
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
    render(<TransactionTabs {...baseProps} onTabChange={onTabChange} />);
    const tab = screen.getByTestId("tab-attachments");
    expect(tab).toBeInTheDocument();
    fireEvent.click(tab);
    expect(onTabChange).toHaveBeenCalledWith("attachments");
  });

  it("does NOT render a count badge on the Attachments tab", () => {
    render(<TransactionTabs {...baseProps} />);
    expect(screen.queryByTestId("tab-attachments-badge")).not.toBeInTheDocument();
  });
});
