/**
 * AccountButton — the initials circle in the title bar (BACKLOG-3964).
 *
 * One component for both bars (Electron title bar and the mobile header).
 * `inDragBand` adds .no-drag-region: in Electron the button sits inside the
 * WindowDragStrip band (BACKLOG-1790) and would not receive clicks without it.
 */

import React from "react";
import type { AppUser } from "../state/types";

/**
 * The letter shown when the user has no avatar.
 * Today: first letter of the display name, else of the email, else "?".
 * (Two initials per the mock — SR change R3b — land in a later slice here.)
 */
export function getAccountInitials(user: Pick<AppUser, "display_name" | "email">): string {
  return (
    user.display_name?.[0]?.toUpperCase() ||
    user.email?.[0]?.toUpperCase() ||
    "?"
  );
}

interface AccountButtonProps {
  user: AppUser;
  onClick: () => void;
  inDragBand: boolean;
}

export function AccountButton({ user, onClick, inDragBand }: AccountButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 hover:from-blue-500 hover:to-purple-600 flex items-center justify-center text-white text-sm font-bold shadow-md transition-all hover:shadow-lg${inDragBand ? " no-drag-region" : ""}`}
      title={`${user.display_name || user.email} - Click for account settings`}
      data-tour="profile-button"
      data-testid="nav-profile"
    >
      {user.avatar_url ? (
        <img src={user.avatar_url} alt="Profile" className="w-8 h-8 rounded-full" />
      ) : (
        getAccountInitials(user)
      )}
    </button>
  );
}
