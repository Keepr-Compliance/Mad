/**
 * Unit tests for the afterSign notarisation hook (BACKLOG-3192).
 *
 * The hook has three exits and only one of them should ever be silent:
 *   1. non-darwin                      -> return, nothing to notarise
 *   2. CSC_IDENTITY_AUTO_DISCOVERY=false -> return, this is the supported
 *      credential-free local path used by package:dev / package:unsigned /
 *      package:qa:dir
 *   3. signed build, credentials missing -> THROW
 *
 * (3) used to warn and return. A signed release build with an empty or absent
 * credential therefore succeeded and shipped an un-notarised app that
 * Gatekeeper refuses on a customer's machine. These tests hold that exit open.
 *
 * Runs in CI: jest.config.js's CI testMatch includes
 * `<rootDir>/scripts/__tests__/**`, the same glob that selects afterPack.test.ts.
 */

// `@electron/notarize` is redirected to tests/__mocks__/electron-notarize.js by
// jest.config.js. That entry is required, not a convenience: the repo's
// `^@electron/(.*)` path alias otherwise rewrites the package to a path that
// does not exist, and resolution fails inside the mapper before any jest.mock
// can apply. Requiring it here yields the same module instance the hook gets.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockNotarize = require('@electron/notarize').notarize as jest.Mock;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const notarizing = require('../notarize').default;

/** Minimal shape of the electron-builder afterSign context the hook reads. */
const context = (electronPlatformName: string) => ({
  electronPlatformName,
  appOutDir: '/tmp/does-not-exist/mac-arm64',
  packager: { appInfo: { productFilename: 'Keepr' } },
});

const CREDENTIALS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] as const;

describe('notarize afterSign hook', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    for (const key of CREDENTIALS) delete process.env[key];
    delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // The BACKLOG-3192 case. Revert the `throw` in scripts/notarize.js to the old
  // `return` and this is the assertion that goes red.
  it('THROWS on a signed build when the notarisation credentials are missing', async () => {
    await expect(notarizing(context('darwin'))).rejects.toThrow(/Notarization aborted/);
    expect(mockNotarize).not.toHaveBeenCalled();
  });

  it.each(CREDENTIALS)('throws when only %s is missing', async (missing) => {
    for (const key of CREDENTIALS) process.env[key] = 'set-for-test';
    delete process.env[missing];

    await expect(notarizing(context('darwin'))).rejects.toThrow(/Notarization aborted/);
    expect(mockNotarize).not.toHaveBeenCalled();
  });

  it('throws when a credential is present but empty', async () => {
    for (const key of CREDENTIALS) process.env[key] = 'set-for-test';
    process.env.APPLE_TEAM_ID = '';

    await expect(notarizing(context('darwin'))).rejects.toThrow(/Notarization aborted/);
    expect(mockNotarize).not.toHaveBeenCalled();
  });

  // Guards the supported local paths. If this goes red, package:dev,
  // package:unsigned and package:qa:dir have been broken.
  it('returns quietly for an explicitly unsigned build, even with no credentials', async () => {
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

    await expect(notarizing(context('darwin'))).resolves.toBeUndefined();
    expect(mockNotarize).not.toHaveBeenCalled();
  });

  it('returns quietly on a non-darwin platform', async () => {
    await expect(notarizing(context('win32'))).resolves.toBeUndefined();
    expect(mockNotarize).not.toHaveBeenCalled();
  });

  it('notarises when all three credentials are present', async () => {
    for (const key of CREDENTIALS) process.env[key] = 'set-for-test';
    mockNotarize.mockResolvedValue(undefined);

    await expect(notarizing(context('darwin'))).resolves.toBeUndefined();
    expect(mockNotarize).toHaveBeenCalledTimes(1);
    expect(mockNotarize).toHaveBeenCalledWith(
      expect.objectContaining({ appPath: '/tmp/does-not-exist/mac-arm64/Keepr.app' })
    );
  });

  it('propagates a notarisation failure rather than swallowing it', async () => {
    for (const key of CREDENTIALS) process.env[key] = 'set-for-test';
    mockNotarize.mockRejectedValue(new Error('Apple said no'));

    await expect(notarizing(context('darwin'))).rejects.toThrow('Apple said no');
  });
});
