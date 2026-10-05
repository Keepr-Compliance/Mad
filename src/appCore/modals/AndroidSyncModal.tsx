/**
 * AndroidSyncModal Component
 *
 * The Google Messages sync flow (BACKLOG-3659) in a modal overlay with a
 * minimize button. Mirrors IPhoneSyncModal; launched from the Dashboard's
 * Android card (BACKLOG-2320). SR C6 (founder): the Android Companion's
 * wizard is no longer offered here.
 */

import React, { useEffect } from "react";
import { ResponsiveModal } from "../../components/common/ResponsiveModal";
import { GoogleMessagesSyncFlow } from "../../components/settings/android/GoogleMessagesSyncFlow";
import { GM_LOOKBACK_TARGET } from "../../components/settings/android/googleMessagesSyncSteps";
import logger from "../../utils/logger";

interface AndroidSyncModalProps {
  /** The logged-in desktop user id (forwarded to the wizard for BACKLOG-2224 account-match). */
  userId: string;
  onClose: () => void;
  /** Open Settings scrolled to a section (by element id): Google Messages' "Change". */
  onOpenSettings?: (target: string) => void;
  /** Opened from Settings' Link / Relink or keepr://link: the link step. */
  startAtLink?: boolean;
}

export function AndroidSyncModal({ userId, onClose, onOpenSettings, startAtLink = false }: AndroidSyncModalProps) {
  useEffect(() => {
    logger.info("[AndroidSyncModal] Mounted");
    return () => logger.info("[AndroidSyncModal] Unmounted");
  }, []);

  // BACKLOG-2324: The panel is a flex column (h-full on mobile, capped at 90vh on
  // desktop). The minimize header is pinned (flex-shrink-0) and the wizard lives
  // in a `flex-1 min-h-0 overflow-y-auto` body, so tall content scrolls WITHIN
  // the modal on a narrow/short viewport instead of being clipped and unreachable
  // (the previous static body clipped everything below "I've Installed It"). The
  // single inner scroll region replaces the panel-level `sm:overflow-y-auto`.
  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[60]" overlayClassName="bg-black/50" panelClassName="max-w-lg sm:max-h-[90vh]">
        {/* Minimize button — dismisses modal without stopping sync. Pinned. */}
        <div className="flex-shrink-0 flex justify-end px-4 pt-4">
          <button
            onClick={() => { logger.info("[AndroidSyncModal] Minimize clicked"); onClose(); }}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title="Minimize — sync continues in background"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
        {/* The storyboards' frame: 0 24 24 padding under the minimize row. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6" data-testid="android-sync-modal-body">
            <GoogleMessagesSyncFlow
              onClose={onClose}
              userId={userId}
              startAtLink={startAtLink}
              onOpenSettings={
                onOpenSettings
                  ? () => {
                      onClose();
                      onOpenSettings(GM_LOOKBACK_TARGET);
                    }
                  : undefined
              }
            />
        </div>
    </ResponsiveModal>
  );
}
