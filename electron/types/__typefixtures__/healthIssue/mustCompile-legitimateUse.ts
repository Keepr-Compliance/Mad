/**
 * BACKLOG-3230 — CONTROL 3. MUST COMPILE.
 *
 * Without this, the two failures above prove nothing: a fixture environment that
 * is simply broken would fail them too. This one compiles the REAL shapes the
 * producer emits and the REAL property reads the renderer performs, so a failure
 * here means the union is wrong rather than the controls being right.
 */
import type { HealthIssue } from "../../ipc/healthIssue";
import type { ConnectionError } from "../../../services/connectionStatusService";

declare const connError: ConnectionError;
declare const providerName: "google" | "microsoft";

const issues: HealthIssue[] = [];

// The connection row, exactly as diagnosticHandlers builds it.
issues.push({
  provider: providerName,
  severity: "error",
  ...connError,
});

// A permission row, as permissionService emits it and the collapse decorates it.
issues.push({
  hasPermission: false,
  errorCode: "FULL_DISK_ACCESS_DENIED",
  userMessage: "Full Disk Access permission is required to read iMessages.",
  title: "Full Disk Access Required",
  message: "Without it, Keepr can't read your Messages history.",
  action: "Show me how",
  actionHandler: "open-fda-explainer",
});

// A contacts-probe row.
issues.push({
  type: "CONTACTS_LOADING_FAILED",
  title: "Cannot Load Contacts",
  message: "Could not load contacts from Contacts app",
  details: "",
  action: "Grant Full Disk Access",
  actionHandler: "open-system-settings",
  severity: "warning",
});

// The renderer's property reads, across the whole union and with no narrowing.
export function render(issue: HealthIssue): string {
  const severity: "error" | "warning" | "info" = issue.severity || "warning";
  return [
    severity,
    issue.title ?? issue.userMessage ?? "",
    issue.message ?? "",
    issue.action ?? "",
    issue.actionHandler ?? "",
  ].join("");
}

// The identity read, which is why the `?: undefined` witnesses exist.
export function identityOf(issue: HealthIssue): string | null {
  if (issue.provider) return `connection:${issue.provider}`;
  if (issue.errorCode) return `permission:${issue.errorCode}`;
  if (issue.type) return `probe:${issue.type}`;
  return null;
}
