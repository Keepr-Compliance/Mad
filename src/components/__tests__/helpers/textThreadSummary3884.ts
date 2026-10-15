/**
 * BACKLOG-3884: a `transactions:get-text-threads` conversation, shaped like
 * `buildTextThreadSummaries` output (electron/services/db/transactionTextPagingDb.ts):
 * counts plus header rows whose columns are those of transactionTextThreadSamplesSql
 * (id, thread_id, channel, communication_type, participants, direction, sender,
 * sent_at, received_at, thread_display_name). No bodies.
 */
import type { TextThreadSummary } from "../../../../electron/types/textThreads";
import type { Communication } from "../../../../electron/types/models";

export function textThreadSummary(opts: {
  threadId: string;
  phone: string;
  lastSentAt: string;
  totalCount?: number;
  inWindowCount?: number;
  sampleId?: string;
  direction?: "inbound" | "outbound";
}): TextThreadSummary {
  const total = opts.totalCount ?? 1;
  const direction = opts.direction ?? "inbound";
  const participants =
    direction === "inbound"
      ? JSON.stringify({ from: opts.phone, to: ["me"] })
      : JSON.stringify({ from: "me", to: [opts.phone] });
  const sample = {
    id: opts.sampleId ?? `${opts.threadId}-m1`,
    thread_id: opts.threadId,
    channel: "sms",
    communication_type: "sms",
    participants,
    direction,
    sender: direction === "inbound" ? opts.phone : "me",
    sent_at: opts.lastSentAt,
    received_at: opts.lastSentAt,
    thread_display_name: null,
  } as unknown as Communication;
  return {
    threadId: opts.threadId,
    totalCount: total,
    inWindowCount: opts.inWindowCount ?? total,
    lastSentAt: opts.lastSentAt,
    lastInWindowSentAt: opts.lastSentAt,
    samples: [sample],
  };
}
