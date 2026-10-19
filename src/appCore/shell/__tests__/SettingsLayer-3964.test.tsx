/**
 * BACKLOG-3964 slice 2: Settings as a page over the app content.
 *
 * Renders the REAL AppShell + ShellContent + SettingsLayer + useModalFlow, so
 * openSettings / closeSettings / the Esc listener / the inert container are the
 * shipped ones. Only Settings itself is a stub (its own suite covers the page).
 *
 * Controls aimed at the likely-wrong builds:
 *  - Back loses the previous view (children unmounted while Settings shows, or
 *    a close* fired on open/Back).
 *  - A deep link ignores its target (openSettings drops the argument).
 *  - Esc closes the popup underneath (listener on document/window bubble, or
 *    no stopPropagation) — three popup fixtures: document, window, React.
 *  - Esc swallowed with Settings closed (listener attached unconditionally).
 *  - Dashboard reachable under Settings (no inert).
 */
import React, { useEffect, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppShell } from "../../AppShell";
import { useModalFlow } from "../../state/flows/useModalFlow";
import type { AppStateMachine } from "../../state/types";

jest.mock("../../../utils/platform", () => ({ isElectron: () => true }));
jest.mock("../../../hooks/useSessionValidator", () => ({ useSessionValidator: jest.fn() }));
jest.mock("../../../hooks/useIdleSessionExpiry", () => ({ useSessionIdleTimeout: jest.fn() }));
jest.mock("../../../components/SystemHealthMonitor", () => ({ __esModule: true, default: () => null }));
jest.mock("../ShellBanners", () => ({ ShellBanners: () => null }));
jest.mock("../../hooks/useEmailSettingsCallbacks", () => ({
  useEmailSettingsCallbacks: () => ({
    handleEmailConnectedFromSettings: jest.fn(),
    handleEmailDisconnectedFromSettings: jest.fn(),
  }),
}));

/** Stub page: Back, its target, and a kebab menu with a document Escape listener (ConnectionMenu's shape). */
jest.mock("../../../components/Settings", () => {
  const React = jest.requireActual("react");
  function MenuInside() {
    const [open, setOpen] = React.useState(false);
    React.useEffect(() => {
      if (!open) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setOpen(false);
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [open]);
    return (
      <div>
        <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(true)} data-testid="inner-menu-trigger">
          more
        </button>
        {open && <div role="menu" data-testid="inner-menu" />}
      </div>
    );
  }
  function StubSettings(props: { onClose: () => void; initialSection?: string | null }) {
    return (
      <div data-testid="settings-page">
        <button data-testid="settings-close" onClick={props.onClose}>
          Back
        </button>
        <span data-testid="settings-target">{props.initialSection ?? "none"}</span>
        <MenuInside />
      </div>
    );
  }
  return { __esModule: true, default: StubSettings };
});

const user = { id: "user-1", email: "avery@example.com", display_name: "Avery Example" };

/** Spies the popup fixtures report into. */
const popupEsc = { document: jest.fn(), window: jest.fn(), react: jest.fn() };

/** A popup under Settings with all three Escape handler shapes found in src. */
function PopupWithEscHandlers() {
  useEffect(() => {
    const onDoc = (e: KeyboardEvent) => e.key === "Escape" && popupEsc.document();
    const onWin = (e: KeyboardEvent) => e.key === "Escape" && popupEsc.window();
    document.addEventListener("keydown", onDoc); // InfoTooltip / ConnectionMenu shape
    window.addEventListener("keydown", onWin); // AttachmentPreviewModal shape
    return () => {
      document.removeEventListener("keydown", onDoc);
      window.removeEventListener("keydown", onWin);
    };
  }, []);
  return (
    <div className="fixed inset-0 z-[60]" data-testid="popup-under">
      {/* NotSyncedChatsModal shape: React onKeyDown */}
      <div onKeyDown={(e) => e.key === "Escape" && popupEsc.react()}>
        <button data-testid="popup-inner">inside popup</button>
      </div>
    </div>
  );
}

function Dashboard() {
  const [count, setCount] = useState(0);
  return (
    <button data-testid="dashboard-counter" onClick={() => setCount((c) => c + 1)}>
      {count}
    </button>
  );
}

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
    openProfile: jest.fn(),
    handleLogout: jest.fn(),
    openAndroidSync: jest.fn(),
    openIPhoneSync: jest.fn(),
    getPageTitle: () => "Dashboard",
    ...modal,
  } as unknown as AppStateMachine;
  return (
    <AppShell app={app}>
      <Dashboard />
      {modal.modalState.showTransactions && <PopupWithEscHandlers />}
    </AppShell>
  );
}

const pressEsc = (target: Element) => fireEvent.keyDown(target, { key: "Escape" });

beforeEach(() => {
  Object.values(popupEsc).forEach((f) => f.mockReset());
});

describe("Settings page layer (BACKLOG-3964 slice 2)", () => {
  it("title bar reads Settings while it shows, the page title otherwise", () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dashboard");
    act(() => modal.openSettings());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings");
  });

  it("a deep link hands its target to the page; Back clears it", () => {
    render(<Harness />);
    act(() => modal.openSettings("settings-security"));
    expect(screen.getByTestId("settings-target")).toHaveTextContent("settings-security");
    fireEvent.click(screen.getByTestId("settings-close"));
    act(() => modal.openSettings());
    expect(screen.getByTestId("settings-target")).toHaveTextContent("none");
  });

  it("Back returns to the Dashboard with its state intact (not remounted)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("dashboard-counter"));
    fireEvent.click(screen.getByTestId("dashboard-counter"));
    act(() => modal.openSettings());
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("settings-close"));
    expect(screen.queryByTestId("settings-page")).toBeNull();
    expect(screen.getByTestId("dashboard-counter")).toHaveTextContent("2");
  });

  it("opens ABOVE a popup that is already open, and Back returns to that popup", () => {
    render(<Harness />);
    act(() => modal.openTransactions());
    act(() => modal.openSettings("settings-email"));
    expect(screen.getByTestId("popup-under")).toBeInTheDocument();
    expect(screen.getByTestId("settings-layer")).toHaveClass("z-[105]");
    fireEvent.click(screen.getByTestId("settings-close"));
    expect(screen.queryByTestId("settings-page")).toBeNull();
    expect(screen.getByTestId("popup-under")).toBeInTheDocument();
    expect(modal.modalState.showTransactions).toBe(true);
  });

  it("the Dashboard underneath is inert while Settings shows, and only then", () => {
    render(<Harness />);
    const content = screen.getByTestId("shell-content");
    expect(content).not.toHaveAttribute("inert");
    act(() => modal.openSettings());
    expect(content).toHaveAttribute("inert");
    expect(content).toContainElement(screen.getByTestId("dashboard-counter"));
    expect(content).not.toContainElement(screen.getByTestId("settings-page"));
    fireEvent.click(screen.getByTestId("settings-close"));
    expect(content).not.toHaveAttribute("inert");
  });

  describe("Esc is Back, and never reaches the popup underneath", () => {
    const openBoth = () => {
      render(<Harness />);
      act(() => modal.openTransactions());
      act(() => modal.openSettings());
    };

    it.each(["document", "window", "react"] as const)("popup's %s Escape handler is not called", (shape) => {
      openBoth();
      pressEsc(screen.getByTestId("popup-inner"));
      expect(screen.queryByTestId("settings-page")).toBeNull();
      expect(popupEsc[shape]).not.toHaveBeenCalled();
      expect(screen.getByTestId("popup-under")).toBeInTheDocument();
    });

    it("with Settings closed, Esc still reaches every popup handler (C2b)", () => {
      render(<Harness />);
      act(() => modal.openTransactions());
      pressEsc(screen.getByTestId("popup-inner"));
      expect(popupEsc.document).toHaveBeenCalledTimes(1);
      expect(popupEsc.window).toHaveBeenCalledTimes(1);
      expect(popupEsc.react).toHaveBeenCalledTimes(1);
    });

    it("a menu open INSIDE the page takes Esc for itself; the page stays", () => {
      render(<Harness />);
      act(() => modal.openSettings());
      fireEvent.click(screen.getByTestId("inner-menu-trigger"));
      expect(screen.getByTestId("inner-menu")).toBeInTheDocument();
      pressEsc(screen.getByTestId("inner-menu-trigger"));
      expect(screen.queryByTestId("inner-menu")).toBeNull();
      expect(screen.getByTestId("settings-page")).toBeInTheDocument();
      pressEsc(screen.getByTestId("inner-menu-trigger"));
      expect(screen.queryByTestId("settings-page")).toBeNull();
    });
  });
});
