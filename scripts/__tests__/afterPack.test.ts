/**
 * Unit tests for the afterPack fuse-gate decision logic (BACKLOG-1885).
 *
 * These cover the pure, extracted decision functions ONLY — no packaging, no fuse flip.
 * They lock in the two BACKLOG-1885 guarantees:
 *   1. Default-secure: any env other than exactly KEEPR_QA_BUILD=1 => inspect fuse OFF, never throws.
 *   2. Hard guard: KEEPR_QA_BUILD=1 + a release/publish context => build refused (throws).
 *
 * Runs locally via `npm test` (CI `testMatch` scopes to src/**+electron/**, matching the
 * existing scripts/qa/harness/__tests__ precedent).
 */
// Imports the pure decision module (no `@electron/fuses` dependency), so the repo jest
// `^@electron/(.*)` path-alias mapper never interferes.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parsePublishFlag, detectPublishContext, resolveFuseGate, resolveResourcesDir } = require('../afterPack.fuse-gate');

describe('parsePublishFlag', () => {
  it('returns null when no publish flag present', () => {
    expect(parsePublishFlag([])).toBeNull();
    expect(parsePublishFlag(['electron-builder', '--mac', '--dir'])).toBeNull();
  });

  it('parses the space-separated form (--publish always / -p always)', () => {
    expect(parsePublishFlag(['--publish', 'always'])).toBe('always');
    expect(parsePublishFlag(['-p', 'never'])).toBe('never');
  });

  it('parses the equals form and lower-cases the value', () => {
    expect(parsePublishFlag(['--publish=onTagOrDraft'])).toBe('ontagordraft');
    expect(parsePublishFlag(['-p=Always'])).toBe('always');
  });

  it('returns empty string for a bare --publish with no following value', () => {
    expect(parsePublishFlag(['--publish'])).toBe('');
  });
});

describe('detectPublishContext', () => {
  it('flags GitHub Actions / CI environments', () => {
    expect(detectPublishContext({ CI: 'true' }, []).inCi).toBe(true);
    expect(detectPublishContext({ CI: '1' }, []).inCi).toBe(true);
    expect(detectPublishContext({ GITHUB_ACTIONS: 'true' }, []).inCi).toBe(true);
    expect(detectPublishContext({ GITHUB_WORKFLOW: 'Release' }, []).inCi).toBe(true);
  });

  it('does not flag a local shell (CI unset / falsey)', () => {
    expect(detectPublishContext({}, []).inCi).toBe(false);
    expect(detectPublishContext({ CI: 'false' }, []).inCi).toBe(false);
    expect(detectPublishContext({ CI: '0' }, []).inCi).toBe(false);
    expect(detectPublishContext({ CI: '' }, []).inCi).toBe(false);
  });

  it('flags an explicit publish flag but not --publish never', () => {
    expect(detectPublishContext({}, ['--publish', 'always']).publishing).toBe(true);
    expect(detectPublishContext({}, ['--publish=onTag']).publishing).toBe(true);
    expect(detectPublishContext({}, ['--publish', 'never']).publishing).toBe(false);
    expect(detectPublishContext({}, ['-p', 'false']).publishing).toBe(false);
    expect(detectPublishContext({}, []).publishing).toBe(false);
  });
});

describe('resolveFuseGate — default-secure', () => {
  it('leaves the inspect fuse OFF and never throws when the env is unset', () => {
    expect(resolveFuseGate({}, [])).toEqual({ isQaBuild: false, enableInspect: false });
  });

  it('treats anything other than exactly "1" as production (default-secure)', () => {
    for (const v of ['0', 'true', 'yes', 'TRUE', ' 1', '1 ']) {
      expect(resolveFuseGate({ KEEPR_QA_BUILD: v }, [])).toEqual({ isQaBuild: false, enableInspect: false });
    }
  });

  it('does not throw for a non-QA build even in CI / with --publish', () => {
    expect(() => resolveFuseGate({ CI: 'true' }, ['--publish', 'always'])).not.toThrow();
    expect(resolveFuseGate({ CI: 'true' }, ['--publish', 'always'])).toEqual({
      isQaBuild: false,
      enableInspect: false,
    });
  });
});

describe('resolveFuseGate — QA build gate', () => {
  it('enables the inspect fuse for a legitimate LOCAL QA build', () => {
    expect(resolveFuseGate({ KEEPR_QA_BUILD: '1' }, [])).toEqual({ isQaBuild: true, enableInspect: true });
    expect(resolveFuseGate({ KEEPR_QA_BUILD: '1' }, ['--publish', 'never'])).toEqual({
      isQaBuild: true,
      enableInspect: true,
    });
  });

  it('REFUSES a QA build in CI / GitHub Actions', () => {
    expect(() => resolveFuseGate({ KEEPR_QA_BUILD: '1', CI: 'true' }, [])).toThrow(/REFUSING TO BUILD/);
    expect(() => resolveFuseGate({ KEEPR_QA_BUILD: '1', GITHUB_ACTIONS: 'true' }, [])).toThrow(
      /release\/publish context/,
    );
    expect(() => resolveFuseGate({ KEEPR_QA_BUILD: '1', GITHUB_WORKFLOW: 'Release' }, [])).toThrow(
      /REFUSING TO BUILD/,
    );
  });

  it('REFUSES a QA build combined with an explicit publish flag', () => {
    expect(() => resolveFuseGate({ KEEPR_QA_BUILD: '1' }, ['--publish', 'always'])).toThrow(/REFUSING TO BUILD/);
    expect(() => resolveFuseGate({ KEEPR_QA_BUILD: '1' }, ['--publish=onTagOrDraft'])).toThrow(
      /REFUSING TO BUILD/,
    );
  });
});

describe('resolveResourcesDir', () => {
  it('falls back to appOutDir when no resources dir exists', () => {
    // Neither path exists on disk -> returns appOutDir.
    const out = resolveResourcesDir('/nope/Keepr.app', '/nope/out', 'darwin');
    expect(out).toBe('/nope/out');
  });
});
