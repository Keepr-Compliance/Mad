/**
 * FDA (Full Disk Access) step — ported "screenshot" graphics.
 *
 * BACKLOG-1842 redesign, founder directive: these three recreations
 * (macOS System Settings > Full Disk Access window, the Touch ID/password
 * auth dialog, and the "choose an app" picker) must be PORTED VERBATIM from
 * the approved mock (fda-screen-options.html) — same markup/styles adapted
 * minimally to React, NOT redesigned. They use raw CSS (not Tailwind) to
 * preserve the exact pixel-for-pixel look from the mock, scoped under a
 * `.kpr-fda-mock` root class so nothing leaks into the app's global styles.
 *
 * The Keepr row inside these graphics uses the real AppMark component (per
 * founder direction) instead of the mock's placeholder <use href="#mark">.
 *
 * @module onboarding/steps/FdaGraphics
 */

import React from "react";
import { AppMark } from "../../common/AppMark";

/**
 * Scoped styles for the ported graphics, translated 1:1 from the mock's
 * .macwin / .sysdlg / .picker rule blocks. Injected once via a <style> tag
 * (React de-dupes identical <style> content across instances is NOT
 * guaranteed, so each graphic component renders its own scoped block keyed
 * by a stable id — cheap, and avoids a global CSS file for three widgets).
 */
const MOCK_STYLES = `
.kpr-fda-mock{
  --mac:#F5F5F7; --macline:#DEDEE3; --macblue:#0A82FF; --gold:#F5A524;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
}
.kpr-fda-mock .macwin{background:var(--mac);border-radius:12px;border:1px solid var(--macline);overflow:hidden;box-shadow:0 10px 28px rgba(0,0,0,.25);font-size:12px}
.kpr-fda-mock .mactitle{display:flex;align-items:center;gap:6px;background:#EAEAEE;border-bottom:1px solid var(--macline);padding:8px 10px}
.kpr-fda-mock .dot{width:10px;height:10px;border-radius:50%}
.kpr-fda-mock .dot.r{background:#FF5F57}
.kpr-fda-mock .dot.y{background:#FEBC2E}
.kpr-fda-mock .dot.g{background:#28C840}
.kpr-fda-mock .mactitle .tt{margin-left:6px;font-size:11px;font-weight:600;color:#5A5A60}
.kpr-fda-mock .macbody{padding:12px 12px 10px}
.kpr-fda-mock .machead{font-size:12.5px;font-weight:700;color:#1D1D1F;margin-bottom:2px}
.kpr-fda-mock .macsub{font-size:10.5px;color:#86868B;margin-bottom:10px}
.kpr-fda-mock .macrow{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid #E5E5EA;padding:8px 10px}
.kpr-fda-mock .macrow:first-of-type{border-radius:9px 9px 0 0}
.kpr-fda-mock .macrow + .macrow{border-top:0}
.kpr-fda-mock .macrow:last-of-type{border-radius:0 0 9px 9px}
.kpr-fda-mock .macrow .ic{width:22px;height:22px;border-radius:6px;background:#C9CAD1;flex:none}
.kpr-fda-mock .macrow .ic.zoom{background:#2D8CFF;display:flex;align-items:center;justify-content:center}
.kpr-fda-mock .macrow .ic.teams{background:#6264A7;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:11px}
.kpr-fda-mock .macrow .nm{font-size:12px;color:#1D1D1F;font-weight:500;flex:1}
.kpr-fda-mock .toggle{width:36px;height:21px;border-radius:20px;background:#D5D5DA;position:relative;flex:none}
.kpr-fda-mock .toggle::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.kpr-fda-mock .toggle.on{background:var(--macblue)}
.kpr-fda-mock .toggle.on::after{left:auto;right:2px}
.kpr-fda-mock .macplus{display:flex;gap:8px;margin-top:7px;padding-left:2px}
.kpr-fda-mock .macplus span{width:22px;height:18px;border:1px solid #D2D2D7;background:#fff;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#6E6E73}
.kpr-fda-mock .kicon{width:22px;height:22px;border-radius:6px;flex:none;display:block}
.kpr-fda-mock .plus-hi{outline:2px solid var(--gold);outline-offset:1px;border-radius:5px}

.kpr-fda-mock .sysdlg-stage{margin-top:10px;background:#EDEEF2;border:1px dashed #E2E3EE;border-radius:11px;padding:14px;display:flex;justify-content:center}
.kpr-fda-mock .sysdlg{width:200px;background:#2B2B2E;border-radius:14px;padding:18px 14px 12px;text-align:center;box-shadow:0 12px 30px rgba(0,0,0,.35)}
.kpr-fda-mock .sd-icon{position:relative;width:52px;height:52px;margin:0 auto 10px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center}
.kpr-fda-mock .sd-icon .fp{width:38px;height:38px}
.kpr-fda-mock .sd-hand{position:absolute;right:-7px;bottom:-3px;width:20px;height:20px;background:#1E7BF6;border-radius:6px;font-size:11px;display:flex;align-items:center;justify-content:center}
.kpr-fda-mock .sd-title{font-size:12.5px;font-weight:800;color:#F5F5F7;margin-bottom:6px}
.kpr-fda-mock .sd-body{font-size:10px;color:#C9C9CE;line-height:1.45;margin:0 0 7px}
.kpr-fda-mock .sd-btn{border-radius:8px;padding:7px;font-size:11px;font-weight:600;margin-top:5px}
.kpr-fda-mock .sd-btn.blue{background:#2667E8;color:#fff}
.kpr-fda-mock .sd-btn.gray{background:#48484D;color:#E8E8EC}

.kpr-fda-mock .picker{background:var(--mac);border-radius:12px;border:1px solid var(--macline);overflow:hidden;box-shadow:0 10px 28px rgba(0,0,0,.22);font-size:11px}
.kpr-fda-mock .pk-body{display:flex;background:#fff}
.kpr-fda-mock .pk-side{width:86px;flex:none;background:#F2F2F5;border-right:1px solid #E5E5EA;padding:7px 5px}
.kpr-fda-mock .pk-item{padding:4px 8px;border-radius:6px;color:#5A5A60;font-size:10.5px;margin-bottom:2px}
.kpr-fda-mock .pk-item.on{background:#DCDCE1;color:#1D1D1F;font-weight:600}
.kpr-fda-mock .pk-list{flex:1;padding:7px 8px}
.kpr-fda-mock .pk-row{display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:6px;color:#1D1D1F;font-size:11px;margin-bottom:1px}
.kpr-fda-mock .pk-row.sel{background:var(--macblue);color:#fff;font-weight:600}
.kpr-fda-mock .pk-ic{width:16px;height:16px;border-radius:4px;background:#C9CAD1;flex:none}
.kpr-fda-mock .pk-foot{display:flex;justify-content:flex-end;gap:7px;padding:8px 10px;background:#F5F5F7;border-top:1px solid #E5E5EA}
.kpr-fda-mock .pk-btn{border-radius:7px;padding:4px 14px;font-size:10.5px;font-weight:600}
.kpr-fda-mock .pk-btn.blue{background:var(--macblue);color:#fff}
.kpr-fda-mock .pk-btn.gray{background:#fff;border:1px solid #D2D2D7;color:#1D1D1F}
`;

let stylesInjected = false;

/**
 * Injects the ported mock styles into the document once. Cheap idempotent
 * guard — React StrictMode double-invokes effects/renders, and multiple
 * graphic instances may mount on the same step.
 */
function useMockStyles() {
  React.useEffect(() => {
    if (stylesInjected) return;
    if (typeof document === "undefined") return;
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-kpr-fda-mock-styles", "true");
    styleEl.textContent = MOCK_STYLES;
    document.head.appendChild(styleEl);
    stylesInjected = true;
  }, []);
}

function ZoomIcon() {
  return (
    <span className="ic zoom">
      <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="7" width="12" height="10" rx="2.5" fill="#fff" />
        <path d="M16 10.5 21 8v8l-5-2.5z" fill="#fff" />
      </svg>
    </span>
  );
}

function FingerprintIcon() {
  return (
    <svg viewBox="0 0 64 64" className="fp" aria-hidden="true">
      <g fill="none" stroke="#E2477B" strokeWidth={2.6} strokeLinecap="round">
        <path d="M32 14c-10 0-18 8-18 18 0 6 1 11 3 16" />
        <path d="M32 20c-6.6 0-12 5.4-12 12 0 6 1.4 12 4 17" />
        <path d="M32 26c-3.3 0-6 2.7-6 6 0 7 2 13 5 18" />
        <path d="M32 32v6c0 5 1.5 9.5 4 13" />
        <path d="M38 27c2.4 1.8 4 4.7 4 8 0 6-1 12-3 16" />
        <path d="M44 20c3.7 3 6 7.6 6 12.8 0 5.2-.8 10.2-2.3 14.7" />
      </g>
    </svg>
  );
}

/**
 * Recreation of macOS System Settings > Privacy & Security > Full Disk
 * Access, showing zoom / Keepr (highlighted, toggled ON) / Microsoft Teams
 * rows plus the +/- add-remove buttons. Used on step 2 of the main screen
 * (toggle already on) — pass `keeprEnabled={false}` for the detour's step 1
 * (before the user has added Keepr).
 *
 * BACKLOG-1842 (visual-polish round): the "↲ this one" callout was removed —
 * the highlighted Keepr row already makes it clear which row matters, and the
 * callout was mispositioned/confusing on the packaged build.
 */
export function FdaSettingsWindowGraphic({
  keeprEnabled = true,
  highlightPlus = false,
}: {
  keeprEnabled?: boolean;
  highlightPlus?: boolean;
}) {
  useMockStyles();
  return (
    <div className="kpr-fda-mock" data-testid="fda-settings-window-graphic">
      <div className="macwin">
        <div className="mactitle">
          <span className="dot r" />
          <span className="dot y" />
          <span className="dot g" />
          <span className="tt">Privacy &amp; Security</span>
        </div>
        <div className="macbody">
          <div className="machead">Full Disk Access</div>
          <div className="macsub">Allow the apps below to access data on this Mac.</div>
          <div className="macrow">
            <ZoomIcon />
            <span className="nm">zoom</span>
            <span className="toggle" />
          </div>
          <div
            className="macrow"
            style={keeprEnabled ? { background: "#F0F3FF", borderColor: "#C9CCF6" } : undefined}
          >
            <AppMark size={22} className="kicon" title="Keepr" />
            <span className="nm" style={{ fontWeight: 700 }}>Keepr</span>
            <span className={`toggle${keeprEnabled ? " on" : ""}`} />
          </div>
          <div className="macrow">
            <span className="ic teams">T</span>
            <span className="nm">Microsoft Teams</span>
            <span className="toggle" />
          </div>
          <div className="macplus">
            <span className={highlightPlus ? "plus-hi" : undefined}>+</span>
            <span>&minus;</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Shared, presentational recreation of the macOS Touch ID / password auth
 * dialog (the dark `.sysdlg` chrome: fingerprint glyph + hand badge, title,
 * body copy, and Use Password / Cancel-style buttons). The visual is fixed —
 * only the copy is parameterized — so every place that shows this system prompt
 * (the FDA step, the Keychain step) renders the SAME mockup with different text.
 *
 * `data-testid` is passed through so callers keep their own stable test hooks.
 *
 * This is the single source of truth for the auth-dialog visual. When the
 * founder tweaks proportions/styles, both consumers update together.
 */
export function AuthDialogMock({
  title,
  bodyLines,
  primaryButtonLabel = "Use Password…",
  secondaryButtonLabel = "Cancel",
  testId = "auth-dialog-mock",
}: {
  /** Bold heading line inside the dialog. */
  title: React.ReactNode;
  /** One or more body copy lines, rendered as stacked `.sd-body` paragraphs. */
  bodyLines: React.ReactNode[];
  /** Emphasized (blue) button label. */
  primaryButtonLabel?: React.ReactNode;
  /** Secondary (gray) button label. */
  secondaryButtonLabel?: React.ReactNode;
  /** Test id applied to the root, so each caller keeps its own hook. */
  testId?: string;
}) {
  useMockStyles();
  return (
    <div className="kpr-fda-mock" data-testid={testId}>
      <div className="sysdlg-stage">
        <div className="sysdlg">
          <div className="sd-icon">
            <FingerprintIcon />
            <span className="sd-hand">&#9995;</span>
          </div>
          <div className="sd-title">{title}</div>
          {bodyLines.map((line, i) => (
            <p className="sd-body" key={i}>
              {line}
            </p>
          ))}
          <div className="sd-btn blue">{primaryButtonLabel}</div>
          <div className="sd-btn gray">{secondaryButtonLabel}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Recreation of the macOS Touch ID / password auth dialog that appears when
 * flipping a Privacy & Security toggle. `showPasswordHint` toggles the extra
 * "Touch ID or enter your password" line shown on the main screen's step 3
 * but omitted on the detour's shorter version.
 *
 * Thin wrapper over the shared {@link AuthDialogMock} — same visual, FDA copy.
 */
export function FdaAuthDialogGraphic({
  showPasswordHint = true,
}: {
  showPasswordHint?: boolean;
}) {
  const bodyLines: React.ReactNode[] = [
    "Privacy & Security is trying to modify your system settings.",
  ];
  if (showPasswordHint) {
    bodyLines.push("Touch ID or enter your password to allow this.");
  }
  return (
    <AuthDialogMock
      testId="fda-auth-dialog-graphic"
      title="Privacy & Security"
      bodyLines={bodyLines}
      primaryButtonLabel="Use Password…"
      secondaryButtonLabel="Cancel"
    />
  );
}

/**
 * Recreation of the "Choose an app to allow full disk access" Finder-style
 * picker shown when the user clicks "+" to add Keepr manually (detour step 3).
 */
export function FdaAppPickerGraphic() {
  useMockStyles();
  return (
    <div className="kpr-fda-mock" data-testid="fda-app-picker-graphic">
      <div className="picker">
        <div className="mactitle">
          <span className="dot r" />
          <span className="dot y" />
          <span className="dot g" />
          <span className="tt">Choose an app to allow full disk access</span>
        </div>
        <div className="pk-body">
          <div className="pk-side">
            <div className="pk-item">Recents</div>
            <div className="pk-item on">Applications</div>
            <div className="pk-item">Documents</div>
          </div>
          <div className="pk-list">
            <div className="pk-row">
              <span className="pk-ic" />
              FaceTime
            </div>
            <div className="pk-row sel">
              <AppMark size={16} className="kicon" title="Keepr" />
              Keepr
            </div>
            <div className="pk-row">
              <span className="pk-ic" />
              Mail
            </div>
            <div className="pk-row">
              <span className="pk-ic" />
              Maps
            </div>
          </div>
        </div>
        <div className="pk-foot">
          <span className="pk-btn gray">Cancel</span>
          <span className="pk-btn blue">Open</span>
        </div>
      </div>
    </div>
  );
}
