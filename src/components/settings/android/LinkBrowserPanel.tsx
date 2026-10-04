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
  /** The approved mockup's title and label (KeeprEnterCode). */
  title: "Link your browser",
  none: "In Chrome, click the Keepr extension, then Link.",
  enter: "Enter the code shown in Chrome",
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

  const cancel = useCallback(async () => {
    setCode("");
    setError(null);
    await rcsImportService.linkCancel();
    void refresh();
  }, [refresh]);

  const waiting = link && (link.state === "waiting" || link.state === "answered");
  // The approved mockup (KeeprEnterCode): a 480-wide card, padding 32, gap 18,
  // "Link your browser", the code field (56 high, 2px brand border, mono
  // 28px), then Cancel + Link at the bottom-right.
  return (
    <div
      id={LINK_PANEL_ID}
      className="w-full max-w-[480px] box-border p-8 flex flex-col gap-[18px] bg-white rounded-2xl border border-[#D6D9E4] text-[#1F2433]"
      data-testid="gm-link-panel"
    >
      <div className="text-[22px] leading-7 font-bold" data-testid="gm-link-title">{LINK_COPY.title}</div>
      {link?.intrusion && (
        <div className="flex items-center gap-2" role="alert" data-testid="gm-link-intrusion">
          <p className="text-[15px] font-medium text-[#B42318]">{LINK_COPY.locked}</p>
          {link.state !== "locked" && (
            <button type="button" className="text-[13px] text-[#B42318] underline" onClick={() => void rcsImportService.linkDismissWarning().then(refresh)}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {/* Live (B2): a code waiting from the browser ALWAYS gets the field —
          linked or not (a new link replaces the old one). */}
      {waiting ? (
        <>
          <label className="flex flex-col gap-2 text-[15px] text-[#374151]">
            {LINK_COPY.enter}
            <input
              aria-label="Code from your browser"
              data-testid="gm-link-code"
              inputMode="numeric"
              autoComplete="off"
              placeholder="000 000"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(cleanLinkCode(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              className="min-h-[56px] box-border px-4 border-2 border-[#4F46E5] rounded-[10px] font-mono text-[28px] tracking-[0.2em] text-[#1F2433]"
            />
          </label>
          {error && (
            <p className="text-[13px] text-[#B42318]" role="alert" data-testid="gm-link-error">
              {error}
            </p>
          )}
          {link && "expiresAt" in link && (
            <p className="text-[13px] text-[#4B5163]" data-testid="gm-link-countdown">Expires in {countdown(link.expiresAt - now)}</p>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              className="min-h-[44px] px-[18px] border border-[#CDD1DE] rounded-[10px] bg-white text-[15px] font-semibold text-[#1F2433]"
              onClick={() => void cancel()}
              data-testid="gm-link-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="min-h-[44px] px-[22px] border-0 rounded-[10px] bg-[#4F46E5] hover:bg-[#4338CA] text-[15px] font-bold text-white disabled:opacity-60"
              onClick={() => void submit()}
              disabled={busy}
              data-testid="gm-link-submit"
            >
              Link
            </button>
          </div>
        </>
      ) : link?.state === "locked" ? null : linked && !howOpen ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[15px] text-[#14532D] font-semibold" data-testid="gm-link-linked">{LINK_COPY.linked}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-[14px] font-semibold text-[#4F46E5] hover:text-[#3730A3]"
              onClick={() => setHowOpen(true)}
              data-testid="gm-link-another"
            >
              Link a browser
            </button>
            {/* SR (B1): the only Keepr-side way to delete a link. */}
            <button
              type="button"
              className="text-[14px] text-[#4B5163] hover:text-[#1F2433]"
              onClick={() => void rcsImportService.linkForget().then(refresh)}
              data-testid="gm-link-forget"
            >
              Forget link
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[15px] leading-[22px] text-[#374151]" data-testid="gm-link-none">{LINK_COPY.none}</p>
      )}
    </div>
  );
}
