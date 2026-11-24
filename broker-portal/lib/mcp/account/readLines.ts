/**
 * BACKLOG-4263 P11: one line of text per row of the person's AI read log (mcp_list_my_message_reads). Every word comes
 * from AI_READS; the sender, subject and address are the database's values, shown as text.
 */

import { AI_READS, PROVIDER_LABELS } from './messages';
import { formatDate, formatDateTime } from './format';
import type { MessageRead } from './rpc';

export interface ReadLine {
  id: string;
  text: string;
}

export function readLine(r: MessageRead): string {
  const app = PROVIDER_LABELS[r.provider];
  const kind = AI_READS.kind(r.channel);
  const part = r.tool === 'get_message' && r.part !== null && r.part > 1 ? AI_READS.part(r.part) : '';
  const when = formatDateTime(r.readAt);
  if (r.messageState === 'live') {
    const who = r.from !== null && r.from !== '' ? AI_READS.from(r.from) : '';
    const subj = r.subject !== null && r.subject !== '' ? AI_READS.subject(r.subject) : '';
    const where = r.address !== null ? ` · ${r.address}` : '';
    return `${app} ${AI_READS.verb(r.tool)} ${kind}${who}${subj}${part}${where} · ${when}`;
  }
  const sent = r.sentAt !== null ? AI_READS.sent(formatDate(r.sentAt)) : '';
  if (r.dealState === 'gone' || r.address === null) {
    return `${app} ${AI_READS.read} ${kind}${sent}${AI_READS.dealDeleted}${part} · ${when}`;
  }
  return `${app} ${AI_READS.read} ${kind}${sent}${AI_READS.removedFromDeal}${part} · ${r.address} · ${when}`;
}

export function readLines(reads: MessageRead[]): ReadLine[] {
  return reads.map((r) => ({ id: r.readId, text: readLine(r) }));
}
