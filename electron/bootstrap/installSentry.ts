/**
 * Sentry for the main process, initialised BEFORE the composition root
 * (BACKLOG-2962).
 *
 * Imported for its side effect from `main.ts`, in the same style as
 * `installAppDataPaths` and `installNativeCapabilities`. Until this module
 * existed, `Sentry.init` sat at `main.ts:223` — AFTER the composition root at
 * `main.ts:12` — so a capability missing at launch exited the app before Sentry
 * existed. The founder's question after the 2026-09-06 launch probe ("did it
 * also fire a Sentry log?") was answered "no, by construction". This is the
 * construction changing.
 *
 * WHERE THIS IMPORT MAY SIT IN `main.ts`, AND WHY — traced, not chosen
 * ----------------------------------------------------------------------
 *   AFTER  `./bootstrap/installAppDataPaths`  (main.ts:6)
 *     `Sentry.init` builds its transport in the `@sentry/core` `Client`
 *     constructor, and the Electron offline transport creates its queue store
 *     right there: core `transports/offline.js:22` → `@sentry/electron/main`
 *     `transports/offline-store.js:29` → `app.getPath("userData")/sentry`.
 *     Read AT INIT, so it must see the repointed `userData` or the queue lands
 *     in the production directory that BACKLOG-2709 exists to keep dev out of.
 *   BEFORE `./bootstrap/installNativeCapabilities` (main.ts, a few lines down)
 *     The point of this module: the fatal `catch` there calls
 *     `Sentry.captureException`, which is a no-op until a client exists.
 *   BEFORE `protocol.registerSchemesAsPrivileged([...])` (main.ts, app scheme)
 *     `@sentry/electron/main` `ipc.js` `configureProtocol` throws if
 *     `app.isReady()` (this is module evaluation, long before `ready`),
 *     registers its own `sentry-ipc` scheme, and then PROXIES
 *     `registerSchemesAsPrivileged` so later calls are merged with it. Before
 *     this move main's call ran first and Sentry's second, as a plain second
 *     call; now Sentry's runs first and main's goes through the proxy, which
 *     appends the Sentry scheme — a superset of what main asked for. Safe
 *     under any semantics Electron has for a repeated call.
 *
 * THE DOTENV BLOCK TRAVELS WITH IT
 * --------------------------------
 * `dsn: process.env.SENTRY_DSN` is populated by `dotenv.config`, which lived at
 * `main.ts:119-131` — also after the composition root. It is transcribed below
 * with ONE change: `__dirname` is now `dist-electron/bootstrap/`, one level
 * deeper than `dist-electron/`, so `../.env.*` became `../../.env.*`. The
 * suite beside this file pins the resolved paths against the repository root.
 * `.env.development` is untracked and carries a real DSN on the founder's
 * machine, so `npm run dev` there runs with Sentry ENABLED after this change;
 * a dev checkout without it runs with Sentry disabled, as before.
 * Nothing that `main.ts` evaluates between line 6 and the old line 119 reads
 * a key these files set (checked by name at 139913c51: `KEEPR_E2E` is read
 * there and `KEEPR_USER_DATA_DIR` before line 6; neither file sets either).
 *
 * THE INIT OPTIONS ARE A TRANSCRIPTION
 * ------------------------------------
 * The `Sentry.init` call below is byte-for-byte the one removed from
 * `main.ts`, comments included — except two BACKLOG-3801 changes: `enabled`
 * also requires the user's "Send crash reports" choice, and `transport` wraps
 * the network transport in that switch. `installSentry.test.ts` pins the option
 * keys and their values on both `app.isPackaged` branches so the move cannot drift.
 * BACKLOG-4040 S3 adds `transportOptions` (the sealed offline queue) and widens
 * `beforeBreadcrumb` from HTTP-only to every category; both are pinned there too.
 * `Sentry.setContext("auto-updater", …)` stays in `main.ts`: it is not an init
 * input, it annotates later events, and nothing this early emits one that
 * needs it.
 *
 * WHAT MOVING INIT EARLIER ALSO MOVES
 * -----------------------------------
 * `Sentry.init` installs `onUncaughtExceptionIntegration`, a
 * `process.on("uncaughtException")` listener. It now also covers a throw that
 * escapes `main.ts` between the composition root and the old line 223. Its
 * own error box is suppressed whenever another listener exists (Electron's
 * default is one; `main.ts` registers a second), so no dialog changes hands.
 *
 * WHAT SENTRY KEEPS ON DISK (BACKLOG-4040 S3)
 * -------------------------------------------
 *   sentry/sealed-queue/*   reports that failed to send: SEALED (KEPRENC) through
 *                           the public `createStore` option below
 *                           (atRest/sentrySealedQueue.ts). Held in memory until
 *                           the file-data key opens; never written as plaintext.
 *   sentry/queue/*          the stock store's plaintext queue from 2.41 / 2.42:
 *                           DELETED below, before init, unconditionally.
 *   sentry/scope_v3.json    PLAINTEXT, REDACTED only. Written by the minidump
 *   sentry/session.json     integration and sessions through a hard-coded store
 *                           with no hook, so they cannot be sealed. The user is
 *                           set as an id only, and every main-process breadcrumb
 *                           is scrubbed (sentryBreadcrumbScrub.ts).
 *   Crashpad/*.dmp          memory dumps: neither sealed nor redacted; only
 *                           produced when "Send crash reports" is on.
 *
 * @module electron/bootstrap/installSentry
 */

import { app } from "electron";
import path from "path";
import log from "electron-log";
import dotenv from "dotenv";
import * as Sentry from "@sentry/electron/main";
import { scrubUpdaterEventPII } from "../services/updateDiagnostics";
import { scrubRcsEventPII } from "../services/rcsSentryScrub";
import { scrubBreadcrumb } from "../services/sentryBreadcrumbScrub";
import {
  configureSentrySealedQueue,
  createSealedOfflineStore,
  onSentrySealedQueueActivated,
  removeLegacySentryQueue,
} from "../services/atRest/sentrySealedQueue";
import {
  gateBaseTransport,
  isCrashReportingEnabled,
  loadCrashReportingPreference,
} from "../services/crashReportingPreference";
import { nodeCaDenylistFailure } from "./nodeCaDenylist";

// Load environment files based on whether app is packaged or in development
if (app.isPackaged) {
  // Packaged build: load .env.production from extraResources
  // extraResources files are copied to process.resourcesPath (NOT inside app.asar)
  const envPath = path.join(process.resourcesPath, ".env.production");
  dotenv.config({ path: envPath });
} else {
  // Development: load .env.development first (OAuth credentials), then .env.local for overrides
  dotenv.config({ path: path.join(__dirname, "../../.env.development") });
  dotenv.config({ path: path.join(__dirname, "../../.env.local") });
}

// BACKLOG-3801: the user's "Send crash reports" choice, read synchronously
// before init (userData is already repointed by installAppDataPaths). OFF at
// launch → Sentry starts disabled (no integrations, no native crash handler).
// The transport gate below also covers a switch turned OFF mid-session and
// the offline queue an earlier run left on disk, which `enabled: false` alone
// does not: the transport is built and flushed whenever a DSN is set.
const crashReportingAtLaunch = loadCrashReportingPreference(app.getPath("userData"));

// BACKLOG-4040 S3: the stock offline queue that 2.41 / 2.42 wrote in plaintext is
// deleted, whatever the crash-reporting choice; new reports queue sealed. Once the
// at-rest startup job opens the key, ask the transport to send what is queued.
removeLegacySentryQueue(app.getPath("userData"), (level, message) => log[level]?.(message));
configureSentrySealedQueue(app.getPath("userData"), (level, message) => log[level]?.(message));
onSentrySealedQueueActivated(() => {
  void Sentry.getClient()?.getTransport()?.flush();
});

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: app.isPackaged ? "production" : "development",
  release: app.getVersion(),
  // Don't send events in development unless DSN is explicitly set
  enabled: (app.isPackaged || !!process.env.SENTRY_DSN) && crashReportingAtLaunch,
  // BACKLOG-3801: the single network egress for main AND renderer envelopes
  // (renderer envelopes arrive over IPC and leave through this transport).
  transport: Sentry.makeElectronOfflineTransport(gateBaseTransport(Sentry.makeElectronTransport)),
  // BACKLOG-4040 S3: the offline queue is sealed at rest (replaces the stock
  // plaintext store; the wrapper spreads these options after its own default).
  transportOptions: { createStore: createSealedOfflineStore },
  // BACKLOG-1903: scrub signed-URL tokens + local paths from the exception
  // VALUE (and top-level message) of auto-updater events before they leave
  // the process. Sentry derives the issue title/exception value from the
  // ORIGINAL err.message passed to captureException(), which bypasses the
  // sanitization already applied to extra.sanitizedMessage — see
  // scrubUpdaterEventPII() for the full explanation. Scoped to
  // tags.component === "auto-updater" so non-updater events are untouched,
  // and never mutates `fingerprint`, so grouping is unaffected. Guarded so a
  // throwing beforeSend can never silently drop the event.
  // BACKLOG-3668 L3: then RCS events (tags component "rcs" / source
  // "google-messages"): phone numbers, emails, quoted text — see
  // scrubRcsEventPII. The updater scrub runs first, unchanged; an RCS event
  // whose scrub throws is dropped (its text may hold a number or a message).
  // BACKLOG-3768: HTTP breadcrumbs keep origin + path only (no query string).
  // BACKLOG-4040 S3: every category also has emails and phone numbers redacted,
  // because breadcrumbs are persisted to sentry/scope_v3.json in plaintext.
  beforeBreadcrumb(breadcrumb) {
    return scrubBreadcrumb(breadcrumb);
  },
  beforeSend(event) {
    if (!isCrashReportingEnabled()) return null;
    let scrubbed: typeof event;
    try {
      scrubbed = scrubUpdaterEventPII(event);
    } catch (scrubError) {
      log.error("[Sentry] beforeSend PII scrub failed, sending event unscrubbed:", scrubError);
      return event;
    }
    try {
      return scrubRcsEventPII(scrubbed);
    } catch (scrubError) {
      log.error("[Sentry] beforeSend RCS scrub failed, event dropped:", scrubError);
      return null;
    }
  },
});

// BACKLOG-4052: installNodeCaDenylist runs before Sentry exists and fails open;
// a failed install is reported here, once Sentry is up.
const caDenylistFailure = nodeCaDenylistFailure();
if (caDenylistFailure) {
  Sentry.captureException(caDenylistFailure, { tags: { bootstrap: "node-ca-denylist" } });
}
