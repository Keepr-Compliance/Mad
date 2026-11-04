# Auto-Update Implementation Guide

## Overview

For Electron apps, **electron-updater** is the standard solution for auto-updates. It checks for new versions and prompts users to install them.

---

## Option 1: GitHub Releases (FREE & Simple)

### Requirements
- ✅ GitHub repository (you have this)
- ✅ Code signing certificate (required for macOS auto-updates)
- ✅ GitHub token for publishing

### Step 1: Install Dependencies

```bash
npm install electron-updater
```

### Step 2: Update package.json

Add publish configuration:

```json
{
  "build": {
    "appId": "com.realestate.archiveapp",
    "productName": "Keepr",
    "publish": {
      "provider": "github",
      "owner": "5hdaniel",
      "repo": "Mad",
      "releaseType": "release"
    },
    "mac": {
      "category": "public.app-category.productivity",
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist",
      "target": ["dmg", "zip"]
    }
  }
}
```

**Note:** You MUST build both DMG (for manual install) and ZIP (for auto-updates)

### Step 3: Add Auto-Update Code to electron/main.js

```javascript
const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configure logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    // ... your existing config
  });

  // Check for updates after window is created (only in production)
  if (!app.isPackaged) {
    console.log('Skipping auto-updater in development');
  } else {
    // Check for updates 5 seconds after launch
    setTimeout(() => {
      autoUpdater.checkForUpdates();
    }, 5000);
  }
}

// Auto-updater event handlers
autoUpdater.on('checking-for-update', () => {
  log.info('Checking for update...');
});

autoUpdater.on('update-available', (info) => {
  log.info('Update available:', info);
  mainWindow.webContents.send('update-available', info);
});

autoUpdater.on('update-not-available', (info) => {
  log.info('Update not available:', info);
});

autoUpdater.on('error', (err) => {
  log.error('Error in auto-updater:', err);
});

autoUpdater.on('download-progress', (progressObj) => {
  let message = `Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}%`;
  log.info(message);
  mainWindow.webContents.send('update-progress', progressObj);
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded:', info);
  mainWindow.webContents.send('update-downloaded', info);
});

// IPC handler for installing update
ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});
```

### Step 4: Update electron/preload.js

Add update handlers to the exposed API:

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // ... your existing API methods

  // Auto-update methods
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_, info) => callback(info)),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_, progress) => callback(progress)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (_, info) => callback(info)),
  installUpdate: () => ipcRenderer.send('install-update'),
});
```

### Step 5: Add UI for Updates (React)

Create a component to show update notifications:

```jsx
// src/components/UpdateNotification.jsx
import { useState, useEffect } from 'react';

export default function UpdateNotification() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [updateInfo, setUpdateInfo] = useState(null);

  useEffect(() => {
    // Listen for update events
    window.electron?.onUpdateAvailable?.((info) => {
      setUpdateAvailable(true);
      setUpdateInfo(info);
    });

    window.electron?.onUpdateProgress?.((progress) => {
      setDownloadProgress(Math.round(progress.percent));
    });

    window.electron?.onUpdateDownloaded?.((info) => {
      setUpdateDownloaded(true);
    });
  }, []);

  if (updateDownloaded) {
    return (
      <div className="fixed bottom-4 right-4 bg-green-500 text-white p-4 rounded-lg shadow-lg">
        <h3 className="font-bold">Update Ready!</h3>
        <p>Version {updateInfo?.version} has been downloaded.</p>
        <button
          onClick={() => window.electron.installUpdate()}
          className="mt-2 bg-white text-green-500 px-4 py-2 rounded"
        >
          Restart & Install
        </button>
      </div>
    );
  }

  if (updateAvailable) {
    return (
      <div className="fixed bottom-4 right-4 bg-blue-500 text-white p-4 rounded-lg shadow-lg">
        <h3 className="font-bold">Downloading Update...</h3>
        <div className="w-full bg-white/30 rounded-full h-2 mt-2">
          <div
            className="bg-white h-2 rounded-full transition-all"
            style={{ width: `${downloadProgress}%` }}
          />
        </div>
        <p className="text-sm mt-1">{downloadProgress}%</p>
      </div>
    );
  }

  return null;
}
```

### Step 6: Publishing a New Release

```bash
# 1. Update version in package.json
npm version patch  # or minor, or major

# 2. Build the app
npm run build

# 3. Package and publish to GitHub Releases
GH_TOKEN=your_github_token npm run package -- --publish always

# Or manually:
# - Build locally: npm run package
# - Create GitHub Release
# - Upload the DMG and ZIP files
# - Add latest.yml (generated automatically)
```

### Important Files for Updates

electron-builder will generate these files (needed for updates):
- `Keepr-1.0.3.dmg` (for manual install)
- `Keepr-1.0.3-mac.zip` (for auto-update)
- `latest-mac.yml` (tells app where to find updates)

---

## Option 2: Self-Hosted (S3, DigitalOcean Spaces, etc.)

If you want more control or plan to go beyond GitHub's free tier:

### Update package.json:

```json
{
  "build": {
    "publish": {
      "provider": "s3",
      "bucket": "your-bucket-name",
      "region": "us-east-1"
    }
  }
}
```

**Monthly Cost:**
- AWS S3: ~$0.023/GB storage + $0.09/GB transfer (very cheap for small apps)
- DigitalOcean Spaces: $5/mo (250GB storage, 1TB transfer)

---

## Option 3: Dedicated Update Server (Advanced)

Use services like:
- **Nucleus.sh** - $19/mo for indie apps (analytics + updates)
- **AppCenter** - Microsoft's service (free tier available)
- **update.electronjs.org** - Hazel-based (free, self-host)

---

## Critical: macOS Code Signing

**⚠️ Auto-updates ONLY work if your app is code-signed!**

### Why?
macOS Gatekeeper blocks unsigned apps from auto-updating.

### How to Get a Certificate:

1. **Join Apple Developer Program** ($99/year)
2. **Generate certificate** in Xcode or developer.apple.com
3. **Set environment variables:**

```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=your_certificate_password
```

4. **Build & sign:**

```bash
npm run package
```

### Without Code Signing:

Users will have to:
- Manually download new DMG
- Drag to Applications
- Right-click → Open (bypass Gatekeeper)

---

## Update Flow Comparison

### With Auto-Updates (Code-Signed):
1. User opens app
2. App checks GitHub for new version
3. "Update available" notification appears
4. User clicks "Download"
5. App downloads in background
6. User clicks "Install & Restart"
7. App updates automatically ✅

### Without Auto-Updates:
1. You email users "New version available!"
2. User goes to website/GitHub
3. User downloads DMG
4. User drags to Applications (replacing old version)
5. User opens app manually 😓

---

## Recommended Approach for Your Project

### Phase 1: Manual Updates (Now)
- Build DMG with `npm run package`
- Upload to GitHub Releases
- Share link with users
- **No code signing needed**
- **FREE**

### Phase 2: Auto-Updates (When you have paying customers)
- Join Apple Developer Program ($99/year)
- Get code signing certificate
- Implement electron-updater
- Publish to GitHub Releases
- **Seamless updates for users**

---

## Testing Auto-Updates

1. **Build version 1.0.2:**
   ```bash
   npm run package
   ```

2. **Create GitHub Release with DMG + ZIP**

3. **Install the app on your Mac**

4. **Bump version to 1.0.3:**
   ```bash
   npm version patch
   npm run package
   ```

5. **Create new GitHub Release**

6. **Open the installed app (v1.0.2)**

7. **Check console logs** - should see "Update available"

---

## Resources

- [electron-updater docs](https://www.electron.build/auto-update)
- [Code signing guide](https://www.electron.build/code-signing)
- [GitHub Releases publishing](https://www.electron.build/configuration/publish#githuboptions)

---

## Summary

| Method | Cost | Complexity | User Experience |
|--------|------|------------|-----------------|
| Manual (no signing) | FREE | Easy | Manual download |
| GitHub + Auto-update | $99/year | Medium | One-click update |
| S3 + Auto-update | $99/year + $5-10/mo | Medium | One-click update |
| Dedicated service | $19-50/mo + $99/year | Easy | One-click update + analytics |

**My Recommendation:**
- Start with manual updates (free, simple)
- Add auto-updates once you have 50+ users (worth the $99/year)
