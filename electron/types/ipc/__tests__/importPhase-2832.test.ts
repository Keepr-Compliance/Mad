/**
 * BACKLOG-2832 — the declared import-progress phase union must cover every
 * phase its producer emits.
 *
 * THE DEFECT THIS PINS: `window-api-messages.ts` declared `onImportProgress`
 * with a hand-written union that omitted `"querying"`, a phase
 * `macOSMessagesImportService` has always emitted (`:763`, `:915`). Six copies
 * of the union existed in production code and three were missing that member.
 * Both live consumers depended on `"querying"` arriving at runtime and survived
 * only by widening away from the declared type — it degraded rather than broke,
 * which is why nothing caught it for so long.
 *
 * WHY THE LOAD-BEARING ASSERTIONS ARE TYPE-LEVEL, NOT RUNTIME.
 *
 * Every producer emit site already goes through a parameter typed
 * `ImportProgressCallback` (`macOSMessagesImportService.ts:214/382/1321/1784`),
 * and both IPC send sites spread that typed object. So the producer cannot emit
 * a phase outside its own union without `tsc` failing — that half was never
 * broken. The unchecked hop was the contract: the preload bridge object carries
 * no contract-type annotation, so the contract's union and the preload's were
 * unrelated declarations with nothing comparing them.
 *
 * The mutation that reproduces the original defect is therefore re-forking
 * `window-api-messages.ts` back to a hand-written union. A runtime test cannot
 * see that: callback parameter contravariance keeps every consumer compiling
 * when the contract is NARROWED, and the emitted JavaScript is identical. The
 * equality assertions below are the only thing that goes red on it.
 *
 * These live in a test file rather than a shipped module because they reach
 * across three layers that should not import each other at runtime. CI gates
 * them: `.github/workflows/ci.yml` runs `npm run type-check:tests`
 * (`tsc -p tsconfig.test.json`), a step BACKLOG-2414 added precisely because
 * the default `tsconfig.json` does not cover test files. The tuple-covers-union check is kept
 * in the shipped `importPhase.ts` so `npm run type-check` catches that half too.
 *
 * Cross-refs: BACKLOG-2793 / PR #2365 (found it), BACKLOG-1898 (same shape),
 * BACKLOG-2818 (the published-union pattern), BACKLOG-3121 (`elapsedMs`, the
 * second defect on the same contract line), BACKLOG-3122 (dead `"deleting"`).
 */

import { IMPORT_PHASES } from "../importPhase";
// Type-only, all three. `ImportProgress` lives in the preload, which value-imports
// `ipcRenderer` from "electron" — a value import here would make jest load the
// preload at runtime and fail.
import type { ImportPhase } from "../importPhase";
import type { WindowApiMessages } from "../window-api-messages";
import type { ImportProgress } from "../../../preload/messageBridge";
import type { ImportProgressCallback } from "../../../services/macOSMessagesImportService/types";

/** The phase type as the IPC CONTRACT declares it. */
type ContractPhase = Parameters<
  Parameters<WindowApiMessages["onImportProgress"]>[0]
>[0]["phase"];

/** The phase type as the PRODUCER declares it — the one emits are checked against. */
type ProducerPhase = Parameters<ImportProgressCallback>[0]["phase"];

/** The phase type as the PRELOAD bridge declares it. */
type PreloadPhase = ImportProgress["phase"];

/**
 * Mutual `extends`, not one-directional. A one-way check would pass while the
 * contract stayed NARROWER than the producer, which is exactly the bug.
 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _CONTRACT_MATCHES_PRODUCER: Equals<ContractPhase, ProducerPhase> = true;
const _PRELOAD_MATCHES_PRODUCER: Equals<PreloadPhase, ProducerPhase> = true;
const _CONTRACT_IS_THE_PUBLISHED_UNION: Equals<ContractPhase, ImportPhase> = true;
void _CONTRACT_MATCHES_PRODUCER;
void _PRELOAD_MATCHES_PRODUCER;
void _CONTRACT_IS_THE_PUBLISHED_UNION;

describe("BACKLOG-2832: import progress phase union", () => {
  it("publishes every phase the producer emits, in run order", () => {
    // Transcribed from the producer's emit sites, not invented:
    //   macOSMessagesImportService.ts:763, :915  -> "querying"
    //   macOSMessagesImportService.ts:1043, :1756 -> "importing"
    //   macOSMessagesImportService.ts:2200       -> "attachments"
    //   macOSMessagesImportService.ts:1043      -> "finalizing" (BACKLOG-3132)
    // "deleting" is declared but emitted by nothing since 01b521eab
    // (stage-and-swap Force Re-import, BACKLOG-2790). It stays because
    // SyncOrchestratorService still branches on it. Tracked by BACKLOG-3122.
    expect(IMPORT_PHASES).toEqual([
      "querying",
      "deleting",
      "importing",
      "attachments",
      "finalizing",
    ]);
  });

  it("lists each phase exactly once", () => {
    expect(new Set(IMPORT_PHASES).size).toBe(IMPORT_PHASES.length);
  });

  it("includes the phase whose absence was the defect", () => {
    // The one-word regression this item exists to prevent.
    expect(IMPORT_PHASES).toContain("querying");
  });

  it("orders phases so SyncOrchestrator's indexOf weighting stays monotonic", () => {
    // SyncOrchestratorService weights progress by indexOf(phase) over this
    // order, so a reordering silently changes the progress bar's arithmetic.
    const order = IMPORT_PHASES.map((p) => IMPORT_PHASES.indexOf(p));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(IMPORT_PHASES.indexOf("querying")).toBeLessThan(
      IMPORT_PHASES.indexOf("importing")
    );
    expect(IMPORT_PHASES.indexOf("importing")).toBeLessThan(
      IMPORT_PHASES.indexOf("attachments")
    );
    // BACKLOG-3132: saving is last. It used to be emitted as a second
    // "importing" event AFTER attachments, which is the reversal this ordering
    // now forbids.
    expect(IMPORT_PHASES.indexOf("attachments")).toBeLessThan(
      IMPORT_PHASES.indexOf("finalizing")
    );
  });
});
