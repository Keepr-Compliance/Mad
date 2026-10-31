/**
 * @jest-environment node
 *
 * BACKLOG-3943 — REAL engine proof. Starts /usr/bin/osascript, so it runs ONLY on macOS
 * with KEEPR_OCR_PROOF=1; everywhere else jest reports these tests as SKIPPED, never as
 * passed (SR plan review R8).
 *
 *   KEEPR_OCR_PROOF=1 npx jest electron/services/ocr/__tests__/ocrChild.proof.test.ts
 *
 * C9 / R4: the committed image-only raster of a blank public form (fixtures/README.md)
 * goes through the shipping child and the 3941 matcher finds it. Mutation run at build
 * time: switch the script to the fast level -> no match (the fixture's "Forrn 41" /
 * "Rev. 8124" shape), so this control is load-bearing for "accurate level only".
 * C10: the script parses and runs — with empty stdin it exits 1 with its own message.
 */
import fs from "fs";
import path from "path";
import { matchForms } from "../../formRecognition/formMatcher";
import { runOcrPage, type OcrPageOptions } from "../ocrChild";
import { OCR_DPI, OCR_MAX_LONG_EDGE_PX, OCR_MAX_STDOUT_BYTES } from "../ocrConfig";

const ENABLED = process.platform === "darwin" && process.env.KEEPR_OCR_PROOF === "1";
const describeProof = ENABLED ? describe : describe.skip;

const FIXTURE = path.join(__dirname, "fixtures", "s1-form41-p1-200dpi-imageonly.pdf");
const OPTS: OcrPageOptions = {
  dpi: OCR_DPI,
  maxLongEdgePx: OCR_MAX_LONG_EDGE_PX,
  timeoutMs: 30_000,
  maxStdoutBytes: OCR_MAX_STDOUT_BYTES,
};

describeProof("real Apple Vision child (macOS, KEEPR_OCR_PROOF=1)", () => {
  it("C9: OCRs the image-only Form 41 page and the matcher finds nwmls-41 footer+title Rev. 8/24", async () => {
    const r = await runOcrPage(fs.readFileSync(FIXTURE), 0, OPTS);
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
