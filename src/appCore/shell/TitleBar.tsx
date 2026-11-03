/**
 * TitleBar — the app's top bar, extracted from AppShell (BACKLOG-3964 slice 1).
 *
 * Electron: full-width white bar on every step except login. An empty w-8
 * spacer on the left, centred page title, initials on the RIGHT (BACKLOG-4112,
 * the macOS convention; nothing else sits on the right: "hiddenInset" puts the
 * traffic lights on the left and there is no titleBarOverlay). BACKLOG-1790:
 * this bar is NOT a drag region — the global WindowDragStrip (App.tsx) overlays
 * its top 36px, so the initials carry .no-drag-region. On macOS the left
 * padding clears the traffic lights (electron/constants.ts).
 *
 * Non-Electron: mobile header, only when signed in, hidden at lg and up.
 * Initials left, then the title.
 */

import React from "react";
import type { AppStep, AppUser } from "../state/types";
import { AccountButton } from "./AccountButton";

interface TitleBarProps {
  runningInElectron: boolean;
  /** macOS: the left padding clears the traffic lights. */
  isMacOS?: boolean;
  currentStep: AppStep;
  isAuthenticated: boolean;
  currentUser: AppUser | null;
  title: string;
  onOpenAccount: () => void;
  /** The account panel is open. */
  accountOpen?: boolean;
}

export function TitleBar({
  runningInElectron,
  isMacOS = false,
  currentStep,
  isAuthenticated,
  currentUser,
  title,
  onOpenAccount,
  accountOpen = false,
}: TitleBarProps) {
  if (currentStep === "login") return null;
  const user = isAuthenticated ? currentUser : null;

  if (runningInElectron) {
    return (
      <div
        data-testid="title-bar"
        className={`flex-shrink-0 bg-white border-b border-warm-line pr-4 py-3 flex items-center justify-between select-none ${isMacOS ? "pl-20" : "pl-4"}`}
      >
        {/* Left spacer keeps the title centred */}
        <div className="w-8 shrink-0" />
        <h1 className="min-w-0 truncate px-2 text-sm font-semibold text-ink">{title}</h1>
        <div className="flex w-8 shrink-0 items-center justify-end" data-testid="title-bar-right">
          {user && <AccountButton user={user} onClick={onOpenAccount} inDragBand expanded={accountOpen} />}
        </div>
      </div>
    );
  }

  if (!user) return null;
  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 lg:hidden">
      <AccountButton user={user} onClick={onOpenAccount} inDragBand={false} expanded={accountOpen} />
      <h1 className="min-w-0 truncate text-base font-semibold text-gray-900">{title}</h1>
    </div>
  );
}
