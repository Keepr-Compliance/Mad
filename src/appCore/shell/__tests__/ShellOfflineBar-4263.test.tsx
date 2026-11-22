/**
 * BACKLOG-4263: with Settings open and the app offline, the shell's offline bar is still rendered, outside
 * the Settings layer. Real AppShell + ShellBanners + OfflineBanner + ShellContent + SettingsLayer + useModalFlow;
 * Settings itself is a stub page (its own suite proves it has no offline notice of its own). `isOnline` is the
 * app-state field ShellBanners reads (useAppStateMachine.ts feeds `app.isOnline`).
 *
 * jsdom has no layout: this shows the bar is in the render tree, not that it is visible on screen.
 */
import { act, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppShell } from "../../AppShell";
import { useModalFlow } from "../../state/flows/useModalFlow";
import type { AppStateMachine } from "../../state/types";

jest.mock("../../../utils/platform", () => ({ isElectron: () => true, isMacOS: () => true }));
jest.mock("../../../hooks/useSessionValidator", () => ({ useSessionValidator: jest.fn() }));
jest.mock("../useTitleBarSync", () => ({ useTitleBarSync: () => ({ pill: null, onClick: () => {} }) }));
jest.mock("../../../hooks/useIdleSessionExpiry", () => ({ useSessionIdleTimeout: jest.fn() }));
jest.mock("../../../components/SystemHealthMonitor", () => ({ __esModule: true, default: () => null }));
// The two other shell banners are not under test here (they read their own state).
jest.mock("../../../components/setup/ResumeSetupBanner", () => ({ ResumeSetupBanner: () => null }));
jest.mock("../../../components/common/AtRestMigrationBanner", () => ({ AtRestMigrationBanner: () => null }));
jest.mock("../../hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));
jest.mock("../../../components/Settings", () => ({
  __esModule: true,
  default: () => <div data-testid="settings-page">Settings</div>,
}));

const user = { id: "user-1", email: "avery@example.com", display_name: "Avery Example" };
let modal: ReturnType<typeof useModalFlow>;

function Harness({ isOnline }: { isOnline: boolean }) {
  modal = useModalFlow();
  const app = {
    currentStep: "dashboard",
    isAuthenticated: true,
    isDatabaseInitialized: true,
    currentUser: user,
    authProvider: "google",
    isTourActive: false,
    needsTermsAcceptance: false,
    isOnline,
    isChecking: false,
    handleRetryConnection: jest.fn(),
    handleLogout: jest.fn(),
    getPageTitle: () => "Dashboard",
    ...modal,
  } as unknown as AppStateMachine;
  return (
    <AppShell app={app}>
      <div data-testid="dashboard">Dashboard</div>
    </AppShell>
  );
}

describe("shell offline bar with Settings open (BACKLOG-4263)", () => {
  it("offline: exactly one offline bar, rendered outside the Settings layer", () => {
    render(<Harness isOnline={false} />);
    act(() => modal.openSettings());
    const layer = screen.getByTestId("settings-layer");
    expect(within(layer).getByTestId("settings-page")).toBeInTheDocument();
    expect(screen.getAllByText("You're offline")).toHaveLength(1);
    expect(layer).not.toContainElement(screen.getByText("You're offline"));
  });

  it("online: no offline bar", () => {
    render(<Harness isOnline />);
    act(() => modal.openSettings());
    expect(screen.getByTestId("settings-layer")).toBeInTheDocument();
    expect(screen.queryAllByText("You're offline")).toHaveLength(0);
  });
});
