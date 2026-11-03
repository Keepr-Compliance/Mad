/**
 * BACKLOG-3943 — the macOS OCR child, as JXA source.
 *
 * Run as: /usr/bin/osascript -l JavaScript -e VISION_OCR_SCRIPT <dpi> <maxLongEdgePx> <startPage0> <endPageExcl>
 * with the document BYTES on stdin. No path is ever passed, so no plaintext copy of an
 * attachment is written to disk (files at rest are KEPRENC ciphertext; the parent
 * decrypts into memory and pipes the buffer).
 *
 * Output on stdout (UTF-8), streamed per page:
 *   \u0001DOC pages=<n>
 *   \u0001PAGE <k> ms=<ms> lines=<count>
 *   <one recognised line per line, in Vision's reading order>
 *   \u0002
 *
 * Vision ACCURATE level only (founder ruling 6, 2026-10-31). The fast level merges the
 * form-code line and misreads the revision ("Rev. 7119"), so the form matcher reads
 * nothing from it.
 *
 * Object lifetime (SR plan review R5): one observed crash was Vision receiving a CGImage
 * whose owning NSImage had already been released. The page, the thumbnail NSImage and the
 * CGImage are held in variables that stay live until performRequests has returned
 * (`keep` below). One child per page plus one retry is still what makes a crash safe.
 *
 * JXA notes: pass $() for nil, never null (null is NSNull and raises). Autorelease pools
 * cannot be used from JXA, which is one reason the parent runs one child per page.
 *
 * Replaceable later by a signed helper behind the same interface (bytes in, page text out)
 * — see ocrChild.ts.
 */
export const VISION_OCR_SCRIPT = `ObjC.import('Foundation'); ObjC.import('Quartz'); ObjC.import('Vision'); ObjC.import('AppKit');
const STDOUT = $.NSFileHandle.fileHandleWithStandardOutput;
function emit(s) { STDOUT.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding)); }
function recognize(cg) {
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  req.usesLanguageCorrection = true;
  req.recognitionLanguages = $(['en-US']);
  const handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $({}));
  if (!handler.performRequestsError($([req]), null)) throw new Error('vision performRequests failed');
  const res = req.results, n = res.count, lines = [];
  for (let i = 0; i < n; i++) { const c = res.objectAtIndex(i).topCandidates(1); if (c.count > 0) lines.push(c.objectAtIndex(0).string.js); }
  return lines;
}
function run(argv) {
  const dpi = parseInt(argv[0] || '200', 10), maxEdge = parseInt(argv[1] || '2600', 10);
  const start = parseInt(argv[2] || '0', 10), endArg = parseInt(argv[3] || '1', 10);
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const doc = $.PDFDocument.alloc.initWithData(data);
  if (!doc.isNil()) {
    const total = doc.pageCount, end = Math.min(total, endArg);
    emit('\\u0001DOC pages=' + total + '\\n');
    for (let p = start; p < end; p++) {
      const page = doc.pageAtIndex(p);
      const b = page.boundsForBox($.kPDFDisplayBoxMediaBox);
      const scale = Math.min(dpi / 72, maxEdge / Math.max(b.size.width, b.size.height));
      const w = Math.round(b.size.width * scale), h = Math.round(b.size.height * scale);
      const thumb = page.thumbnailOfSizeForBox($.NSMakeSize(w, h), $.kPDFDisplayBoxMediaBox);
      const cg = thumb.CGImageForProposedRectContextHints($(), $(), $());
      const t0 = Date.now();
      const lines = recognize(cg);
      const keep = [doc, page, thumb, cg];
      emit('\\u0001PAGE ' + (p + 1) + ' ms=' + (Date.now() - t0) + ' lines=' + lines.length + ' held=' + keep.length + '\\n' + lines.join('\\n') + '\\n\\u0002\\n');
    }
  } else {
    const img = $.NSImage.alloc.initWithData(data);
    if (img.isNil()) throw new Error('stdin is neither a PDF nor an image');
    const cg = img.CGImageForProposedRectContextHints($(), $(), $());
    const lines = recognize(cg);
    const keep = [img, cg];
    emit('\\u0001DOC pages=1\\n\\u0001PAGE 1 lines=' + lines.length + ' held=' + keep.length + '\\n' + lines.join('\\n') + '\\n\\u0002\\n');
  }
  return '';
}`;

/** The stderr text the child raises when stdin is neither a PDF nor an image. */
export const VISION_UNREADABLE_MESSAGE = "stdin is neither a PDF nor an image";
