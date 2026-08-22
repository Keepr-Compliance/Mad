/**
 * Unit tests for the QA-H7 LOG-SCAN core (BACKLOG-1854). Pure logic — no DB, no
 * Electron. Covers the telemetry marker detector (BACKLOG-1843) and the
 * redaction / PII scanner (guards BACKLOG-1785).
 *
 * The redaction scanner MUST demonstrate a true positive (non-zero on a log with
 * a synthetic leak) AND zero on a clean log — a scanner that cannot fire is
 * worse than none (SR review requirement 6).
 *
 * BACKLOG-2782: was `.test.js`, which tsc LOADED (allowJs) and never CHECKED
 * (checkJs:false) — a type error here was invisible to `npm run type-check:tests`
 * locally and in CI. The rename is the fix; assertions are untouched.
 *
 * The subject module is CommonJS `.js`, so it is pulled in with `require(...) as
 * {...}` (the count-linked-by-source.test.ts pattern). Shapes are transcribed
 * from ../log-scan-core.js (exports at :167). `logText` is typed wider than that
 * file's `@param {string}` because both functions open with an explicit
 * null/undefined guard (`logText === null || logText === undefined ? '' : logText`,
 * :68) and these tests assert that null/undefined do not throw.
 */
import * as fs from 'fs';
import * as path from 'path';

type TelemetryMarker = { id: string; label: string; present: boolean; count: number };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  scanTelemetry,
  scanRedaction,
  maskEmail,
} = require('../log-scan-core') as {
  scanTelemetry: (logText: string | null | undefined) => {
    markers: TelemetryMarker[];
    presentCount: number;
    totalMarkers: number;
    allPresent: boolean;
  };
  scanRedaction: (
    logText: string | null | undefined,
    opts?: { sampleLimit?: number; allowlist?: string[] },
  ) => {
    leakCount: number;
    uniqueLeakCount: number;
    maskedSamples: string[];
    lineNumbers: number[];
  };
  maskEmail: (addr: string) => string;
};

const FIX = path.join(__dirname, 'fixtures');
const readFix = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');
// The scenario-referenced telemetry fixture lives beside the scenario.
const SCENARIO_TELEMETRY = path.join(
  __dirname, '..', '..', '..', '..', 'docs', 'qa', 'scenarios', 'fixtures', 'main-log-with-telemetry.sample.txt',
);

describe('scanTelemetry (BACKLOG-1843)', () => {
  test('detects all three markers in a log that has them', () => {
    const text = fs.readFileSync(SCENARIO_TELEMETRY, 'utf8');
    const res = scanTelemetry(text);
    expect(res.allPresent).toBe(true);
    expect(res.presentCount).toBe(3);
    const byId = Object.fromEntries(res.markers.map((m): [string, TelemetryMarker] => [m.id, m]));
    expect(byId['cache-hitmiss'].present).toBe(true);
    expect(byId['cache-hitmiss'].count).toBe(1);
    expect(byId['fetch'].present).toBe(true);
    expect(byId['fetch'].count).toBeGreaterThanOrEqual(1);
    expect(byId['sync-entry'].present).toBe(true);
  });

  test('reports missing markers on a log without telemetry', () => {
    const res = scanTelemetry(readFix('main-log-no-telemetry.sample.txt'));
    expect(res.allPresent).toBe(false);
    expect(res.presentCount).toBe(0);
  });

  test('the exact CACHE-HITMISS line format from emailSyncService.ts matches', () => {
    // Pinned to the emit site: `[CACHE-HITMISS] transaction=.. reason=.. fetched=N hits=N misses=N hitRate=x`
    const line =
      '[CACHE-HITMISS] transaction=abc reason=auto fetched=190 hits=190 misses=0 hitRate=1.000';
    const res = scanTelemetry(line);
    expect(res.markers.find((m) => m.id === 'cache-hitmiss')!.present).toBe(true);
  });

  test('a malformed CACHE-HITMISS (missing fields) does NOT match', () => {
    const res = scanTelemetry('[CACHE-HITMISS] transaction=abc');
    expect(res.markers.find((m) => m.id === 'cache-hitmiss')!.present).toBe(false);
  });

  test('empty/null input → all markers absent, no throw', () => {
    expect(scanTelemetry('').presentCount).toBe(0);
    expect(scanTelemetry(null).presentCount).toBe(0);
    expect(scanTelemetry(undefined).presentCount).toBe(0);
  });
});

describe('scanRedaction (guards BACKLOG-1785)', () => {
  test('TRUE POSITIVE — fires on a log with a synthetic leaked address', () => {
    const res = scanRedaction(readFix('main-log-with-leak.sample.txt'), {
      allowlist: ['noreply@', '@keeprcompliance.com'],
    });
    // leak@example.com, second.leak@example.org, third@example.net = 3 leaks.
    expect(res.leakCount).toBe(3);
    expect(res.uniqueLeakCount).toBe(3);
    // Allowlisted noreply@keeprcompliance.com is NOT counted.
    expect(res.maskedSamples.length).toBeGreaterThan(0);
  });

  test('ZERO on the clean telemetry fixture (no PII, only synthetic tx ids)', () => {
    const res = scanRedaction(fs.readFileSync(SCENARIO_TELEMETRY, 'utf8'), {
      allowlist: ['noreply@', '@keeprcompliance.com'],
    });
    expect(res.leakCount).toBe(0);
    expect(res.maskedSamples).toEqual([]);
  });

  test('masked samples never echo a full address', () => {
    const res = scanRedaction('user leak@example.com here', {});
    expect(res.leakCount).toBe(1);
    for (const s of res.maskedSamples) {
      expect(s).not.toContain('leak@example.com');
      expect(s).toContain('***');
    }
  });

  test('allowlist suppresses build/noreply addresses', () => {
    const text = 'from noreply@keeprcompliance.com and real@leak.example.com';
    const withAllow = scanRedaction(text, { allowlist: ['@keeprcompliance.com'] });
    const withoutAllow = scanRedaction(text, {});
    expect(withAllow.leakCount).toBe(1);
    expect(withoutAllow.leakCount).toBe(2);
  });

  test('empty/null input → 0 leaks, no throw', () => {
    expect(scanRedaction('').leakCount).toBe(0);
    expect(scanRedaction(null).leakCount).toBe(0);
    expect(scanRedaction(undefined).leakCount).toBe(0);
  });
});

describe('maskEmail', () => {
  test('keeps 2 local chars + TLD, masks the rest', () => {
    expect(maskEmail('amanda@cascadetitle.com')).toBe('am***@***.com');
    expect(maskEmail('a@b.io')).toBe('a***@***.io');
  });
  test('non-email input → ***', () => {
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
