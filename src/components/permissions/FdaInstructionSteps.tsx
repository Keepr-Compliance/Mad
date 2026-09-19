/**
 * FdaInstructionSteps / FdaManualAddSteps — the Full Disk Access how-to,
 * extracted from `PermissionsStep` so onboarding and the post-onboarding
 * explainer render ONE definition of it (BACKLOG-3210 part 2, round 2).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The first round of this item pointed "Show me how" at `FdaSafetySheet`. That
 * sheet answers "is this safe" — the privacy pledge and the Keepr-vs-other-apps
 * comparison — and answers nothing about HOW. Its own props say so:
 * `onLetsGo` / `onSkip` are a consent decision, not guidance. A button labelled
 * "Show me how" that opened it promised something it did not contain.
 *
 * The instructions the founder means are these: the numbered steps with the
 * ported macOS graphics that have always been the last screen of onboarding.
 * They are now here, and BOTH consumers render this module. That is the point
 * of the extraction, not a side effect of it: if Settings and onboarding kept
 * separate copies they would teach users different things the first time either
 * was edited, and no test in the repo would notice.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT IN HERE
 * ---------------------------------------------------------------------------
 * Onboarding navigation. No Continue, no Back, no "Check permissions" — those
 * belong to the onboarding queue and the relaunch flow, and they are the reason
 * this could not simply be rendered from Settings before. The onboarding step
 * keeps every one of them, unchanged, around this card.
 *
 * The copy is ported verbatim from the founder-approved mock
 * (fda-screen-options.html) by way of `PermissionsStep`. Do not paraphrase it.
 *
 * @module components/permissions/FdaInstructionSteps
 */

import React from "react";
import {
  FdaSettingsWindowGraphic,
  FdaAuthDialogGraphic,
  FdaAppPickerGraphic,
} from "../onboarding/steps/FdaGraphics";

/**
 * Numbered circle badge for a step's leading number (BACKLOG-1842
 * visual-polish round). Mirrors the approved mock's `ol.steps li::before`
 * rule: a small filled indigo circle with the white bold number, sitting to
 * the left of the step's title.
 */
export function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-white text-xs font-bold flex items-center justify-center"
    >
      {n}
    </span>
  );
}

export interface FdaInstructionStepsProps {
  /**
   * The "Open System Settings" button. Onboarding passes its
   * trigger-then-open-then-poll handler; the post-onboarding explainer passes
   * the shared `systemService.openFullDiskAccessSettings`.
   */
  onOpenSystemSettings: () => void;
  /**
   * The "Keepr not in the list? Add it manually" link. OPTIONAL: when it is
   * not supplied the link is not rendered, so a consumer with nowhere to send
   * the user cannot show a link that goes nowhere.
   */
  onAddManually?: () => void;
  /**
   * BACKLOG-3210 (part 2): step 3's closing sentence.
   *
   * The default is onboarding's, and it is TRUE ONLY THERE: `PermissionsStep`
   * relaunches the app itself the moment it detects the grant, and resumes the
   * queue afterwards. macOS decides an app's Full Disk Access at process start
   * and does not revisit it, so from Settings or the dashboard nothing restarts
   * on its own — which is exactly why BACKLOG-3208 put a "restart Keepr to
   * finish" notice in the Messages panel. A shared component that carried
   * onboarding's promise into those surfaces would state something the app does
   * not do, one inch from a panel saying the opposite.
   */
  restartCopy?: React.ReactNode;
}

/**
 * The three numbered steps. Ported verbatim from `PermissionsStep`'s inline
 * `<ol>`; the only changes are the two callbacks and the restart sentence.
 *
 * BACKLOG-1842 (hanging-indent fix): each `li` is a flex row with the badge
 * (w-6) + gap-3 forming a 36px left gutter — the circle sits OUTSIDE the text
 * column (list-style-position: outside equivalent) and every step's text starts
 * at the same 36px axis as the header block above it (pl-9).
 */
export function FdaInstructionSteps({
  onOpenSystemSettings,
  onAddManually,
  restartCopy,
}: FdaInstructionStepsProps) {
  return (
    <ol
      className="space-y-5 mb-6 text-sm text-gray-700"
      data-testid="fda-instruction-steps"
    >
      <li className="flex gap-3">
        <StepBadge n={1} />
        <div className="flex-1 min-w-0">
          <p className="font-bold text-gray-900 mb-1">Open System Settings</p>
          <p className="text-xs text-gray-500">
            We&rsquo;ll take you straight to the right pane.
          </p>

          {/* BACKLOG-1842 (visual-polish, founder-directed): the primary
              "Open System Settings" action sits here, directly under step 1,
              rather than at the bottom with the other button. */}
          <button
            onClick={onOpenSystemSettings}
            data-testid="onboarding-permissions-open-settings"
            className="w-full mt-3 bg-primary text-white py-2.5 px-6 rounded-lg font-semibold hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Open System Settings
          </button>
        </div>
      </li>
      <li className="flex gap-3">
        <StepBadge n={2} />
        <div className="flex-1 min-w-0">
          <p className="font-bold text-gray-900 mb-1">Flip the Keepr toggle on</p>
          <p className="text-xs text-gray-500 mb-2">It&rsquo;ll look exactly like this:</p>

          {/* BACKLOG-1842 (visual-polish, founder-directed): the "not listed?
              add manually" link sits here — right after "It'll look exactly
              like this:" and before the Settings-window graphic, because that
              is where a user realizes Keepr isn't in their list. */}
          {onAddManually && (
            <button
              type="button"
              onClick={onAddManually}
              data-testid="onboarding-permissions-manual-add-link"
              className="block text-left text-xs font-semibold text-gray-400 underline underline-offset-2 mb-2"
            >
              Keepr not in the list? Add it manually &rarr;
            </button>
          )}

          <FdaSettingsWindowGraphic keeprEnabled />
        </div>
      </li>
      <li className="flex gap-3">
        <StepBadge n={3} />
        <div className="flex-1 min-w-0">
          <p className="font-bold text-gray-900 mb-1">
            Approve &mdash; then Keepr restarts automatically
          </p>
          <p className="text-xs text-gray-500 mb-2">
            {restartCopy ?? (
              <>
                macOS will ask you to confirm with Touch ID or your password
                &mdash; this exact prompt. Approve it; Keepr quits and reopens
                right back here.
              </>
            )}
          </p>
          <FdaAuthDialogGraphic />
        </div>
      </li>
    </ol>
  );
}

export interface FdaManualAddStepsProps {
  /**
   * BACKLOG-3210 (part 2): step 4's closing sentence, for the same reason as
   * `restartCopy` above — onboarding continues its setup after the relaunch,
   * and nothing outside onboarding has a setup to continue.
   */
  returnCopy?: React.ReactNode;
}

/**
 * The "Keepr isn't in the list" detour: how to add the app by hand.
 *
 * The STEPS only. The way back out is the consumer's, because the two contexts
 * return to different places — onboarding replaces its whole screen with this
 * and returns to the step, while the explainer swaps a view inside its sheet.
 */
export function FdaManualAddSteps({ returnCopy }: FdaManualAddStepsProps) {
  return (
    <ol
      className="space-y-5 mb-6 text-sm text-gray-700"
      data-testid="fda-manual-add-steps"
    >
      <li>
        <p className="font-semibold mb-1">
          1. Click the <strong>+</strong> under the Full Disk Access list
        </p>
        <FdaSettingsWindowGraphic keeprEnabled={false} highlightPlus />
      </li>
      <li>
        <p className="font-semibold mb-1">2. Approve with Touch ID or your password</p>
        <p className="text-xs text-gray-500 mb-2">Same prompt as before &mdash; that&rsquo;s macOS confirming it&rsquo;s really you.</p>
        <FdaAuthDialogGraphic showPasswordHint={false} />
      </li>
      <li>
        <p className="font-semibold mb-1">3. Pick Keepr in the window that opens</p>
        <p className="text-xs text-gray-500 mb-2">It&rsquo;s the indigo <strong>K</strong> in your Applications folder.</p>
        <FdaAppPickerGraphic />
      </li>
      <li>
        <p className="font-semibold mb-1">4. That&rsquo;s it &mdash; the toggle turns on by itself</p>
        <p className="text-xs text-gray-500 mb-2">
          {returnCopy ?? (
            <>
              Keepr appears in the list already enabled. Come back and Keepr will
              restart and continue your setup automatically.
            </>
          )}
        </p>
        <FdaSettingsWindowGraphic keeprEnabled />
      </li>
    </ol>
  );
}
