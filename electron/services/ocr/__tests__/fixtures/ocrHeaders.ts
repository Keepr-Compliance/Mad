/**
 * BACKLOG-3943 — Vision OCR output fixtures (header lines only).
 *
 * Every non-SYNTH line is copied byte-for-byte from ONE captured run of the shipping child
 * (visionOcrScript.ts) on a BLANK public form, and cited by run-file line number. Form
 * bodies are replaced by the 3941 SYNTH line. No filled form is a source. Vision output
 * varies between runs (one run reads the copyright sign as "©", another as "@"); these
 * strings are the run they cite and nothing else. Provenance and the mechanical
 * whole-line check: fixtures/README.md and the BACKLOG-3943 build comment.
 *
 * Runs (200 dpi, long edge 2600, page 1, /usr/bin/osascript, macOS 15.7.3, 2026-10-31):
 *   OCR_S1_P1       accurate level, input = fixtures/s1-form41-p1-200dpi-imageonly.pdf
 *                   (S1 = NWMLS Form 41 Rev. 8/24 blank, sha256 d7f01baa…), run file sha256 9a7a2c8b…
 *   OCR_S1_P1_FAST  FAST level (mutation run only — the product never uses it), same input,
 *                   run file sha256 8d3b5de2…
 *   OCR_S7_P1       accurate level, input = S7 (NWMLS Form 21 Rev. 7/23 blank, born-digital,
 *                   sha256 d604c45b…), run file sha256 83a4e570…
 */
import { BODY } from "../../../formRecognition/__tests__/fixtures/nwmlsHeaders";

export const OCR_S1_P1: readonly string[] = [
  "Form 41", // run line 3
  "Buyer Brokerage Services Agreement", // run line 4
  "Rev. 8/24", // run line 5
  "Page 1 of 3", // run line 6
  "BUYER BROKERAGE", // run line 7
  "SERVICES AGREEMENT", // run line 8
  "©Copyright 2024", // run line 9
  "Northwest Multiple Listing Service", // run line 10
  "ALL RIGHTS RESERVED", // run line 11
  ...BODY,
];

export const OCR_S1_P1_FAST: readonly string[] = [
  "Forrn 41", // run line 3
  "Buyer Brokerage Services Agreement", // run line 4
  "Rev. 8124", // run line 5
  "Page1 of3", // run line 6
  "Ocopyright 2024", // run line 7
  "Northwest Multiple Listing Service", // run line 8
  "ALL RIGHTS RESERVED", // run line 9
  "BUYER BROKERAGE", // run line 10
  "SERVICES AGREEMENT", // run line 11
  ...BODY,
];

export const OCR_S7_P1: readonly string[] = [
  "Form 21", // run line 3
  "Residential PSA", // run line 4
  "Rev. 7/23", // run line 5
  "Page 1 of 6", // run line 6
  "RESIDENTIAL PURCHASE AND SALE AGREEMENT", // run line 9
  "©Copyright 2023", // run line 11
  "Northwest Multiple Listing Service", // run line 12
  "ALL RIGHTS RESERVED", // run line 13
  ...BODY,
];
