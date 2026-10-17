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
 *
 * ## BACKLOG-3969: the Android panel is gone
 *
 * `AndroidMessagesSettings` (the Wi-Fi companion panel) was removed with the
 * companion's desktop server. What survives here:
 *   - the macOS panel still never writes the Android namespace (rendered);
 *   - the Android namespace rules themselves — `resolveAndroidImportFilters`
 *     and `androidFilterPatch` — driven as functions through the same merge.
 *     They have no desktop caller now; they are kept because
 *     `android-companion/services/syncWindow.ts` restates them, and its mirror
 *     test (`syncWindow.mirror-2800`) pins the same cases (BACKLOG-3990).
 * Deleted: the seed-race block, which tested only the removed panel's
 * disabled dropdowns. The DEFAULT_LOOKBACK_MONTHS pin now rests on
 * `MacOSMessagesImportSettings.allTime-2561.test.tsx` alone.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import { TextsLookbackSettings } from "../TextsLookbackSettings";
import { TextsLookbackProvider } from "../textsLookback";
import { androidFilterPatch, resolveAndroidImportFilters } from "../messageImportPreferences";

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
  /**
   * BACKLOG-3208: the macOS Messages panel now asks whether Full Disk Access is
   * usable before it offers an import, through the same service abstraction it
   * already uses for preferences. Granted is this suite's premise — nothing
   * here is about the permission notice. Its own suite is
   * `MacOSMessagesImportSettings.fdaRecovery-3208.test.tsx`.
   */
  systemService: {
    checkMessagesPermission: jest
      .fn()
      .mockResolvedValue({ success: true, data: { hasPermission: true } }),
    openFullDiskAccessSettings: jest.fn().mockResolvedValue({ success: true }),
    relaunchApp: jest
      .fn()
      .mockResolvedValue({ success: true, data: { relaunched: true } }),
  },
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

/**
 * BACKLOG-3892 S3: the macOS lookback dropdown is the shared "How far back to
 * import texts" picker now, outside the panel. Rendered as Settings composes
 * it, so the macOS half's lookback can still be read off the screen.
 */
const renderMacWithSharedPicker = () =>
  renderStrict(
    <TextsLookbackProvider userId="u-2734">
      <TextsLookbackSettings userId="u-2734" />
      <MacOSMessagesImportSettings userId="u-2734" />
    </TextsLookbackProvider>
  );

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

/** Apply a patch exactly as `preferences:update` would. */
const write = (patch: unknown) => {
  store = deepMerge(store, patch);
};

describe("BACKLOG-2734 · the macOS panel and the Android namespace do not reconfigure each other", () => {
  it("an Android filter write leaves the macOS preference byte-for-byte intact", async () => {
    store = {
      messageImport: { filters: { lookbackMonths: 12, maxMessages: 10000 } },
    };

    write(androidFilterPatch({ lookbackMonths: 12, maxMessages: 50000 }));

    expect(androidFilters()).toEqual({ lookbackMonths: 12, maxMessages: 50000 });
    // The macOS half of the store — the one the main process imports with — is
    // exactly what it was. Not "still an object", not "still has a cap": equal.
    expect(sharedFilters()).toEqual({ lookbackMonths: 12, maxMessages: 10000 });

    // The macOS panel, reading the same store, still shows the user's macOS choice.
    renderMacWithSharedPicker();
    await waitFor(() =>
      expect(screen.getByDisplayValue("Last 1 year")).toBeInTheDocument()
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

    renderMacWithSharedPicker();
    await waitFor(() =>
      expect(screen.getByDisplayValue("Last 1 year")).toBeInTheDocument()
    );

    await userEvent.selectOptions(
      screen.getByDisplayValue("10,000"),
      "100000"
    );
    await waitFor(() =>
      expect(sharedFilters()).toEqual({ lookbackMonths: 12, maxMessages: 100000 })
    );

    expect(androidFilters()).toEqual({ lookbackMonths: 6, maxMessages: 50000 });
    // No write was ever addressed to the Android namespace.
    expect(updateCalls).not.toContainEqual(
      expect.objectContaining({
        messageImport: expect.objectContaining({ android: expect.anything() }),
      })
    );
    expect(resolveAndroidImportFilters(store)).toEqual({
      lookbackMonths: 6,
      maxMessages: 50000,
      needsSeed: false,
    });
  });
});

describe("BACKLOG-2734 · the Android namespace's one-time seed (kept for the companion mirror)", () => {
  it("seeds from the value the panels shared", () => {
    store = {
      messageImport: { filters: { lookbackMonths: 18, maxMessages: 10000 } },
    };
    expect(resolveAndroidImportFilters(store)).toEqual({
      lookbackMonths: 18,
      maxMessages: 10000,
      needsSeed: true,
    });
  });

  /**
   * The seed resolves the PAIR, not the raw legacy object, so a partial legacy
   * value (only the lookback ever changed) gets the default cap rather than a gap.
   */
  it("completes a partial shared value instead of carrying its gaps across", () => {
    store = { messageImport: { filters: { lookbackMonths: 18 } } };
    expect(resolveAndroidImportFilters(store)).toEqual({
      lookbackMonths: 18,
      maxMessages: 50000,
      needsSeed: true,
    });
  });

  it("preserves an explicit All time / Unlimited rather than defaulting it", () => {
    store = {
      messageImport: { filters: { lookbackMonths: null, maxMessages: null } },
    };
    expect(resolveAndroidImportFilters(store)).toEqual({
      lookbackMonths: null,
      maxMessages: null,
      needsSeed: true,
    });
  });

  /** Idempotence is by STATE: once the namespace exists, no seed is owed. */
  it("owes no seed once the namespace exists, and reads the Android value, not the shared one", () => {
    store = {
      messageImport: {
        filters: { lookbackMonths: 12, maxMessages: 10000 },
        android: { filters: { lookbackMonths: 6, maxMessages: 50000 } },
      },
    };
    expect(resolveAndroidImportFilters(store)).toEqual({
      lookbackMonths: 6,
      maxMessages: 50000,
      needsSeed: false,
    });
  });
});
