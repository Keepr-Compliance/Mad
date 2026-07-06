'use client';

/**
 * BrowserDiagnostics - Collects and displays browser diagnostics
 *
 * Provides a hook to collect browser environment data (user agent, viewport,
 * timezone, etc.) and a collapsible display component so users can see
 * what is being shared with their support ticket.
 *
 * Diagnostics collection is best-effort -- failures never block ticket submission.
 */

import { useEffect, useState } from 'react';

export interface BrowserDiagnosticsData {
  user_agent: string;
  viewport_width: number;
  viewport_height: number;
  screen_width: number;
  screen_height: number;
  device_pixel_ratio: number;
  current_url: string;
  referrer: string;
  timezone: string;
  language: string;
  online: boolean;
  cookies_enabled: boolean;
  collected_at: string;
}

/**
 * Hook to collect browser diagnostics on mount.
 * Returns null if collection fails (best-effort).
 */
export function useBrowserDiagnostics(): BrowserDiagnosticsData | null {
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnosticsData | null>(null);

  useEffect(() => {
    try {
      setDiagnostics({
        user_agent: navigator.userAgent,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        screen_width: screen.width,
        screen_height: screen.height,
        device_pixel_ratio: window.devicePixelRatio,
        current_url: window.location.href,
        referrer: document.referrer,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
        online: navigator.onLine,
        cookies_enabled: navigator.cookieEnabled,
        collected_at: new Date().toISOString(),
      });
    } catch {
      // Diagnostics collection is best-effort -- never block the form
    }
  }, []);

  return diagnostics;
}

/**
 * Collapsible diagnostics display.
 * Shows a summary line that expands to reveal the full JSON payload.
 */
export function BrowserDiagnostics({ diagnostics }: { diagnostics: BrowserDiagnosticsData | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!diagnostics) return null;

  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm text-gray-600 w-full text-left"
      >
        <span className="text-xs">{expanded ? '\u25BC' : '\u25B6'}</span>
        Diagnostics (attached automatically)
      </button>
      {expanded && (
        <pre className="mt-2 text-xs text-gray-500 overflow-auto max-h-40 p-2 bg-white rounded border border-gray-200">
          {JSON.stringify(diagnostics, null, 2)}
        </pre>
      )}
    </div>
  );
}
