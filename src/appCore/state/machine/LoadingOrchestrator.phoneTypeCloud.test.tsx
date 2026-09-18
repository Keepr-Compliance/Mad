/**
 * BACKLOG-3276 — Phase 4 recovers a phone type that exists only in the cloud.
 *
 * On a fresh local profile `users_local.mobile_phone_type` is NULL while the
 * user's answer is already in Supabase (usePhoneTypeApi.ts writes the cloud copy
 * first). Phase 4 reads LOCAL only, so without this the user is asked again.
 *
 * FIXTURE PROVENANCE — the main process is simulated by a small store whose
 * behaviour is transcribed from the real handlers, not invented:
 *   user:get-phone-type          userSettingsHandlers.ts:33-98
 *     ok          -> { success: true, phoneType }                 (:80-83)
 *     no user row -> { success: true, phoneType: null }           (:76-78)
 *     DB not ready-> { success: false, phoneType: null, transient: true,
 *                      retryable: true, error: "Database is starting up" } (:63-69)
 *   user:sync-phone-type-from-cloud  userSettingsHandlers.ts:264-318
 *     cloud absent -> { success: true }, no write                 (:280-286)
 *     equal        -> { success: true }, no write                 (:290-297)
 *     user row     -> writes cloud value to local, { success: true } (:300-309, :317)
 *     no user row  -> { success: true }, no write                 (:310-317)
 *     thrown error -> { success: false, error }                   (wrapHandler.ts:64)
 *   user:get-phone-type-cloud    userSettingsHandlers.ts:160-191 -> { success: true, phoneType? }
 * A rejected promise stands for an IPC failure; Phase 4 already maps a rejected
 * local read to `{ success: false, phoneType: null }` (LoadingOrchestrator.tsx:620-623).
 *
 * The user is a returning user with a connected mailbox, swept over macOS and
 * Windows. `hasEmailConnected: true` distinguishes a normal load from the
 * catch-all fallback (LoadingOrchestrator.tsx fallbackData), which sets it false.
 * Windows reads the Apple driver state when the phone type is iPhone; the mock
 * reports it installed.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { LoadingOrchestrator } from "./LoadingOrchestrator";
import { AppStateProvider } from "./AppStateContext";
import { useAppState } from "./useAppState";
import { AuthProvider } from "../../../contexts/AuthContext";
import type { AppState } from "./types";

jest.mock("@sentry/electron/renderer", () => ({
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../../components/support/SupportWidget", () => ({ SupportWidget: () => null }));
jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true, isChecking: false, lastOnlineAt: null, lastOfflineAt: null,
    connectionError: null, checkConnection: jest.fn(), clearError: jest.fn(), setConnectionError: jest.fn(),
  }),
}));

type Phone = "iphone" | "android";
type Mode = "ok" | "reject" | "transient" | "fail";

/** Simulated main-process store. */
const store = {
  local: null as Phone | null,
  cloud: undefined as Phone | undefined,
  localUserExists: true,
  /** Behaviour of successive get-phone-type calls; missing entries are "ok". */
  localReads: [] as Mode[],
  sync: "ok" as Mode,
};

let localReadCount = 0;

const mockApi = {
  auth: { getCurrentUser: jest.fn(), preValidateSession: jest.fn(), checkEmailOnboarding: jest.fn() },
  system: {
    hasEncryptionKeyStore: jest.fn(), initializeSecureStorage: jest.fn(), onInitStage: jest.fn(),
    getInitStage: jest.fn(), checkAllConnections: jest.fn(), checkPermissions: jest.fn(),
  },
  user: {
    getPhoneType: jest.fn(async (_userId: string) => {
      const mode = store.localReads[localReadCount++] ?? "ok";
      if (mode === "reject") throw new Error("ipc failure");
      if (mode === "transient") {
        return { success: false, phoneType: null, transient: true, retryable: true, error: "Database is starting up" };
      }
      return { success: true, phoneType: store.localUserExists ? store.local : null };
    }),
    syncPhoneTypeFromCloud: jest.fn(async (_userId: string) => {
      if (store.sync === "reject") throw new Error("ipc failure");
      if (store.sync === "fail") return { success: false, error: "supabase unreachable" };
      if (!store.cloud) return { success: true };
      if (store.localUserExists && store.local === store.cloud) return { success: true };
      if (store.localUserExists) store.local = store.cloud;
      return { success: true };
    }),
    getPhoneTypeCloud: jest.fn(async (_userId: string) => ({ success: true, phoneType: store.cloud })),
  },
  preferences: { get: jest.fn() },
  drivers: { checkApple: jest.fn() },
};

beforeAll(() => {
  (window as unknown as { api: typeof mockApi }).api = mockApi;
});
afterAll(() => {
  delete (window as unknown as { api?: typeof mockApi }).api;
});

const baseUser = { id: "user-3276", email: "user@example.com" };
// hasIPhone:false — the value every production producer sets (LoadingOrchestrator.tsx:73-76, useLoginHandlers.ts:44).
const macOS = { isMacOS: true, isWindows: false, hasIPhone: false };
const windows = { isMacOS: false, isWindows: true, hasIPhone: false };
type Platform = typeof macOS;
let platform: Platform = macOS;

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window.navigator, "platform", { value: platform.isMacOS ? "MacIntel" : "Win32", configurable: true });
  mockApi.drivers.checkApple.mockResolvedValue({ isInstalled: true });
  Object.assign(store, { local: null, cloud: undefined, localUserExists: true, localReads: [], sync: "ok" });
  localReadCount = 0;

  mockApi.system.hasEncryptionKeyStore.mockReturnValue(new Promise(() => {}));
  mockApi.system.initializeSecureStorage.mockReturnValue(new Promise(() => {}));
  mockApi.auth.getCurrentUser.mockReturnValue(new Promise(() => {}));
  mockApi.auth.preValidateSession.mockReturnValue(new Promise(() => {}));
  mockApi.system.onInitStage.mockReturnValue(jest.fn());
  mockApi.system.getInitStage.mockResolvedValue({ stage: "complete" });
  mockApi.auth.checkEmailOnboarding.mockResolvedValue({ success: true, completed: false });
  mockApi.system.checkAllConnections.mockResolvedValue({
    success: true, google: { connected: true }, microsoft: { connected: false },
  });
  mockApi.system.checkPermissions.mockResolvedValue({ hasPermission: false, fullDiskAccess: false });
  mockApi.preferences.get.mockResolvedValue({ success: true, preferences: {} });
});

function Probe() {
  const { state } = useAppState();
  const view =
    state.status === "onboarding"
      ? {
          status: state.status,
          selectedPhoneType: state.selectedPhoneType ?? null,
          phoneTypeCompleted: state.completedSteps.includes("phone-type"),
          hasEmailConnected: state.hasEmailConnected ?? null,
        }
      : state.status === "ready"
        ? {
            status: state.status,
            selectedPhoneType: state.userData.phoneType,
            phoneTypeCompleted: state.userData.phoneType !== null,
            hasEmailConnected: state.userData.hasEmailConnected,
          }
        : { status: state.status };
  return <div data-testid="probe">{JSON.stringify(view)}</div>;
}

async function load() {
  render(
    <AuthProvider>
      <AppStateProvider initialState={{ status: "loading", phase: "loading-user-data", user: baseUser, platform } as AppState}>
        <LoadingOrchestrator>
          <Probe />
        </LoadingOrchestrator>
      </AppStateProvider>
    </AuthProvider>
  );
  await waitFor(() => expect(screen.getByTestId("probe")).toBeInTheDocument(), { timeout: 3000 });
  const view = JSON.parse(screen.getByTestId("probe").textContent ?? "{}");
  expect(["onboarding", "ready"]).toContain(view.status); // PRECONDITION: the load finished
  return view as { selectedPhoneType: Phone | null; phoneTypeCompleted: boolean; hasEmailConnected: boolean | null };
}

describe.each<[string, Platform]>([["macOS", macOS], ["Windows", windows]])(
  "BACKLOG-3276 [Q1] — Phase 4 recovers the cloud phone type on a fresh local profile (%s)",
  (_name, p) => {
    beforeAll(() => {
      platform = p;
    });
    it.each<Phone>(["iphone", "android"])(
      "[Q1-recover] local empty, cloud %s -> copied into the local record and loaded",
      async (phone) => {
        store.cloud = phone;
        const view = await load();

        expect(view.selectedPhoneType).toBe(phone);
        expect(view.phoneTypeCompleted).toBe(true);
        expect(mockApi.user.syncPhoneTypeFromCloud).toHaveBeenCalledTimes(1);
        expect(mockApi.user.syncPhoneTypeFromCloud).toHaveBeenCalledWith(baseUser.id);
        expect(store.local).toBe(phone); // the local record now holds it
        // The answer is the local RE-READ, taken after the sync.
        expect(mockApi.user.getPhoneType).toHaveBeenCalledTimes(2);
        const [firstRead, reRead] = mockApi.user.getPhoneType.mock.invocationCallOrder;
        const [syncCall] = mockApi.user.syncPhoneTypeFromCloud.mock.invocationCallOrder;
        expect(firstRead).toBeLessThan(syncCall);
        expect(syncCall).toBeLessThan(reRead);
      }
    );

    it("[Q1-cloud-empty] local empty, nothing in the cloud -> still unanswered", async () => {
      const view = await load();
      expect(view.selectedPhoneType).toBeNull();
      expect(view.phoneTypeCompleted).toBe(false);
    });

    it("[Q1-no-local-user] sync reports success but wrote nothing -> still unanswered", async () => {
      store.cloud = "iphone";
      store.localUserExists = false;
      const view = await load();
      expect(view.selectedPhoneType).toBeNull();
      expect(view.phoneTypeCompleted).toBe(false);
    });

    it("[Q1-reread-rejects] re-read fails -> unanswered, and the rest of the load is intact", async () => {
      store.cloud = "iphone";
      store.localReads = ["ok", "reject"];
      const view = await load();
      expect(view.selectedPhoneType).toBeNull();
      expect(view.phoneTypeCompleted).toBe(false);
      expect(view.hasEmailConnected).toBe(true); // not the catch-all fallback
    });

    it.each<Mode>(["reject", "fail"])(
      "[Q1-sync-%s] sync does not succeed -> unanswered, and the rest of the load is intact",
      async (mode) => {
        store.cloud = "iphone";
        store.sync = mode;
        const view = await load();
        expect(view.selectedPhoneType).toBeNull();
        expect(view.phoneTypeCompleted).toBe(false);
        expect(view.hasEmailConnected).toBe(true);
      }
    );

    it("[Q1-local-wins] local android, cloud iphone -> android, no cloud call, local record untouched", async () => {
      store.local = "android";
      store.cloud = "iphone";
      const view = await load();
      expect(view.selectedPhoneType).toBe("android");
      expect(mockApi.user.syncPhoneTypeFromCloud).not.toHaveBeenCalled();
      expect(mockApi.user.getPhoneType).toHaveBeenCalledTimes(1);
      expect(store.local).toBe("android");
    });

    it.each<Mode>(["transient", "reject"])(
      "[Q1-failed-read-%s] a FAILED local read stays unanswered and makes no cloud call",
      async (mode) => {
        store.cloud = "iphone";
        store.localReads = [mode];
        const view = await load();
        expect(view.selectedPhoneType).toBeNull();
        expect(view.phoneTypeCompleted).toBe(false);
        expect(mockApi.user.syncPhoneTypeFromCloud).not.toHaveBeenCalled();
        expect(store.local).toBeNull();
      }
    );
  }
);
