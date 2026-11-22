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
import {
  CLOUD_FIRST_ANSWER_BOUND_MS,
  CLOUD_VISIBLE_STORAGE_PREFIX,
  STRICT_ANSWER_TTL_MS,
  STRICT_FOCUS_THROTTLE_MS,
  StrictFeatureProvider,
} from "../../../contexts/StrictFeatureContext";

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
// Settings reports the view the test sets (BACKLOG-4263 W4), through the real hook.
let mockReportView: unknown = null;
jest.mock("../../../components/Settings", () => {
  const { useReportKeeprCloudView } = jest.requireActual("../../../contexts/StrictFeatureContext");
  function StubSettings() {
    useReportKeeprCloudView(mockReportView);
    return <div data-testid="settings-page" />;
  }
  return { __esModule: true, default: StubSettings };
});

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
const remember = (who: keyof typeof USERS, value: string) =>
  window.localStorage.setItem(CLOUD_VISIBLE_STORAGE_PREFIX + USERS[who].id, value);
const stored = (who: keyof typeof USERS) => window.localStorage.getItem(CLOUD_VISIBLE_STORAGE_PREFIX + USERS[who].id);

beforeEach(() => {
  frames = [];
  mockReportView = null;
  window.localStorage.clear();
  getView.mockReset();
  api.cloudSync = { getView };
  jest.mocked(window.api.featureGate.getAll).mockReset();
  jest.mocked(window.api.featureGate.getAll).mockImplementation(async (): Promise<Record<string, FeatureAccess>> => ({}));
  jest.mocked(window.api.featureGate.strictState).mockReset();
  jest.mocked(window.api.featureGate.strictState).mockImplementation(async () => "blocked");
});
afterEach(() => {
  delete api.cloudSync;
  jest.useRealTimers();
  jest.restoreAllMocks();
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

describe("C2 first open after sign-in, nothing remembered, answer inside the bound: no rows until every read has settled, then all rows in one commit", () => {
  it("plan and Learn settled, Keepr Cloud held (under the bound): only [] frames, then the full list", async () => {
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

describe("C8 a restart uses the remembered answer on the first frame", () => {
  it("remembered visible for A, main never answers: the first open has every row, Keepr Cloud included", async () => {
    remember("a", "1");
    getView.mockImplementation(never);
    render(<Root initial="a" />);
    await flush();
    expect(getView).toHaveBeenCalledTimes(1); // main is still asked
    openPanel();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    expect(frames[0]).toEqual(WITH_CLOUD);
  });

  it("remembered visible, main's start-up answer says hidden: it replaces the remembered value (never dropped as stale)", async () => {
    remember("a", "1");
    let releaseStart: (v: unknown) => void = () => undefined;
    getView.mockImplementationOnce(() => new Promise((r) => (releaseStart = r))).mockImplementation(never);
    render(<Root initial="a" />);
    await flush();
    expect(getView).toHaveBeenCalledTimes(1);
    await act(async () => releaseStart(HIDDEN));
    await flush();
    expect(stored("a")).toBe("0");
    openPanel(); // this open's own read never answers
    expect(rowsInDom()).toEqual(WITHOUT_CLOUD);
  });

  it("remembered visible, the panel open while main is asked: the late hidden answer removes the row", async () => {
    remember("a", "1");
    const held: Array<(v: unknown) => void> = [];
    getView.mockImplementation(() => new Promise((r) => held.push(r)));
    render(<Root initial="a" />);
    await flush();
    openPanel();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    await act(async () => held.forEach((r) => r(HIDDEN)));
    await flush();
    expect(rowsInDom()).toEqual(WITHOUT_CLOUD);
  });
});

describe("C9 nothing remembered: the rows wait at most the bound", () => {
  it("1499 ms: no rows; 1500 ms: rows without Keepr Cloud; main's late answer then adds the row", async () => {
    jest.useFakeTimers();
    const held: Array<(v: unknown) => void> = [];
    getView.mockImplementation(() => new Promise((r) => held.push(r)));
    render(<Root initial="a" />);
    await flush();
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(CLOUD_FIRST_ANSWER_BOUND_MS - 1);
    });
    expect(rowsInDom()).toEqual([]);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(rowsInDom()).toEqual(WITHOUT_CLOUD);
    await act(async () => held.forEach((r) => r(ON)));
    await flush();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    expect(stored("a")).toBe("1");
  });
});

describe("C10 remembered answers never cross user ids", () => {
  it("visible remembered for A only: B signs in with its read pending and gets no Keepr Cloud row", async () => {
    remember("a", "1");
    getView.mockImplementation(never);
    render(<Root initial="b" />);
    await flush();
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual([]);
    expect(stored("b")).toBeNull();
  });

  it("an unknown stored value counts as nothing remembered", async () => {
    remember("b", "yes");
    getView.mockImplementation(never);
    render(<Root initial="b" />);
    await flush();
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual([]);
  });

  it("a storage that throws on every call: the panel still renders main's answer", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    getView.mockResolvedValue(ON);
    render(<Root initial="a" />);
    await flush();
    openPanel();
    await flush();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
  });
});

describe("W4 an older read never overwrites a newer answer", () => {
  it("Settings reports hidden while the panel's earlier read is in flight; that read answering visible later is dropped", async () => {
    getView.mockResolvedValueOnce(ON);
    render(<Root initial="a" />);
    await flush();
    let releaseOld: (v: unknown) => void = () => undefined;
    getView.mockImplementationOnce(() => new Promise((r) => (releaseOld = r))).mockImplementation(never);
    openPanel();
    expect(rowsInDom()).toEqual(WITH_CLOUD);
    mockReportView = HIDDEN;
    fireEvent.click(screen.getByTestId("nav-settings")); // closes the panel, opens Settings, which reports hidden
    await flush();
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    await act(async () => releaseOld(ON));
    await flush();
    openPanel();
    expect(rowsInDom()).toEqual(WITHOUT_CLOUD);
  });
});

describe("W5 the Keepr Cloud read does not repeat on a timer or on window focus", () => {
  it("focus past the throttle and time past the answer TTL add no getView call", async () => {
    jest.useFakeTimers();
    getView.mockResolvedValue(ON);
    render(<Root initial="a" />);
    await flush();
    expect(getView).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(STRICT_FOCUS_THROTTLE_MS + 1);
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(STRICT_ANSWER_TTL_MS + 1);
    });
    await flush();
    expect(getView).toHaveBeenCalledTimes(1);
  });
});
