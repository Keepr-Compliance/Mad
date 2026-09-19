/**
 * BACKLOG-3230 — CONTROL 1. MUST NOT COMPILE.
 *
 * This is `SystemHealthMonitor.tsx:83` as it stood at develop `a6fe128aa`: the
 * wire declared `issues?: string[]`, the producer emitted objects, and the
 * renderer cast one to the other.
 *
 * BEFORE-EVIDENCE, and the reason this control is informative: with the old
 * local `SystemIssue` interface — every property optional, therefore a WEAK type
 * and mutually comparable with `string` — this exact cast compiled with
 * **exit 0 and zero diagnostics**. The contract could not fail, so it was not a
 * contract. Against `HealthIssue` it is TS2352.
 */
import type { HealthIssue } from "../../ipc/healthIssue";

declare const payload: { issues?: string[] };

export const next = payload.issues as HealthIssue[];
