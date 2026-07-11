/**
 * QA Harness — export-manifest-core unit tests (BACKLOG-1852 / QA-H5).
 *
 * Fixture-first: exercises the deliverable readers, the manifest gate, the
 * source-timezone date identity (the 4 evening rows that roll +1 day in UTC),
 * the MULTISET email-set diff (canonical rows 20/21), and the DEFERRED broker
 * CSV schema check — all without launching the app or the H2 driver.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseEmlHeaders,
  emlToMember,
  isEmailType,
  jsonExportToMembers,
  validateManifest,
  readExportDeliverable,
  findEmailSource,
  findManifest,
  assertBrokerAuditCsvSchema,
  splitCsvRow,
  BROKER_AUDIT_CSV_HEADERS,
} from '../export-manifest-core';
import { diffMembers } from '../diff';
import { loadCanonicalList } from '../canonicalList';
import type { EmailSetMember } from '../types';

const TZ = 'America/Los_Angeles';
const FIX = path.join(__dirname, 'fixtures');
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CANONICAL_PATH = path.join(REPO_ROOT, 'docs', 'qa', 'tx1-canonical-list-v2.20.0.md');

const EML_DIR = path.join(FIX, 'eml-export-tx1');
const JSON_DIR = path.join(FIX, 'json-export-tx1');
const FOLDER_DIR = path.join(FIX, 'folder-export-tx1');
const BROKEN_DIR = path.join(FIX, 'folder-export-broken');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// EML header parsing + timezone-correct date identity
// ---------------------------------------------------------------------------

describe('parseEmlHeaders', () => {
  it('extracts Subject and Date, stopping at the header/body boundary', () => {
    const eml =
      'From: a@b.com\r\nTo: c@d.com\r\nSubject: Hello | World\r\n' +
      'Date: Mon, 05 Jan 2026 20:00:00 GMT\r\nContent-Type: text/plain\r\n\r\nSubject: not-a-header\n';
    const { subject, date } = parseEmlHeaders(eml);
    expect(subject).toBe('Hello | World');
    expect(date).toBe('Mon, 05 Jan 2026 20:00:00 GMT');
  });
});

describe('emlToMember — source-timezone (rollover) identity', () => {
  it('resolves an evening/UTC-rollover email to its LOCAL shifted date, not the UTC day', () => {
    const eml = fs.readFileSync(path.join(EML_DIR, 'emails', '2_742_Birchwood_showing.eml'), 'utf8');
    const member = emlToMember(eml, TZ);
    expect(member.subject).toBe('742 Birchwood Lane showing today - thoughts?');
    // EML Date is Sun 08 Feb 2026 06:30 GMT == 07 Feb 22:30 Pacific -> LOCAL 2026-02-07.
    expect(member.shiftedDate).toBe('2026-02-07');
    expect(member.shiftedDate).not.toBe('2026-02-08');
  });
});

// ---------------------------------------------------------------------------
// EML deliverable — exact set + MULTISET vs canonical subset
// ---------------------------------------------------------------------------

describe('readExportDeliverable — EML deliverable', () => {
  it('derives the lossless email set from emails/*.eml (no manifest)', () => {
    const result = readExportDeliverable(EML_DIR, { timeZone: TZ });
    expect(result.emailSource).toBe('eml');
    expect(result.manifestFound).toBe(false);
    expect(result.exportedEmails).toHaveLength(5);
    expect(result.deviations).toEqual([]);
  });

  it('matches the canonical rows exactly (0 missing / 0 extra), MULTISET-preserving rows 20/21', () => {
    const parsed = loadCanonicalList(CANONICAL_PATH);
    // Fixture covers canonical rows 1, 4, 12, 20, 21 (20/21 share a key).
    const wanted = new Set([1, 4, 12, 20, 21]);
    const subset: EmailSetMember[] = parsed.filterOff
      .filter((e) => wanted.has(e.index))
      .map((e) => ({ subject: e.subject, shiftedDate: e.shiftedDate }));
    expect(subset).toHaveLength(5);

    const exported = readExportDeliverable(EML_DIR, { timeZone: TZ }).exportedEmails;
    const { missing, extra } = diffMembers(subset, exported);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);

    // The 20/21 collision key must appear with multiplicity 2 (not collapsed).
    const dupKey = exported.filter(
      (m) =>
        m.subject === 'Re: 742 Birchwood Lane - Inspection Results - My Recommendations' &&
        m.shiftedDate === '2026-02-14',
    );
    expect(dupKey).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// JSON deliverable — email filtering + discovery
// ---------------------------------------------------------------------------

describe('isEmailType', () => {
  it('treats text/mobile types as non-email and defaults unknown to email', () => {
    expect(isEmailType('email')).toBe(true);
    expect(isEmailType(undefined)).toBe(true);
    expect(isEmailType('sms')).toBe(false);
    expect(isEmailType('iMessage')).toBe(false);
  });
});

describe('readExportDeliverable — JSON deliverable', () => {
  it('derives the email set from a top-level *.json, filtering out text communications', () => {
    const result = readExportDeliverable(JSON_DIR, { timeZone: TZ });
    expect(result.emailSource).toBe('json');
    // 2 emails, the sms is filtered out.
    expect(result.exportedEmails).toHaveLength(2);
    const rollover = result.exportedEmails.find(
      (m) => m.subject === '742 Birchwood Lane showing today - thoughts?',
    );
    expect(rollover?.shiftedDate).toBe('2026-02-07');
  });

  it('jsonExportToMembers ignores a manifest-shaped JSON (no communications[])', () => {
    const members = jsonExportToMembers('{"transactionId":"x","attachments":[]}', TZ);
    expect(members).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// folderExport folder — manifest gate + structural deviations
// ---------------------------------------------------------------------------

describe('readExportDeliverable — folderExport audit folder', () => {
  it('validates a well-formed attachments/manifest.json (no deviations)', () => {
    const result = readExportDeliverable(FOLDER_DIR, {
      timeZone: TZ,
      expectedAttachmentCount: 2,
      expectedTransactionId: 'dda5188c-4d5b-48a7-8a51-bd60378cf44b',
      expectedPropertyAddress: '742 Birchwood',
    });
    expect(result.manifestFound).toBe(true);
    // Emails are lossy PDFs -> no lossless set is derived here.
    expect(result.emailSource).toBe('none');
    expect(result.exportedEmails).toEqual([]);
    expect(result.deviations).toEqual([]);
  });

  it('flags an attachment-count mismatch', () => {
    const result = readExportDeliverable(FOLDER_DIR, { timeZone: TZ, expectedAttachmentCount: 3 });
    const dev = result.deviations.find((d) => d.cell === 'attachmentCount');
    expect(dev).toMatchObject({ expected: 3, got: 2 });
  });

  it('flags a transactionId mismatch', () => {
    const result = readExportDeliverable(FOLDER_DIR, {
      timeZone: TZ,
      expectedTransactionId: 'wrong-id',
    });
    expect(result.deviations.map((d) => d.cell)).toContain('manifest.transactionId');
  });

  it('flags a broken manifest (missing/empty fields + bad attachment shape)', () => {
    const result = readExportDeliverable(BROKEN_DIR, { timeZone: TZ });
    const cells = result.deviations.map((d) => d.cell);
    expect(cells).toContain('manifest.transactionId');
    expect(cells).toContain('manifest.propertyAddress');
    expect(cells).toContain('manifest.attachments.shape');
  });

  it('flags an unrecognized directory (no email source, no manifest)', () => {
    const dir = tmpDir('qa-h5-empty-');
    try {
      const result = readExportDeliverable(dir, { timeZone: TZ });
      expect(result.deviations.map((d) => d.cell)).toContain('deliverable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findEmailSource / findManifest discovery', () => {
  it('does not misclassify attachments/manifest.json as a JSON email source', () => {
    expect(findEmailSource(FOLDER_DIR).kind).toBe('none');
    expect(findManifest(FOLDER_DIR)).not.toBeNull();
  });

  it('finds an EML source and a manifest one directory level below a ceremony root', () => {
    const root = tmpDir('qa-h5-root-');
    try {
      // Combined layout: <root>/txt_eml/emails/*.eml + <root>/folder/attachments/manifest.json
      fs.mkdirSync(path.join(root, 'txt_eml', 'emails'), { recursive: true });
      fs.copyFileSync(
        path.join(EML_DIR, 'emails', '1_Happy_New_Year.eml'),
        path.join(root, 'txt_eml', 'emails', '1_Happy_New_Year.eml'),
      );
      fs.mkdirSync(path.join(root, 'folder', 'attachments'), { recursive: true });
      fs.copyFileSync(
        path.join(FOLDER_DIR, 'attachments', 'manifest.json'),
        path.join(root, 'folder', 'attachments', 'manifest.json'),
      );
      const src = findEmailSource(root);
      expect(src.kind).toBe('eml');
      expect(findManifest(root)).not.toBeNull();

      const result = readExportDeliverable(root, { timeZone: TZ, expectedAttachmentCount: 2 });
      expect(result.emailSource).toBe('eml');
      expect(result.exportedEmails).toHaveLength(1);
      expect(result.manifestFound).toBe(true);
      expect(result.deviations).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// validateManifest — direct unit coverage
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  const good = {
    transactionId: 't1',
    propertyAddress: '742 Birchwood',
    exportDate: '2026-07-06T05:01:00.000Z',
    attachments: [{ filename: 'a.pdf', status: 'exported' }],
  };

  it('passes a well-formed manifest', () => {
    expect(validateManifest(good).deviations).toEqual([]);
  });

  it('rejects a non-object manifest', () => {
    expect(validateManifest(null).deviations.map((d) => d.cell)).toContain('manifest.json');
  });

  it('rejects a missing attachments array', () => {
    const { transactionId, propertyAddress, exportDate } = good;
    const cells = validateManifest({ transactionId, propertyAddress, exportDate }).deviations.map(
      (d) => d.cell,
    );
    expect(cells).toContain('manifest.attachments');
  });

  it('flags emailAttachments.exportedCount inconsistency', () => {
    const m = {
      ...good,
      emailAttachments: { exportedCount: 3, items: [{}, {}] },
    };
    expect(validateManifest(m).deviations.map((d) => d.cell)).toContain(
      'manifest.emailAttachments.exportedCount',
    );
  });
});

// ---------------------------------------------------------------------------
// Full-69 determinism (synthesized EML) + missing/extra file cases
// ---------------------------------------------------------------------------

describe('full canonical set — synthesized EML deliverable', () => {
  const parsed = loadCanonicalList(CANONICAL_PATH);
  const expectedMembers: EmailSetMember[] = parsed.filterOff.map((e) => ({
    subject: e.subject,
    shiftedDate: e.shiftedDate,
  }));

  /** Write one .eml per canonical row into <dir>/emails, midday-Pacific so the
   * local shifted date equals the canonical date. */
  function writeSynthDeliverable(dir: string): void {
    const emailsDir = path.join(dir, 'emails');
    fs.mkdirSync(emailsDir, { recursive: true });
    parsed.filterOff.forEach((row, i) => {
      const iso = `${row.shiftedDate}T20:00:00.000Z`; // 12:00 PST / 13:00 PDT -> same local day
      const eml =
        `From: sender@example.com\r\nTo: agent@izzyrescue.org\r\n` +
        `Subject: ${row.subject}\r\nDate: ${new Date(iso).toUTCString()}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n\r\nbody ${i}\r\n`;
      fs.writeFileSync(path.join(emailsDir, `${String(i + 1).padStart(3, '0')}_row.eml`), eml);
    });
  }

  it('reproduces the exact 69-row set (0 missing / 0 extra)', () => {
    const dir = tmpDir('qa-h5-full-');
    try {
      writeSynthDeliverable(dir);
      const exported = readExportDeliverable(dir, { timeZone: TZ }).exportedEmails;
      expect(exported).toHaveLength(parsed.filterOff.length);
      const { missing, extra } = diffMembers(expectedMembers, exported);
      expect(missing).toEqual([]);
      expect(extra).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a MISSING email file as one missing member', () => {
    const dir = tmpDir('qa-h5-missing-');
    try {
      writeSynthDeliverable(dir);
      const files = fs.readdirSync(path.join(dir, 'emails')).sort();
      fs.unlinkSync(path.join(dir, 'emails', files[0]));
      const exported = readExportDeliverable(dir, { timeZone: TZ }).exportedEmails;
      const { missing, extra } = diffMembers(expectedMembers, exported);
      expect(missing).toHaveLength(1);
      expect(extra).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects an EXTRA email file as one extra member', () => {
    const dir = tmpDir('qa-h5-extra-');
    try {
      writeSynthDeliverable(dir);
      const eml =
        `From: x@example.com\r\nSubject: Unexpected Email Not In Canonical Set\r\n` +
        `Date: ${new Date('2026-03-01T20:00:00.000Z').toUTCString()}\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n`;
      fs.writeFileSync(path.join(dir, 'emails', '999_extra.eml'), eml);
      const exported = readExportDeliverable(dir, { timeZone: TZ }).exportedEmails;
      const { missing, extra } = diffMembers(expectedMembers, exported);
      expect(missing).toEqual([]);
      expect(extra).toHaveLength(1);
      expect(extra[0].subject).toBe('Unexpected Email Not In Canonical Set');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// DEFERRED broker audit-log CSV schema check
// ---------------------------------------------------------------------------

describe('assertBrokerAuditCsvSchema (deferred broker variant)', () => {
  const header = BROKER_AUDIT_CSV_HEADERS.join(',');

  it('accepts a well-formed audit CSV (header + a quote-escaped row)', () => {
    const row =
      'log-1,2026-07-06T00:00:00Z,export,transaction,tx-1,,,actor-1,a@b.com,Agent,127.0.0.1,' +
      '"Mozilla, 5.0","{""k"":""v""}"';
    expect(assertBrokerAuditCsvSchema(`${header}\n${row}\n`)).toEqual([]);
  });

  it('flags a wrong header', () => {
    const cells = assertBrokerAuditCsvSchema('id,created_at,action\nx,y,z').map((d) => d.cell);
    expect(cells).toContain('broker.csv.header');
  });

  it('flags a data row with the wrong field count', () => {
    const cells = assertBrokerAuditCsvSchema(`${header}\ntoo,few,columns`).map((d) => d.cell);
    expect(cells).toContain('broker.csv.rowShape');
  });

  it('splitCsvRow honours quoted commas and escaped quotes', () => {
    expect(splitCsvRow('a,"b, c","d""e"')).toEqual(['a', 'b, c', 'd"e']);
  });
});
