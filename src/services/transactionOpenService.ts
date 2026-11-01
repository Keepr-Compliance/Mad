/**
 * "Last opened" service — BACKLOG-3965 PR-2.
 *
 * The renderer's abstraction over `window.api.transactions.recordOpen` and
 * `getRecentlyOpened`.
 *
 * ## recordOpen NEVER throws and never rejects
 *
 * It is called from TransactionDetails' mount. An unguarded bridge call there
 * reddened 189 of 243 tests in 26 suites (plan probe P1), and in the app a
 * failed write must not stop a deal from opening. So:
 *   - bridge missing (an older preload, a test without the mock): returns quietly;
 *   - main answered { success: false }: logged (main already reported it to Sentry);
 *   - the call threw or rejected: logged with its message and reported to Sentry.
 */
import * as Sentry from "@sentry/electron/renderer";
import { type ApiResult, getErrorMessage } from "./index";
import logger from "../utils/logger";
import type { RecentlyOpenedTransaction } from "../../electron/types/transactionOpen";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportRecordOpenFailure(err: unknown): void {
  const message = messageOf(err);
  // The logger serialises an Error to {}, so log the message.
  logger.error("[transactionOpenService] Recording the open failed", message);
  Sentry.captureException(err, {
    tags: { component: "transactionOpenService" },
    extra: { operation: "record-open", error_message: message },
  });
}

export const transactionOpenService = {
  /** Record that a deal was opened. Fire and forget: resolves, never rejects. */
  async recordOpen(transactionId: string): Promise<void> {
    try {
      const recordOpen = window.api?.transactions?.recordOpen;
      if (typeof recordOpen !== "function") return;
      const result = await recordOpen(transactionId);
      if (result && !result.success) {
        logger.warn("[transactionOpenService] Recording the open was refused", result.error ?? "");
      }
    } catch (err) {
      try {
        reportRecordOpenFailure(err);
      } catch {
        // Reporting must not throw either.
      }
    }
  },

  /** The deals this user opened most recently, newest first. */
  async getRecentlyOpened(
    userId: string,
    limit?: number,
  ): Promise<ApiResult<RecentlyOpenedTransaction[]>> {
    try {
      const result = await window.api.transactions.getRecentlyOpened(userId, limit);
      if (!result.success || !result.transactions) {
        return { success: false, error: result.error ?? "Recently opened deals couldn't be loaded." };
      }
      return { success: true, data: result.transactions };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  },
};

export default transactionOpenService;
