/**
 * Support SLA report — how to read it (BACKLOG-3721). Collapsed by default.
 */

export function SupportSlaHowToUse() {
  return (
    <details className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
      <summary className="cursor-pointer font-medium text-gray-900">How to use this report</summary>
      <ul className="mt-3 list-disc space-y-1.5 pl-5">
        <li>
          <strong>Open now</strong> counts new, assigned, in progress and pending tickets, whatever
          the period. Deleted tickets are never counted anywhere.
        </li>
        <li>
          <strong>Created</strong> and <strong>Avg first response</strong> use tickets created in the
          period. A ticket with no reply yet is left out of the average.
        </li>
        <li>
          <strong>Resolved</strong> and <strong>Avg resolution</strong> use tickets resolved or closed
          in the period. A ticket closed without a resolved time counts at its closed time.
        </li>
        <li>Tickets with no assignee count in the cards but have no agent row.</li>
        <li>No response or resolution targets are set yet, so there is no met or missed rate.</li>
        <li>Days are UTC. This week starts on Monday.</li>
      </ul>
    </details>
  );
}
