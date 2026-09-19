/**
 * Validation utilities for Zod schema validation at trust boundaries.
 *
 * These utilities wrap Zod's safeParse with:
 * - Logging for validation failures (graceful degradation)
 * - Typed success/failure responses
 * - Context strings for debugging
 *
 * IMPORTANT: Validation failures should WARN, not crash. The app has been running
 * without validation -- sudden strict enforcement would break things.
 */
import { z } from 'zod/v4';
import { hostLogger } from '../capabilities/loggerProvider';
import { hostErrorReporter } from '../capabilities/errorReporterProvider';

/**
 * Validate data against a Zod schema with graceful degradation.
 *
 * On success: returns validated & typed data.
 * On failure: logs a warning and returns the original data cast to T.
 * This ensures the app continues working even with unexpected data shapes.
 *
 * @param schema - Zod schema to validate against
 * @param data - Unknown data to validate
 * @param context - Description string for log messages (e.g., "userDbService.getUser")
 * @returns Typed data (validated or original)
 */
export function validateResponse<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    // Log the first few issues for debugging without flooding logs
    const issues = result.error.issues.slice(0, 3);
    const issueMessages = issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`
    );
    const warnMsg = `[Validation] ${context}: Schema validation failed (${result.error.issues.length} issue(s)):\n${issueMessages.join('\n')}`;
    hostLogger.warn(warnMsg);

    // Sentry breadcrumb with specific field-level details (BACKLOG-1347)
    try {
      hostErrorReporter.addBreadcrumb({
        category: "validation",
        message: `Schema validation failed: ${context}`,
        level: "warning",
        data: {
          context,
          issueCount: result.error.issues.length,
          issues: result.error.issues.slice(0, 5).map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })),
        },
      });
    } catch {
      // Sentry may not be initialized in test environments
    }

    // Graceful degradation: return data as-is
    return data as T;
  }
  return result.data;
}

/**
 * Validate data against a Zod schema and return a result object.
 *
 * Unlike validateResponse, this does NOT do graceful degradation.
 * Use this for IPC input validation where invalid data should be rejected.
 *
 * @param schema - Zod schema to validate against
 * @param data - Unknown data to validate
 * @returns Result with success flag, data or error
 */
export function safeValidate<T>(
  schema: z.ZodType<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validate an array of items against a schema.
 * Logs warnings for invalid items but returns all items (graceful degradation).
 *
 * @param schema - Zod schema for individual items
 * @param items - Array of unknown items
 * @param context - Description string for log messages
 * @returns Array of items (type assertion for invalid ones)
 */
export function validateArray<T>(
  schema: z.ZodType<T>,
  items: unknown[],
  context: string
): T[] {
  let invalidCount = 0;
  const results = items.map((item, index) => {
    const result = schema.safeParse(item);
    if (!result.success) {
      invalidCount++;
      if (invalidCount <= 3) {
        const firstIssue = result.error.issues[0];
        hostLogger.warn(
          `[Validation] ${context}[${index}]: ${firstIssue?.path.join('.')}: ${firstIssue?.message}`
        );
      }
      return item as T; // Graceful degradation
    }
    return result.data;
  });

  if (invalidCount > 3) {
    hostLogger.warn(
      `[Validation] ${context}: ${invalidCount} invalid items total (showing first 3)`
    );
  }

  return results;
}
