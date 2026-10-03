/**
 * C1 (UX redesign, founder 2026-10-03): link the Keepr extension with this
 * Keepr — REVERSED: the extension's popup shows a 6-digit code (Link), the
 * user types it here. Keepr never makes a code. One short line + a button per
 * state (founder's copy rule).
 *
 * Shown in Settings › Google Messages and in the Sync flow's Connect step;
 * keepr://link opens it (id "gm-link-panel"). Once linked, the parent stops
 * showing it.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { RcsLinkState } from "../../../../electron/types/ipc/window-api-rcs-import";
import { rcsImportService } from "../../../services/rcsImportService";

export const LINK_PANEL_ID = "gm-link-panel";
export const LINK_COPY = {
  none: "In Chrome, click the Keepr extension, then Link.",
  enter: "Enter the code from your browser",
  linked: "Linked with your browser ✓",
  locked: "Another app tried to link — check for unknown software",
} as const;
const POLL_MS = 1000;

/** "123456" / "123 456" / "123-456" → "123456"; anything else stays as typed (max 7 characters). */
export function cleanLinkCode(text: string): string {
  return text.replace(/[^0-9]/g, "").slice(0, 6);
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface LinkBrowserPanelProps {
  /** Called once Keepr reports this user linked (the parent may hide the panel). */
  onLinked?: () => void;
}

export function LinkBrowserPanel({ onLinked }: LinkBrowserPanelProps) {
  const [link, setLink] = useState<RcsLinkState | null>(null);
  const [linked, setLinked] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** Live (B2): "Link a browser" opened while already linked. */
  const [howOpen, setHowOpen] = useState(false);

  const refresh = useCallback(async () => {
    const r = await rcsImportService.linkState();
    if (!r.success || !r.data) return;
    setLink(r.data.link);
    setNow(Date.now());
    // Live (B1): Keepr's honest state each time (a lost link is shown again).
    if (r.data.linked && !linked) {
      setCode("");
      setError(null);
      setHowOpen(false);
      onLinked?.();
    }
    setLinked(r.data.linked);
  }, [linked, onLinked]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const submit = useCallback(async () => {
    if (code.length !== 6) {
      setError("Codes have 6 digits.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await rcsImportService.linkEnterCode(code);
    setBusy(false);
    if (!r.success) setError(r.error ?? "That code didn't work.");
    void refresh();
  }, [code, refresh]);

  const waiting = link && (link.state === "waiting" || link.state === "answered");
  return (
    <div id={LINK_PANEL_ID} className="flex flex-col gap-2 p-3 rounded-xl border border-indigo-200 bg-indigo-50" data-testid="gm-link-panel">
      {link?.intrusion && (
        <div className="flex items-center gap-2" role="alert" data-testid="gm-link-intrusion">
          <p className="text-sm font-medium text-red-700">{LINK_COPY.locked}</p>
          {link.state !== "locked" && (
            <button type="button" className="text-xs text-red-700 underline" onClick={() => void rcsImportService.linkDismissWarning().then(refresh)}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {/* Live (B2): a code waiting from the browser ALWAYS gets the field —
          linked or not (a new link replaces the old one). */}
      {waiting ? (
        <>
          <p className="text-sm font-medium text-gray-900">{LINK_COPY.enter}</p>
          <div className="flex items-center gap-2">
            <input
              aria-label="Code from your browser"
              data-testid="gm-link-code"
              inputMode="numeric"
              autoComplete="off"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(cleanLinkCode(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              className="w-28 px-2 py-1 rounded-lg border border-indigo-300 font-mono text-lg tracking-widest"
            />
            <button
              type="button"
              className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-60"
              onClick={() => void submit()}
              disabled={busy}
              data-testid="gm-link-submit"
            >
              Link
            </button>
            {link && "expiresAt" in link && (
              <span className="text-xs text-gray-600" data-testid="gm-link-countdown">{countdown(link.expiresAt - now)}</span>
            )}
          </div>
          {error && (
            <p className="text-xs text-red-700" role="alert" data-testid="gm-link-error">
              {error}
            </p>
          )}
        </>
      ) : link?.state === "locked" ? null : linked && !howOpen ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-gray-800" data-testid="gm-link-linked">{LINK_COPY.linked}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-sm text-indigo-700 hover:text-indigo-900"
              onClick={() => setHowOpen(true)}
              data-testid="gm-link-another"
            >
              Link a browser
            </button>
            {/* SR (B1): the only Keepr-side way to delete a link. */}
            <button
              type="button"
              className="text-sm text-gray-600 hover:text-gray-900"
              onClick={() => void rcsImportService.linkForget().then(refresh)}
              data-testid="gm-link-forget"
            >
              Forget link
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-800" data-testid="gm-link-none">{LINK_COPY.none}</p>
      )}
    </div>
  );
}
