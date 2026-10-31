/**
 * AccountPanel — the dark account side panel the title-bar initials open
 * (BACKLOG-3964 slice 3; replaces the Account popup, components/Profile).
 *
 * Left edge, below the window drag strip in Electron (mock v14: the panel and
 * scrim start under the chrome). ~256 px wide on desktop, 82% with a darker
 * scrim on phones. The whole panel scrolls as one.
 *
 * Contents: who is signed in, plan, User ID with Copy, one row per Settings
 * tab (the same `visibleSettingsTabs()` list the Settings page uses), and
 * Sign out at the bottom — the only Sign out in the app (founder decision 10).
 * A row closes the panel and opens Settings at that tab.
 *
 * Closes on X, Esc and a click on the scrim; a click inside never closes it.
 * Esc and Tab defer to the support form when it is open above the panel. Focus
 * is trapped inside while open and goes back to the opener on close (to the
 * Settings Back button after a row). The "?" support button sits above the
 * scrim and moves beside the panel (SupportWidget `accountPanelOpen`).
 *
 * State: `modalState.showProfile` is "account panel open"; the flow keeps its
 * openProfile / closeProfile names (useModalFlow).
 */
import React, { useCallback, useRef, useState } from "react";
import {
  Database,
  Info,
  LifeBuoy,
  LogOut,
  Mail,
  MessageSquare,
  Shield,
  SlidersHorizontal,
  Sparkles,
  User,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AppStateMachine } from "../state/types";
import { AccountAvatar } from "./AccountAvatar";
import { visibleSettingsTabs } from "../../components/settings/settingsTabs";
import { formatPlanLabel } from "../../components/settings/account/formatPlanLabel";
import { useLicense } from "../../contexts/LicenseContext";
import { useFeatureGate } from "../../hooks/useFeatureGate";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useCopyText } from "../../hooks/useCopyText";
import { Z_CLASS } from "../../constants/zLayers";
import * as Sentry from "@sentry/electron/renderer";
import logger from "../../utils/logger";
// The support form is mounted at the app root and sits above the panel; Esc and Tab belong to it.
import { isSupportFormOpen } from "../../components/support/supportDialogSelector";

/** One icon per Settings tab id. A tab without an icon fails AccountPanel-3964 C5b. */
export const SETTINGS_TAB_ICONS: Record<string, LucideIcon> = {
  "settings-account": User,
  "settings-general": SlidersHorizontal,
  "settings-email": Mail,
  "settings-messages": MessageSquare,
  "settings-contacts": Users,
  "settings-ai": Sparkles,
  "settings-security": Shield,
  "settings-data": Database,
  "settings-troubleshooting": Wrench,
  "settings-support-access": LifeBuoy,
  "settings-about": Info,
};

/** Test id of a panel row. The Account row keeps `nav-settings` (e2e gotoSettings). */
export function accountPanelRowTestId(tabId: string): string {
  return tabId === "settings-account" ? "nav-settings" : `account-panel-row-${tabId}`;
}

/** First 4 and last 5 characters of a long id ("abcd…vwxyz"); the full id goes in the title. */
function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 4)}…${id.slice(-5)}` : id;
}

const ROW =
  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500";
// No row looks selected: the panel only opens with Settings closed (useModalFlow openProfile).
const ROW_IDLE = "text-gray-300 hover:bg-gray-800 hover:text-white";

interface AccountPanelProps {
  app: AppStateMachine;
  runningInElectron: boolean;
}

export function AccountPanel({ app, runningInElectron }: AccountPanelProps) {
  const { modalState, currentUser, closeProfile, openSettings, handleLogout } = app;
  const user = modalState.showProfile ? currentUser : null;
  const open = !!user;
  const panelRef = useRef<HTMLDivElement>(null);

  // Both hooks are attached only while the panel is open.
  useEscapeToClose(open, closeProfile, isSupportFormOpen);
  const focusRedirect = useFocusTrap(panelRef, open, isSupportFormOpen);

  // One sign-out at a time: a double click must not call logout twice. The ref
  // blocks a second click before React re-renders; the state disables the button.
  const signingOutRef = useRef(false);
  const [signingOut, setSigningOut] = useState(false);
  const signOut = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setSigningOut(true);
    try {
      await handleLogout();
    } catch (err) {
      // The button comes back so the user can try again.
      // The logger serialises an Error to {}, so log the message; and report it, since the catch hides it from Sentry.
      logger.error("[AccountPanel] Sign out failed", err instanceof Error ? err.message : String(err));
      Sentry.captureException(err, {
        tags: { component: "AccountPanel" },
        extra: { operation: "sign-out", error_message: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      signingOutRef.current = false;
      setSigningOut(false);
    }
  }, [handleLogout]);

  const openTab = useCallback(
    (tabId: string) => {
      focusRedirect.current = () => document.querySelector<HTMLElement>('[data-testid="settings-close"]');
      closeProfile();
      openSettings(tabId);
    },
    [closeProfile, openSettings, focusRedirect],
  );

  if (!user) return null;
  const top = runningInElectron ? "top-9" : "top-0";
  return (
    <>
      <div
        data-testid="account-panel-scrim"
        aria-hidden="true"
        onClick={closeProfile}
        className={`fixed inset-x-0 bottom-0 ${top} ${Z_CLASS.accountScrim} bg-gray-900/55 sm:bg-gray-900/35`}
      />
      <OpenAccountPanel
        ref={panelRef}
        user={user}
        top={top}
        onClose={closeProfile}
        onOpenTab={openTab}
        onSignOut={signOut}
        signingOut={signingOut}
      />
    </>
  );
}

interface OpenAccountPanelProps {
  user: NonNullable<AppStateMachine["currentUser"]>;
  top: string;
  onClose: () => void;
  onOpenTab: (tabId: string) => void;
  onSignOut: () => void;
  signingOut: boolean;
}

const OpenAccountPanel = React.forwardRef<HTMLDivElement, OpenAccountPanelProps>(function OpenAccountPanel(
  { user, top, onClose, onOpenTab, onSignOut, signingOut },
  ref,
) {
  const { licenseType } = useLicense();
  const { isAllowed } = useFeatureGate();
  const tabs = visibleSettingsTabs(isAllowed("ai_detection"));
  const { copied, copy } = useCopyText("AccountPanel");
  const planLabel = licenseType ? formatPlanLabel(licenseType) : "";

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Account"
      data-testid="account-panel"
      className={`fixed bottom-0 left-0 ${top} ${Z_CLASS.accountPanel} flex w-[82%] flex-col overflow-y-auto overscroll-contain border-r border-gray-800 bg-gray-900 text-white shadow-xl [scrollbar-width:none] sm:w-64 sm:[scrollbar-width:thin] [&>*]:flex-none`}
    >
      <div className="relative flex flex-col gap-3 border-b border-gray-800 px-6 py-4">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close menu"
          title="Close"
          data-testid="account-panel-close"
          className="no-drag-region absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="flex min-w-0 items-center gap-2.5 pr-8">
          <AccountAvatar size={32} name={user.display_name} email={user.email} imageUrl={user.avatar_url} />
          <div className="min-w-0">
            {user.display_name && <p className="truncate text-sm leading-tight text-white">{user.display_name}</p>}
            <p className="truncate text-xs leading-tight text-gray-400">{user.email}</p>
          </div>
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 text-xs text-gray-300">
          {planLabel && (
            <>
              <span className="text-gray-400">Plan</span>
              <span>
                <span
                  data-testid="account-panel-plan"
                  className="inline-flex items-center rounded-full bg-gray-800 px-2.5 py-0.5 text-xs font-medium text-gray-200"
                >
                  {planLabel}
                </span>
              </span>
              <span />
            </>
          )}
          <span className="text-gray-400">User ID</span>
          <span className="truncate font-mono" title={user.id}>
            {shortId(user.id)}
          </span>
          <button
            type="button"
            onClick={() => copy(user.id)}
            data-testid="account-panel-copy-id"
            className="inline-flex items-center justify-center rounded-md bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <nav className="px-3 py-4" aria-label="Settings">
        <div className="px-3 pb-2 text-xs font-medium uppercase tracking-wider text-gray-400">Settings</div>
        {tabs.map((tab) => {
          const Icon = SETTINGS_TAB_ICONS[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              data-testid={accountPanelRowTestId(tab.id)}
              onClick={() => onOpenTab(tab.id)}
              className={`${ROW} ${ROW_IDLE}`}
            >
              {Icon && <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />}
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="border-t border-gray-800 px-3 py-4">
        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          aria-busy={signingOut || undefined}
          data-testid="account-panel-signout"
          className={`${ROW} ${ROW_IDLE} disabled:opacity-50`}
        >
          <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
});
