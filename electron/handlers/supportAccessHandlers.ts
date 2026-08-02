/**
 * Support access mode IPC handlers (BACKLOG-2393)
 *
 * Thin: every decision lives in the services. These exist to move a plain
 * object across the process boundary and to make sure a failed server delete
 * arrives in the renderer as a failure, not as a silence.
 */

import { ipcMain } from "electron";
import logService from "../services/logService";
import { wrapHandler } from "../utils/wrapHandler";
import { getSupportAccess } from "../services/supportAccess";
import {
  currentDisclosure,
  SUPPORT_REPORT_RETENTION_DAYS,
} from "../services/supportAccess/disclosure";
import {
  SUPPORT_ACCESS_DURATIONS,
  DEFAULT_SUPPORT_ACCESS_DURATION,
  type SupportAccessDurationId,
} from "../services/supportAccess/types";
import {
  DEFAULT_SUPPORT_LOG_SCOPES,
  SUPPORT_LOG_SCOPE_DETAILS,
  normaliseScopes,
  type SupportLogScopeId,
} from "../services/supportAccess/scopes";

const MODULE = "SupportAccessHandlers";

export interface GrantRequest {
  durationId: SupportAccessDurationId;
  scopes?: SupportLogScopeId[];
  /** The disclosure text the renderer actually displayed. */
  disclosureId?: string;
  disclosureText?: string;
}

export function registerSupportAccessHandlers(): void {
  /**
   * Everything the Settings section needs in one call: the window, the offered
   * durations, the scope catalogue and the exact disclosure wording.
   *
   * The wording is served from main rather than duplicated in the renderer, so
   * the text that is shown and the text that is hashed into the consent record
   * cannot drift apart.
   */
  ipcMain.handle(
    "support-access:get-state",
    wrapHandler(
      async () => {
        const { access, queue } = getSupportAccess();
        await access.load();
        await access.reconcile();
        return {
          success: true,
          state: access.getState(),
          reports: await queue.listForDisplay(),
          durations: SUPPORT_ACCESS_DURATIONS,
          defaultDurationId: DEFAULT_SUPPORT_ACCESS_DURATION,
          scopes: Object.values(SUPPORT_LOG_SCOPE_DETAILS),
          defaultScopes: DEFAULT_SUPPORT_LOG_SCOPES,
          disclosure: currentDisclosure(),
          retentionDays: SUPPORT_REPORT_RETENTION_DAYS,
        };
      },
      { module: MODULE },
    ),
  );

  ipcMain.handle(
    "support-access:grant",
    wrapHandler(
      async (_event, request: GrantRequest) => {
        const { access, scheduler } = getSupportAccess();
        await access.load();
        const scopes = request?.scopes
          ? normaliseScopes(request.scopes)
          : [...DEFAULT_SUPPORT_LOG_SCOPES];
        const consent = await access.grant({
          durationId: request?.durationId ?? DEFAULT_SUPPORT_ACCESS_DURATION,
          scopes,
          disclosureId: request?.disclosureId,
          disclosureText: request?.disclosureText,
        });
        scheduler.start();
        logService.info(
          `[SupportAccess] Granted until ${consent.expiresAt}`,
          MODULE,
        );
        return { success: true, consent, state: access.getState() };
      },
      { module: MODULE },
    ),
  );

  ipcMain.handle(
    "support-access:revoke",
    wrapHandler(
      async () => {
        const { access, scheduler, logStore } = getSupportAccess();
        await access.load();
        await access.revoke();
        scheduler.stop();
        // Captured-but-unsent reports stay in the queue so the user can still
        // see and delete them. The raw scoped log is cleared, because it has no
        // remaining purpose and it is the largest thing on disk.
        await logStore.clear();
        return { success: true, state: access.getState() };
      },
      { module: MODULE },
    ),
  );

  ipcMain.handle(
    "support-access:list-reports",
    wrapHandler(
      async () => {
        const { queue } = getSupportAccess();
        return { success: true, reports: await queue.listForDisplay() };
      },
      { module: MODULE },
    ),
  );

  ipcMain.handle(
    "support-access:capture-now",
    wrapHandler(
      async () => {
        const { scheduler, queue } = getSupportAccess();
        const report = await scheduler.captureNow("manual");
        return { success: true, report, reports: await queue.listForDisplay() };
      },
      { module: MODULE },
    ),
  );

  ipcMain.handle(
    "support-access:send-now",
    wrapHandler(
      async (_event, id: string) => {
        const { scheduler, queue } = getSupportAccess();
        const report = await scheduler.sendNow(id);
        return { success: true, report, reports: await queue.listForDisplay() };
      },
      { module: MODULE },
    ),
  );

  /**
   * Delete a report locally and on the server.
   *
   * Note the shape: `success` means the IPC call completed, `deleted` means the
   * data is gone. They are separate on purpose — a server that could not be
   * reached returns `{ success: true, deleted: false, error }`, and the UI
   * shows the error rather than removing the row.
   */
  ipcMain.handle(
    "support-access:delete-report",
    wrapHandler(
      async (_event, id: string) => {
        const { scheduler, queue } = getSupportAccess();
        const result = await scheduler.deleteReport(id);
        return {
          success: true,
          deleted: result.deleted,
          error: result.error,
          remoteRemains: result.remoteRemains,
          reports: await queue.listForDisplay(),
        };
      },
      { module: MODULE },
    ),
  );
}
