/**
 * Test fixture helper for BACKLOG-2771 export plans.
 *
 * Builds plans by running the REAL `resolveExportPlan`, never by hand. A
 * hand-built `ExportPlan` literal could describe a combination the resolver
 * cannot produce (for example `writesAttachmentsToDisk: true` alongside an
 * empty `attachmentComms`), and a renderer test driven by such a fixture would
 * be asserting against a state that can never reach production.
 *
 * Callers state what the USER chose — the same three answers the ExportModal
 * collects — and get back exactly what the handler would hand the renderer.
 */

import type { Communication } from "../../../types/models";
import {
  resolveExportPlan,
  type ExportAttachmentType,
  type ExportContentType,
  type ExportEmailMode,
  type ExportPlan,
  type ExportPlanFormat,
} from "../../exportPlan";

export interface TestPlanOptions {
  format?: ExportPlanFormat;
  contentType?: ExportContentType;
  attachmentType?: ExportAttachmentType;
  emailMode?: ExportEmailMode;
  startDate?: string | null;
  endDate?: string | null;
  summaryOnly?: boolean;
}

/**
 * Resolve a plan for a folder export (the default) or any other format.
 *
 * Defaults match the folder handler's own defaults: everything included, all
 * attachments, thread-grouped emails, no audit window.
 */
export function testExportPlan(
  communications: Communication[],
  options: TestPlanOptions = {},
): ExportPlan {
  return resolveExportPlan(
    {
      format: options.format ?? "folder",
      contentType: options.contentType ?? "both",
      attachmentType: options.attachmentType ?? "all",
      emailMode: options.emailMode ?? "thread",
      startDate: options.startDate,
      endDate: options.endDate,
      summaryOnly: options.summaryOnly,
    },
    communications,
  );
}
