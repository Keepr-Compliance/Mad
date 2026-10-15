/**
 * BACKLOG-3884 (SR B4): the conversation key of a linked text that has no thread_id.
 *
 * The iPhone importer (iPhoneSyncStorageService.ts: `chatId ? ios-chat-… : null`) and
 * the Mac importer can store texts without a thread_id. The Texts tab has always
 * grouped those by their participant set — `getThreadKey` in
 * src/components/transactionDetailsModule/components/MessageThreadCard.tsx — so each
 * person's thread-less texts form their own conversation. This is the same rule on the
 * main side (the renderer cannot be imported here, nor this there); the parity test
 * threadlessTextKey-3884.test.ts holds the two equal.
 *
 * The key carries a prefix no thread_id has, so the readers can tell it apart.
 */
export const THREADLESS_KEY_PREFIX = "__nothread__:";

/** Same normalisation as MessageThreadCard's normalizeParticipant. */
function normalizeParticipant(participant: string): string {
  if (!participant) return "";
  const digits = participant.replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return participant.toLowerCase().trim();
}

/** The renderer's fallback key (`participants-…` or `msg-<id>`), unprefixed. */
export function threadlessGroupKey(participants: unknown, id: string): string {
  try {
    if (participants) {
      const parsed = (typeof participants === "string" ? JSON.parse(participants) : participants) as {
        from?: string;
        to?: string | string[];
      };
      const all = new Set<string>();
      if (parsed.from) all.add(normalizeParticipant(parsed.from));
      if (parsed.to) {
        const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
        toList.forEach((p) => all.add(normalizeParticipant(p)));
      }
      all.delete("me");
      if (all.size > 0) return `participants-${Array.from(all).sort().join("|")}`;
    }
  } catch {
    // fall through
  }
  return `msg-${id}`;
}

/** The conversation key main and the renderer exchange for a thread-less text. */
export function threadlessTextKey(participants: unknown, id: string): string {
  return THREADLESS_KEY_PREFIX + threadlessGroupKey(participants, id);
}

export function isThreadlessKey(key: string): boolean {
  return key.startsWith(THREADLESS_KEY_PREFIX);
}
