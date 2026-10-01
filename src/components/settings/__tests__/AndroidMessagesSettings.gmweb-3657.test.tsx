/**
 * BACKLOG-3657 — Android Messages' Force re-import also clears the texts
 * imported from Google Messages for Web (founder: one shared reset).
 *
 * Mutations that turn this red: the warning no longer names Google Messages
 * for Web or "Show removed"; the result line drops the Google Messages count.
 *
 * Harness copied from AndroidMessagesSettings.forceCopy-3476.test.tsx.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AndroidMessagesSettings } from "../AndroidMessagesSettings";

jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: jest.fn().mockResolvedValue({ success: true, data: {} }),
    updatePreferences: jest.fn().mockResolvedValue({ success: true }),
  },
}));

const clearAndroidData = jest.fn();

beforeEach(() => {
  (window.api.localSync.getStatus as jest.Mock).mockResolvedValue({
    running: false,
    port: null,
    address: null,
    totalMessagesReceived: 0,
    lastSyncTimestamp: null,
  });
  clearAndroidData.mockResolvedValue({ messagesDeleted: 12, contactsDeleted: 3, gmwebMessagesDeleted: 50 });
  (window.api.localSync as unknown as { clearAndroidData: jest.Mock }).clearAndroidData = clearAndroidData;
});

describe("BACKLOG-3657 — Force re-import clears Google Messages for Web texts too", () => {
  it("the warning names both sources and says removed chats stay removed", async () => {
    render(<AndroidMessagesSettings userId="user-3657" />);
    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));
    const heading = await screen.findByText(/Force re-import will delete all Android data/);
    const warning = heading.parentElement as HTMLElement;
    expect(warning).toHaveTextContent(
      /deletes all Android texts and contacts in Keepr, including texts imported from Google Messages for Web/,
    );
    expect(warning).toHaveTextContent(/Chats you removed from a transaction stay removed when you sync again/);
    expect(warning).toHaveTextContent(/“Show removed”/);
  });

  it("after the clear, the result names the Google Messages for Web count", async () => {
    render(<AndroidMessagesSettings userId="user-3657" />);
    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));
    fireEvent.click(await screen.findByRole("button", { name: /continue with re-import/i }));
    expect(await screen.findByText(/plus 50 texts imported from Google Messages for Web/)).toBeInTheDocument();
    expect(clearAndroidData).toHaveBeenCalledWith({ userId: "user-3657" });
  });
});
