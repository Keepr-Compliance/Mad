/**
 * BACKLOG-2734 — two panels, two preference keys, no crosstalk.
 *
 * `AndroidMessagesSettings` and `MacOSMessagesImportSettings` both wrote and
 * read `messageImport.filters`, so a user who set "Last 3 months" on the Android
 * companion panel silently narrowed the macOS iMessage import — and the macOS
 * panel then displayed that window as though it had been chosen there. Neither
 * screen said the setting was shared.
 *
 * The Android panel now owns `messageImport.android.filters`. The macOS panel
 * keeps `messageImport.filters`, which is the key the MAIN process imports with
 * (`electron/services/importPlanInputs.ts` `loadStoredImportFilters`) — moving
 * that would relocate a fact four electron suites pin at its current address,
 * for no gain the user can see.
 *
 * ## These tests drive a real store, not a call-count
 *
 * Asserting "updatePreferences was called with the android key" proves where a
 * write is ADDRESSED, not that the sibling preference survives it. The store
 * below therefore merges writes the way the app does, and every assertion reads
 * the resulting STATE by identity.
 *
 * The merge is TRANSCRIBED from `electron/handlers/preferenceHandlers.ts`
 * (`deepMerge`, lines 207-227 at ee72c365e), which is the function
 * `preferences:update` actually applies — not an invented approximation. Its
 * recursion is the load-bearing property: had it replaced `messageImport`
 * wholesale, namespacing the Android panel would have DESTROYED the macOS
 * preferences on the first Android write.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AndroidMessagesSettings } from "../AndroidMessagesSettings";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";

// ---------------------------------------------------------------------------
// The preference store, merging exactly as the main process does
// ---------------------------------------------------------------------------

/** Transcribed from `preferenceHandlers.ts:229-232` (`isObject`). */
const isObject = (item: unknown): item is Record<string, unknown> =>
  item !== null && typeof item === "object" && !Array.isArray(item);

/** Transcribed from `preferenceHandlers.ts:207-227` (`deepMerge`). */
function deepMerge(target: unknown, source: unknown): Record<string, unknown> {
  const output = { ...(target as Record<string, unknown>) };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key) => {
      if (isObject(source[key])) {
        if (!(key in (target as Record<string, unknown>))) {
          output[key] = source[key];
        } else {
          output[key] = deepMerge(
            (target as Record<string, unknown>)[key],
            source[key]
          );
        }
      } else {
        output[key] = source[key];
      }
    });
  }
  return output;
}

let store: Record<string, unknown> = {};
const updateCalls: unknown[] = [];

const mockGetPreferences = jest.fn(async () => ({
  success: true,
  data: store,
}));
const mockUpdatePreferences = jest.fn(async (_userId: string, patch: unknown) => {
  updateCalls.push(patch);
  store = deepMerge(store, patch);
  return { success: true };
});

jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: (...args: unknown[]) =>
      (mockGetPreferences as unknown as (...a: unknown[]) => unknown)(...args),
    updatePreferences: (...args: unknown[]) =>
      (mockUpdatePreferences as unknown as (...a: unknown[]) => unknown)(...args),
  },
}));

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({ queue: [], requestSync: jest.fn() })),
}));

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

const messageImport = () =>
  (store as { messageImport?: Record<string, unknown> }).messageImport ?? {};
const sharedFilters = () =>
  (messageImport() as { filters?: unknown }).filters;
const androidFilters = () =>
  ((messageImport() as { android?: { filters?: unknown } }).android ?? {}).filters;

beforeEach(() => {
  store = {};
  updateCalls.length = 0;
  mockGetPreferences.mockClear();
  mockUpdatePreferences.mockClear();
  (window.api.localSync.getStatus as jest.Mock).mockResolvedValue({
    running: false,
    port: null,
    address: null,
    totalMessagesReceived: 0,
    lastSyncTimestamp: null,
  });
  (window.api.messages.getImportStatus as jest.Mock).mockResolvedValue({
    success: true,
    messageCount: 0,
    lastImportAt: null,
  });
  (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
    success: true,
    effectiveCutoffISO: null,
    source: "lookback-pref",
    lookbackMonths: null,
  });
  (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
    success: true,
    count: 10,
    filteredCount: 10,
  });
});

describe("BACKLOG-2734 · the panels no longer reconfigure each other", () => {
  it("an Android cap change leaves the macOS preference byte-for-byte intact", async () => {
    store = {
      messageImport: { filters: { lookbackMonths: 12, maxMessages: 10000 } },
    };

    const android = renderStrict(<AndroidMessagesSettings userId="u-2734" />);
    // The seed lands first; wait for it so the cap change merges onto it.
    await waitFor(() => expect(androidFilters()).toBeDefined());

    await userEvent.selectOptions(
      screen.getByDisplayValue("10,000"),
      "50000"
    );
    await waitFor(() =>
      expect(androidFilters()).toEqual({ lookbackMonths: 12, maxMessages: 50000 })
    );

    // The macOS half of the store — the one the main process imports with — is
    // exactly what it was. Not "still an object", not "still has a cap": equal.
    expect(sharedFilters()).toEqual({ lookbackMonths: 12, maxMessages: 10000 });
    // And no write was ever addressed to it.
    expect(updateCalls).not.toContainEqual(
      expect.objectContaining({
        messageImport: expect.objectContaining({ filters: expect.anything() }),
      })
    );

    android.unmount();

    // The macOS panel, reading the same store, still shows the user's macOS
    // choice — the display half of the same defect.
    renderStrict(<MacOSMessagesImportSettings userId="u-2734" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("Last 12 months")).toBeInTheDocument()
    );
    expect(screen.getByDisplayValue("10,000")).toBeInTheDocument();
  });

  it("a macOS cap change leaves the Android preference byte-for-byte intact", async () => {
    store = {
      messageImport: {
        filters: { lookbackMonths: 12, maxMessages: 10000 },
        android: { filters: { lookbackMonths: 6, maxMessages: 50000 } },
      },
    };

    const mac = renderStrict(<MacOSMessagesImportSettings userId="u-2734" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("Last 12 months")).toBeInTheDocument()
    );

    await userEvent.selectOptions(
      screen.getByDisplayValue("10,000"),
      "100000"
    );
    await waitFor(() =>
      expect(sharedFilters()).toEqual({ lookbackMonths: 12, maxMessages: 100000 })
    );

    expect(androidFilters()).toEqual({ lookbackMonths: 6, maxMessages: 50000 });

    mac.unmount();

    renderStrict(<AndroidMessagesSettings userId="u-2734" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("Last 6 months")).toBeInTheDocument()
    );
    expect(screen.getByDisplayValue("50,000")).toBeInTheDocument();
  });
});

describe("BACKLOG-2734 · the seed cannot race the user", () => {
  /**
   * The panel mounts showing its defaults and `getPreferences` is a round trip.
   * A user who changed a dropdown inside that window used to write a choice the
   * seed then deep-merged straight over — the panel displaying one value and the
   * store holding another, which is the told-versus-does defect this file family
   * exists to remove.
   *
   * The controls are therefore disabled until the read AND the seed have both
   * settled. This asserts the disabled attribute rather than attempting a click,
   * because a synthetic change event on a disabled `<select>` still reaches
   * React's handler — the test would prove the event system's behaviour, not the
   * guard's.
   */
  it("keeps both dropdowns disabled until the load and seed have settled", async () => {
    store = {
      messageImport: { filters: { lookbackMonths: 18, maxMessages: 10000 } },
    };
    let releasePrefs: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releasePrefs = resolve;
    });
    mockGetPreferences.mockImplementationOnce(async () => {
      await gate;
      return { success: true, data: store };
    });

    renderStrict(<AndroidMessagesSettings userId="u-2734" />);

    const rangeSelect = screen.getByDisplayValue("Last 3 months");
    const capSelect = screen.getByDisplayValue("50,000");
    expect(rangeSelect).toBeDisabled();
    expect(capSelect).toBeDisabled();

    releasePrefs!();

    await waitFor(() =>
      expect(screen.getByDisplayValue("Last 18 months")).not.toBeDisabled()
    );
    expect(screen.getByDisplayValue("10,000")).not.toBeDisabled();
    // The seed has landed by the time the controls open, so the first thing the
    // user can write merges onto a complete namespace.
    expect(androidFilters()).toEqual({ lookbackMonths: 18, maxMessages: 10000 });
  });

  /**
   * SETTLED, not succeeded — BACKLOG-2760's rule, applied here. A failed read
   * means the component's defaults ARE the effective preference, so the user
   * must still be able to change them; dead dropdowns would be the worse answer.
   */
  it("enables the dropdowns even when the preference read fails", async () => {
    mockGetPreferences.mockRejectedValueOnce(new Error("offline"));

    renderStrict(<AndroidMessagesSettings userId="u-2734" />);

    await waitFor(() =>
      expect(screen.getByDisplayValue("Last 3 months")).not.toBeDisabled()
    );
    expect(screen.getByDisplayValue("50,000")).not.toBeDisabled();
  });
});

describe("BACKLOG-2734 · the one-time migration", () => {
  it("seeds the Android namespace from the value the panels shared", async () => {
    store = {
      messageImport: { filters: { lookbackMonths: 18, maxMessages: 10000 } },
    };

    renderStrict(<AndroidMessagesSettings userId="u-2734" />);

    await waitFor(() =>
      expect(androidFilters()).toEqual({ lookbackMonths: 18, maxMessages: 10000 })
    );
    // Seeding is not editing: the shared value is untouched by the migration.
    expect(sharedFilters()).toEqual({ lookbackMonths: 18, maxMessages: 10000 });
    expect(screen.getByDisplayValue("Last 18 months")).toBeInTheDocument();
    expect(screen.getByDisplayValue("10,000")).toBeInTheDocument();
  });

  /**
   * The seed writes the RESOLVED PAIR, not the raw legacy object. A partial
   * legacy value (only ever the lookback changed) would otherwise seed
   * `{ lookbackMonths: 18 }`, and the next Android write would deep-merge onto
   * a namespace with no cap — resolving to the 50,000 default and quietly
   * discarding a legacy cap of 10,000. The migration meant to preserve the
   * preference would be the thing that lost it.
   */
  it("completes a partial shared value instead of carrying its gaps across", async () => {
    store = { messageImport: { filters: { lookbackMonths: 18 } } };

    renderStrict(<AndroidMessagesSettings userId="u-2734" />);

    await waitFor(() =>
      expect(androidFilters()).toEqual({ lookbackMonths: 18, maxMessages: 50000 })
    );
  });

  it("preserves an explicit All time / Unlimited rather than defaulting it", async () => {
    store = {
      messageImport: { filters: { lookbackMonths: null, maxMessages: null } },
    };

    renderStrict(<AndroidMessagesSettings userId="u-2734" />);

    await waitFor(() =>
      expect(androidFilters()).toEqual({ lookbackMonths: null, maxMessages: null })
    );
    expect(screen.getByDisplayValue("All time")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Unlimited")).toBeInTheDocument();
  });

  /**
   * Idempotence is by STATE, not by a first-run guard (this repo's StrictMode
   * antipattern): a load that FINDS the namespace writes nothing. That is the
   * property that matters — it holds on every subsequent mount forever, whereas
   * "called once" holds only for the run that seeded.
   */
  it("writes nothing on a load that finds the namespace already seeded", async () => {
    store = {
      messageImport: {
        filters: { lookbackMonths: 12, maxMessages: 10000 },
        android: { filters: { lookbackMonths: 6, maxMessages: 50000 } },
      },
    };

    renderStrict(<AndroidMessagesSettings userId="u-2734" />);

    await waitFor(() =>
      expect(screen.getByDisplayValue("Last 6 months")).toBeInTheDocument()
    );
    expect(updateCalls).toEqual([]);
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
  });

  it("re-mounting after a seed does not write again", async () => {
    store = {
      messageImport: { filters: { lookbackMonths: 18, maxMessages: 10000 } },
    };

    const first = renderStrict(<AndroidMessagesSettings userId="u-2734" />);
    await waitFor(() => expect(androidFilters()).toBeDefined());
    const seededStore = JSON.parse(JSON.stringify(store));
    first.unmount();
    updateCalls.length = 0;
    mockUpdatePreferences.mockClear();

    renderStrict(<AndroidMessagesSettings userId="u-2734" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("Last 18 months")).toBeInTheDocument()
    );

    expect(mockUpdatePreferences).not.toHaveBeenCalled();
    expect(store).toEqual(seededStore);
  });
});
