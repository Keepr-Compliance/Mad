# BACKLOG-3943 OCR fixtures

## s1-form41-p1-200dpi-imageonly.pdf

- What: page 1 of NWMLS Form 41 Rev. 8/24, BLANK (source S1 of BACKLOG-3941,
  sha256 `d7f01baa1e844045f3d8e3a6b7ad5edd4dfce73b3c634d760a983c28b315ab68`), rasterised and
  re-wrapped as a PDF that holds one image and no text layer (`/Image` present, `/Font` absent).
  It is the shape this item exists for: a PDF whose text-layer pass returns "".
- sha256: `8cff3bcfb0aa2f0ccba3d9c5be9e6e494396fede394374672c34782f5ac2d2a3` (980,652 bytes)
- Raster: 200 dpi, 1700 x 2200 px PNG, sha256
  `11c1e4c4cb5c3294a4d8c2735d9db64e5cc5175f7ef3fc4ec7a8639df741a434` (the PNG is not committed;
  the generator reproduces it byte-for-byte — the SR plan review's independent raster has the same
  hash).
- Generator: `make-image-only-page.jxa` in this folder, run on macOS 15.7.3 (PDFKit):

  ```
  osascript -l JavaScript make-image-only-page.jxa <S1.pdf> 0 200 <out.png> <out.pdf>
  ```

  The PDF bytes differ run to run (PDFKit stamps a creation date); the raster does not.
- Metadata: Producer = macOS Quartz PDFContext, creation date only. No author, no path.

Used by `ocrChild.proof.test.ts` (darwin + `KEEPR_OCR_PROOF=1` only): the real child must OCR it
and the 3941 matcher must find `nwmls-41`, footer+title, Rev. 8/24.

## ocrHeaders.ts

Header lines copied byte-for-byte from three captured runs of the shipping child, each line cited
by run-file line number. Body lines are the 3941 SYNTH line. Blank public forms only (S1, S7). The
run files and the mechanical whole-line check output are recorded on BACKLOG-3943.
