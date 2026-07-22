/**
 * Keychain access prompt — ported "screenshot" graphic for the
 * SecureStorageStep (macOS Keychain onboarding step).
 *
 * A recreation of the real macOS system dialog the user sees when Keepr first
 * reads its encryption key from the login keychain. macOS shows this prompt in
 * ONE of TWO forms depending on the Mac, so we recreate both:
 *
 * 1. Password form (`KeychainDialogGraphic`) — the classic prompt with a
 *    password field:
 *
 *   ┌───────────────────────────────────────────┐
 *   │ [K]  Keepr wants to use your confidential  │
 *   │      information stored in "login keychain"│
 *   │      in your keychain.                     │
 *   │                                            │
 *   │      To allow this, enter the "login"      │
 *   │      keychain password.                    │
 *   │                                            │
 *   │      Password: [•••••••••••••]             │
 *   │                                            │
 *   │        [Always Allow]  [Allow]   [Deny]    │
 *   └───────────────────────────────────────────┘
 *
 * 2. Touch ID form (`KeychainTouchIdGraphic`) — shown on Touch-ID Macs. Same
 *    app-icon + heading, but instead of the password field it shows a Touch ID
 *    fingerprint glyph with "Use Touch ID to allow this", an "Enter
 *    Password…" fallback affordance, and the Always Allow / Deny buttons:
 *
 *   ┌───────────────────────────────────────────┐
 *   │ [K]  Keepr wants to use your confidential  │
 *   │      information stored in "login keychain"│
 *   │      in your keychain.                     │
 *   │                                            │
 *   │              ( fingerprint )               │
 *   │           Use Touch ID to allow this       │
 *   │                Enter Password…             │
 *   │                                            │
 *   │        [Always Allow]           [Deny]     │
 *   └───────────────────────────────────────────┘
 *
 * Built to mirror FdaGraphics.tsx: raw CSS (not Tailwind) scoped under a
 * `.kpr-keychain-mock` root class so the pixel-for-pixel macOS look never
 * leaks into the app's global styles, injected once via an idempotent guard.
 * The Keepr row uses the real AppMark component (matching the FDA graphics).
 *
 * Rendered with JSX/SVG only — no screenshots — so it renders identically
 * regardless of host system fonts.
 *
 * NOTE: The Touch ID variant is a hand-built recreation and warrants a founder
 * visual glance against a real Touch-ID keychain prompt.
 *
 * @module onboarding/steps/KeychainDialogGraphic
 */

import React from "react";
import { AppMark } from "../../common/AppMark";

/**
 * Scoped styles for the ported keychain dialog. Same authoring approach as
 * FdaGraphics' MOCK_STYLES: a single `.kpr-keychain-mock` root scopes every
 * rule so nothing bleeds into global styles.
 */
const KEYCHAIN_MOCK_STYLES = `
.kpr-keychain-mock{
  --kc-line:#D0D0D5;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  display:flex;justify-content:center;
}
.kpr-keychain-mock .kcwin{
  width:340px;max-width:100%;
  background:#ECECEE;
  border:1px solid var(--kc-line);
  border-radius:12px;
  box-shadow:0 12px 30px rgba(0,0,0,.28);
  padding:18px 18px 14px;
}
.kpr-keychain-mock .kc-top{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px}
.kpr-keychain-mock .kc-icon{width:44px;height:44px;border-radius:10px;flex:none;display:block}
.kpr-keychain-mock .kc-copy{flex:1;min-width:0}
.kpr-keychain-mock .kc-title{font-size:12.5px;font-weight:700;color:#1D1D1F;line-height:1.4;margin:0 0 6px}
.kpr-keychain-mock .kc-sub{font-size:11px;color:#5A5A60;line-height:1.4;margin:0}
.kpr-keychain-mock .kc-field-row{display:flex;align-items:center;gap:8px;margin:0 0 14px}
.kpr-keychain-mock .kc-field-label{font-size:11.5px;color:#1D1D1F;flex:none}
.kpr-keychain-mock .kc-field{
  flex:1;height:22px;background:#fff;border:1px solid #C2C2C8;border-radius:5px;
  box-shadow:inset 0 1px 1px rgba(0,0,0,.06);
  display:flex;align-items:center;padding:0 8px;letter-spacing:2px;color:#3A3A40;font-size:11px;
}
.kpr-keychain-mock .kc-btns{display:flex;justify-content:flex-end;gap:8px}
.kpr-keychain-mock .kc-btn{
  border-radius:7px;padding:5px 12px;font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap;
  border:1px solid #C2C2C8;background:#FBFBFC;color:#1D1D1F;
}
.kpr-keychain-mock .kc-btn.primary{
  background:#0A82FF;border-color:#0A82FF;color:#fff;box-shadow:0 1px 2px rgba(10,130,255,.35);
}

/* Touch ID variant — same window chrome, fingerprint prompt instead of a field. */
.kpr-keychain-mock .kc-touch{
  display:flex;flex-direction:column;align-items:center;gap:6px;margin:2px 0 14px;
}
.kpr-keychain-mock .kc-fingerprint{width:40px;height:40px;display:block;color:#6B6B72}
.kpr-keychain-mock .kc-touch-prompt{font-size:12px;font-weight:600;color:#1D1D1F;margin:0;text-align:center}
.kpr-keychain-mock .kc-touch-alt{
  font-size:11px;color:#0A6CFF;margin:0;text-align:center;
  background:none;border:none;padding:0;cursor:default;
}
`;

let stylesInjected = false;

/**
 * Injects the ported keychain-dialog styles into the document once. Idempotent
 * guard mirroring FdaGraphics.useMockStyles — safe against StrictMode's
 * double-invoke and multiple graphic instances on one step.
 */
function useKeychainMockStyles() {
  React.useEffect(() => {
    if (stylesInjected) return;
    if (typeof document === "undefined") return;
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-kpr-keychain-mock-styles", "true");
    styleEl.textContent = KEYCHAIN_MOCK_STYLES;
    document.head.appendChild(styleEl);
    stylesInjected = true;
  }, []);
}

/**
 * The shared app-icon + heading block that opens both keychain prompt forms.
 * Kept identical between the password and Touch ID variants so the two mockups
 * read as the same system dialog in two guises.
 */
function KeychainHeader() {
  return (
    <div className="kc-top">
      <AppMark size={44} className="kc-icon" title="Keepr" />
      <div className="kc-copy">
        <p className="kc-title">
          Keepr wants to use your confidential information stored in
          &ldquo;login keychain&rdquo; in your keychain.
        </p>
        <p className="kc-sub">
          To allow this, enter the &ldquo;login&rdquo; keychain password.
        </p>
      </div>
    </div>
  );
}

/**
 * Inline Touch ID fingerprint glyph — concentric fingerprint ridges drawn as
 * stroked SVG arcs so it renders identically regardless of host fonts/assets.
 */
function FingerprintGlyph() {
  return (
    <svg
      className="kc-fingerprint"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 10.5a1.5 1.5 0 0 1 1.5 1.5c0 1.8-.2 3.6-.7 5.3" />
      <path d="M9 11.8a3 3 0 0 1 5.9-.6c.3 2.4.1 4.9-.6 7.2" />
      <path d="M6.6 12.2a5.4 5.4 0 0 1 10.6-1.1c.4 2.9.2 5.9-.7 8.7" />
      <path d="M4.5 14.5A9 9 0 0 1 4 12a8 8 0 0 1 15.5-2.8" />
      <path d="M7 20.4a12 12 0 0 0 1-3.4" />
      <path d="M20 12v.6c0 2.2-.3 4.4-1 6.5" />
      <path d="M6.5 6.8A8 8 0 0 1 17.6 7" />
    </svg>
  );
}

/**
 * Recreation of the macOS Keychain-access system dialog (password form) shown
 * the first time Keepr reads its encryption key from the login keychain. Ported
 * to look like the real prompt so the user recognizes it when it appears. The
 * "Always Allow" button is emphasized (it's the default action Keepr guides the
 * user to click, so they aren't re-prompted on every launch).
 */
export function KeychainDialogGraphic() {
  useKeychainMockStyles();
  return (
    <div className="kpr-keychain-mock" data-testid="keychain-dialog-graphic">
      <div className="kcwin">
        <KeychainHeader />

        <div className="kc-field-row">
          <span className="kc-field-label">Password:</span>
          <span className="kc-field" aria-hidden="true">
            &bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;
          </span>
        </div>

        <div className="kc-btns">
          <span className="kc-btn primary">Always Allow</span>
          <span className="kc-btn">Allow</span>
          <span className="kc-btn">Deny</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Recreation of the macOS Keychain-access system dialog (Touch ID form) shown
 * on Touch-ID Macs. Shares the app-icon + heading with the password form, but
 * replaces the password field with a Touch ID fingerprint glyph, "Use Touch ID
 * to allow this" prompt text, and an "Enter Password…" fallback affordance.
 *
 * Hand-built recreation — warrants a founder visual glance against a real
 * Touch-ID keychain prompt.
 */
export function KeychainTouchIdGraphic() {
  useKeychainMockStyles();
  return (
    <div className="kpr-keychain-mock" data-testid="keychain-touchid-graphic">
      <div className="kcwin">
        <KeychainHeader />

        <div className="kc-touch">
          <FingerprintGlyph />
          <p className="kc-touch-prompt">Use Touch ID to allow this</p>
          <p className="kc-touch-alt" aria-hidden="true">
            Enter Password&hellip;
          </p>
        </div>

        <div className="kc-btns">
          <span className="kc-btn primary">Always Allow</span>
          <span className="kc-btn">Deny</span>
        </div>
      </div>
    </div>
  );
}

export default KeychainDialogGraphic;
