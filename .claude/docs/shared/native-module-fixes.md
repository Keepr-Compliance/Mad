# Native Module Fixes

**Status:** Troubleshooting reference for native module issues
**Last Updated:** 2024-12-24

---

## Overview

Native modules like `better-sqlite3-multiple-ciphers` must be compiled for the correct Node.js ABI version. Mismatches cause the app to crash or hang.

---

## Common Error

```
The module '.../better_sqlite3.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION X. This version of Node.js requires NODE_MODULE_VERSION Y.
```

**Example:** `NODE_MODULE_VERSION 127` (Node 22.x) vs `NODE_MODULE_VERSION 133` (Electron's bundled Node)

---

## Quick Fix Commands

### Standard Rebuild (Try First)

```bash
npm rebuild better-sqlite3-multiple-ciphers
node node_modules/@electron/rebuild/lib/cli.js -f -o better-sqlite3-multiple-ciphers
```

On Electron 44 `npx electron-rebuild` no longer works: npx resolves a stale cached 3.2.9 that fails to build (BACKLOG-4052).

### If Standard Rebuild Fails (Windows without Python; Electron 38 and earlier only)

No prebuild exists for Electron 44. On 44, use the from-source command above (needs VS Build Tools + Python on Windows).

```powershell
# 1. Clear the prebuild cache
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_prebuilds"

# 2. Delete the existing build
Remove-Item -Recurse -Force "node_modules\better-sqlite3-multiple-ciphers\build"

# 3. Download the correct Electron-specific prebuild
cd node_modules/better-sqlite3-multiple-ciphers
npx prebuild-install --runtime=electron --target=<VERSION> --arch=x64 --platform=win32
```

Replace `<VERSION>` with your Electron version from: `npx electron --version`

---

## When to Rebuild

| Situation | Action |
|-----------|--------|
| After `npm install` | Run both rebuild commands |
| After upgrading Node.js | Run both rebuild commands |
| After pulling changes with dependency updates | Run both rebuild commands |
| After switching branches with different dependencies | Run both rebuild commands |
| After updating Electron version | Run `node node_modules/@electron/rebuild/lib/cli.js -f -o better-sqlite3-multiple-ciphers` |
| If only tests fail | Run `npm rebuild better-sqlite3-multiple-ciphers` |

---

## Scenario-Specific Fixes

### Scenario 1: Jest Tests Fail

Jest uses the system Node.js, which may differ from what the native module was compiled against.

**Symptoms:**
- Tests fail with `NODE_MODULE_VERSION` error
- App works fine in dev mode

**Fix:**
```bash
npm rebuild better-sqlite3-multiple-ciphers
```

### Scenario 2: App Fails at Runtime (Electron Dev)

The Electron app gets stuck (e.g., infinite loop on "Secure Storage Setup" screen) because database initialization fails silently.

**Symptoms:**
- App stuck on loading/onboarding screens
- `NODE_MODULE_VERSION` error in console
- Works in tests but not in app

**Fix:**
```bash
node node_modules/@electron/rebuild/lib/cli.js -f -o better-sqlite3-multiple-ciphers
```

### Scenario 3: Both Tests and App Fail

**Fix (run both):**
```bash
npm rebuild better-sqlite3-multiple-ciphers && node node_modules/@electron/rebuild/lib/cli.js -f -o better-sqlite3-multiple-ciphers
```

---

## Production Builds

Production builds are unaffected because `electron-builder` compiles native modules for Electron's bundled Node.js automatically.

---

## Verification

After rebuilding, verify the fix:

```bash
# Check app starts
npm run dev

# Check tests pass
npm test
```

**Verify in app:**
- [ ] No `NODE_MODULE_VERSION` errors in console
- [ ] Database initializes successfully
- [ ] App doesn't get stuck on loading/onboarding screens

---

## References

- Electron rebuild docs: https://github.com/electron/rebuild
- Prebuild-install docs: https://github.com/prebuild/prebuild-install
