/**
 * FdaSafetySheet — "Why does Keepr need this — and is it safe?" slide-up
 * sheet for the PermissionsStep (BACKLOG-1842 redesign, v12 spec).
 *
 * Opens over the permissions step (not a new page — context stays), carries
 * the privacy pledge + a Keepr-vs-other-apps comparison, and ends in the two
 * recorded choices: "Let's go" (closes the sheet, returns to the 3-step
 * instructions) or "Skip for now" (continues onboarding without FDA — the
 * ≥1-source data-source floor covers a user who has email connected).
 *
 * Founder-directed product-behavior change: this is the FIRST escape hatch
 * PermissionsStep has ever had. Flagged for SR review — skipping FDA was not
 * previously possible from this step.
 *
 * @module onboarding/steps/FdaSafetySheet
 */

import React from "react";
import { ResponsiveModal } from "../../common/ResponsiveModal";

export interface FdaSafetySheetProps {
  onLetsGo: () => void;
  onSkip: () => void;
}

function LockIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
      />
    </svg>
  );
}

export function FdaSafetySheet({ onLetsGo, onSkip }: FdaSafetySheetProps) {
  return (
    <ResponsiveModal
      onClose={onLetsGo}
      overlayClassName="bg-black bg-opacity-50"
      // BACKLOG-1842 (visual-polish round): the panel container (ResponsiveModal's
      // `flex flex-col h-full`) previously top-aligned content, leaving large dead
      // white space below on tall windows. `justify-center` centers the column
      // vertically when the content fits; `overflow-y-auto` keeps the mobile
      // (max-sm) full-screen presentation scrollable if content ever exceeds the
      // viewport instead of clipping it.
      panelClassName="max-w-md p-6 justify-center overflow-y-auto"
    >
      <p className="text-[10.5px] font-bold uppercase tracking-wider text-gray-400 mb-1">
        About this permission
      </p>
      <h2 className="text-lg font-extrabold text-gray-900 mb-3 leading-tight">
        Your messages stay on this Mac. Period.
      </h2>
      <p className="text-sm text-gray-600 mb-4 leading-relaxed">
        To build your text-message records, macOS requires one permission
        &mdash; it calls it &ldquo;Full Disk Access.&rdquo; Here&rsquo;s what
        it actually means for Keepr:
      </p>

      <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-green-700 mb-2">
          <LockIcon />
          The Keepr difference
        </div>
        <ul className="space-y-1.5 text-sm text-green-800 list-disc list-inside">
          <li>
            Keepr reads your Messages <strong>on this Mac</strong> &mdash;
            nothing is uploaded, ever
          </li>
          <li>
            Your records are <strong>encrypted here</strong>, in your control
          </li>
          <li>
            You can switch it off in System Settings <strong>any time</strong>
          </li>
        </ul>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-[10.5px] font-bold uppercase tracking-wide text-red-700 mb-1">
            Other apps
          </p>
          <p className="text-xs text-red-800">
            Your messages get uploaded to their servers &#10007;
          </p>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <p className="text-[10.5px] font-bold uppercase tracking-wide text-green-700 mb-1">
            Keepr
          </p>
          <p className="text-xs text-green-800">
            Read + encrypted on this Mac. Nothing leaves &#10003;
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onLetsGo}
        data-testid="fda-safety-lets-go"
        className="w-full bg-primary text-white py-2.5 px-6 rounded-lg font-semibold hover:bg-blue-600 transition-colors mb-2"
      >
        Let&rsquo;s go
      </button>
      <button
        type="button"
        onClick={onSkip}
        data-testid="fda-safety-skip"
        className="w-full bg-gray-100 text-gray-700 py-2.5 px-6 rounded-lg font-semibold hover:bg-gray-200 transition-colors"
      >
        Skip for now
      </button>
      <p className="text-center text-[11px] text-gray-500 mt-3 leading-relaxed">
        Skipping only pauses text-message capture.
        <br />
        Your email records keep building.
        <br />
        Turn it on any time in Settings &rarr; Permissions.
      </p>
    </ResponsiveModal>
  );
}

export default FdaSafetySheet;
