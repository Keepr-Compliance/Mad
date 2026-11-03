# Code Signing and Notarization Setup

This document explains how to set up code signing and notarization for Audit Magic so that macOS recognizes the app and doesn't block installation.

## Prerequisites

1. **Apple Developer Account** (Required)
   - You need an active Apple Developer Program membership ($99/year)
   - Sign up at: https://developer.apple.com

2. **Developer ID Certificate**
   - Go to: https://developer.apple.com/account/resources/certificates/list
   - Create a "Developer ID Application" certificate
   - Download and install it in your Keychain

## Step 1: Get Your Apple Credentials

### 1.1 Apple ID
Your Apple Developer account email address.

### 1.2 Team ID
Find your Team ID (10-character code like `ABC123DEFG`):

**Method 1: From Developer Portal**
1. Go to: https://developer.apple.com/account
2. Sign in with your Apple ID
3. Click "Membership" in the left sidebar
4. Your Team ID is displayed (it's a 10-character alphanumeric code)

**Method 2: Run Helper Script**
```bash
chmod +x scripts/find-team-id.sh
./scripts/find-team-id.sh
```

**Method 3: From Certificate**
```bash
security find-identity -v -p codesigning
```
Look for "Developer ID Application" - the Team ID is in the organization unit (OU)

### 1.3 App-Specific Password
Generate an app-specific password for notarization:
1. Go to: https://appleid.apple.com
2. Sign in with your Apple ID
3. Under "Security" section, click "App-Specific Passwords"
4. Click "Generate an app-specific password"
5. Give it a name like "Audit Magic Notarization"
6. Copy the password (format: `xxxx-xxxx-xxxx-xxxx`)

## Step 2: Configure Environment Variables

1. Copy `.env.local.example` to `.env.local`:
   ```bash
   cp .env.local.example .env.local
   ```

2. Edit `.env.local` and fill in your credentials:
   ```bash
   # Apple Developer Credentials for Notarization
   APPLE_ID=your-email@example.com
   APPLE_TEAM_ID=ABC123XYZ
   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx

   # Microsoft Graph API (if using Outlook integration)
   MICROSOFT_CLIENT_ID=your-client-id-here
   MICROSOFT_TENANT_ID=common
   ```

3. **Important**: Never commit `.env.local` to git! It's already in `.gitignore`.

## Step 3: Build and Package

Run the package command to build, sign, and notarize:
```bash
npm run package
```

The build process will:
1. Build the React app
2. Package the Electron app
3. Sign the app with your Developer ID certificate
4. Upload to Apple for notarization
5. Wait for notarization to complete
6. Staple the notarization ticket to the DMG

This can take 5-15 minutes for notarization.

## Step 4: Verify Notarization

After packaging, verify the app is properly signed and notarized:

```bash
# Check code signature
codesign -dv --verbose=4 dist/mac/Audit\ Magic.app

# Check notarization
spctl -a -vv -t install dist/mac/Audit\ Magic.app

# Check DMG notarization
spctl -a -vv -t open --context context:primary-signature dist/Audit\ Magic-*.dmg
```

You should see:
- `Status: approved` or `accepted`
- `source=Notarized Developer ID`

## Understanding the Configuration

### package.json Build Settings

```json
"build": {
  "appId": "com.auditmagic.app",
  "productName": "Audit Magic",
  "mac": {
    "hardenedRuntime": true,        // Required for notarization
    "gatekeeperAssess": false,      // Don't assess during build
    "entitlements": "build/entitlements.mac.plist",
    "notarize": {
      "teamId": "${APPLE_TEAM_ID}"  // From .env.local
    }
  },
  "afterSign": "scripts/notarize.js"  // Notarization script
}
```

### Entitlements File

The `build/entitlements.mac.plist` file declares required permissions:
- Full Disk Access (for Messages database)
- Contacts access
- Network access (for Outlook)
- Keychain access (for storing credentials)

## Troubleshooting

### "HTTP status code: 403. Invalid or inaccessible developer team ID"

**Cause**: Apple cannot verify the Team ID with your Apple ID. This usually means:
- The Apple ID doesn't belong to that team
- You don't have the right permissions in that team
- The credentials don't match the signing certificate

**Solution**:

1. **Verify your credentials match:**
   ```bash
   chmod +x scripts/verify-credentials.sh
   ./scripts/verify-credentials.sh
   ```

2. **Check Apple ID & Team ID association:**
   - Go to: https://developer.apple.com/account
   - Sign in with the Apple ID from `.env.local`
   - Click "Membership" → verify the Team ID matches
   - If different, update `.env.local` with the correct Team ID

3. **Common causes of this error:**

   **A. You belong to multiple Apple Developer teams**
   - Your certificate belongs to Team A, but you're using Team B's ID
   - Run: `security find-identity -v -p codesigning`
   - Look for the Team ID in the certificate name (OU field)
   - Use that Team ID in `.env.local`

   **B. Wrong Apple ID**
   - The certificate was created under a different Apple ID
   - Use the Apple ID that matches the certificate's team

   **C. Insufficient permissions**
   - Your role must be "Admin" or "Account Holder"
   - Check at: https://developer.apple.com/account/#!/membership/
   - If you're just a "Member", ask the Account Holder to upgrade your role

   **D. App-specific password issues**
   - Password expired or incorrect
   - Generate new one at: https://appleid.apple.com
   - Update `APPLE_APP_SPECIFIC_PASSWORD` in `.env.local`
   - Format must be: `xxxx-xxxx-xxxx-xxxx` (with dashes)

4. **Rebuild after fixing**:
   ```bash
   npm run package
   ```

**Important**: The Team ID must match the team that owns your Developer ID certificate. The error "403 Invalid team ID" means Apple can't find that Team ID associated with your Apple ID, or you don't have permission to use it for notarization.

### "The app can't be opened because it is from an unidentified developer"

**Cause**: App is not properly signed or notarized.

**Solution**:
1. Verify your Developer ID certificate is installed in Keychain
2. Check that `.env.local` has correct credentials
3. Rebuild with `npm run package`

### Notarization Fails

**Check notarization status**:
```bash
xcrun notarytool history --apple-id "your@email.com" --team-id "ABC123XYZ"
```

**Get detailed error**:
```bash
xcrun notarytool log <submission-id> --apple-id "your@email.com" --team-id "ABC123XYZ"
```

Common issues:
- Incorrect app-specific password → regenerate at appleid.apple.com
- Missing entitlements → check build/entitlements.mac.plist
- Unsigned libraries → check that all dependencies are signed

### "App is damaged and can't be opened"

**Cause**: Quarantine attribute from downloading unsigned app.

**Temporary fix** (for testing only):
```bash
xattr -cr /Applications/Audit\ Magic.app
```

**Proper fix**: Always download notarized DMG from official source.

## Distribution

### For End Users

**Recommended**: Distribute the notarized DMG file:
- File: `dist/Audit Magic-1.0.3.dmg`
- Users can double-click to install
- macOS will verify notarization automatically

### Auto-Updates

The app includes auto-update functionality via GitHub releases:
1. Tag a release on GitHub
2. Upload the DMG and ZIP files
3. Users will be notified of updates automatically

## Security Best Practices

1. **Never share** your app-specific password
2. **Never commit** `.env.local` to version control
3. **Rotate passwords** periodically
4. **Keep certificates** backed up securely
5. **Test installations** on a clean Mac before distributing

## References

- [Apple Notarization Guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [electron-builder Code Signing](https://www.electron.build/code-signing)
- [Hardened Runtime Entitlements](https://developer.apple.com/documentation/bundleresources/entitlements)

## Support

For issues with:
- Apple Developer Account → https://developer.apple.com/support
- Electron Builder → https://github.com/electron-userland/electron-builder/issues
- App-specific issues → Create an issue in this repository
