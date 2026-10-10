/**
 * Normalise the `user:get-account-setup` IPC result (BACKLOG-3673).
 *
 * Anything that is not a well-formed answer -- a missing bridge, a rejection,
 * `success: false`, or an unrecognised `setup` value -- becomes
 * `setup: "unknown"`, which `routeAccount` sends to the "Couldn't load your
 * account settings" screen (never to setup, never to the dashboard).
 * The two answers default to `false` ("not recorded" -> the step is asked).
 *
 * @module appCore/state/machine/routing/readAccountSetup
 */

import type { AccountSetup } from "./routeAccount";
import { hasRecordedEmailProvider } from "../recordedEmailProviders";

export interface AccountSetupReading {
  setup: AccountSetup;
  emailStepAnswered: boolean;
  contactSourceAnswered: boolean;
  /** BACKLOG-3888: the account has connected a mailbox at some point. */
  hasRecordedEmailProvider: boolean;
}

const SETUP_VALUES: ReadonlySet<string> = new Set(["finished", "not-finished", "unknown"]);

export function readAccountSetup(result: unknown): AccountSetupReading {
  const r = (result ?? undefined) as
    | {
        success?: unknown;
        setup?: unknown;
        emailStepAnswered?: unknown;
        contactSourceAnswered?: unknown;
        emailProviders?: unknown;
      }
    | undefined;

  if (!r || r.success !== true || typeof r.setup !== "string" || !SETUP_VALUES.has(r.setup)) {
    return {
      setup: "unknown",
      emailStepAnswered: false,
      contactSourceAnswered: false,
      hasRecordedEmailProvider: false,
    };
  }

  return {
    setup: r.setup as AccountSetup,
    emailStepAnswered: r.emailStepAnswered === true,
    contactSourceAnswered: r.contactSourceAnswered === true,
    hasRecordedEmailProvider: hasRecordedEmailProvider(r.emailProviders),
  };
}
