/**
 * useResumeSetup Hook (BACKLOG-1709 / BACKLOG-1711)
 *
 * Business logic behind the persistent "Resume setup" affordance shown in the
 * main app. Keeps the entry files (App.tsx / AppShell) purely compositional.
 *
 * The hook answers one question — "should we nudge this user to finish
 * connecting a data source?" — by reusing the onboarding data-source floor
 * (BACKLOG-1821) via {@link selectSetupIncomplete}. A user who has satisfied the
 * floor (a mailbox OR a texts source — macOS Full Disk Access, iPhone, or
 * Android) is NEVER surfaced: texts-only is a valid, non-degraded completion.
 *
 * Resume re-enters onboarding at the email-connect step via the existing
 * `START_EMAIL_SETUP` machine action (`app.goToEmailOnboarding`). Dismissal is
 * session-only (backed by the existing `showSetupPromptDismissed` UI flag, which
 * is component-local `useState` reset on reload).
 *
 * @module components/setup/useResumeSetup
 */

import { useOptionalMachineState } from "../../appCore/state/machine";
import { selectSetupIncomplete } from "../../appCore/state/machine/selectors";
import type { AppStateMachine } from "../../appCore/state/types";

export interface UseResumeSetupResult {
  /**
   * True when the persistent "Resume setup" banner should be shown:
   * the user is in the main app (`ready`), the data-source floor is unmet,
   * and they have not dismissed the prompt this session.
   */
  show: boolean;
  /** Re-enter onboarding at the email-connect step. */
  onResume: () => void;
  /** Dismiss the banner for the current session only. */
  onDismiss: () => void;
}

/**
 * Derives whether to show the "Resume setup" affordance and wires its actions.
 *
 * @param app - The app state machine (for the resume action + session dismissal)
 * @returns show flag plus resume/dismiss handlers
 */
export function useResumeSetup(app: AppStateMachine): UseResumeSetupResult {
  const machineState = useOptionalMachineState();

  // Floor-aware: true only when in `ready` AND genuinely below the data-source
  // floor. Non-ready states return false (selector handles this), so the banner
  // is naturally absent during onboarding/login/loading.
  const floorUnmet = machineState
    ? selectSetupIncomplete(machineState.state)
    : false;

  const show = floorUnmet && !app.showSetupPromptDismissed;

  return {
    show,
    onResume: app.goToEmailOnboarding,
    onDismiss: app.handleDismissSetupPrompt,
  };
}
