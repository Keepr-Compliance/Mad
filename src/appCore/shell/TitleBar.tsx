/**
 * TitleBar — the app's top bar, extracted from AppShell (BACKLOG-3964 slice 1).
 *
 * Electron: full-width bar on every step except login. Left slot (empty w-8
 * spacer), centred page title, initials on the right. BACKLOG-1790: this bar
 * is NOT a drag region — the global WindowDragStrip (App.tsx) overlays its top
 * 36px, so the initials carry .no-drag-region.
 *
 * The empty left slot also keeps the macOS traffic-light area clear
 * (titleBarStyle "hiddenInset", electron/constants.ts). A later slice moves
 * the initials into this slot with a macOS offset.
 *
 * Non-Electron: mobile header, only when signed in, hidden at lg and up.
 * Title left, initials right.
 */

import React from "react";
import type { AppStep, AppUser } from "../state/types";
import { AccountButton } from "./AccountButton";

interface TitleBarProps {
  runningInElectron: boolean;
  currentStep: AppStep;
  isAuthenticated: boolean;
  currentUser: AppUser | null;
  title: string;
  onOpenAccount: () => void;
}

export function TitleBar({
  runningInElectron,
  currentStep,
  isAuthenticated,
  currentUser,
  title,
  onOpenAccount,
}: TitleBarProps) {
  if (currentStep === "login") return null;
  const user = isAuthenticated ? currentUser : null;

  if (runningInElectron) {
    return (
      <div className="flex-shrink-0 bg-gradient-to-b from-gray-100 to-gray-50 border-b border-gray-200 px-4 py-3 flex items-center justify-between select-none">
        <div className="w-8" /> {/* Left slot / spacer for centering */}
        <h1 className="text-sm font-semibold text-gray-700">{title}</h1>
        {user && <AccountButton user={user} onClick={onOpenAccount} inDragBand />}
      </div>
    );
  }

  if (!user) return null;
  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between lg:hidden">
      <h1 className="text-base font-semibold text-gray-900">{title}</h1>
      <AccountButton user={user} onClick={onOpenAccount} inDragBand={false} />
    </div>
  );
}
