/**
 * Exports report — how to read it (BACKLOG-4004). Collapsed by default.
 */

export function ExportsHowToUse() {
  return (
    <details className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
      <summary className="cursor-pointer font-medium text-gray-900">How to use this report</summary>
      <ul className="mt-3 list-disc space-y-1.5 pl-5">
        <li>One export is one completed export from the desktop app (PDF, folder or another format).</li>
        <li>
          <strong>Exports</strong> counts every export, repeats included. <strong>Unique exports</strong>{' '}
          counts each user&apos;s deal once, whatever the format and however often it was exported. Two
          users exporting the same deal are two.
        </li>
        <li>
          Before version 2.43 a double click could record one export twice. Exports includes those;
          Unique exports does not.
        </li>
        <li>In the chart, a unique export counts on the first day in the period that the user exported that deal.</li>
        <li>Organization is the user&apos;s membership today, not at the time of the export.</li>
        <li>No app version or platform is recorded with an export, so neither can be filtered.</li>
        <li>Days are UTC. This week starts on Monday.</li>
      </ul>
    </details>
  );
}
