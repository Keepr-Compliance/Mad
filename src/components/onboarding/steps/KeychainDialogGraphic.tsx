/**
 * Keychain access prompt — ported "screenshot" graphic for the
 * SecureStorageStep (macOS Keychain onboarding step).
 *
 * A recreation of the real macOS system dialog the user sees when Keepr first
 * reads its encryption key from the login keychain:
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
 * Built to mirror FdaGraphics.tsx: raw CSS (not Tailwind) scoped under a
 * `.kpr-keychain-mock` root class so the pixel-for-pixel macOS look never
 * leaks into the app's global styles, injected once via an idempotent guard.
 * The Keepr row uses the real AppMark component (matching the FDA graphics).
 *
 * Rendered with JSX/SVG only — no screenshots — so it renders identically
 * regardless of host system fonts.
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
 * Recreation of the macOS Keychain-access system dialog shown the first time
 * Keepr reads its encryption key from the login keychain. Ported to look like
 * the real prompt so the user recognizes it when it appears. The "Always
 * Allow" button is emphasized (it's the default action Keepr guides the user
 * to click, so they aren't re-prompted on every launch).
 */
export function KeychainDialogGraphic() {
  useKeychainMockStyles();
  return (
    <div className="kpr-keychain-mock" data-testid="keychain-dialog-graphic">
      <div className="kcwin">
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

export default KeychainDialogGraphic;
