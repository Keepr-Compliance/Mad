/**
 * Full Disk Access state — one named state, replacing three booleans.
 *
 * BACKLOG-3275. Before this module, the same situation was described by
 * `UserData.hasPermissions`, `UserData.fdaSkipped` and the `"permissions"`
 * entry in `completedSteps`. Three independent fields can express combinations
 * the domain does not have, and they did: `reducer.ts` seeded `completedSteps`
 * from the flags and then derived the flags back out of `completedSteps`, so a
 * user who DECLINED Full Disk Access was reported as having GRANTED it.
 *
 * The case that kept being lost is "never asked". With two booleans it was only
 * visible by reading both together, and every transition that rebuilt `UserData`
 * dropped one of them.
 *
 * @module appCore/state/machine/fdaState
 */

/**
 * The Full Disk Access situation, as one value.
 *
 * Deliberately NOT the `"granted" | "denied" | "unknown"` union at
 * `electron/services/contactsDiagnostics.ts:167`. That one is an optional INPUT
 * PARAMETER to a diagnostics collector: its `"unknown"` is the `?? "unknown"`
 * default meaning "the caller passed nothing", and its `"denied"` means "the
 * probe returned false" — which is equally true of a user who has never been
 * asked. Reusing those tokens would encode BACKLOG-3275's bug in the type.
 *
 * The `"n/a"` precedent at `contactsDiagnostics.ts:178-181` DOES transfer, and
 * `"not-applicable"` exists for its stated reason: forcing a token rather than
 * "letting a stale `granted` through, which would be a confidently wrong line
 * on a Windows ticket".
 */
export type FdaState =
  /** The permission probe reports Full Disk Access is present. */
  | "granted"
  /**
   * The user chose "Skip for now" and that choice is persisted (Supabase
   * user_preferences `onboarding.fdaSkipped`). Asked and answered: no.
   *
   * This is the ONLY token sourced from a user action rather than a probe, and
   * that is what keeps it cleanly separable from `"not-asked"`.
   */
  | "declined"
  /**
   * Not granted, and no recorded decline.
   *
   * KNOWN NARROWING (BACKLOG-3275 OQ-2, accepted deliberately): a probe that
   * THREW is swallowed into `false` at `LoadingOrchestrator.tsx:640-643`
   * (`.catch(() => ({ hasPermission: false, fullDiskAccess: false }))`) and at
   * `usePermissionsFlow.ts:57-61` (`else { setHasPermissions(false) }`). So
   * this token silently also covers "we could not find out" — the same
   * conflation BACKLOG-2926 removed one subsystem over, where `"check-failed"`
   * was split from `"no-backup"` because `GROUP BY` could not separate "we know
   * there is none" from "we could not find out".
   *
   * Not fixed here: distinguishing them means widening the `check-permissions`
   * IPC contract, which is its own item. Adding a fifth token now would create
   * an arm with no producer. Both directions lead to "ask", so the narrowing is
   * behaviourally safe — it is recorded, not relied upon.
   */
  | "not-asked"
  /**
   * Non-macOS. Full Disk Access is not a concept on this platform, so neither
   * "granted" nor "denied" is a true statement about it.
   */
  | "not-applicable";

/**
 * THE CAPABILITY QUESTION: can this user actually read the local Messages
 * database right now?
 *
 * Feeds `OnboardingContext.permissionsGranted` and, through it, the
 * BACKLOG-1821 data-source floor. Answer "yes" only for an observed grant.
 *
 * `"not-applicable"` is false on purpose. Full Disk Access is not a data source
 * on Windows, and saying otherwise is how `reducer.ts` used to put
 * `hasPermissions: true` on every Windows user. Every consumer that would care
 * is already platform-guarded (`reducer.ts:89`, `:157`, `dataSourceFloor.ts:84`
 * via `isMacOsFamily`, and `PermissionsStep` meta `platforms: ["macos"]`), so
 * the honest value costs nothing.
 */
export function isFdaGranted(fda: FdaState): boolean {
  switch (fda) {
    case "granted":
      return true;
    case "declined":
      return false;
    case "not-asked":
      return false;
    case "not-applicable":
      // Not a texts source here. See the doc comment above.
      return false;
    default: {
      // Adding a state without deciding whether it grants the capability fails
      // to compile here — which is the point.
      const exhaustive: never = fda;
      return exhaustive;
    }
  }
}

/**
 * THE NAVIGATION QUESTION: is there still something to ask this user about
 * Full Disk Access?
 *
 * Deliberately PURE on `fda`. `isOnboardingComplete` additionally releases a
 * user who declined AND has a mailbox (BACKLOG-3212), but that conjunct reads
 * `hasEmailConnected` — a second field — so it stays at its call site in
 * `reducer.ts` rather than being folded in here. A function that reads a second
 * field is not a projection of this union and cannot be exhaustively checked
 * on it.
 *
 * This is the function that replaces the `platform.isMacOS &&` guards at
 * `reducer.ts:89` and `:157`: `"not-applicable"` answers "no, nothing to ask",
 * which is exactly what those guards short-circuited to.
 */
export function fdaBlocksOnboarding(fda: FdaState): boolean {
  switch (fda) {
    case "granted":
      return false;
    case "declined":
      // Answered, but the capability is absent. Callers that release a declined
      // user apply their own additional condition — see reducer.ts:157.
      return true;
    case "not-asked":
      return true;
    case "not-applicable":
      return false;
    default: {
      // A new state must decide whether onboarding may pass it.
      const exhaustive: never = fda;
      return exhaustive;
    }
  }
}

/**
 * THE "ALREADY ANSWERED" QUESTION: has this user given an answer — either one —
 * to the Full Disk Access prompt?
 *
 * Used in exactly two places, and only these two: seeding the `"permissions"`
 * entry of `completedSteps` in `USER_DATA_LOADED`, and seeding the onboarding
 * queue's manually-completed set in `OnboardingFlow.tsx`.
 *
 * This is the one-way arrow that stops the drift BACKLOG-3275 is about.
 * `completedSteps` is derived FROM this union; no reducer path derives the
 * union from `completedSteps`.
 *
 * NOTE: `"not-applicable"` returns true, but both call sites keep their own
 * `platform.isMacOS` guard. That is not redundancy for its own sake — a Windows
 * user must not acquire `"permissions"`/`"secure-storage"` entries they do not
 * have today, and `completedSteps` is read outside the reducer at
 * `derivation/stepDerivation.ts:189`.
 */
export function wasFdaAnswered(fda: FdaState): boolean {
  switch (fda) {
    case "granted":
      return true;
    case "declined":
      return true;
    case "not-asked":
      return false;
    case "not-applicable":
      // Nothing to answer. Call sites guard on platform anyway; see above.
      return true;
    default: {
      // A new state must decide whether it counts as an answer.
      const exhaustive: never = fda;
      return exhaustive;
    }
  }
}

/**
 * The single derivation point, called only from `LoadingOrchestrator` Phase 4.
 *
 * Both inputs already exist and neither contract changes: `probeGranted` comes
 * from the `check-permissions` IPC call, `recordedDecline` from the
 * `onboarding.fdaSkipped` key in the Supabase preferences bag that
 * `PermissionsStep` writes.
 *
 * Order matters: an observed grant wins over a stale recorded decline, so a
 * user who declined and later granted in System Settings is reported granted.
 */
export function fdaFromProbe(input: {
  isMacOS: boolean;
  probeGranted: boolean;
  recordedDecline: boolean;
}): FdaState {
  if (!input.isMacOS) {
    return "not-applicable";
  }
  if (input.probeGranted) {
    return "granted";
  }
  if (input.recordedDecline) {
    return "declined";
  }
  return "not-asked";
}

/**
 * The state to assume when Full Disk Access has not been established at all —
 * a fallback path, or a transition rebuilding `UserData` without a loaded
 * value.
 *
 * "Ask again" is the safe direction to be wrong in, so macOS gets
 * `"not-asked"`, never `"declined"`. Making a user who was never asked look
 * declined is how BACKLOG-3212's population would stop being asked by accident.
 */
export function unknownFdaFor(platform: { isMacOS: boolean }): FdaState {
  return platform.isMacOS ? "not-asked" : "not-applicable";
}
