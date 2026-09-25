/**
 * BACKLOG-3476 — the Android force re-import warning names checklist links.
 *
 * Force re-import deletes every Android message (`clearAndroidData` →
 * `deleteMessagesByMetadataSource`), their attachments go with them, and
 * checklist links to those attachments cascade — proven on the real driver by
 * `checklistForceReimport-3475.test.ts`. The warning says so, unconditionally.
 *
 * Harness copied from AndroidMessagesSettings.panelHonesty-2795.test.tsx.
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

beforeEach(() => {
  (window.api.localSync.getStatus as jest.Mock).mockResolvedValue({
    running: false,
    port: null,
    address: null,
    totalMessagesReceived: 0,
    lastSyncTimestamp: null,
  });
});

describe("BACKLOG-3476 — Android force re-import warning", () => {
  it("says checklist links to those messages' attachments are removed too", async () => {
    render(<AndroidMessagesSettings userId="user-3476" />);

    fireEvent.click(await screen.findByRole("button", { name: /force re-import/i }));

    const heading = await screen.findByText(/Force re-import will delete all Android data/);
    const warning = heading.parentElement as HTMLElement;
    expect(warning).toHaveTextContent(
      /Links from checklist items to those messages’ attachments are removed too\./,
    );
  });
});
