/**
 * IPhoneSyncModal Component
 *
 * Wraps IPhoneSyncFlow in a modal overlay with close button.
 * Extracted from AppModals.tsx to keep the orchestrator under 150 lines.
 */

import React, { useEffect } from "react";
import { ResponsiveModal } from "../../components/common/ResponsiveModal";
import { IPhoneSyncFlow } from "../../components/iphone/IPhoneSyncFlow";
import logger from "../../utils/logger";

interface IPhoneSyncModalProps {
  onClose: () => void;
}

export function IPhoneSyncModal({ onClose }: IPhoneSyncModalProps) {
  useEffect(() => {
    logger.info("[IPhoneSyncModal] Mounted");
    return () => logger.info("[IPhoneSyncModal] Unmounted");
  }, []);

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[60]" overlayClassName="bg-black/50" panelClassName="max-w-lg sm:max-h-[90vh] sm:overflow-y-auto">
        {/* Minimize button — dismisses modal without stopping sync.

            BACKLOG-3416: this is now the ONLY thing that minimises the modal
            during a sync. It used to share that job with `onSyncStarted`, which
            fired automatically at the `backing_up` phase — before the user had
            necessarily unlocked the phone, tapped "Trust This Computer" or
            entered their passcode — and hid the instructions for doing so. */}
        <div className="flex justify-end p-4 pb-0">
          <button
            onClick={() => { logger.info("[IPhoneSyncModal] Minimize clicked"); onClose(); }}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title="Minimize — sync continues in background"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
        <IPhoneSyncFlow onClose={onClose} />
    </ResponsiveModal>
  );
}
