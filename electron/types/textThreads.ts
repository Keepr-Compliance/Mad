/**
 * BACKLOG-3884: the Texts tab's conversation list and pages (IPC shapes).
 */
import type { Communication } from "./models";

/** The audit window, as epoch milliseconds, inclusive. Null bound = open. */
export interface TextWindow {
  startMs: number | null;
  endMs: number | null;
}

/**
 * Where the next page starts: below sent_at `sk`, or inside group `sk` after
 * `afterId`. `sk: null` is the trailing group of rows with no sent_at, by id.
 */
export interface TextPageCursor {
  sk: string | null;
  afterId: string | null;
}

export interface TextThreadSummary {
  threadId: string;
  /** Deduplicated non-reaction texts, all history. */
  totalCount: number;
  /** Deduplicated non-reaction texts inside the window (= totalCount with no window). */
  inWindowCount: number;
  lastSentAt: string | null;
  lastInWindowSentAt: string | null;
  /** Header rows (distinct participant sets), newest first; no bodies. */
  samples: Communication[];
}

export interface TextPage {
  rows: Communication[];
  nextCursor: TextPageCursor | null;
}

