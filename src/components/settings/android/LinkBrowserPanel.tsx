/**
 * C1 (UX redesign, founder 2026-10-03): link the Keepr extension with this
 * Keepr — REVERSED: the extension shows a 6-digit code, the user types it
 * here. Keepr never makes a code.
 *
 * The approved mockups (KeeprLinkPrompt + LinkFlow steps 4–5, founder
 * 2026-10-04): ONE minimal card — "Link your browser", (1) Open Google
 * Messages (works without a link), (2) "Type the code from Chrome". The 6th
 * digit (typed or pasted) submits by itself — no Link button. Checking: a
 * small spinner in the field. Linked: a green field with ✓, "Linked", and
 * "Sync now" right below (it starts the Sync). Wrong: a red field, "Code
 * didn't match — N tries left", the field cleared for retyping; after the
 * 5th: "Code used up. Get a new code in Chrome." Every submitted code is one
 * try (Keepr counts them, unchanged).
 *
 * Shown in Settings › Google Messages and in the Sync flow's Connect step;
 * keepr://link opens it (id "gm-link-panel").
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { RcsLinkState } from "../../../../electron/types/ipc/window-api-rcs-import";
import { rcsImportService } from "../../../services/rcsImportService";

export const LINK_PANEL_ID = "gm-link-panel";
export const LINK_COPY = {
  title: "Link your browser",
  enter: "Type the code from Chrome",
  linked: "Linked with your browser ✓",
  justLinked: "Linked",
  syncNow: "Sync now",
  usedUp: "Code used up. Get a new code in Chrome.",
  /** SR (F01): the field's placeholder after a miss. */
  retype: "Retype the code",
  expired: "Code expired. Get a new code in Chrome.",
  locked: "Another app tried to link — check for unknown software",
} as const;
const POLL_MS = 1000;

/** "Code didn't match · 3 tries left" (SR, F01 storyboard). */
export function wrongCodeLine(triesLeft: number): string {
  return `Code didn't match · ${triesLeft} ${triesLeft === 1 ? "try" : "tries"} left`;
}

/** "123456" / "123 456" / "123-456" → "123456" (digits only, at most 6). */
export function cleanLinkCode(text: string): string {
  return text.replace(/[^0-9]/g, "").slice(0, 6);
}

interface LinkBrowserPanelProps {
  /** Called once Keepr reports this user linked (the parent may hide the panel). */
  onLinked?: () => void;
  /** A code typed here just linked the browser (the parent hides its own Sync). */
  onJustLinked?: () => void;
  /** "Sync now" after a link; default: Keepr's Google Messages Sync. */
  onSyncNow?: () => void;
  /** Inside the Sync Android modal (D01): no card of its own — the modal frames it. */
  bare?: boolean;
}

type Check =
  | { kind: "idle" }
  | { kind: "checking"; triesBefore: number | null; expiresAt: number | null }
  | { kind: "wrong"; message: string }
  | { kind: "linked" };

export function LinkBrowserPanel({ onLinked, onJustLinked, onSyncNow, bare = false }: LinkBrowserPanelProps) {
  const [link, setLink] = useState<RcsLinkState | null>(null);
  const [linked, setLinked] = useState(false);
  const [code, setCode] = useState("");
  const [check, setCheck] = useState<Check>({ kind: "idle" });
  /** Live (B2): "Link a browser" opened while already linked. */
  const [howOpen, setHowOpen] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const checkRef = useRef(check);
  checkRef.current = check;

  const refresh = useCallback(async () => {
    const r = await rcsImportService.linkState();
    if (!r.success || !r.data) return;
    const l = r.data.link;
    setLink(l);
    const c = checkRef.current;
    if (c.kind === "checking") {
      const expired = c.expiresAt !== null && Date.now() > c.expiresAt;
      if (r.data.linked && !expired && (l.state === "none" || l.state === "locked")) {
        setCheck({ kind: "linked" });
        onJustLinked?.();
      } else if (l.state === "waiting" && c.triesBefore !== null && l.triesLeft < c.triesBefore) {
        // The browser caught a wrong code: one try used.
        setCheck({ kind: "wrong", message: wrongCodeLine(l.triesLeft) });
        setCode("");
        setTimeout(() => input.current?.focus(), 0);
      } else if (l.state === "none" || l.state === "locked") {
        setCheck({ kind: "wrong", message: expired ? LINK_COPY.expired : LINK_COPY.usedUp });
        setCode("");
      }
    }
    // Live (B1): Keepr's honest state each time (a lost link is shown again).
    if (r.data.linked && !linked) {
      setHowOpen(false);
      onLinked?.();
    }
    setLinked(r.data.linked);
  }, [linked, onLinked, onJustLinked]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  /** The 6th digit (typed or pasted): one try. */
  const submit = useCallback(
    async (six: string) => {
      const triesBefore = link && "triesLeft" in link ? link.triesLeft : null;
      const expiresAt = link && "expiresAt" in link ? link.expiresAt : null;
      setCheck({ kind: "checking", triesBefore, expiresAt });
      const r = await rcsImportService.linkEnterCode(six);
      if (!r.success) {
        setCheck({ kind: "wrong", message: r.error ?? "That code didn't work." });
        setCode("");
        setTimeout(() => input.current?.focus(), 0);
        return;
      }
      void refresh();
    },
    [link, refresh],
  );

  const onType = useCallback(
    (text: string) => {
      const next = cleanLinkCode(text);
      setCode(next);
      if (checkRef.current.kind === "wrong") setCheck({ kind: "idle" });
      if (next.length === 6 && checkRef.current.kind !== "checking") void submit(next);
    },
    [submit],
  );

  const syncNow = useCallback(() => {
    if (onSyncNow) onSyncNow();
    else void rcsImportService.startCacheJob();
  }, [onSyncNow]);

  const waiting = !!link && (link.state === "waiting" || link.state === "answered");
  const locked = link?.state === "locked";
  const justLinked = check.kind === "linked";
  /** Not linked (or "Link a browser"), a code waiting, or just linked here: the steps. */
  const steps = justLinked || (!locked && (waiting || !linked || howOpen));
  const stepNum = "w-7 h-7 flex-shrink-0 rounded-full bg-[#EEF0FF] text-[#312E81] flex items-center justify-center font-bold";
  const fieldBorder = justLinked
    ? "border-[#15803D] bg-[#F0FDF4]"
    : check.kind === "wrong"
      ? "border-[#B42318]"
      : "border-[#CDD1DE] focus:border-[#4F46E5]";
  // 520 wide, padding 28, gap 20 (the mockup).
  return (
    <div
      id={LINK_PANEL_ID}
      className={
        bare
          ? "w-full flex flex-col gap-4 text-[#1F2433]"
          : "w-full max-w-[520px] box-border p-7 flex flex-col gap-5 bg-white rounded-2xl border border-[#D6D9E4] text-[#1F2433]"
      }
      data-testid="gm-link-panel"
    >
      <div className="text-[22px] leading-7 font-bold" data-testid="gm-link-title">{LINK_COPY.title}</div>
      {link?.intrusion && (
        <div className="flex items-center gap-2" role="alert" data-testid="gm-link-intrusion">
          <span className="text-[15px] font-medium text-[#B42318]">{LINK_COPY.locked}</span>
          {link.state !== "locked" && (
            <button type="button" className="text-[13px] text-[#B42318] underline" onClick={() => void rcsImportService.linkDismissWarning().then(refresh)}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {linked && !waiting && !howOpen && !locked && !justLinked && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px] text-[#14532D] font-semibold" data-testid="gm-link-linked">{LINK_COPY.linked}</span>
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
      )}
      {steps && (
        <>
          {/* D05: step 1 stays after the link (only step 2 changes). */}
          <div className="flex gap-3.5 items-center" data-testid="gm-link-step-1">
            <div className={stepNum}>1</div>
            <button
              type="button"
              className="flex-grow min-h-[48px] border-0 rounded-[10px] bg-[#4F46E5] hover:bg-[#4338CA] text-white text-[15px] font-bold"
              onClick={() => void rcsImportService.openGoogleMessages()}
              data-testid="gm-link-open-messages"
            >
              Open Google Messages
            </button>
          </div>
          <div className="flex gap-3.5 items-start" data-testid="gm-link-step-2">
            <div className={`${stepNum} mt-7`}>2</div>
            <div className="flex-grow flex flex-col gap-1.5">
              <label className="flex flex-col gap-1.5 text-[14px] text-[#374151]">
                {LINK_COPY.enter}
                <span className="relative block">
                  <input
                    ref={input}
                    aria-label="Code from Chrome"
                    data-testid="gm-link-code"
                    data-check={check.kind}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder={check.kind === "wrong" ? LINK_COPY.retype : "000 000"}
                    maxLength={7}
                    value={code}
                    readOnly={check.kind === "checking" || justLinked}
                    onChange={(e) => onType(e.target.value)}
                    className={`min-h-[52px] w-full box-border px-3.5 border-2 ${fieldBorder} rounded-[10px] font-mono text-[26px] tracking-[0.2em] text-[#1F2433]`}
                  />
                  {check.kind === "checking" && (
                    <span
                      className="absolute right-3.5 top-1/2 -mt-2.5 w-5 h-5 rounded-full border-2 border-[#CDD1DE] border-t-[#4F46E5] animate-spin"
                      role="status"
                      aria-label="Checking the code"
                      data-testid="gm-link-checking"
                    />
                  )}
                  {justLinked && (
                    <span
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#15803D] font-extrabold text-[22px]"
                      aria-hidden="true"
                      data-testid="gm-link-ok"
                    >
                      ✓
                    </span>
                  )}
                </span>
              </label>
              {/* D05 / F01: under the field — "✓ Linked" + Sync now, or the reason. */}
              {(justLinked || check.kind === "wrong") && (
                <div className="flex flex-col gap-3 mt-1.5">
                  {justLinked && (
                    <span className="flex items-center gap-2 text-[15px] font-bold text-[#15803D]" data-testid="gm-link-just-linked">
                      <span aria-hidden="true">✓</span>
                      <span>{LINK_COPY.justLinked}</span>
                    </span>
                  )}
                  {justLinked && (
                    <button
                      type="button"
                      className="w-full min-h-[48px] border-0 rounded-[10px] bg-[#4F46E5] hover:bg-[#4338CA] text-white text-[15px] font-bold"
                      onClick={syncNow}
                      data-testid="gm-link-sync-now"
                    >
                      {LINK_COPY.syncNow}
                    </button>
                  )}
                  {check.kind === "wrong" && (
                    <span className="text-[14px] font-semibold text-[#B42318]" role="alert" data-testid="gm-link-error">
                      {check.message}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
