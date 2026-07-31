#!/usr/bin/env node
/**
 * Build the native modules CI installs without their own install scripts.
 *
 * CI runs `npm install` with `npm_config_ignore_scripts: true`, so NO native
 * module builds itself. This script is the only thing that builds them, which
 * means every native dependency the test run needs has to be listed here.
 *
 * TWO CATEGORIES, and the difference matters:
 *
 * 1. ELECTRON_ABI_MODULES — compiled against Electron's Node ABI, not the
 *    system Node's. Rebuilt per Electron version.
 *
 * 2. NAPI_MODULES — built against Node-API, which is ABI-stable, so ONE binary
 *    serves both plain Node (jest) and Electron (the app). No Electron target.
 *
 * `sqlite3` sat in neither category until BACKLOG-2392 and was therefore never
 * built in CI. That went unnoticed because every suite resolved `^sqlite3$` to
 * the hand-written stub in `tests/__mocks__`, so nothing ever loaded the real
 * binding. The address-book suites deliberately bypass that stub to drive the
 * REAL driver — a stub cannot hold a WAL or fail to open, so it cannot prove
 * the reader is correct — and they failed in CI with "Could not locate the
 * bindings file" while passing locally, where node_modules was installed
 * normally. If you add a test that uses a real native driver, add the module
 * here too.
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/** Compiled against Electron's ABI; must be rebuilt per Electron version. */
const ELECTRON_ABI_MODULES = ['better-sqlite3-multiple-ciphers'];

/** Node-API: ABI-stable, so one binary serves both jest (Node) and Electron. */
const NAPI_MODULES = ['sqlite3'];

function getElectronVersion() {
  try {
    // Try to get version from installed electron
    const result = execSync('npx electron --version', { encoding: 'utf-8' });
    return result.trim().replace('v', '');
  } catch {
    // Fall back to package.json
    const pkgPath = path.join(__dirname, '..', 'node_modules', 'electron', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version;
    }
    throw new Error('Could not determine Electron version');
  }
}

function getArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function getPlatform() {
  const platforms = { darwin: 'darwin', win32: 'win32', linux: 'linux' };
  return platforms[process.platform] || 'linux';
}

function tryPrebuildInstall(moduleName, electronVersion) {
  const modulePath = path.join(__dirname, '..', 'node_modules', moduleName);

  if (!fs.existsSync(modulePath)) {
    console.log(`[rebuild-native] ${moduleName} not found, skipping`);
    return true;
  }

  console.log(`[rebuild-native] ${moduleName}: prebuild-install for Electron ${electronVersion}...`);

  const result = spawnSync('npx', [
    'prebuild-install',
    '--runtime=electron',
    `--target=${electronVersion}`,
    `--arch=${getArch()}`,
    `--platform=${getPlatform()}`
  ], {
    cwd: modulePath,
    stdio: 'inherit',
    shell: true
  });

  return result.status === 0;
}

/**
 * Build a Node-API module. No `--runtime=electron`: a NAPI binary is ABI-stable
 * across Node versions AND Electron, so the one artifact serves the jest run
 * and the packaged app alike.
 */
function buildNapiModule(moduleName) {
  const modulePath = path.join(__dirname, '..', 'node_modules', moduleName);

  if (!fs.existsSync(modulePath)) {
    console.log(`[rebuild-native] ${moduleName} not found, skipping`);
    return true;
  }

  if (findBinding(modulePath)) {
    console.log(`[rebuild-native] ${moduleName}: binding already present`);
    return true;
  }

  console.log(`[rebuild-native] ${moduleName}: prebuild-install -r napi...`);
  const prebuilt = spawnSync('npx', ['prebuild-install', '-r', 'napi'], {
    cwd: modulePath,
    stdio: 'inherit',
    shell: true
  });

  if (prebuilt.status === 0 && findBinding(modulePath)) {
    return true;
  }

  // No prebuild for this platform/arch — compile it.
  console.log(`[rebuild-native] ${moduleName}: no prebuild, falling back to node-gyp rebuild...`);
  const built = spawnSync('npx', ['node-gyp', 'rebuild'], {
    cwd: modulePath,
    stdio: 'inherit',
    shell: true
  });

  return built.status === 0 && Boolean(findBinding(modulePath));
}

/** Recursively look for a compiled `.node` addon under a module directory. */
function findBinding(modulePath) {
  const roots = [
    path.join(modulePath, 'build', 'Release'),
    path.join(modulePath, 'lib', 'binding'),
    path.join(modulePath, 'prebuilds')
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith('.node')) return full;
      }
    }
  }
  return null;
}

function tryElectronRebuild() {
  console.log('[rebuild-native] Falling back to electron-rebuild...');

  const result = spawnSync('npx', ['electron-rebuild'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    shell: true
  });

  return result.status === 0;
}

function main() {
  console.log('[rebuild-native] Building native modules...');

  let failed = false;

  // NAPI modules first: these are what the jest run needs, and they do not
  // depend on resolving an Electron version. Doing them first means a missing
  // Electron install cannot stop the test-critical binding from being built.
  for (const moduleName of NAPI_MODULES) {
    if (buildNapiModule(moduleName)) {
      console.log(`[rebuild-native] ${moduleName}: OK`);
    } else {
      failed = true;
      console.error(`[rebuild-native] ${moduleName}: FAILED — tests that use the real driver will fail`);
    }
  }

  try {
    const electronVersion = getElectronVersion();
    console.log(`[rebuild-native] Detected Electron version: ${electronVersion}`);
    console.log(`[rebuild-native] Platform: ${getPlatform()}, Arch: ${getArch()}`);

    for (const moduleName of ELECTRON_ABI_MODULES) {
      // Try prebuild-install first (faster, no build tools needed)
      if (tryPrebuildInstall(moduleName, electronVersion)) {
        console.log(`[rebuild-native] ${moduleName}: installed prebuilt binary`);
        continue;
      }

      // Fall back to electron-rebuild
      if (tryElectronRebuild()) {
        console.log(`[rebuild-native] ${moduleName}: rebuilt with electron-rebuild`);
        continue;
      }

      failed = true;
      console.error(`[rebuild-native] ${moduleName}: FAILED`);
    }
  } catch (error) {
    failed = true;
    console.error('[rebuild-native] Electron rebuild error:', error.message);
  }

  if (failed) {
    console.error('[rebuild-native] One or more native modules failed to build.');
    console.error('[rebuild-native] You may need to install build tools:');
    console.error('  Windows: npm install -g windows-build-tools');
    console.error('  macOS: xcode-select --install');
    process.exit(1);
  }

  console.log('[rebuild-native] All native modules built.');
}

main();
