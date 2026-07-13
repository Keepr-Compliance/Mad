/**
 * Unit tests for the EXPORT-COMPLETENESS cell core (BACKLOG-1983). Pure Node — no app launch, DB,
 * keychain, or PDF; runs under the harness jest config (npm run qa:test).
 *
 * Proves:
 *   1. the completeness diff helper is correct in BOTH directions (missing = under-link/export-loss;
 *      unexpected = over-link/stray content) and set-exact;
 *   2. the marker-in-text / marker-in-rows observers work;
 *   3. the duplicated EXPECTED constants stay byte-identical to the seeder's exports (the writer runs
 *      in a separate Electron-main process, so the value is mirrored and cross-checked here — the
 *      delete-emails / users-roles precedent).
 *
 * NOTE: this file does NOT import extractPdfText's pdfjs path — the dynamic import in the core keeps
 * pdfjs's ESM build out of the ts-jest (CommonJS) graph. Only the pure helpers are exercised here.
 */
import {
  EXPECTED_LINKED_EMAILS,
  EXPECTED_MARKERS,
  EXPORT_COMPLETENESS_ACCOUNT_ID,
  diffCompleteness,
  markersFoundInText,
  markersInCommsRows,
  type CommContentRow,
} from '../export-completeness-core';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../seed-fixture.js') as {
  EXPORT_COMPLETENESS_LINKED_EMAIL_IDS: string[];
  EXPORT_COMPLETENESS_BODY_MARKERS: Record<string, string>;
  EXPORT_COMPLETENESS_ACCOUNT_ID: string;
};

describe('export-completeness constants fidelity (BACKLOG-1983)', () => {
  it('the core linked-email ids are byte-identical to the seeder ids', () => {
    // The seeder (Electron-main) is the WRITER; this core (Node cell) mirrors it. Drift would make the
    // hardcoded oracle assert against a set the DB does not have.
    expect(EXPECTED_LINKED_EMAILS.map((e) => e.emailId)).toEqual(
      seed.EXPORT_COMPLETENESS_LINKED_EMAIL_IDS,
    );
  });

  it('the core markers are byte-identical to the seeder body markers (per email id)', () => {
    const coreMap: Record<string, string> = {};
    for (const { emailId, marker } of EXPECTED_LINKED_EMAILS) coreMap[emailId] = marker;
    expect(coreMap).toEqual(seed.EXPORT_COMPLETENESS_BODY_MARKERS);
  });

  it('the covering email_sync_state account id matches the seeder', () => {
    expect(EXPORT_COMPLETENESS_ACCOUNT_ID).toBe(seed.EXPORT_COMPLETENESS_ACCOUNT_ID);
  });

  it('EXPECTED_MARKERS is the sorted, deduped, 4-item marker set', () => {
    expect(EXPECTED_MARKERS).toEqual([
      'KEEPRPDFMARKERALPHA',
      'KEEPRPDFMARKERBRAVO',
      'KEEPRPDFMARKERCHARLIE',
      'KEEPRPDFMARKERDELTA',
    ]);
    expect(EXPECTED_MARKERS.length).toBe(4);
  });

  it('markers are unique ASCII single tokens (wrap-proof, no whitespace/dashes)', () => {
    for (const m of EXPECTED_MARKERS) {
      expect(m).toMatch(/^[A-Z0-9]+$/);
    }
    expect(new Set(EXPECTED_MARKERS).size).toBe(EXPECTED_MARKERS.length);
  });
});

describe('diffCompleteness (BACKLOG-1983)', () => {
  it('PASS: observed == expected exactly → ok, no missing, no unexpected', () => {
    const d = diffCompleteness(EXPECTED_MARKERS, [...EXPECTED_MARKERS]);
    expect(d.ok).toBe(true);
    expect(d.missing).toEqual([]);
    expect(d.unexpected).toEqual([]);
  });

  it('order-insensitive: a shuffled observed set still passes', () => {
    const shuffled = [...EXPECTED_MARKERS].reverse();
    expect(diffCompleteness(EXPECTED_MARKERS, shuffled).ok).toBe(true);
  });

  it('UNDER-link / export loss: a missing marker is reported and ok=false', () => {
    const observed = EXPECTED_MARKERS.filter((m) => m !== 'KEEPRPDFMARKERCHARLIE');
    const d = diffCompleteness(EXPECTED_MARKERS, observed);
    expect(d.ok).toBe(false);
    expect(d.missing).toEqual(['KEEPRPDFMARKERCHARLIE']);
    expect(d.unexpected).toEqual([]);
  });

  it('OVER-link / stray content: an unexpected marker is reported and ok=false', () => {
    const d = diffCompleteness(EXPECTED_MARKERS, [...EXPECTED_MARKERS, 'KEEPRPDFMARKERSTRAY']);
    expect(d.ok).toBe(false);
    expect(d.missing).toEqual([]);
    expect(d.unexpected).toEqual(['KEEPRPDFMARKERSTRAY']);
  });

  it('dedupes a duplicated observed marker (does not double-count)', () => {
    const d = diffCompleteness(EXPECTED_MARKERS, [...EXPECTED_MARKERS, 'KEEPRPDFMARKERALPHA']);
    expect(d.ok).toBe(true);
  });

  it('empty observed set (e.g. unextractable/empty PDF) → all missing, ok=false', () => {
    const d = diffCompleteness(EXPECTED_MARKERS, []);
    expect(d.ok).toBe(false);
    expect(d.missing).toEqual([...EXPECTED_MARKERS]);
  });
});

describe('markersFoundInText (BACKLOG-1983)', () => {
  it('finds every expected marker embedded in realistic PDF-extracted text (spaces between items)', () => {
    const pdfText =
      'Transaction Summary  742 Birchwood Lane NE — offer accepted ' +
      'Seller accepted your offer on 742 Birchwood Lane NE. KEEPRPDFMARKERALPHA ' +
      'Re: 742 Birchwood Lane NE inspection KEEPRPDFMARKERBRAVO ' +
      'Closing docs KEEPRPDFMARKERCHARLIE Wire instructions KEEPRPDFMARKERDELTA';
    expect(markersFoundInText(pdfText, EXPECTED_MARKERS)).toEqual([...EXPECTED_MARKERS]);
  });

  it('reports only the markers actually present (partial extraction → partial found)', () => {
    const pdfText = 'body KEEPRPDFMARKERALPHA and KEEPRPDFMARKERDELTA only';
    expect(markersFoundInText(pdfText, EXPECTED_MARKERS)).toEqual([
      'KEEPRPDFMARKERALPHA',
      'KEEPRPDFMARKERDELTA',
    ]);
  });

  it('empty text finds nothing', () => {
    expect(markersFoundInText('', EXPECTED_MARKERS)).toEqual([]);
  });
});

describe('markersInCommsRows (BACKLOG-1983)', () => {
  const rows: CommContentRow[] = EXPECTED_LINKED_EMAILS.map((e, i) => ({
    email_id: e.emailId,
    subject: `subject ${i}`,
    body_text: `some body text ${e.marker} tail`,
    sent_at: `2026-01-0${i + 1}T00:00:00.000Z`,
  }));

  it('finds every expected marker across the DB content rows', () => {
    expect(markersInCommsRows(rows)).toEqual([...EXPECTED_MARKERS]);
  });

  it('UNDER-link: a missing DB row means its marker is absent → diff reports it', () => {
    const short = rows.filter((r) => r.email_id !== 'qa-seed-email-match-2');
    const observed = markersInCommsRows(short);
    const d = diffCompleteness(EXPECTED_MARKERS, observed);
    expect(d.ok).toBe(false);
    expect(d.missing).toEqual(['KEEPRPDFMARKERBRAVO']);
  });

  it('tolerates a null body_text row without throwing', () => {
    const withNull: CommContentRow[] = [
      ...rows,
      { email_id: 'x', subject: null, body_text: null, sent_at: null },
    ];
    expect(markersInCommsRows(withNull)).toEqual([...EXPECTED_MARKERS]);
  });
});
