/**
 * AccountButton — the initials circle in the title bar (BACKLOG-3964).
 *
 * One component for both bars (Electron title bar and the mobile header). It
 * opens the account side panel (slice 3). `inDragBand` adds .no-drag-region:
 * in Electron the button sits inside the WindowDragStrip band (BACKLOG-1790)
 * and would not receive clicks without it.
 */

import React from "react";
import type { AppUser } from "../state/types";
import { AccountAvatar } from "./AccountAvatar";

export { getAccountInitials } from "./AccountAvatar";

interface AccountButtonProps {
  user: AppUser;
  onClick: () => void;
  inDragBand: boolean;
  /** The account panel is open (aria-expanded). */
  expanded?: boolean;
}

export function AccountButton({ user, onClick, inDragBand, expanded = false }: AccountButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full shadow-sm transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2${inDragBand ? " no-drag-region" : ""}`}
      title={`${user.display_name || user.email} - Click for account settings`}
      aria-label="Account"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      data-tour="profile-button"
      data-testid="nav-profile"
    >
      <AccountAvatar size={32} name={user.display_name} email={user.email} imageUrl={user.avatar_url} />
    </button>
  );
}
