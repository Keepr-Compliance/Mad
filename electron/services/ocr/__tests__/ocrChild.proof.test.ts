/**
 * @jest-environment node
 *
 * BACKLOG-3943 — REAL engine proof. Starts /usr/bin/osascript, so it runs ONLY on macOS
 * with KEEPR_OCR_PROOF set; everywhere else jest reports these tests as SKIPPED, never as
 * passed (SR plan review R8).
 *
 * KEEPR_OCR_PROOF carries the PATH of the image-only page. The page is a full-page image
 * of a copyrighted form, so it is deliberately NOT committed: regenerate it from the blank
 * public form with fixtures/make-image-only-page.jxa (fixtures/README.md), or use a local
 * copy whose sha256 equals PROOF_PAGE_SHA256 below. A missing file or a wrong file FAILS
 * the suite; it never skips or passes on the wrong input.
 *
 *   KEEPR_OCR_PROOF=/path/to/s1-form41-p1-200dpi-imageonly.pdf \
 *     npx jest electron/services/ocr/__tests__/ocrChild.proof.test.ts
 *
 * C9 / R4: the image-only raster of a blank public form goes through the shipping child
 * and the 3941 matcher finds it. Mutation run at build time: switch the script to the fast
 * level -> no match (the page's "Forrn 41" / "Rev. 8124" shape), so this control is
 * load-bearing for "accurate level only".
 * C10: the script parses and runs — with empty stdin it exits 1 with its own message.
 */
import crypto from "crypto";
import fs from "fs";
import { matchForms } from "../../formRecognition/formMatcher";
import { runOcrPage, type OcrPageOptions } from "../ocrChild";
import { OCR_DPI, OCR_MAX_LONG_EDGE_PX, OCR_MAX_STDOUT_BYTES } from "../ocrConfig";

/** sha256 of the image-only page this proof was built against (fixtures/README.md). */
const PROOF_PAGE_SHA256 = "8cff3bcfb0aa2f0ccba3d9c5be9e6e494396fede394374672c34782f5ac2d2a3";

const PROOF_PATH = process.env.KEEPR_OCR_PROOF ?? "";
const ENABLED = process.platform === "darwin" && PROOF_PATH !== "";
const describeProof = ENABLED ? describe : describe.skip;

const OPTS: OcrPageOptions = {
  dpi: OCR_DPI,
  maxLongEdgePx: OCR_MAX_LONG_EDGE_PX,
  timeoutMs: 30_000,
  maxStdoutBytes: OCR_MAX_STDOUT_BYTES,
};

function readProofPage(): Buffer {
  expect({ path: PROOF_PATH, exists: fs.existsSync(PROOF_PATH) }).toEqual({ path: PROOF_PATH, exists: true });
  const bytes = fs.readFileSync(PROOF_PATH);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  expect({ path: PROOF_PATH, sha256 }).toEqual({ path: PROOF_PATH, sha256: PROOF_PAGE_SHA256 });
  return bytes;
}

describeProof("real Apple Vision child (macOS, KEEPR_OCR_PROOF=<page path>)", () => {
  it("C9: OCRs the image-only Form 41 page and the matcher finds nwmls-41 footer+title Rev. 8/24", async () => {
    const r = await runOcrPage(readProofPage(), 0, OPTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pagesTotal).toBe(1);
    expect(r.lines.length).toBeGreaterThan(20);
    const m = matchForms(r.lines.join("\n"));
    expect(m.map((x) => ({ formId: x.formId, strength: x.strength, revisionSeen: x.revisionSeen }))).toEqual([
      { formId: "nwmls-41", strength: "footer+title", revisionSeen: "8/24" },
    ]);
  }, 40_000);

  it("C10: with empty stdin the script exits 1 with its unreadable message", async () => {
    await expect(runOcrPage(Buffer.alloc(0), 0, OPTS)).resolves.toMatchObject({ ok: false, failure: "unreadable" });
  }, 40_000);
});
