/**
 * BACKLOG-4263 fix 6 — the account panel's Keepr Cloud row comes from the
 * session provider, so it is on the first frame with the other rows.
 *
 * Real StrictFeatureProvider (as main.tsx mounts it) + real AppShell (which
 * opens the Keepr Cloud slot once the database is ready) + real useModalFlow.
 * Every panel commit is recorded through a Profiler, so "no frame with a
 * subset" is a claim about commits, not about the final DOM.
 *
 * Views transcribed from the real producer, CloudSyncService.getView
 * (electron/services/cloudSync/cloudSyncService.ts:188-200): its `base`
 * (status "hidden") and the same object with status "on".
 */
import type { FeatureAccess } from "../../../../electron/types/featureGate";
import React, { Profiler, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppShell } from "../../AppShell";
import { useModalFlow } from "../../state/flows/useModalFlow";
import type { AppStateMachine } from "../../state/types";
import { visibleSettingsTabs } from "../../../components/settings/settingsTabs";
import { StrictFeatureProvider } from "../../../contexts/StrictFeatureContext";

jest.mock("../../../utils/platform", () => ({
  ...jest.requireActual("../../../utils/platform"),
  isElectron: () => true,
  isMacOS: () => true,
}));
jest.mock("../../../hooks/useSessionValidator", () => ({ useSessionValidator: jest.fn() }));
jest.mock("../../../hooks/useIdleSessionExpiry", () => ({ useSessionIdleTimeout: jest.fn() }));
jest.mock("../../../components/SystemHealthMonitor", () => ({ __esModule: true, default: () => null }));
jest.mock("../ShellBanners", () => ({ ShellBanners: () => null }));
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isMacOS: true, isWindows: false, isLinux: false, platform: "macos" }),
}));
jest.mock("../../../contexts/LicenseContext", () => ({
  useLicense: () => ({ licenseType: "individual" }),
}));
jest.mock("../../hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));
jest.mock("../../../components/Settings", () => ({ __esModule: true, default: () => <div data-testid="settings-page" /> }));

const USERS = {
  // pii-allow-uuid: invented all-zero fixture ids, not from any live row
  a: { id: "00000000-0000-0000-0000-00000000000a", email: "avery@example.com", display_name: "Avery Example" },
  // pii-allow-uuid: invented all-zero fixture ids, not from any live row
  b: { id: "00000000-0000-0000-0000-00000000000b", email: "dana@example.com", display_name: "Dana Example" },
};
type Who = keyof typeof USERS | null;

const HIDDEN = {
  engineInstalled: true,
  status: "hidden",
  pausedReason: null,
  noticeVersion: null,
  pendingDeals: 0,
  notSavedDeals: 0,
  lastSavedAt: null,
  onlineNotHereDeals: 0,
  otherInstalls: null,
  aiAppsAvailable: true,
};
const ON = { ...HIDDEN, status: "on" };

/** AI add-on allowed (`{}`), Learn blocked: the expected lists below. */
const WITH_CLOUD = visibleSettingsTabs(true, false, true).map((t) => t.label);
const WITHOUT_CLOUD = visibleSettingsTabs(true, false, false).map((t) => t.label);

const getView = jest.fn();
const never = () => new Promise<never>(() => {});
const flush = () => act(async () => {});

let modal: ReturnType<typeof useModalFlow>;
/** The panel's row labels at every commit while the panel is mounted. */
let frames: string[][] = [];

function rowsInDom(): string[] | null {
  const panel = document.querySelector('[data-testid="account-panel"]');
  if (!panel) return null;
  return Array.from(panel.querySelectorAll('nav[aria-label="Settings"] button')).map((b) => b.textContent ?? "");
}

function Harness({ who, db }: { who: Who; db: boolean }) {
  modal = useModalFlow();
  const user = who ? USERS[who] : null;
  const app = {
    currentStep: user ? "dashboard" : "login",
    isAuthenticated: !!user,
    isDatabaseInitialized: db,
    currentUser: user,
    authProvider: "google",
    isTourActive: false,
    needsTermsAcceptance: false,
    handleLogout: jest.fn(),
    getPageTitle: () => "Dashboard",
    ...modal,
  } as unknown as AppStateMachine;
  return (
    <AppShell app={app}>
      <div />
    </AppShell>
  );
}

let setWho: (w: Who) => void = () => undefined;
let setDb: (v: boolean) => void = () => undefined;
function Root({ initial, dbReady = true }: { initial: Who; dbReady?: boolean }) {
  const [who, set] = useState<Who>(initial);
  const [db, setDbState] = useState(dbReady);
  setWho = set;
  setDb = setDbState;
  return (
    <Profiler
      id="app"
      onRender={() => {
        const rows = rowsInDom();
        if (rows) frames.push(rows);
      }}
    >
      <StrictFeatureProvider userId={who ? USERS[who].id : null} organizationId="org-1">
        <Harness who={who} db={db} />
      </StrictFeatureProvider>
    </Profiler>
  );
}

function openPanel(): void {
  fireEvent.click(screen.getByTestId("nav-profile"));
}
function closePanel(): void {
  fireEvent.click(screen.getByTestId("account-panel-close"));
  expect(screen.queryByTestId("account-panel")).toBeNull();
}
/** Distinct consecutive frames, so "[] then full" reads as exactly two entries. */
function distinct(list: string[][]): string[][] {
  return list.filter((f, i) => i === 0 || JSON.stringify(f) !== JSON.stringify(list[i - 1]));
}

const api = window.api as unknown as Record<string, unknown>;
beforeEach(() => {
  frames = [];
  getView.mockReset();
  api.cloudSync = { getView };
  jest.mocked(window.api.featureGate.getAll).mockReset();
  jest.mocked(window.api.featureGate.getAll).mockImplementation(async (): Promise<Record<string, FeatureAccess>> => ({}));
  jest.mocked(window.api.featureGate.strictState).mockReset();
  jest.mocked(window.api.featureGate.strictState).mockImplementation(async () => "blocked");
});
afterEach(() => {
  delete api.cloudSync;
});

describe("C1 a reopen has the Keepr Cloud row on its first frame", () => {
  it("session value known, the open's background read never answers: first frame = every row in final order, no later insertion", async () => {
    getView.mockResolvedValueOnce(ON).mockImplementation(never);
    render(<Root initial="a" />);
    await flush();
    expect(getView).toHaveBeenCalledTimes(1); // the session read, once the database is ready
    frames = [];
    openPanel();
    // Read synchronously: no await between the click and this line.
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    expect(frames[0]).toEqual(WITH_CLOUD);
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => JSON.stringify(f) === JSON.stringify(WITH_CLOUD))).toBe(true);
    expect(getView).toHaveBeenCalledTimes(2); // one background re-ask for the open
  });
});

describe("C2 first open after sign-in: no rows until every read has settled, then all rows in one commit", () => {
  it("plan and Learn settled, Keepr Cloud held: only [] frames, then the full list", async () => {
    const held: Array<(v: unknown) => void> = [];
    getView.mockImplementation(() => new Promise((r) => held.push(r)));
    render(<Root initial="a" />);
    await flush();
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual([]);
    expect(held.length).toBeGreaterThan(0);
    await act(async () => held.forEach((r) => r(ON)));
    await flush();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    expect(distinct(frames)).toEqual([[], WITH_CLOUD]);
  });

  it("Keepr Cloud settled, the plan held: only [] frames, then the full list", async () => {
    let releasePlan: (v: Record<string, FeatureAccess>) => void = () => undefined;
    jest.mocked(window.api.featureGate.getAll).mockImplementation(() => new Promise((r) => (releasePlan = r)));
    getView.mockResolvedValue(ON);
    render(<Root initial="a" />);
    await flush();
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual([]);
    await act(async () => releasePlan({}));
    await flush();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    expect(distinct(frames)).toEqual([[], WITH_CLOUD]);
  });
});

describe("C3 a change while the panel is closed", () => {
  it("hidden -> visible -> hidden: each open corrects in the background, the next open shows it on the first frame; a failed read keeps the last answer", async () => {
    getView.mockResolvedValue(HIDDEN);
    render(<Root initial="a" />);
    await flush();
    openPanel();
    expect(rowsInDom()).toEqual(WITHOUT_CLOUD);
    closePanel();

    // Turned visible in main while closed. This open still starts from the
    // stored answer and corrects one background read later...
    getView.mockResolvedValue(ON);
    openPanel();
    expect(rowsInDom()).toEqual(WITHOUT_CLOUD);
    await flush();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    closePanel();
    // ...so the next open has it on the first frame, even with its read hanging.
    getView.mockImplementation(never);
    openPanel();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    closePanel();

    // Visible -> hidden, the same way.
    getView.mockReset();
    getView.mockResolvedValue(HIDDEN);
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual(WITHOUT_CLOUD);
    closePanel();
    getView.mockImplementation(never);
    openPanel();
    expect(rowsInDom()).toEqual(WITHOUT_CLOUD);
    closePanel();

    // A failed read (main unreachable) keeps the last answer: visible stays visible.
    getView.mockReset();
    getView.mockResolvedValue(ON);
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    closePanel();
    getView.mockReset();
    getView.mockRejectedValue(new Error("unreachable"));
    openPanel();
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(getView).toHaveBeenCalledTimes(1);
    expect(rowsInDom()).toEqual(WITH_CLOUD);
  });
});

describe("C4 sign-out and account switch clear the answer", () => {
  it("A visible, sign out, B signs in with its read pending: B's panel has no rows (nothing from A)", async () => {
    getView.mockResolvedValue(ON);
    render(<Root initial="a" />);
    await flush();
    openPanel();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    closePanel();
    getView.mockImplementation(never);
    act(() => setWho(null));
    await flush();
    act(() => setWho("b"));
    await flush();
    frames = [];
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual([]);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.length === 0)).toBe(true);
  });

  it("A visible, switch to B whose read fails: B settles with no Keepr Cloud row", async () => {
    getView.mockResolvedValue(ON);
    render(<Root initial="a" />);
    await flush();
    openPanel();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    closePanel();
    getView.mockReset();
    getView.mockRejectedValue(new Error("unreachable"));
    act(() => setWho(null));
    await flush();
    act(() => setWho("b"));
    await flush();
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual(WITHOUT_CLOUD);
  });
});

describe("C7 the session read waits for the local database", () => {
  it("restored session: nothing is asked before the database is open (main would answer hidden), so the first open has the row", async () => {
    let dbOpen = false;
    // As main: "hidden" while its database is not initialized (cloudSyncService.ts:202), the real view after.
    getView.mockImplementation(async () => (dbOpen ? ON : HIDDEN));
    render(<Root initial="a" dbReady={false} />);
    await flush();
    expect(getView).not.toHaveBeenCalled();
    dbOpen = true;
    act(() => setDb(true));
    await flush();
    expect(getView).toHaveBeenCalledTimes(1);
    getView.mockImplementation(never);
    openPanel();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
  });
});
