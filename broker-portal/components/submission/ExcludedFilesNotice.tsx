'use client';

/**
 * BACKLOG-3682 / BACKLOG-3403: files the agent chose to submit without,
 * shown at the end of the broker review page. Renders nothing when the list
 * is empty (every submission before 2.39, and most after).
 *
 * A client component so the dates use the broker's own time zone.
 */

import {
  excludedFileName,
  excludedReasonText,
  excludedSourceText,
  formatSourceTime,
  type ExcludedFile,
} from '@/lib/submissions/attachmentSources';

interface ExcludedFilesNoticeProps {
  files: ExcludedFile[];
  /** Whether the org lets brokers see texts / emails; a hidden channel's label is dropped. */
  showTextLabels: boolean;
  showEmailLabels: boolean;
}

export function ExcludedFilesNotice({ files, showTextLabels, showEmailLabels }: ExcludedFilesNoticeProps) {
  if (files.length === 0) return null;

  return (
    <section
      className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden"
      data-testid="excluded-files-notice"
    >
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">These files were not included by the agent:</h2>
      </div>
      <ul className="divide-y divide-gray-100">
        {files.map((file, i) => {
          const when = formatSourceTime(file.sent_at);
          const source = excludedSourceText(file, file.kind === 'text' ? showTextLabels : showEmailLabels);
          return (
            <li key={`${file.message_id ?? 'none'}-${i}`} className="px-6 py-3" data-testid="excluded-file">
              <p className="text-sm font-medium text-gray-900 break-words">{excludedFileName(file)}</p>
              <p className="text-xs text-gray-500 break-words">
                {when ? `${source}, ${when}` : source}
              </p>
              <p className="text-xs text-gray-700">{excludedReasonText(file.reason)}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default ExcludedFilesNotice;
