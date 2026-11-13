/**
 * BACKLOG-4174 — the Settings tab list is held until the plan read and the
 * strict autodetect_eval read have both settled.
 *
 * The REAL useFeatureGate and useStrictFeatureState run here; only window.api
 * is mocked, with deferred promises so each test controls which read settles
 * first. Every DOM change to the tab list is recorded, and each control asserts:
 *   (a) no tab id appears and then disappears, and
 *   (b) the non-empty list is set exactly once (no tab is added late either).
 *
 *   C-A1   Settings page: plan read settles first, then the strict read.
 *   C-A1b  Settings page: strict read settles first, then the plan read.
 *   C-A2   Account panel rows, both orders.
 *   C-A3   plan read rejects: the tabs still appear, AI included (fail-open).
 */

import React from "react";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Settings from "../../Settings";
import { AccountPanel } from "../../../appCore/shell/AccountPanel";
import type { AppStateMachine } from "../../../appCore/state/types";
import { PlatformProvider } from "../../../contexts/PlatformContext";
import { NotificationProvider } from "../../../contexts/NotificationContext";

if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = jest.fn();
}

// Context providers the page needs; neither decides the tab list.
jest.mock("@/contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: true,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));
jest.mock("@/contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: new Date(),
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn().mockResolvedValue(true),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

// Fictional fixture values.
const ACCOUNT = { user: { id: "user-123", email: "avery@example.com", display_name: "Avery Example" }, provider: "google" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Records the tab ids after every DOM change; `take()` also records on demand. */
function recordIds(read: () => string[]): { snaps: string[][]; take: () => void; stop: () => string[][] } {
  const snaps: string[][] = [];
  const take = () => {
    const ids = read();
    const last = snaps[snaps.length - 1];
    if (!last || last.join() !== ids.join()) snaps.push(ids);
  };
  const mo = new MutationObserver(take);
  mo.observe(document.body, { childList: true, subtree: true, attributes: true });
  return {
    snaps,
    take,
    stop: () => {
      take();
      mo.disconnect();
      return snaps;
    },
  };
}

const settingsTabIds = (): string[] =>
  Array.from(document.querySelectorAll('[data-testid^="settings-tab-"]'))
    .map((e) => e.getAttribute("data-testid") ?? "")
    .filter((id) => id !== "settings-tab-strip");

const panelRowIds = (): string[] =>
  Array.from(document.querySelectorAll('nav[aria-label="Settings"] button')).map(
    (e) => e.getAttribute("data-testid") ?? "",
  );

function appearedThenDisappeared(snaps: string[][]): string[] {
  const seen = new Set<string>();
  const bad = new Set<string>();
  for (const s of snaps) {
    for (const id of seen) if (!s.includes(id)) bad.add(id);
    s.forEach((id) => seen.add(id));
  }
  return Array.from(bad);
}

function assertSettledOnce(snaps: string[][]): void {
  expect(snaps.length).toBeGreaterThan(0);
  expect(appearedThenDisappeared(snaps)).toEqual([]);
  expect(snaps.filter((s) => s.length > 0)).toHaveLength(1);
}

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

/** Plan read and strict read, each settled by the test. */
function mockReads(): {
  plan: Deferred<Record<string, { allowed: boolean }>>;
  strict: Deferred<string>;
} {
  const plan = deferred<Record<string, { allowed: boolean }>>();
  const strict = deferred<string>();
  jest.mocked(window.api.featureGate.getAll).mockReturnValue(plan.promise as never);
  jest.mocked(window.api.featureGate.strictState).mockImplementation(((key: string) =>
    key === "autodetect_eval" ? strict.promise : Promise.resolve("blocked")) as never);
  return { plan, strict };
}

function mockSettingsApi(): void {
  jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
    success: true,
    google: { connected: false },
    microsoft: { connected: false },
  });
  jest.mocked(window.api.preferences.get).mockResolvedValue({
    success: true,
    preferences: { export: { defaultFormat: "combined-pdf" } },
  });
  jest.mocked(window.api.preferences.update).mockResolvedValue({ success: true });
  jest.mocked(window.api.onGoogleMailboxConnected).mockReturnValue(jest.fn());
  jest.mocked(window.api.onMicrosoftMailboxConnected).mockReturnValue(jest.fn());
  jest.mocked(window.api.onGoogleMailboxDisconnected).mockReturnValue(jest.fn());
  jest.mocked(window.api.onMicrosoftMailboxDisconnected).mockReturnValue(jest.fn());
  jest.mocked(window.api.messages.onImportProgress).mockReturnValue(jest.fn());
  jest.mocked(window.api.llm.getConfig).mockResolvedValue({ success: true, data: {} } as never);
  jest.mocked(window.api.llm.getUsage).mockResolvedValue({
    success: true,
    data: { tokensThisMonth: 0, platformAllowance: 10000, platformUsed: 0 },
  } as never);
  window.api.update.checkForUpdates = jest.fn().mockResolvedValue({ updateAvailable: false });
  window.api.auth.getActiveDevices = jest.fn().mockResolvedValue({ success: true, devices: [] });
  window.api.transactions.precacheEmails = jest
    .fn()
    .mockResolvedValue({ success: true, emailsFetched: 0, emailsStored: 0 });
  window.api.preferences.save = jest.fn().mockResolvedValue({ success: true });
  (window.api as unknown as { learn: unknown }).learn = {
    getState: jest.fn().mockResolvedValue({
      success: true,
      available: true,
      enabled: false,
      answers: { deal: 0, bulk: 0 },
      pilotReport: false,
      pilotPending: false,
      pilotLastSentAt: null,
    }),
  };
}

function renderSettings(): void {
  render(
    <NotificationProvider>
      <PlatformProvider>
        <Settings
          account={ACCOUNT}
          userId="user-123"
          onClose={jest.fn()}
          onStartLearn={jest.fn()}
          onSeeLearnScore={jest.fn()}
        />
      </PlatformProvider>
    </NotificationProvider>,
  );
}

function renderPanel(): void {
  const app = {
    modalState: { showProfile: true },
    // pii-allow-uuid: invented all-zero fixture id, not from any live row
    currentUser: { id: "00000000-0000-0000-0000-000000000001", email: "avery@example.com", display_name: "Avery Example" },
    closeProfile: jest.fn(),
    openSettings: jest.fn(),
    handleLogout: jest.fn(),
  } as unknown as AppStateMachine;
  render(<AccountPanel app={app} />);
}

beforeEach(() => {
  mockSettingsApi();
});

describe("BACKLOG-4174 Settings tab strip waits for both reads", () => {
  it("C-A1: plan read settles first, then the strict read — no tab appears then disappears; list set once", async () => {
    const { plan, strict } = mockReads();
    const rec = recordIds(settingsTabIds);
    renderSettings();
    rec.take();
    await tick();
    await act(async () => plan.resolve({ ai_detection: { allowed: false } }));
    await tick();
    await act(async () => strict.resolve("allowed"));
    await tick();
    const snaps = rec.stop();
    const final = snaps[snaps.length - 1];
    expect(final).toContain("settings-tab-learn");
    expect(final).toContain("settings-tab-account");
    expect(final).not.toContain("settings-tab-ai");
    assertSettledOnce(snaps);
  });

  it("C-A1b: strict read settles first, then the plan read — no tab appears then disappears; list set once", async () => {
    const { plan, strict } = mockReads();
    const rec = recordIds(settingsTabIds);
    renderSettings();
    rec.take();
    await tick();
    await act(async () => strict.resolve("allowed"));
    await tick();
    await act(async () => plan.resolve({ ai_detection: { allowed: false } }));
    await tick();
    const snaps = rec.stop();
    const final = snaps[snaps.length - 1];
    expect(final).toContain("settings-tab-learn");
    expect(final).toContain("settings-tab-account");
    expect(final).not.toContain("settings-tab-ai");
    assertSettledOnce(snaps);
  });

  it("C-A3: plan read rejects — the tabs still appear, AI included (fail-open); list set once", async () => {
    const { plan, strict } = mockReads();
    const rec = recordIds(settingsTabIds);
    renderSettings();
    rec.take();
    await tick();
    await act(async () => strict.resolve("blocked"));
    await tick();
    await act(async () => plan.reject(new Error("offline")));
    expect(await screen.findByTestId("settings-tab-ai")).toBeInTheDocument();
    await tick();
    const snaps = rec.stop();
    const final = snaps[snaps.length - 1];
    expect(final).toContain("settings-tab-account");
    expect(final).toContain("settings-tab-ai");
    expect(final).not.toContain("settings-tab-learn");
    assertSettledOnce(snaps);
  });
});

describe("BACKLOG-4174 C-A2 account panel rows wait for both reads", () => {
  it.each(["planFirst", "strictFirst"] as const)(
    "C-A2 (%s): no row appears then disappears; rows set once",
    async (order) => {
      const { plan, strict } = mockReads();
      const rec = recordIds(panelRowIds);
      renderPanel();
      rec.take();
      await tick();
      const settlePlan = async () => {
        await act(async () => plan.resolve({ ai_detection: { allowed: false } }));
        await tick();
      };
      const settleStrict = async () => {
        await act(async () => strict.resolve("allowed"));
        await tick();
      };
      if (order === "planFirst") {
        await settlePlan();
        await settleStrict();
      } else {
        await settleStrict();
        await settlePlan();
      }
      const snaps = rec.stop();
      const final = snaps[snaps.length - 1];
      expect(final).toContain("account-panel-row-settings-learn");
      expect(final).toContain("nav-settings");
      expect(final).not.toContain("account-panel-row-settings-ai");
      assertSettledOnce(snaps);
    },
  );
});
