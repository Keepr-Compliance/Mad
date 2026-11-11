/**
 * BACKLOG-4188 — "Auto-discover from conversations": Outlook emails and Gmail
 * emails are ON when nothing is stored. A stored value always wins.
 *
 * The container resolves the stored preference (ContactsSettings.tsx) with the
 * renderer mirror of the main-process rule, so the switch drawn here matches
 * what main does with the same stored value. Both mailboxes are connected and
 * the plan answers "allowed" in every case, so the stored preference is the
 * only thing that can turn a switch off.
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContactsSettings } from "../ContactsSettings";
import { PlatformProvider } from "../../../contexts/PlatformContext";
import { settingsService } from "../../../services";

jest.mock("../../../services", () => ({
  settingsService: {
    updatePreferences: jest.fn().mockResolvedValue({ success: true }),
  },
}));

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ queue: [], isRunning: false, requestSync: jest.fn() }),
}));

jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

const originalApi = window.api;

const SWITCHES = {
  outlookEmails: "Outlook emails auto-discover",
  gmailEmails: "Gmail emails auto-discover",
} as const;
type Key = keyof typeof SWITCHES;

function renderSettings(inferred: Partial<Record<Key, boolean>> | undefined) {
  Object.defineProperty(window, "api", {
    value: {
      ...originalApi,
      system: { ...originalApi?.system, platform: "darwin" },
      featureGate: {
        ...originalApi?.featureGate,
        strictState: jest.fn().mockResolvedValue("allowed"),
      },
      contacts: {
        getExternalSyncStatus: jest
          .fn()
          .mockResolvedValue({ success: true, lastSyncAt: null, contactCount: 0 }),
        syncOutlookContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
        syncGoogleContacts: jest.fn().mockResolvedValue({ success: true, count: 0 }),
        syncExternal: jest.fn().mockResolvedValue({ success: true }),
        forceReimport: jest.fn().mockResolvedValue({ success: true, cleared: 0 }),
        getSourceStats: jest.fn().mockResolvedValue({ success: true, stats: {} }),
      },
    },
    writable: true,
    configurable: true,
  });

  const prefs = {
    phone_type: "iphone",
    contactSources: {
      direct: { macosContacts: true },
      ...(inferred ? { inferred } : {}),
    },
  };

  return render(
    <PlatformProvider>
      <ContactsSettings
        userId="user-1"
        initialPreferences={prefs as never}
        isMicrosoftConnected={true}
        isGoogleConnected={true}
      />
    </PlatformProvider>,
  );
}

/** Wait until the plan answer has landed and the switch is usable. */
async function enabledSwitch(key: Key): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByRole("switch", { name: SWITCHES[key] })).toBeEnabled());
  return screen.getByRole("switch", { name: SWITCHES[key] });
}

afterEach(() => {
  Object.defineProperty(window, "api", {
    value: originalApi,
    writable: true,
    configurable: true,
  });
  jest.clearAllMocks();
});

describe("BACKLOG-4188 — inferred email switches default ON in Settings", () => {
  for (const key of ["outlookEmails", "gmailEmails"] as const) {
    describe(key, () => {
      it("no contactSources.inferred at all → ON", async () => {
        renderSettings(undefined);
        expect(await enabledSwitch(key)).toHaveAttribute("aria-checked", "true");
      });

      it("inferred present, key absent → ON", async () => {
        renderSettings({});
        expect(await enabledSwitch(key)).toHaveAttribute("aria-checked", "true");
      });

      it("explicit false → OFF", async () => {
        renderSettings({ [key]: false });
        expect(await enabledSwitch(key)).toHaveAttribute("aria-checked", "false");
      });

      it("explicit true → ON", async () => {
        renderSettings({ [key]: true });
        expect(await enabledSwitch(key)).toHaveAttribute("aria-checked", "true");
      });

      it("clicking an unset (ON) switch stores an explicit false", async () => {
        renderSettings(undefined);
        fireEvent.click(await enabledSwitch(key));
        await waitFor(() => expect(settingsService.updatePreferences).toHaveBeenCalled());
        expect(settingsService.updatePreferences).toHaveBeenCalledWith(
          "user-1",
          expect.objectContaining({
            contactSources: expect.objectContaining({
              inferred: expect.objectContaining({ [key]: false }),
            }),
          }),
        );
        await waitFor(() =>
          expect(screen.getByRole("switch", { name: SWITCHES[key] })).toHaveAttribute(
            "aria-checked",
            "false",
          ),
        );
      });
    });
  }
});
