/**
 * FDA (Full Disk Access) step telemetry — BACKLOG-1842 redesign.
 *
 * Flow-only events (no message content, no PII) tracking the FDA onboarding
 * funnel: view → (optional safety sheet) → settings opened → check/grant →
 * relaunch resume. Lets us see where FDA scares people off and A/B the
 * "why do we need this" link copy.
 *
 * No dedicated analytics/telemetry service exists in this codebase yet (only
 * Sentry breadcrumbs/messages, used throughout onboarding — see
 * sentryOnboarding.ts). This module extends that SAME mechanism rather than
 * introducing a new pipeline: every event is a Sentry breadcrumb (cheap,
 * always recorded, visible on any subsequent captured error/message for
 * context) and select funnel-boundary events also fire a low-level
 * captureMessage so they're independently queryable in Sentry without
 * requiring an associated error. Flagged in the PR per SR review — a proper
 * product-analytics pipeline (PostHog/Amplitude/etc.) is future work.
 *
 * @module onboarding/steps/fdaTelemetry
 */

import * as Sentry from '@sentry/electron/renderer';

/**
 * The "why do we need this" link copy A/B variants (founder wants to test
 * "Why does Keepr need this?" vs "Is it safe?"). Centralized as a constant
 * per the founder's direction so the experiment can flip from one place.
 */
export const FDA_SAFETY_LINK_COPY = "🔒 Why does Keepr need this — and is it safe?" as const;

/** Which link-copy variant is currently live (for the fda_safety_opened event). */
export const FDA_SAFETY_LINK_VARIANT = "combined" as const;

export type FdaCheckOutcome = "granted" | "not_granted";

export interface FdaTelemetry {
  stepViewed(): void;
  safetyOpened(): void;
  letsGo(): void;
  skipped(): void;
  settingsOpened(): void;
  manualAddOpened(): void;
  checkClicked(outcome: FdaCheckOutcome): void;
  granted(): void;
  relaunchResumed(): void;
  enabledLater(): void;
}

function emit(event: string, extra?: Record<string, unknown>): void {
  // Every event is always recorded as a breadcrumb (cheap, contextualizes
  // any error captured later in the same session).
  Sentry.addBreadcrumb({
    category: 'onboarding.fda',
    message: event,
    level: 'info',
    data: extra,
  });
}

/**
 * Funnel-boundary events (start, terminal outcomes) also get an independent
 * captureMessage so they're queryable in Sentry without needing an
 * associated error/exception. Kept to boundary events to avoid noise —
 * intermediate steps (safety sheet open, settings opened) are breadcrumb-only.
 */
function emitBoundary(event: string, extra?: Record<string, unknown>): void {
  emit(event, extra);
  Sentry.captureMessage(`FDA funnel: ${event}`, {
    level: 'info',
    tags: { component: 'onboarding', step: 'permissions', fda_event: event },
    extra,
  });
}

/**
 * Creates a telemetry emitter for the FDA permissions step. A factory
 * (rather than free functions) so tests can trivially assert call sequences
 * without needing to mock the Sentry module for every call site.
 */
export function createFdaTelemetry(): FdaTelemetry {
  return {
    stepViewed: () => emitBoundary('fda_step_viewed'),
    safetyOpened: () =>
      emit('fda_safety_opened', { link_variant: FDA_SAFETY_LINK_VARIANT }),
    letsGo: () => emit('fda_lets_go'),
    skipped: () => emitBoundary('fda_skipped'),
    settingsOpened: () => emit('fda_settings_opened'),
    manualAddOpened: () => emit('fda_manual_add_opened'),
    checkClicked: (outcome: FdaCheckOutcome) =>
      emit('fda_check_clicked', { outcome }),
    granted: () => emitBoundary('fda_granted'),
    relaunchResumed: () => emitBoundary('fda_relaunch_resumed'),
    enabledLater: () => emitBoundary('fda_enabled_later'),
  };
}
