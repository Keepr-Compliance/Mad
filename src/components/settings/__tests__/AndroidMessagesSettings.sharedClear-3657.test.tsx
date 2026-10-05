/**
 * BACKLOG-3657 (founder re-confirmed 2026-10-01) — Android's Force re-import
 * is SHARED: the Android Companion section's Force re-import also clears the
 * texts imported from Google Messages, behind ONE confirmation naming both.
 *
 * Mutations that turn this red: the warning no longer names both sources or
 * "Show removed"; the result line drops the Google Messages count; a partial
 * clear shown as a success.
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
  clearAndroidData.mockResolvedValue({ messagesDeleted: 12, contactsDeleted: 3, gmwebMessagesDeleted: 50, gmwebCleared: true, androidCleared: true });
  (window.api.localSync as unknown as { clearAndroidData: jest.Mock }).clearAndroidData = clearAndroidData;
});

describe("BACKLOG-3657 — the Android Companion's Force re-import is shared with Google Messages", () => {
  it("one warning names both sources and says removed chats stay removed", async () => {
    render(<AndroidMessagesSettings userId="user-3657" />);
    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));
    const warning = await screen.findByTestId("android-force-warning");
    expect(warning).toHaveTextContent(
      "Force re-import will delete every text imported from your Android phone (Google Messages and Android Companion)",
    );
    expect(warning).toHaveTextContent(/Your iPhone and Mac texts stay\./);
    expect(warning).toHaveTextContent(/Chats you removed from a transaction stay removed when you sync again/);
    expect(warning).toHaveTextContent(/“Show removed”/);
  });

  it("after the clear, the result names both sources' counts", async () => {
    render(<AndroidMessagesSettings userId="user-3657" />);
    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));
    fireEvent.click(await screen.findByRole("button", { name: /continue with re-import/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Cleared 62 texts and 3 contacts. Sync Android on the dashboard, or Sync Now in the Android Companion, to get them back.",
    );
    expect(clearAndroidData).toHaveBeenCalledWith({ userId: "user-3657" });
  });

  it("a partial or refused clear shows its error, not a success line", async () => {
    clearAndroidData.mockResolvedValue({
      messagesDeleted: 0, contactsDeleted: 0, gmwebMessagesDeleted: 50, gmwebCleared: true, androidCleared: false,
      error: "The texts imported from Google Messages were cleared, but the Android Companion texts and contacts were not. Try Force re-import again.",
    });
    render(<AndroidMessagesSettings userId="user-3657" />);
    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));
    fireEvent.click(await screen.findByRole("button", { name: /continue with re-import/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/but the Android Companion texts and contacts were not/);
    expect(screen.queryByText(/^Cleared /)).toBeNull();
  });
});
