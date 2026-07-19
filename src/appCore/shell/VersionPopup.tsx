/**
 * VersionPopup Component
 *
 * Displays version information in a popup when triggered.
 * Shows app version, last update, and branding.
 */

import React, { useState, useEffect } from "react";
import { AppMark } from "../../components/common/AppMark";

interface VersionPopupProps {
  isVisible: boolean;
  onClose: () => void;
}

export function VersionPopup({ isVisible, onClose }: VersionPopupProps) {
  const [version, setVersion] = useState<string>("...");

  useEffect(() => {
    if (isVisible) {
      window.api?.system?.getAppInfo?.()
        .then((info: { version?: string }) => {
          if (info?.version) {
            setVersion(info.version);
          }
        })
        .catch(() => {
          // Fallback - version will stay as "..."
        });
    }
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <div className="fixed bottom-16 left-4 bg-white rounded-lg shadow-xl border border-gray-200 p-4 z-50 min-w-64">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">App Info</h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
      <div className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-600">Version:</span>
          <span className="font-mono font-semibold text-gray-900">{version}</span>
        </div>
        <div className="pt-2 border-t border-gray-200 flex items-center gap-1.5">
          <AppMark size={16} />
          <p className="text-gray-500 text-xs">Keepr.</p>
        </div>
      </div>
    </div>
  );
}
