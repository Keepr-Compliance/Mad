/**
 * How each macOS Messages import phase is described to the user (BACKLOG-3128).
 *
 * ONE map, exhaustive over `ImportPhase`, so a phase without copy is a compile
 * error rather than a phase that silently falls through to the wrong label.
 *
 * WHAT THIS REPLACES: three separate ternary chains in
 * `MacOSMessagesImportSettings.tsx` (label, colour, unit), each with an `else`
 * arm that swallowed every phase it did not name. `querying` — the whole
 * chat.db read, the slowest part of a large import — fell into that `else` and
 * was labelled "Importing messages...", so the panel claimed to be importing
 * while it was still reading. The dashboard pill had the same hole from the
 * other side: its `friendlyPhase` record lists iPhone phases only, so every
 * `ImportPhase` fell through `?? phase` and rendered the raw string
 * ("Messages - querying").
 *
 * WHY `src/utils/` AND NOT THE SETTINGS COMPONENT: the dashboard's
 * `SyncStatusIndicator` needs the same vocabulary, and a dashboard component
 * importing from a settings component is the wrong direction. This is the
 * shared place both can reach.
 *
 * The `ImportPhase` import is TYPE-ONLY and erases at compile time — the
 * renderer never takes a runtime value from `electron/`. Same boundary ruling
 * as BACKLOG-2832; `src/utils/connectionStatus.ts` and
 * `src/utils/contactFilterModel.ts` are existing precedent.
 *
 * NOTE ON `deleting`: nothing has emitted it since `01b521eab` (BACKLOG-2790
 * replaced the delete-then-insert pass with stage-and-swap). It keeps an entry
 * because the union still has the member and an exhaustive `Record` requires
 * one. BACKLOG-3122 owns removing the member; when it does, `tsc` will point
 * here.
 */

import type { ImportPhase } from "../../electron/types/ipc/importPhase";

export interface ImportPhaseDisplay {
  /** Full sentence for the Settings panel's inline progress row. */
  label: string;
  /** Short form for the dashboard pill, rendered as "Messages - <pill>". */
  pill: string;
  /** What the counts are counting, e.g. "4,120 of 33,637 messages read". */
  unit: string;
  /** Tailwind class for the progress bar fill. */
  colour: string;
}

/**
 * Copy signed off by SR at BACKLOG-3128 review; the founder may adjust wording
 * at test time.
 *
 * The three dots are ASCII on every row, matching the shipped strings exactly.
 * `deleting` and `attachments` are byte-identical to the copy they replace, so
 * this map changes only the `querying` wording. Worth stating because the two
 * tests that assert this copy (`MacOSMessagesImportSettings.cancel-2748.test.ts`
 * `:242` and `:254`) match `/Clearing existing messages/i` and
 * `/Processing attachments/i` — no trailing punctuation — and so could NOT have
 * caught a change after the matched words. The byte-identity here is held by
 * hand, not by those tests.
 */
export const IMPORT_PHASE_DISPLAY: Record<ImportPhase, ImportPhaseDisplay> = {
  querying: {
    label: "Reading messages from Messages.app...",
    pill: "Reading messages",
    unit: "messages read",
    colour: "bg-purple-500",
  },
  deleting: {
    label: "Clearing existing messages...",
    pill: "Clearing",
    unit: "cleared",
    colour: "bg-orange-500",
  },
  importing: {
    label: "Importing messages...",
    pill: "Importing",
    unit: "messages",
    colour: "bg-blue-500",
  },
  attachments: {
    label: "Processing attachments...",
    pill: "Attachments",
    unit: "attachments",
    colour: "bg-green-500",
  },
  finalizing: {
    // BACKLOG-3132: the work after the last attachment — the stage-and-swap on a
    // force re-import, the chat-thread-name sync on both paths. Deliberately not
    // "Swapping": that is a mechanism word, and the swap is force-only while this
    // phase is emitted on both paths.
    label: "Saving imported messages...",
    pill: "Saving",
    // No count exists for this phase, so no unit. Surfaces render the
    // indeterminate stripe (the producer emits total 0).
    unit: "",
    colour: "bg-indigo-500",
  },
};

/**
 * Look up a phase that arrived as a bare string (the orchestrator queue item
 * types `phase` as `string`, because it carries iPhone and export phases too).
 *
 * Returns `undefined` rather than guessing. Callers render the raw phase text
 * and an indeterminate bar in that case — an unknown phase must not be given
 * some other phase's label, which is the defect this whole item is about.
 */
export function importPhaseDisplayFor(
  phase: string | undefined
): ImportPhaseDisplay | undefined {
  if (!phase) return undefined;
  return Object.prototype.hasOwnProperty.call(IMPORT_PHASE_DISPLAY, phase)
    ? IMPORT_PHASE_DISPLAY[phase as ImportPhase]
    : undefined;
}
