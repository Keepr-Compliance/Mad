/**
 * BACKLOG-3941 / BACKLOG-4106 — dev-only form-match precision report over a local form bank.
 *
 *   FORM_BANK_ROOT=<dir> npx ts-node --transpile-only scripts/forms/form-match-report.ts
 *   npx ts-node --transpile-only scripts/forms/form-match-report.ts <dir>
 *
 * The bank is laid out <STATE>/<publisher folder>/<file>. The script walks it recursively and, for
 * each PDF, reads its text layer from `<file>.pdf.txt` when present, else from the PDF (same pdfjs
 * loop as attachmentTextExtractionService.ts). It SKIPS any directory whose name starts with `_`
 * (court records, staging, tools) and any file whose name matches /FILLED|-demo-/i.
 *
 * Output: one row per file (relative path, matched form ids with page counts and revision, inferred
 * regions), then a per-state precision table, then the cross-state hits (a match whose publisher's
 * region is not the folder's state). It NEVER prints matched text (FormMatch.evidence is document
 * content). No network, no DB, no writes. Not part of the app: nothing in electron/ or src/ imports
 * it. The bank's location is never written into the repo: pass it in.
 */
import * as fs from "fs";
import * as path from "path";
import { inferRegion, matchForms } from "../../electron/services/formRecognition/formMatcher";
import type { FormMatch } from "../../electron/services/formRecognition/formRegistryTypes";
import { DEFAULT_REGISTRY } from "../../electron/services/formRecognition/registry";

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

const SKIP_FILE = /FILLED|-demo-/i;

/** Every PDF under root (relative paths), skipping `_` directories and FILLED / demo files. */
function listSources(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("_")) out.push(...listSources(root, r));
    } else if (/\.pdf$/i.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(r);
    }
  }
  return out.sort();
}

async function readSource(root: string, rel: string): Promise<string> {
  const full = path.join(root, rel);
  const txt = `${full}.txt`;
  return fs.existsSync(txt) ? fs.readFileSync(txt, "utf8") : pdfText(full);
}

const label = (m: FormMatch) => m.formId ?? `?${m.code ?? ""}`;
const stateOf = (publisherId: string) =>
  DEFAULT_REGISTRY.publishers.find((p) => p.id === publisherId)?.region.state ?? "?";

interface FormTally {
  files: number;
  pages: number;
  revisions: Set<string>;
}
interface StateTally {
  sources: number;
  matched: number;
  forms: Map<string, FormTally>;
  folderHits: Map<string, number>;
  crossState: number;
}

async function main(): Promise<void> {
  const root = process.env.FORM_BANK_ROOT || process.argv[2];
  if (!root) {
    console.error("form-match-report: set FORM_BANK_ROOT (or pass the bank directory as the first argument).");
    process.exit(2);
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error("form-match-report: the bank directory does not exist.");
    process.exit(2);
  }
  const states = new Map<string, StateTally>();
  const cross: string[] = [];
  for (const rel of listSources(root)) {
    const [state, folder] = rel.split("/");
    const tally: StateTally = states.get(state) ?? {
      sources: 0,
      matched: 0,
      forms: new Map(),
      folderHits: new Map(),
      crossState: 0,
    };
    states.set(state, tally);
    tally.sources += 1;
    let text: string;
    try {
      text = await readSource(root, rel);
    } catch (err) {
      console.log(`${rel}\tERROR ${(err as Error).name}`);
      continue;
    }
    const matches = matchForms(text);
    if (matches.length > 0) tally.matched += 1;
    for (const m of matches) {
      const key = label(m);
      const f = tally.forms.get(key) ?? { files: 0, pages: 0, revisions: new Set<string>() };
      f.files += 1;
      f.pages += m.occurrences;
      if (m.revisionSeen) f.revisions.add(m.revisionSeen);
      tally.forms.set(key, f);
      const fk = `${folder}->${m.publisherId}`;
      tally.folderHits.set(fk, (tally.folderHits.get(fk) ?? 0) + 1);
      if (stateOf(m.publisherId) !== state) {
        tally.crossState += 1;
        cross.push(`${state}\t${key}\t(${stateOf(m.publisherId)})`);
      }
    }
    // Ids, counts and revisions only — never evidence.
    const forms = matches.map((m) => `${label(m)}(x${m.occurrences},rev ${m.revisionSeen ?? "-"})`).join(" ");
    const region = inferRegion(matches)
      .map((r) => `${r.state}:${r.publisherId}:${r.forms}`)
      .join(" ");
    console.log(`${rel}\t${forms || "-"}\t${region || "-"}`);
  }

  console.log("\n| state | sources | sources matched | form (files, pages, revisions) | folder -> matched publisher | cross-state hits |");
  console.log("|---|---|---|---|---|---|");
  for (const [state, t] of [...states].sort(([a], [b]) => a.localeCompare(b))) {
    const forms = [...t.forms]
      .map(([id, f]) => `${id} (${f.files}, ${f.pages}, ${[...f.revisions].join(" + ") || "-"})`)
      .join("; ");
    const folders = [...t.folderHits].map(([k, n]) => `${k} x${n}`).join("; ");
    console.log(`| ${state} | ${t.sources} | ${t.matched} | ${forms || "-"} | ${folders || "-"} | ${t.crossState} |`);
  }
  console.log(`\ncross-state hits: ${cross.length}`);
  for (const c of cross) console.log(`  ${c}`);
}

main().catch((err: unknown) => {
  console.error(`form-match-report failed: ${(err as Error).name}`);
  process.exit(1);
});
