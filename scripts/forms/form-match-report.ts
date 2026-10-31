/**
 * BACKLOG-3941 — dev-only form-match report over a local folder.
 *
 *   npx ts-node --transpile-only scripts/forms/form-match-report.ts <dir>
 *
 * Reads every .pdf (text layer, via the same pdfjs loop as attachmentTextExtractionService.ts)
 * and .txt in <dir> and prints, per file: form ids / codes, strength and occurrence counts, plus
 * the inferred region. It NEVER prints matched text (FormMatch.evidence is document content).
 * No network, no DB, no writes. Not part of the app: nothing in electron/ or src/ imports it.
 */
import * as fs from "fs";
import * as path from "path";
import { inferRegion, matchForms } from "../../electron/services/formRecognition/formMatcher";

interface PdfTextItem {
  str?: unknown;
  hasEOL?: boolean;
}
interface PdfjsLib {
  getDocument(src: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
      destroy(): Promise<void>;
    }>;
  };
}

// Preserved dynamic import (pdfjs is ESM-only); same technique as the app's extractor.
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<unknown>;

async function pdfText(file: string): Promise<string> {
  const pdfjs = (await dynamicImport("pdfjs-dist/legacy/build/pdf.mjs")) as PdfjsLib;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;
  try {
    const parts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (typeof item.str === "string") pageText += item.str;
        if (item.hasEOL) pageText += "\n";
      }
      parts.push(pageText);
    }
    return parts.join("\n");
  } finally {
    await doc.destroy();
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir || !fs.statSync(dir).isDirectory()) {
    console.error("usage: npx ts-node --transpile-only scripts/forms/form-match-report.ts <dir>");
    process.exit(2);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(pdf|txt)$/i.test(f))
    .sort();
  let matchedFiles = 0;
  for (const name of files) {
    const full = path.join(dir, name);
    let text: string;
    try {
      text = /\.pdf$/i.test(name) ? await pdfText(full) : fs.readFileSync(full, "utf8");
    } catch (err) {
      console.log(`${name}\tERROR ${(err as Error).name}`);
      continue;
    }
    const matches = matchForms(text);
    if (matches.length > 0) matchedFiles += 1;
    // Ids, codes, strength and counts only — never evidence.
    const forms = matches
      .map((m) => `${m.formId ?? `?${m.code ?? ""}`}(${m.strength},x${m.occurrences})`)
      .join(" ");
    const region = inferRegion(matches)
      .map((r) => `${r.state}:${r.publisherId}:${r.forms}`)
      .join(" ");
    console.log(`${name}\t${forms || "-"}\t${region || "-"}`);
  }
  console.log(`files=${files.length} matched=${matchedFiles}`);
}

main().catch((err: unknown) => {
  console.error(`form-match-report failed: ${(err as Error).name}`);
  process.exit(1);
});
