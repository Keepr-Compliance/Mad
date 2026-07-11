const fs = require('node:fs');
const path = require('node:path');

/**
 * Pure, dependency-free decision logic for the afterPack fuse gate (BACKLOG-1885).
 *
 * Kept separate from scripts/afterPack.js (which pulls in `@electron/fuses`) so it is trivially
 * unit-testable in jest with no packaging, no native deps, and no fuse flip.
 *
 * Two guarantees are encoded here:
 *   1. Default-secure: any env other than exactly KEEPR_QA_BUILD=1 => inspect fuse OFF, never throws.
 *   2. Hard guard: KEEPR_QA_BUILD=1 + a release/publish context => build refused (throws).
 */

const QA_BUILD_ENV = 'KEEPR_QA_BUILD';
const QA_MARKER_FILENAME = 'KEEPR_QA_BUILD';

/**
 * Parse the electron-builder publish flag out of an argv array.
 * Returns the (lower-cased) publish value if `--publish`/`-p` is present, else null.
 * @param {string[]} argv
 * @returns {string|null}
 */
function parsePublishFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--publish' || a === '-p') {
      const v = argv[i + 1];
      return v === undefined ? '' : String(v).toLowerCase();
    }
    const m = /^(?:--publish|-p)=(.*)$/.exec(a);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Detect whether electron-builder is running in a release/publish channel context.
 * Pure — reads only the provided env + argv so it is unit-testable.
 *
 * Signals (see BACKLOG-1885 plan / PR #1868 SR review I-1):
 *   - inCi:      release.yml runs in GitHub Actions and NO workflow ever runs `package:qa`
 *                (verified by grep), so a QA build in CI is always a mistake. Primary signal.
 *   - publishing: an explicit `--publish`/`-p` value other than never/false/0/no. Belt-and-
 *                braces — release.yml actually uses `--publish never` (a separate Mirror step
 *                uploads), so this catches a hypothetical local `electron-builder --publish always`.
 *
 * @param {Record<string,string|undefined>} env
 * @param {string[]} argv
 */
function detectPublishContext(env, argv) {
  const ci = env.CI;
  const inCi =
    (ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0') ||
    env.GITHUB_ACTIONS === 'true' ||
    Boolean(env.GITHUB_WORKFLOW);

  const publishFlag = parsePublishFlag(argv);
  const publishing =
    publishFlag !== null &&
    publishFlag !== '' &&
    !publishFlag.startsWith('-') &&
    !['never', 'false', '0', 'no'].includes(publishFlag);

  return { inCi, publishing, isPublishContext: inCi || publishing, publishFlag };
}

/**
 * Pure fuse-gate decision. THROWS when a QA build is combined with a release/publish context.
 * Returns the fuse decision for a legitimate (local) build.
 *
 * Default-secure invariant (PR #1868): when `KEEPR_QA_BUILD` is anything other than exactly '1'
 * (unset, '0', 'true', …) this returns `{ isQaBuild:false, enableInspect:false }` and NEVER throws,
 * so production behavior is byte-identical.
 *
 * @param {Record<string,string|undefined>} env
 * @param {string[]} argv
 * @returns {{ isQaBuild: boolean, enableInspect: boolean }}
 */
function resolveFuseGate(env, argv) {
  const isQaBuild = env[QA_BUILD_ENV] === '1';
  if (isQaBuild) {
    const ctx = detectPublishContext(env, argv);
    if (ctx.isPublishContext) {
      const reasons = [];
      if (ctx.inCi) reasons.push('CI / GitHub Actions environment');
      if (ctx.publishing) reasons.push(`electron-builder publish flag (--publish ${ctx.publishFlag})`);
      throw new Error(
        `[afterPack] REFUSING TO BUILD: ${QA_BUILD_ENV}=1 (Node inspect fuse ENABLED) combined with a ` +
          `release/publish context [${reasons.join(' + ')}]. A QA-fused build is a NON-DISTRIBUTED test ` +
          `artifact and must never be produced by the release pipeline or published to keepr-releases. ` +
          `Run QA builds locally with \`npm run package:qa\` (never in CI, never with --publish).`,
      );
    }
  }
  return { isQaBuild, enableInspect: isQaBuild };
}

/**
 * Resolve the app-bundle resources directory that a marker file should be dropped into,
 * so the QA marker travels inside the signed artifact.
 *   darwin  -> <App>.app/Contents/Resources
 *   win32   -> <appOutDir>/resources
 *   linux   -> <appOutDir>/resources
 * Falls back to appOutDir if the resources dir does not exist.
 *
 * @param {string} electronBinaryPath  full path to the packaged binary/.app
 * @param {string} appOutDir
 * @param {string} platformName        context.electronPlatformName
 */
function resolveResourcesDir(electronBinaryPath, appOutDir, platformName) {
  const candidate =
    platformName === 'darwin'
      ? path.join(electronBinaryPath, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
  return fs.existsSync(candidate) ? candidate : appOutDir;
}

/**
 * Write the DO-NOT-DISTRIBUTE marker into a QA build so the artifact is self-identifying.
 * @returns {string} the marker file path written
 */
function writeQaMarker(electronBinaryPath, appOutDir, platformName) {
  const dir = resolveResourcesDir(electronBinaryPath, appOutDir, platformName);
  const markerPath = path.join(dir, QA_MARKER_FILENAME);
  const contents =
    'KEEPR QA BUILD — DO NOT DISTRIBUTE.\n' +
    'This artifact was built with KEEPR_QA_BUILD=1, which leaves the Electron\n' +
    'EnableNodeCliInspectArguments fuse ENABLED for E2E automation (BACKLOG-1849).\n' +
    'It is NOT a release build and must never be uploaded to keepr-releases.\n' +
    `builtAt: ${new Date().toISOString()}\n`;
  fs.writeFileSync(markerPath, contents, 'utf8');
  return markerPath;
}

module.exports = {
  QA_BUILD_ENV,
  QA_MARKER_FILENAME,
  parsePublishFlag,
  detectPublishContext,
  resolveFuseGate,
  resolveResourcesDir,
  writeQaMarker,
};
