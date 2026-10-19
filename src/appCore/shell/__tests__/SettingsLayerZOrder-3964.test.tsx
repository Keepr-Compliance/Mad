/**
 * BACKLOG-3964 slice 2 fix-up: stacking order around the Settings page, and the
 * title-bar initials while Settings shows.
 *
 * jsdom has no layout, so z-order is asserted on what the shipped components
 * actually render: the z-index class on the real NotificationContainer toast
 * region, the real SupportWidget "?" button and the real SettingsLayer root,
 * read through src/constants/zLayers (the same literals the components emit).
 * The toast is raised by the real NotificationProvider from inside the stub
 * Settings page, as General's "test notification" does.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppShell } from "../../AppShell";
import { useModalFlow } from "../../state/flows/useModalFlow";
import type { AppStateMachine } from "../../state/types";
import { NotificationProvider } from "../../../contexts/NotificationContext";
import { useNotification } from "../../../hooks/useNotification";
import { SupportWidget } from "../../../components/support/SupportWidget";
import { zValue } from "../../../constants/zLayers";

jest.mock("../../../utils/platform", () => ({
  ...jest.requireActual("../../../utils/platform"),
  isElectron: () => true,
}));
jest.mock("../../../hooks/useSessionValidator", () => ({ useSessionValidator: jest.fn() }));
jest.mock("../../../hooks/useIdleSessionExpiry", () => ({ useSessionIdleTimeout: jest.fn() }));
jest.mock("../../../components/SystemHealthMonitor", () => ({ __esModule: true, default: () => null }));
jest.mock("../ShellBanners", () => ({ ShellBanners: () => null }));
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isMacOS: true, isWindows: false, isLinux: false, platform: "macos" }),
}));
jest.mock("../../hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));

/** Stub page: a button that raises a toast the way General's "test notification" does. */
jest.mock("../../../components/Settings", () => {
  const React = jest.requireActual("react");
  const { useNotification: useNotif } = jest.requireActual("../../../hooks/useNotification");
  function StubSettings(props: { onClose: () => void }) {
    const { notify } = useNotif();
    return (
      <div data-testid="settings-page">
        <button data-testid="settings-close" onClick={props.onClose}>
          Back
        </button>
        <button data-testid="fire-toast" onClick={() => notify.success("Desktop notification sent!")}>
          test notification
        </button>
      </div>
    );
  }
  return { __esModule: true, default: StubSettings };
});

const user = { id: "user-1", email: "avery@example.com", display_name: "Avery Example" };

let modal: ReturnType<typeof useModalFlow>;

function Harness() {
  modal = useModalFlow();
  const app = {
    currentStep: "dashboard",
    isAuthenticated: true,
    isDatabaseInitialized: true,
    currentUser: user,
    authProvider: "google",
    isTourActive: false,
    needsTermsAcceptance: false,
    handleLogout: jest.fn(),
    getPageTitle: () => "Dashboard",
    ...modal,
  } as unknown as AppStateMachine;
  return (
    <NotificationProvider>
      <AppShell app={app}>
        <div data-testid="dashboard" />
        {modal.modalState.showProfile && <div data-testid="profile-popup" />}
      </AppShell>
      <SupportWidget />
    </NotificationProvider>
  );
}

/** The z value of the first z-* class on an element. */
function zOf(el: HTMLElement): number {
  const cls = Array.from(el.classList).find((c) => c.startsWith("z-"));
  return cls ? zValue(cls) : NaN;
}

describe("Settings page stacking (BACKLOG-3964 slice 2 fix-up)", () => {
  it("a toast fired from inside Settings renders above the Settings layer", () => {
    render(<Harness />);
    act(() => modal.openSettings());
    fireEvent.click(screen.getByTestId("fire-toast"));
    const toasts = screen.getByTestId("notification-container");
    expect(toasts).toHaveTextContent("Desktop notification sent!");
    const layer = screen.getByTestId("settings-layer");
    expect(zOf(layer)).toBe(105); // the band the popups/Done-footer rulings rely on
    expect(zOf(toasts)).toBeGreaterThan(zOf(layer));
  });

  it('the "?" support button stays above the Settings layer and is reachable', () => {
    render(<Harness />);
    act(() => modal.openSettings());
    const help = screen.getByRole("button", { name: "Open support dialog" });
    expect(zOf(help)).toBeGreaterThan(zOf(screen.getByTestId("settings-layer")));
    expect(help).toBeVisible();
    expect(help.closest("[inert]")).toBeNull(); // not under the inert Dashboard container
  });
});

describe("title-bar initials while Settings shows", () => {
  it("opens Profile and closes Settings, so Profile is not hidden underneath", () => {
    render(<Harness />);
    act(() => modal.openSettings("settings-security"));
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-profile"));
    expect(screen.queryByTestId("settings-page")).toBeNull();
    expect(screen.getByTestId("profile-popup")).toBeInTheDocument();
    expect(modal.modalState.settingsTarget).toBeNull();
  });
});
