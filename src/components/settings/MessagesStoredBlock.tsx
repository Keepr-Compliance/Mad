/**
 * BACKLOG-3156 stage G — "Stored on this computer" for one messages source.
 *
 * Block 3 of each Messages source pane (macOS Messages, iPhone, Google
 * Messages): texts, chats and the oldest text Keepr holds FROM THAT SOURCE,
 * read by `messages:get-source-stats` (electron/services/db/messageSourceStatsDb.ts,
 * on the contact query worker). Cells use the Contacts treatment (STORED_CELL).
 * An unreadable count shows "—", never 0.
 */
import React, { useEffect, useState } from "react";
import { messageService } from "../../services/messageService";
import type { MessageSourceStat, MessageSourceStats } from "@electron/services/db/messageSourceStatsDb";
import { STORED_CELL } from "./storedCell";

/** One retry of an unreadable count (worker not ready yet). */
export const STATS_RETRY_MS = 3000;

export type MessagesStoredSource = keyof MessageSourceStats;

/** The footnote under each block — the mock's wording (approved 2026-10-13). */
export const STORED_FOOTNOTE: Record<MessagesStoredSource, string> = {
  macos: "Counts are texts imported from macOS Messages.",
  iphone: "Counts are texts imported from iPhone.",
  google: "Counts are texts copied from Google Messages.",
};

/** "Mar 2016"; "—" when there is no text. */
export function formatOldest(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

interface MessagesStoredBlockProps {
  userId: string;
  source: MessagesStoredSource;
  /** `${testId}` on the block; cells are `${testId}-texts` / `-chats` / `-oldest`. */
  testId: string;
}

export function MessagesStoredBlock({ userId, source, testId }: MessagesStoredBlockProps): React.ReactElement {
  const [stat, setStat] = useState<MessageSourceStat | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStat(null);
    // The stats worker may still be starting when Settings opens right after
    // sign-in: one failed read is retried once after a short delay, then the
    // dashes stay until Settings is reopened.
    const read = (retry: boolean) => {
      void messageService
        .getSourceStats(userId)
        .catch(() => ({ success: false as const, stats: undefined }))
        .then((r) => {
          if (!live) return;
          if (r.success && r.stats) setStat(r.stats[source]);
          else if (retry) timer = setTimeout(() => read(false), STATS_RETRY_MS);
        });
    };
    read(true);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [userId, source]);

  const cells: Array<{ key: string; value: string; label: string }> = [
    { key: "texts", value: stat ? stat.texts.toLocaleString() : "—", label: "texts" },
    { key: "chats", value: stat ? stat.chats.toLocaleString() : "—", label: "chats" },
    { key: "oldest", value: stat ? formatOldest(stat.oldest) : "—", label: "oldest text" },
  ];

  return (
    <div data-testid={testId} className="p-4 bg-gray-50 rounded-lg border border-gray-200">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
        Stored on this computer
      </p>
      <div className="grid grid-cols-3 gap-2 text-center">
        {cells.map((c) => (
          <div key={c.key} className={STORED_CELL.on} data-testid={`${testId}-${c.key}`}>
            <div className={STORED_CELL.countOn}>{c.value}</div>
            <div className={STORED_CELL.labelOn}>{c.label}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-500 mt-2">{STORED_FOOTNOTE[source]}</p>
    </div>
  );
}
