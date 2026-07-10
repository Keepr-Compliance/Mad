const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const { resolveFuseGate, writeQaMarker } = require('./afterPack.fuse-gate');

/**
 * afterPack hook for electron-builder.
 * Flips Electron fuses on the packaged binary to harden security.
 *
 * Fuse documentation: https://www.electronjs.org/docs/latest/tutorial/fuses
 *
 * This runs AFTER packaging but BEFORE signing/notarization (afterSign).
 * Dev mode (npm run dev) is NOT affected — fuses only apply to packaged builds.
 *
 * QA-build gate (BACKLOG-1849) + hard release-channel guard (BACKLOG-1885):
 * `KEEPR_QA_BUILD=1` (set only by the local `npm run package:qa[:dir]` scripts) keeps
 * `EnableNodeCliInspectArguments` ON so Playwright's `_electron.launch()` can attach to the
 * MAIN process for E2E automation. This produces a NON-DISTRIBUTED test artifact. To make it
 * impossible for that inspect-fused build to ever be produced by the release pipeline or shipped
 * as a release, `resolveFuseGate()` THROWS when the QA flag is combined with a publish/release
 * context, and QA builds drop a `KEEPR_QA_BUILD` marker inside the app bundle. The pure decision
 * logic lives in ./afterPack.fuse-gate.js (unit-tested in scripts/__tests__/afterPack.test.ts).
 */
module.exports = async function afterPack(context) {
  const ext = {
    darwin: '.app',
    win32: '.exe',
    linux: '',
  }[context.electronPlatformName];

  const electronBinaryPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}${ext}`;

  // Hard release-channel guard (BACKLOG-1885): refuse to enable the inspect fuse for a publish/
  // release build. Throws before any fuse is flipped when KEEPR_QA_BUILD=1 meets CI/--publish.
  const { isQaBuild, enableInspect } = resolveFuseGate(process.env, process.argv);
  if (isQaBuild) {
    console.warn('[afterPack] ⚠️  KEEPR_QA_BUILD=1 — EnableNodeCliInspectArguments left ENABLED for E2E automation. DO NOT DISTRIBUTE this build.');
  }

  console.log(`[afterPack] Flipping Electron fuses on: ${electronBinaryPath}`);
  console.log('[afterPack] Fuse configuration:');
  console.log('  RunAsNode: false');
  console.log('  EnableCookieEncryption: false (tokens/DB encrypted separately)');
  console.log('  EnableNodeOptionsEnvironmentVariable: false');
  console.log(`  EnableNodeCliInspectArguments: ${enableInspect} (QA build: ${isQaBuild})`);
  console.log('  EnableEmbeddedAsarIntegrityValidation: true');
  console.log('  OnlyLoadAppFromAsar: true');
  console.log('  GrantFileProtocolExtraPrivileges: false (TASK-2051: app:// protocol replaces file://)');

  await flipFuses(electronBinaryPath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    // Disabled: causes keychain prompts on every launch. Not needed because
    // OAuth tokens and DB key are already encrypted via dedicated services
    // (tokenEncryptionService.ts / databaseEncryptionService.ts).
    [FuseV1Options.EnableCookieEncryption]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    // Production: false (hardened). QA build (KEEPR_QA_BUILD=1): true so Playwright can attach.
    [FuseV1Options.EnableNodeCliInspectArguments]: enableInspect,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // TASK-2051: Disabled after migrating from file:// to custom app:// protocol.
    // The app now uses protocol.handle('app', ...) + mainWindow.loadURL('app://./index.html')
    // instead of mainWindow.loadFile(), so file:// privileges are no longer needed.
    // Previous state: true (required for loadFile). See PR #838 / v2.2.2.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });

  // QA builds get an in-bundle DO-NOT-DISTRIBUTE marker (BACKLOG-1885) so the signed artifact is
  // self-identifying and can never be mistaken for a release. Written before signing (afterSign).
  if (isQaBuild) {
    const markerPath = writeQaMarker(electronBinaryPath, context.appOutDir, context.electronPlatformName);
    console.warn(`[afterPack] QA marker written: ${markerPath}`);
  }

  console.log('[afterPack] Electron fuses configured successfully.');
};
