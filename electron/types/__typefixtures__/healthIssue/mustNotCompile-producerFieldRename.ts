/**
 * BACKLOG-3230 — CONTROL 2. MUST NOT COMPILE.
 *
 * The item's own verification bar: "change a field name in the producer and
 * confirm type-check FAILS."
 *
 * This mirrors the connection row that `diagnosticHandlers.ts` builds, with
 * `severity` renamed. It is the one literal the bar actually covers — see the
 * header of `healthIssue.typeControls.test.ts` for what it does NOT cover.
 */
import type { HealthIssue } from "../../ipc/healthIssue";
import type { ConnectionError } from "../../../services/connectionStatusService";

declare const connError: ConnectionError;
declare const providerName: "google" | "microsoft";

const issues: HealthIssue[] = [];

issues.push({
  provider: providerName,
  sev: "error",
  ...connError,
});

export default issues;
