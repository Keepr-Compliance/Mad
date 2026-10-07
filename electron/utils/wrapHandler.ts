/**
 * Higher-order function that wraps IPC handler functions with
 * standardized error handling, eliminating the duplicated
 * try/catch boilerplate found across handler files.
 *
 * Error handling behavior:
 * - ValidationError -> { success: false, error: "Validation error: " + message } (no logging, expected input failure)
 * - Error -> { success: false, error: message } (logged via logService)
 * - Non-Error throw -> { success: false, error: "Unknown error" } (logged via logService)
 *
 * The wrapped handler should return success responses directly and throw on error.
 * The wrapper catches all errors and formats them consistently.
 */

import type { IpcMainInvokeEvent } from "electron";
import * as Sentry from "@sentry/electron/main";
import { ValidationError } from "./validation";
import logService from "../services/logService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>;

/**
 * Wraps an IPC handler function with standardized error handling.
 *
 * @param handler - The async IPC handler function to wrap
 * @param options - Optional configuration
 * @param options.module - Module name for error logging context (defaults to "IPC")
 * @returns A wrapped handler with the same signature
 *
 * @example
 * ```typescript
 * ipcMain.handle("transactions:get",
 *   wrapHandler(async (event, userId, transactionId) => {
 *     const data = await fetchTransaction(userId, transactionId);
 *     return { success: true, data };
 *   }, { module: "Transactions" })
 * );
 * ```
 */
export function wrapHandler<T extends AnyIpcHandler>(
  handler: T,
  options?: {
    /** Module name for error logging (defaults to "IPC") */
    module?: string;
    /** Tags on the Sentry event (BACKLOG-3668: `component: "rcs"` drives the RCS beforeSend scrub). */
    sentryTags?: Record<string, string>;
    /** Scrub the error's text before it is logged (BACKLOG-3668 L3); the log then omits the raw error. */
    scrubLogText?: (error: unknown) => string;
  },
): T {
  const wrappedHandler = async (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
  ) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      if (error instanceof ValidationError) {
        return { success: false, error: `Validation error: ${error.message}` };
      }
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      if (options?.sentryTags) Sentry.captureException(error, { tags: options.sentryTags });
      else Sentry.captureException(error);
      if (options?.scrubLogText) {
        logService.error(`Handler error: ${options.scrubLogText(error)}`, options.module ?? "IPC");
      } else {
        logService.error(`Handler error: ${errorMessage}`, options?.module ?? "IPC", {
          error,
        });
      }
      return { success: false, error: errorMessage };
    }
  };
  return wrappedHandler as T;
}
