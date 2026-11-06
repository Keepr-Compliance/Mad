/**
 * Learn mode: the document on the left of a deal question (board L2) — BACKLOG-4120 PR3.
 *
 * Shows the ONE attachment the question is about, which main opened (and
 * downloaded, if it was not on disk) when the question was shown. The deal's
 * street number and street name are highlighted in the text layer: that is
 * what Keepr read.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import { highlightPdfText, streetTokenRegex } from "./learnEmailHtml";

// Local worker copy (public/), as in AttachmentPreviewModal: CSP blocks a CDN worker.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export function LearnPdfPane({
  dataUrl,
  filename,
  highlightAddress,
}: {
  dataUrl: string;
  filename: string;
  highlightAddress: string;
}): React.ReactElement {
  const [numPages, setNumPages] = useState(0);
  const [failed, setFailed] = useState(false);
  const re = useMemo(() => streetTokenRegex(highlightAddress), [highlightAddress]);
  const renderText = useCallback(({ str }: { str: string }) => highlightPdfText(str, re), [re]);
  const onLoad = useCallback(({ numPages: n }: { numPages: number }) => setNumPages(n), []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#EEECE7]" data-testid="learn-pdf-pane">
      <div className="flex items-center justify-between gap-3 border-b border-[#E6E4DF] bg-white px-4 py-2.5 text-[13px]">
        <span className="truncate font-semibold">{filename} · PDF</span>
        {numPages > 0 && <span className="flex-none text-gray-500">{numPages === 1 ? "1 page" : `${numPages} pages`}</span>}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-auto p-5 [justify-content:safe_center]" data-testid="learn-pdf-scroll">
        {failed ? (
          <p className="self-center text-sm text-gray-500">This document could not be shown.</p>
        ) : (
          <Document file={dataUrl} onLoadSuccess={onLoad} onLoadError={() => setFailed(true)} loading={null}>
            {Array.from({ length: numPages }, (_, i) => (
              <div key={i} className="mb-4 bg-white shadow-sm">
                <Page
                  pageNumber={i + 1}
                  width={420}
                  renderAnnotationLayer={false}
                  renderTextLayer
                  customTextRenderer={renderText}
                />
              </div>
            ))}
          </Document>
        )}
      </div>
    </div>
  );
}
