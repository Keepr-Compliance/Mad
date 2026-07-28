/**
 * AndroidSyncModal Component
 *
 * Wraps the guided AndroidSyncSetup wizard in a modal overlay with a minimize
 * button. Mirrors IPhoneSyncModal so the Android companion sync flow launches
 * from the Dashboard "Sync Android Messages" card instead of Settings
 * (BACKLOG-2320).
 */

import React, { useEffect } from "react";
import { ResponsiveModal } from "../../components/common/ResponsiveModal";
import { AndroidSyncSetup } from "../../components/settings/android/AndroidSyncSetup";
import logger from "../../utils/logger";

interface AndroidSyncModalProps {
  /** The logged-in desktop user id (forwarded to the wizard for BACKLOG-2224 account-match). */
  userId: string;
  onClose: () => void;
}

export function AndroidSyncModal({ userId, onClose }: AndroidSyncModalProps) {
  useEffect(() => {
    logger.info("[AndroidSyncModal] Mounted");
    return () => logger.info("[AndroidSyncModal] Unmounted");
  }, []);

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[60]" overlayClassName="bg-black/50" panelClassName="max-w-lg sm:max-h-[90vh] sm:overflow-y-auto">
        {/* Minimize button — dismisses modal without stopping sync */}
        <div className="flex justify-end p-4 pb-0">
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
        <div className="px-4 pb-4">
          {/* BACKLOG-2323: onComplete auto-dismisses the modal shortly after a
              live pairing success advances the wizard off the (now-consumed) QR,
              mirroring how IPhoneSyncModal closes on success. */}
          <AndroidSyncSetup userId={userId} onComplete={onClose} />
        </div>
    </ResponsiveModal>
  );
}
