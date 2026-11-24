/**
 * BACKLOG-4263 P11: "Emails and texts read by AI apps" on the AI apps page. Server-rendered; "Show more" is a link with
 * the database's next_cursor, so the page needs no client code for it.
 */

import { AI_READS } from '@/lib/mcp/account/messages';
import type { ReadLine } from '@/lib/mcp/account/readLines';

export function AiReads({ lines, nextCursor }: { lines: ReadLine[] | null; nextCursor: string | null }) {
  return (
    <section className="space-y-3 pt-4 border-t border-gray-200" data-testid="ai-reads">
      <h2 className="text-base font-semibold text-gray-900">{AI_READS.title}</h2>
      {lines === null ? (
        <p role="alert">{AI_READS.loadFailed}</p>
      ) : lines.length === 0 ? (
        <p>{AI_READS.empty}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {lines.map((l) => (
            <li key={l.id} className="py-2" data-testid="ai-read-row">
              <bdi>{l.text}</bdi>
            </li>
          ))}
        </ul>
      )}
      {lines !== null && nextCursor !== null && (
        <p>
          <a className="text-blue-700 underline" href={`?reads=${encodeURIComponent(nextCursor)}`}>
            {AI_READS.more}
          </a>
        </p>
      )}
      <p className="text-gray-600">{AI_READS.retention}</p>
    </section>
  );
}
