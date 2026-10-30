/**
 * BACKLOG-3941 — publisher rows. Each row carries the publisher's header grammar, as observed
 * in the pdfjs text layer of blank forms (attachmentTextExtractionService.ts extractor loop).
 *
 * NWMLS header, layout A (one line per item):
 *   Form 41 ©Copyright 2024
 *   Buyer Brokerage Services Agreement Northwest Multiple Listing Service
 *   Rev. 8/24 ALL RIGHTS RESERVED
 *   Page 1 of 3
 * Layout B puts each item on its own line (bare `Form 17`, title, `Rev. 8/21`, …).
 * The header repeats on every page.
 */
import type { PublisherRow } from "./formRegistryTypes";

export const NWMLS_PUBLISHER: PublisherRow = {
  id: "nwmls",
  name: "Northwest Multiple Listing Service",
  namePattern: /Northwest\s+Multiple\s+Listing\s+Service/i,
  region: { country: "US", state: "WA" },
  header: {
    // R1 whole code line; group 1 = the WHOLE code token (R2 is an exact lookup on it).
    codeLine: /^ *Form +([0-9]+[A-Z]*(?:-[A-Z]+)?)(?: +©Copyright +\d{4})? *$/m,
    // R4.
    requiredMarkers: [/ALL\s+RIGHTS\s+RESERVED/],
    // R5. No OCR loosening: one observed OCR artifact ("Rev. 7110", a filled scan) is not a
    // design input. OCR tolerance belongs with the OS OCR source (BACKLOG-3943) and real samples.
    revision: /Rev\.\s*(\d{1,2}\s*\/\s*\d{2})/,
    // R3/R4/R5 window from the start of the code line. Sweep recorded on BACKLOG-3941.
    windowChars: 400,
  },
};

export const DEFAULT_PUBLISHERS: readonly PublisherRow[] = [NWMLS_PUBLISHER];
