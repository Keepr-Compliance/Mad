const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * afterPack hook for electron-builder.
 * Flips Electron fuses on the packaged binary to harden security.
 *
 * Fuse documentation: https://www.electronjs.org/docs/latest/tutorial/fuses
 *
 * This runs AFTER packaging but BEFORE signing/notarization (afterSign).
 * Dev mode (npm run dev) is NOT affected — fuses only apply to packaged builds.
 */
module.exports = async function afterPack(context) {
  const ext = {
    darwin: '.app',
    win32: '.exe',
    linux: '',
  }[context.electronPlatformName];

  const electronBinaryPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}${ext}`;

  // QA-build gate (BACKLOG-1849): Playwright's `_electron.launch()` attaches to the Electron
  // MAIN process via the Node inspector, which requires EnableNodeCliInspectArguments. Production
  // hardens it OFF, which blocks the E2E driver. Setting KEEPR_QA_BUILD=1 (used only by
  // `npm run package:qa[:dir]`) keeps the inspect fuse ON so the packaged app is drivable.
  // This build is a NON-DISTRIBUTED test artifact; all other hardening stays intact.
  const isQaBuild = process.env.KEEPR_QA_BUILD === '1';
  const enableInspect = isQaBuild;
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

  console.log('[afterPack] Electron fuses configured successfully.');
};
