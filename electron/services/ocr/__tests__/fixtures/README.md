# BACKLOG-3943 OCR fixtures

## Image-only proof page (NOT committed)

`ocrChild.proof.test.ts` needs one PDF page that holds an image and no text layer — the shape
this item exists for: a PDF whose text-layer pass returns "". The page is a full-page image of
a copyrighted form, so it is **deliberately not committed** to this repository. The suite reads
it from the path in `KEEPR_OCR_PROOF`:

```
KEEPR_OCR_PROOF=/path/to/s1-form41-p1-200dpi-imageonly.pdf \
  npx jest electron/services/ocr/__tests__/ocrChild.proof.test.ts
```

- `KEEPR_OCR_PROOF` unset, or not on macOS: both tests report SKIPPED (SR plan review R8).
- Set: the file must exist and its sha256 must equal `PROOF_PAGE_SHA256` in the suite;
  a missing or different file FAILS the suite, it never skips or passes.

### What the page is

- Source: page 1 of NWMLS Form 41 Rev. 8/24, BLANK (source S1 of BACKLOG-3941, sha256
  `d7f01baa1e844045f3d8e3a6b7ad5edd4dfce73b3c634d760a983c28b315ab68`), rasterised and
  re-wrapped as a PDF that holds one image and no text layer (`/Image` present, `/Font` absent).
- Expected PDF sha256: `8cff3bcfb0aa2f0ccba3d9c5be9e6e494396fede394374672c34782f5ac2d2a3`
  (980,652 bytes) — the value pinned as `PROOF_PAGE_SHA256`.
- Raster: 200 dpi, 1700 x 2200 px PNG, sha256
  `11c1e4c4cb5c3294a4d8c2735d9db64e5cc5175f7ef3fc4ec7a8639df741a434`.
- Metadata: Producer = macOS Quartz PDFContext, creation date only. No author, no path.

### How to regenerate it

Use `make-image-only-page.jxa` in this folder (committed), on macOS (built on 15.7.3, PDFKit),
from the blank public form:

```
osascript -l JavaScript make-image-only-page.jxa <blank-form-41.pdf> 0 200 <out.png> <out.pdf>
```

The raster is byte-reproducible: `<out.png>` must hash to the PNG sha256 above (the SR plan
review's independent raster had the same hash). The PDF bytes are NOT reproducible — PDFKit
stamps a creation date — so a freshly generated PDF has a different sha256 and the suite fails
on it by design. To adopt a regenerated page, confirm the PNG hash first, then update
`PROOF_PAGE_SHA256` in the same change.

The proof: the real child must OCR the page and the 3941 matcher must find `nwmls-41`,
footer+title, Rev. 8/24.

## ocrHeaders.ts

Header lines copied byte-for-byte from three captured runs of the shipping child, each line cited
by run-file line number. Body lines are the 3941 SYNTH line. Blank public forms only (S1, S7). The
run files and the mechanical whole-line check output are recorded on BACKLOG-3943. The S1 run's
input was the image-only proof page described above.
