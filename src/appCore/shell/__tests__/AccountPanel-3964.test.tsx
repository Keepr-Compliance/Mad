/**
 * BACKLOG-3964 slice 3a — the account side panel (shell/AccountPanel).
 *
 * Real AppShell + real useModalFlow + real SupportWidget, so the initials,
 * the panel, the Settings layer and the "?" button are the shipped components.
 * Settings itself is a stub page (Back + target). jsdom has no layout: z-order
 * is read off the classes the components render; pixels are the built-app
 * cells (e2e/tests/settings-stacking.spec.ts).
 *
 * Controls (each mutation run against this file, see the IMPL comment):
 *   C1 bands · C3/C3b Esc layering · C4 Esc with the support form · C5/C5b rows
 *   · C6 inside vs scrim click · C7 focus · C13 row -> Settings · C14 Sign out
 *   · geometry (phone width, scrim, Electron top).
 */
import React, { useEffect, useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppShell } from "../../AppShell";
import { useModalFlow } from "../../state/flows/useModalFlow";
import type { AppStateMachine } from "../../state/types";
import { SupportWidget } from "../../../components/support/SupportWidget";
import { SETTINGS_TABS, visibleSettingsTabs } from "../../../components/settings/settingsTabs";
import { SETTINGS_TAB_ICONS, accountPanelRowTestId } from "../AccountPanel";
import { Z_CLASS, zValue } from "../../../constants/zLayers";
import { SUPPORT_DIALOG_SELECTOR } from "../../../components/support/supportDialogSelector";

let mockElectron = true;
jest.mock("../../../utils/platform", () => ({
  ...jest.requireActual("../../../utils/platform"),
  isElectron: () => mockElectron,
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
let mockHasAI = true;
jest.mock("../../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({ isAllowed: (key: string) => (key === "ai_detection" ? mockHasAI : true) }),
}));
jest.mock("../../hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));
jest.mock("../../../components/Settings", () => {
  function StubSettings(props: { onClose: () => void; initialSection?: string | null }) {
    return (
      <div data-testid="settings-page">
        <button data-testid="settings-close" onClick={props.onClose}>
          Back
        </button>
        <span data-testid="settings-target">{props.initialSection ?? "none"}</span>
      </div>
    );
  }
  return { __esModule: true, default: StubSettings };
});

const user = {
  // pii-allow-uuid: invented all-zero fixture id, not from any live row
  id: "00000000-0000-0000-0000-000000000001",
  email: "avery@example.com",
  display_name: "Avery Example",
};

/** Spies the popup fixtures report into. */
const popupEsc = { document: jest.fn(), window: jest.fn(), react: jest.fn() };

/** A popup under the panel with all three Escape handler shapes found in src. */
function PopupWithEscHandlers() {
  useEffect(() => {
    const onDoc = (e: KeyboardEvent) => e.key === "Escape" && popupEsc.document();
    const onWin = (e: KeyboardEvent) => e.key === "Escape" && popupEsc.window();
    document.addEventListener("keydown", onDoc);
    window.addEventListener("keydown", onWin);
    return () => {
      document.removeEventListener("keydown", onDoc);
      window.removeEventListener("keydown", onWin);
    };
  }, []);
  return (
    <div
      data-testid="popup-underneath"
      tabIndex={-1}
      onKeyDown={(e) => e.key === "Escape" && popupEsc.react()}
    />
  );
}

let modal: ReturnType<typeof useModalFlow>;
let setSignedIn: (v: boolean) => void;
const handleLogout = jest.fn();

function Harness() {
  modal = useModalFlow();
  const [signedIn, setSigned] = useState(true);
  setSignedIn = setSigned;
  const app = {
    currentStep: signedIn ? "dashboard" : "login",
    isAuthenticated: signedIn,
    isDatabaseInitialized: true,
    currentUser: signedIn ? user : null,
    authProvider: "google",
    isTourActive: false,
    needsTermsAcceptance: false,
    handleLogout,
    getPageTitle: () => "Dashboard",
    ...modal,
  } as unknown as AppStateMachine;
  return (
    <>
      <AppShell app={app}>
        <PopupWithEscHandlers />
      </AppShell>
      <SupportWidget accountPanelOpen={app.modalState.showProfile} />
    </>
  );
}

function zOf(el: HTMLElement): number {
  const cls = Array.from(el.classList).find((c) => c.startsWith("z-"));
  return cls ? zValue(cls) : NaN;
}

const help = () => screen.getByRole("button", { name: "Open support dialog" });

/** Click the initials the way a user does: focus lands on them first. */
function openFromInitials(): HTMLElement {
  const btn = screen.getByTestId("nav-profile");
  act(() => btn.focus());
  fireEvent.click(btn);
  return btn;
}

function mockSupportApi(): void {
  (window.api as unknown as Record<string, unknown>).support = {
    collectDiagnostics: jest.fn().mockResolvedValue({ success: true, diagnostics: null }),
    captureScreenshot: jest.fn().mockResolvedValue({ success: true, screenshot: null }),
    getCategories: jest.fn().mockResolvedValue({ success: true, categories: [] }),
    submitTicket: jest.fn().mockResolvedValue({ success: true, ticket_number: 1 }),
  };
  (window.api.auth as unknown as Record<string, unknown>).getCurrentUser = jest
    .fn()
    .mockResolvedValue({ success: true, user });
}

beforeEach(() => {
  mockElectron = true;
  mockHasAI = true;
  handleLogout.mockReset();
  Object.values(popupEsc).forEach((f) => f.mockReset());
  mockSupportApi();
});

describe("opening", () => {
  it("the initials open the panel over the app, and it shows who is signed in", () => {
    render(<Harness />);
    expect(screen.queryByTestId("account-panel")).toBeNull();
    openFromInitials();
    const panel = screen.getByRole("dialog", { name: "Account" });
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel).toHaveTextContent("Avery Example");
    expect(panel).toHaveTextContent("avery@example.com");
    expect(within(panel).getByTestId("account-panel-plan")).toHaveTextContent("Individual");
    expect(within(panel).getByTitle(user.id)).toHaveTextContent("0000…00001");
    expect(screen.getByTestId("nav-profile")).toHaveAttribute("aria-expanded", "true");
  });

  it("is dark, starts below the drag strip in Electron, ~256px on desktop and 82% + scrim on phones", () => {
    render(<Harness />);
    openFromInitials();
    const panel = screen.getByTestId("account-panel");
    const scrim = screen.getByTestId("account-panel-scrim");
    expect(panel).toHaveClass("bg-gray-900", "text-white", "fixed", "left-0", "bottom-0", "top-9");
    expect(panel).toHaveClass("w-[82%]", "sm:w-64", "overflow-y-auto");
    expect(scrim).toHaveClass("fixed", "top-9", "bg-gray-900/55", "sm:bg-gray-900/35");
  });

  it("starts at the very top outside Electron (no drag strip)", () => {
    mockElectron = false;
    render(<Harness />);
    openFromInitials();
    expect(screen.getByTestId("account-panel")).toHaveClass("top-0");
    expect(screen.getByTestId("account-panel-scrim")).toHaveClass("top-0");
  });
});

describe('C1 stacking bands: "?" above the panel, panel above its scrim, scrim above Settings', () => {
  it("reads the bands off the rendered elements", () => {
    render(<Harness />);
    openFromInitials();
    const panel = screen.getByTestId("account-panel");
    const scrim = screen.getByTestId("account-panel-scrim");
    expect(zOf(scrim)).toBeGreaterThan(zValue(Z_CLASS.settings));
    expect(zOf(panel)).toBeGreaterThan(zOf(scrim));
    expect(zOf(help())).toBeGreaterThan(zOf(panel));
    expect(zOf(help())).toBeLessThan(zValue(Z_CLASS.supportDialog));
  });

  it('keeps the "?" reachable and moves it beside the panel', () => {
    render(<Harness />);
    expect(help()).toHaveClass("left-4");
    openFromInitials();
    expect(help()).toHaveClass("left-[calc(82%_+_10px)]", "sm:left-[272px]", "bg-primary-600");
    expect(help()).not.toHaveAttribute("aria-hidden");
    expect(help().closest("[inert]")).toBeNull();
    expect(screen.getByTestId("account-panel")).not.toContainElement(help());
  });

  it('opens the support form above the panel when "?" is clicked', async () => {
    render(<Harness />);
    openFromInitials();
    await act(async () => {
      fireEvent.click(help());
    });
    const form = screen.getByTestId("support-ticket-dialog");
    // One selector: the form renders the id the panel and Settings look for (slice 3b dedupe).
    expect(document.querySelector(SUPPORT_DIALOG_SELECTOR)).toBe(form);
    expect(zOf(form)).toBeGreaterThan(zOf(screen.getByTestId("account-panel")));
    expect(screen.getByTestId("account-panel")).toBeInTheDocument();
  });
});

describe("C3 Esc closes the panel and nothing underneath", () => {
  it("panel open: Esc closes the panel; the popup's document, window and React handlers never fire", () => {
    render(<Harness />);
    openFromInitials();
    fireEvent.keyDown(screen.getByTestId("popup-underneath"), { key: "Escape" });
    expect(screen.queryByTestId("account-panel")).toBeNull();
    expect(popupEsc.document).not.toHaveBeenCalled();
    expect(popupEsc.window).not.toHaveBeenCalled();
    expect(popupEsc.react).not.toHaveBeenCalled();
  });

  it("C3b panel closed: Esc reaches all three popup handlers", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByTestId("popup-underneath"), { key: "Escape" });
    expect(popupEsc.document).toHaveBeenCalledTimes(1);
    expect(popupEsc.window).toHaveBeenCalledTimes(1);
    expect(popupEsc.react).toHaveBeenCalledTimes(1);
  });
});

describe("C4 Esc with the support form over the panel", () => {
  it("first Esc closes only the form; the second closes the panel", async () => {
    render(<Harness />);
    openFromInitials();
    await act(async () => {
      fireEvent.click(help());
    });
    expect(screen.getByTestId("support-ticket-dialog")).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("support-ticket-dialog")).toBeNull();
    expect(screen.getByTestId("account-panel")).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("account-panel")).toBeNull();
  });
});

describe("C5 rows = visibleSettingsTabs()", () => {
  const rowIds = (): string[] =>
    within(screen.getByRole("navigation", { name: "Settings" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("data-testid") ?? "");

  it.each([true, false])("one row per visible tab, in order, Account first (AI add-on: %s)", (hasAI) => {
    mockHasAI = hasAI;
    render(<Harness />);
    openFromInitials();
    const expected = visibleSettingsTabs(hasAI);
    const nav = screen.getByRole("navigation", { name: "Settings" });
    const rows = within(nav).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(expected.map((t) => t.label));
    expect(rows[0]).toHaveTextContent("Account");
    expect(rows[0]).toHaveAttribute("data-testid", "nav-settings");
    expect(rows.some((r) => r.textContent === "AI")).toBe(hasAI);
    // Every row's id is its own (SR change 4): no copy-pasted ids.
    expect(rowIds()).toEqual(expected.map((t) => accountPanelRowTestId(t.id)));
    expect(new Set(rowIds()).size).toBe(rows.length);
    expect(rowIds().slice(1).every((id) => id.startsWith("account-panel-row-settings-"))).toBe(true);
  });

  it("no row looks selected: the panel only opens with Settings closed (slice 3b)", () => {
    render(<Harness />);
    openFromInitials();
    expect(screen.queryByTestId("settings-page")).toBeNull();
    const rows = within(screen.getByRole("navigation", { name: "Settings" })).getAllByRole("button");
    for (const row of rows) {
      expect(row).not.toHaveClass("bg-gray-800");
      expect(row).not.toHaveClass("text-white");
      expect(row).not.toHaveAttribute("aria-current");
      expect(row).toHaveClass("text-gray-300");
    }
  });

  it("C5b every Settings tab has an icon, and every row draws it", () => {
    for (const tab of SETTINGS_TABS) expect(SETTINGS_TAB_ICONS[tab.id]).toBeDefined();
    render(<Harness />);
    openFromInitials();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    for (const row of within(nav).getAllByRole("button")) expect(row.querySelector("svg")).not.toBeNull();
  });
});

describe("C6 what closes it", () => {
  it("a click inside the panel does not close it; a click on the scrim does", () => {
    render(<Harness />);
    openFromInitials();
    fireEvent.click(screen.getByText("avery@example.com"));
    fireEvent.click(screen.getByTestId("account-panel"));
    expect(screen.getByTestId("account-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("account-panel-scrim"));
    expect(screen.queryByTestId("account-panel")).toBeNull();
  });

  it("the X closes it", () => {
    render(<Harness />);
    openFromInitials();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByTestId("account-panel")).toBeNull();
  });
});

describe("C7 focus", () => {
  it.each([
    ["X", () => fireEvent.click(screen.getByTestId("account-panel-close"))],
    ["Esc", () => fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" })],
    ["scrim", () => fireEvent.click(screen.getByTestId("account-panel-scrim"))],
  ])("starts on the X and returns to the initials after %s", (_how, close) => {
    render(<Harness />);
    const initials = openFromInitials();
    expect(document.activeElement).toBe(screen.getByTestId("account-panel-close"));
    act(() => close());
    expect(screen.queryByTestId("account-panel")).toBeNull();
    expect(document.activeElement).toBe(initials);
  });

  it("Tab and Shift+Tab cycle inside the panel", () => {
    render(<Harness />);
    openFromInitials();
    const first = screen.getByTestId("account-panel-close");
    const last = screen.getByTestId("account-panel-signout");
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    // Focus somehow outside: Tab brings it back in.
    act(() => screen.getByTestId("popup-underneath").focus());
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("leaves Tab to the support form while it is open above the panel", async () => {
    render(<Harness />);
    openFromInitials();
    await act(async () => {
      fireEvent.click(help());
    });
    const form = screen.getByTestId("support-ticket-dialog");
    const field = form.querySelector<HTMLElement>("input, textarea, button") as HTMLElement;
    act(() => field.focus());
    const notPrevented = fireEvent.keyDown(field, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it("returns to the CURRENT initials on a later open (after sign-out and sign-in remount them)", () => {
    render(<Harness />);
    const firstInitials = openFromInitials();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(firstInitials);
    // Sign out (the logout handler closes the panel) and sign back in: new initials node.
    act(() => setSignedIn(false));
    expect(screen.queryByTestId("nav-profile")).toBeNull();
    act(() => setSignedIn(true));
    const secondInitials = openFromInitials();
    expect(secondInitials).not.toBe(firstInitials);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("account-panel")).toBeNull();
    expect(document.activeElement).toBe(secondInitials);
  });

  it("a row puts focus on the Settings Back button", () => {
    render(<Harness />);
    openFromInitials();
    fireEvent.click(screen.getByTestId("account-panel-row-settings-security"));
    expect(document.activeElement).toBe(screen.getByTestId("settings-close"));
  });
});

describe("C13 a row opens Settings at that tab", () => {
  it("Security: the panel closes, the Settings layer shows with the Security target", () => {
    render(<Harness />);
    openFromInitials();
    fireEvent.click(screen.getByTestId("account-panel-row-settings-security"));
    expect(screen.queryByTestId("account-panel")).toBeNull();
    expect(screen.getByTestId("settings-layer")).toBeInTheDocument();
    expect(screen.getByTestId("settings-target")).toHaveTextContent("settings-security");
    expect(modal.modalState.showProfile).toBe(false);
  });

  it("Account (nav-settings) opens Settings at the Account tab", () => {
    render(<Harness />);
    openFromInitials();
    fireEvent.click(screen.getByTestId("nav-settings"));
    expect(screen.getByTestId("settings-target")).toHaveTextContent("settings-account");
  });
});

describe("C14 Sign out", () => {
  it("is at the bottom of the panel and signs out once, with no confirm step", () => {
    render(<Harness />);
    openFromInitials();
    const panel = screen.getByTestId("account-panel");
    const signOut = within(panel).getByRole("button", { name: "Sign out" });
    expect(panel.lastElementChild).toContainElement(signOut);
    fireEvent.click(signOut);
    expect(handleLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  it("a double click while sign-out is pending signs out once; the button is disabled until it settles (slice 3b)", async () => {
    let finish: () => void = () => {};
    handleLogout.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    render(<Harness />);
    openFromInitials();
    const signOut = screen.getByTestId("account-panel-signout");
    // Both clicks in one batch: no re-render between them, so only the guard can stop the second.
    act(() => {
      signOut.click();
      signOut.click();
    });
    expect(handleLogout).toHaveBeenCalledTimes(1);
    expect(signOut).toBeDisabled();
    // A later click while still pending is also ignored.
    fireEvent.click(signOut);
    expect(handleLogout).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(signOut).not.toBeDisabled();
  });

  it("a failed sign-out can be tried again (slice 3b)", async () => {
    handleLogout.mockRejectedValueOnce(new Error("offline"));
    render(<Harness />);
    openFromInitials();
    const signOut = screen.getByTestId("account-panel-signout");
    await act(async () => {
      fireEvent.click(signOut);
    });
    expect(signOut).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(signOut);
    });
    expect(handleLogout).toHaveBeenCalledTimes(2);
  });
});
