# Release Setup Guide

This document explains how to configure code signing and notarization for Keepr releases.

## Overview

The release workflow (`.github/workflows/release.yml`) handles:
- Building macOS packages (DMG, ZIP) with optional signing and notarization
- Building Windows packages (NSIS installer) with optional signing
- Publishing to GitHub Releases as a draft

## Required GitHub Secrets

Configure these secrets in your repository settings at:
`Settings` → `Secrets and variables` → `Actions` → `New repository secret`

### macOS Code Signing & Notarization

| Secret | Description | Required |
|--------|-------------|----------|
| `MACOS_CERTIFICATE` | Base64-encoded `.p12` certificate file | For signed builds |
| `MACOS_CERTIFICATE_PASSWORD` | Password for the certificate | For signed builds |
| `APPLE_ID` | Your Apple Developer email | For notarization |
| `APPLE_APP_PASSWORD` | App-specific password (NOT your Apple ID password) | For notarization |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID | For notarization |

### Windows Code Signing

| Secret | Description | Required |
|--------|-------------|----------|
| `WIN_CSC_LINK` | Base64-encoded `.pfx` certificate file | For signed builds |
| `WIN_CSC_KEY_PASSWORD` | Password for the certificate | For signed builds |

### App Environment Variables

These are required for the app to function (copied from your `.env.development`):

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `MICROSOFT_CLIENT_ID` | Microsoft/Azure app client ID |
| `MICROSOFT_TENANT_ID` | Microsoft/Azure tenant ID |
| `MICROSOFT_CLIENT_SECRET` | Microsoft/Azure client secret |

---

## macOS Setup

### 1. Get a Developer ID Certificate

1. Go to [Apple Developer Portal](https://developer.apple.com/account/resources/certificates/list)
2. Create a **Developer ID Application** certificate
3. Download and install it in your Keychain
4. Export it as a `.p12` file with a password

### 2. Convert Certificate to Base64

```bash
# Export your certificate from Keychain as a .p12 file, then:
base64 -i your-certificate.p12 | pbcopy
# This copies the base64 string to clipboard - paste as MACOS_CERTIFICATE secret
```

### 3. Create an App-Specific Password

1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Sign in → Security → App-Specific Passwords
3. Generate a new password for "Keepr CI"
4. Save this as `APPLE_APP_PASSWORD` secret

### 4. Find Your Team ID

```bash
# Option 1: From Keychain certificate
security find-identity -v -p codesigning | grep "Developer ID"
# The Team ID is in parentheses: "Developer ID Application: Your Name (TEAM_ID)"

# Option 2: From Apple Developer Portal
# Visit https://developer.apple.com/account → Membership → Team ID
```

### 5. Test Locally

Before setting up CI, verify your credentials work locally:

```bash
# Set environment variables
export APPLE_ID="your@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"

# Run the verification script
./scripts/verify-credentials.sh

# Build and sign
npm run package
```

---

## Windows Setup

### 1. Get a Code Signing Certificate

You need an **Extended Validation (EV)** or **Organization Validation (OV)** code signing certificate from a Certificate Authority like:
- DigiCert
- Sectigo (Comodo)
- GlobalSign

> **Note**: EV certificates provide immediate SmartScreen reputation but require hardware tokens.
> OV certificates are easier to use in CI but may trigger SmartScreen warnings initially.

### 2. Export Certificate as PFX

If you have an EV certificate on a hardware token, you'll need to work with your CA to export it.

For OV certificates:
```powershell
# Export from Windows Certificate Store
$cert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -like "*Your Company*" }
$password = ConvertTo-SecureString -String "YourPassword" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath "certificate.pfx" -Password $password
```

### 3. Convert Certificate to Base64

```powershell
# PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Set-Clipboard
# Paste as WIN_CSC_LINK secret
```

Or on macOS/Linux:
```bash
base64 -i certificate.pfx | pbcopy  # macOS
base64 certificate.pfx | xclip      # Linux
```

---

## Running a Release

### Automatic (on push to main)

When you merge a PR to `main`, the release workflow automatically:
1. Builds signed packages (if certificates are configured)
2. Creates a **draft** GitHub Release

Then:
1. Go to [Releases](https://github.com/5hdaniel/Mad/releases)
2. Review the draft release
3. Edit release notes if needed
4. Click "Publish release"

### Manual (workflow dispatch)

1. Go to Actions → Release workflow
2. Click "Run workflow"
3. Choose whether to publish immediately

---

## Troubleshooting

### macOS Notarization Fails

**Error: "Invalid credentials"**
- Verify APPLE_ID is correct
- Generate a new app-specific password
- Ensure APPLE_TEAM_ID matches your certificate's team

**Error: "The signature of the binary is invalid"**
- Certificate may be expired
- Entitlements may be misconfigured
- Try re-exporting the certificate

### Windows Signing Fails

**Error: "Cannot find certificate"**
- Verify WIN_CSC_LINK is valid base64
- Check password is correct
- Ensure certificate isn't expired

### Builds Work but Aren't Signed

If secrets aren't configured, the workflow gracefully falls back to unsigned builds. Check:
- Secrets are correctly named
- Secrets have values (not empty)
- Base64 encoding is correct (no line breaks)

---

## Security Notes

1. **Never commit certificates** - Always use GitHub Secrets
2. **Rotate app-specific passwords** periodically
3. **Use separate certificates** for CI and local development if possible
4. **Review draft releases** before publishing
