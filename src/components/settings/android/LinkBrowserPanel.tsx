/**
 * C1 (UX redesign, founder 2026-10-03): link the Keepr extension with this
 * Keepr — REVERSED: the extension shows a 6-digit code, the user types it
 * here. Keepr never makes a code.
 *
 * The approved storyboards (KeeprLinkPrompt, D01–D05, F01–F02; founder
 * 2026-10-04): ONE minimal card — "Link your browser", (1) Open Google
 * Messages (works without a link), (2) "Type the code from Chrome". The 6th
 * digit (typed or pasted) submits by itself — no Link button. The field
 * says the state, and its colour always wins over focus:
 *   idle      grey border (indigo while focused)
 *   checking  a small spinner in the field
 *   linked    green border + green tint, ✓ inside (the parent then switches
 *             to the linked screen); the code is not shown afterwards
 *   wrong     red border, "Code didn't match · N tries left" — until the
 *             user types again
 *   used up   disabled (grey), "Code used up. Get a new code in Chrome."
 * Every submitted code is one try (Keepr counts them, unchanged).
 *
 * Shown in the Sync Android modal's link step (id "gm-link-panel").
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { RcsLinkState } from "../../../../electron/types/ipc/window-api-rcs-import";
import { rcsImportService } from "../../../services/rcsImportService";

export const LINK_PANEL_ID = "gm-link-panel";
export const LINK_COPY = {
  title: "Link your browser",
  enter: "Type the code from Chrome",
  usedUp: "Code used up. Get a new code in Chrome.",
  expired: "Code expired. Get a new code in Chrome.",
  locked: "Another app tried to link — check for unknown software",
} as const;
const POLL_MS = 1000;

/** The field's colours per state (they win over any focus style). */
export const FIELD_COLORS = {
  idle: { border: "#CDD1DE", focus: "#4F46E5", background: "#FFFFFF" },
  checking: { border: "#4F46E5", focus: "#4F46E5", background: "#FFFFFF" },
  linked: { border: "#15803D", focus: "#15803D", background: "#F0FDF4" },
  wrong: { border: "#B42318", focus: "#B42318", background: "#FFFFFF" },
  usedUp: { border: "#E5E7EB", focus: "#E5E7EB", background: "#F9FAFB" },
} as const;

/** "Code didn't match · 3 tries left" (SR, F01 storyboard). */
export function wrongCodeLine(triesLeft: number): string {
  return `Code didn't match · ${triesLeft} ${triesLeft === 1 ? "try" : "tries"} left`;
}

/** "123456" / "123 456" / "123-456" → "123456" (digits only, at most 6). */
export function cleanLinkCode(text: string): string {
  return text.replace(/[^0-9]/g, "").slice(0, 6);
}

interface LinkBrowserPanelProps {
  /** Called once Keepr reports this user linked. */
  onLinked?: () => void;
  /** A code typed here just linked the browser (the parent shows the linked screen). */
  onJustLinked?: () => void;
  /** Inside the Sync Android modal (D01): no card of its own — the modal frames it. */
  bare?: boolean;
}

type Check =
  | { kind: "idle" }
  | { kind: "checking"; triesBefore: number | null; expiresAt: number | null }
  | { kind: "wrong"; message: string }
  | { kind: "usedUp"; message: string }
  | { kind: "linked" };

export function LinkBrowserPanel({ onLinked, onJustLinked, bare = false }: LinkBrowserPanelProps) {
  const [link, setLink] = useState<RcsLinkState | null>(null);
  const [linked, setLinked] = useState(false);
  const [code, setCode] = useState("");
  const [check, setCheck] = useState<Check>({ kind: "idle" });
  const [focused, setFocused] = useState(false);
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
        // F02: the last try burned the code (or it expired): nothing to type into.
        setCheck({ kind: "usedUp", message: expired ? LINK_COPY.expired : LINK_COPY.usedUp });
        setCode("");
      }
    } else if (c.kind === "usedUp" && l.state === "waiting") {
      // A new code from Chrome: the field is back.
      setCheck({ kind: "idle" });
    }
    if (r.data.linked && !linked) onLinked?.();
    setLinked(r.data.linked);
  }, [linked, onLinked, onJustLinked]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Founder Option 1: the code field is focused on arrival — when the card
  // opens, and again when the extension brings Keepr forward with a code
  // waiting (its /focus opens this step). Nothing else is arranged.
  useEffect(() => {
    const focusField = (): void => {
      const el = input.current;
      if (el && !el.disabled && !el.readOnly) el.focus();
    };
    focusField();
    return rcsImportService.onOpenLinkScreen(() => setTimeout(focusField, 0));
  }, []);

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
      // F01: the red stays until the user types again.
      if (checkRef.current.kind === "wrong") setCheck({ kind: "idle" });
      if (next.length === 6 && checkRef.current.kind !== "checking") void submit(next);
    },
    [submit],
  );

  const locked = link?.state === "locked";
  const justLinked = check.kind === "linked";
  const usedUp = check.kind === "usedUp";
  const colors = FIELD_COLORS[check.kind];
  const stepNum = "w-7 h-7 flex-shrink-0 rounded-full bg-[#EEF0FF] text-[#312E81] flex items-center justify-center font-bold";
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
      {(!locked || justLinked) && (
        <>
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
                    aria-invalid={check.kind === "wrong" || usedUp}
                    data-testid="gm-link-code"
                    data-check={check.kind}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder={usedUp ? "" : "000 000"}
                    maxLength={7}
                    value={code}
                    disabled={usedUp}
                    tabIndex={usedUp ? -1 : undefined}
                    readOnly={check.kind === "checking" || justLinked}
                    onChange={(e) => onType(e.target.value)}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    className="min-h-[52px] w-full box-border px-3.5 border-2 rounded-[10px] font-mono text-[26px] tracking-[0.2em] text-[#1F2433] disabled:cursor-not-allowed"
                    // The state's colour always wins: no browser / global focus
                    // outline here; the focus indicator is a ring in the
                    // state's own colour (indigo while idle).
                    style={{
                      borderColor: focused && check.kind === "idle" ? colors.focus : colors.border,
                      background: colors.background,
                      outline: "none",
                      boxShadow: focused && !usedUp ? `0 0 0 3px ${colors.focus}33` : "none",
                    }}
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
              {(check.kind === "wrong" || usedUp) && (
                <span className="mt-1.5 text-[14px] font-semibold text-[#B42318]" role="alert" data-testid="gm-link-error">
                  {check.message}
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
