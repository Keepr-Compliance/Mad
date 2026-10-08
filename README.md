# Keepr

Real estate transaction compliance and audit platform. Keepr helps brokerages capture, organize, and verify all communications and documents tied to a transaction.

## Architecture

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop app | Electron + React 18 + TypeScript | Local message capture, iPhone backup sync, offline-first DB |
| Broker portal | Next.js (App Router) | Web dashboard for brokers to review submissions |
| Admin portal | Next.js | Internal admin tooling |
| Backend | Supabase (Postgres + Auth + Edge Functions) | Cloud sync, auth, RLS |
| Integrations | Microsoft Graph, Gmail API | Outlook and Gmail email fetching |

## Getting Started

### Prerequisites

- Node.js 20+
- macOS (primary) or Windows
- Supabase project (for cloud features)

### Installation

```bash
npm install
```

### Development

```bash
# Desktop app (Electron + React)
npm run dev

# Broker portal
npm run portal:dev

# Type checking
npm run type-check

# Tests
npm test          # full suite
npx jest path/to/file.test.ts   # single suite (does not touch node_modules)

# Lint
npm run lint
```

### Building

```bash
# Full production build (React + Electron + preload)
npm run build

# Package macOS DMG
npm run package

# Package Windows installer
npm run package:win

# Unsigned local build (no code signing)
npm run package:unsigned
```

## Environment Variables

Copy `.env.local.example` to `.env.local` and fill in your values. See `.env.production` for the production template.

### Desktop App (Electron)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anonymous/public key |
| `BROKER_PORTAL_URL` | No | Broker portal URL (default: `https://app.keeprcompliance.com`) |
| `MICROSOFT_CLIENT_ID` | No | Azure AD app registration client ID (Outlook integration) |
| `MICROSOFT_TENANT_ID` | No | Azure AD tenant (`common` for multi-tenant) |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID (Gmail integration) |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret |
| `GOOGLE_MAPS_API_KEY` | No | Google Maps/Places API key (address verification) |
| `SENTRY_DSN` | No | Sentry DSN for error tracking |
| `SENTRY_AUTH_TOKEN` | No | Sentry auth token (build-time source map upload) |

### macOS Code Signing & Notarization

| Variable | Description |
|----------|-------------|
| `APPLE_ID` | Apple Developer email |
| `APPLE_TEAM_ID` | 10-char Apple team ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |

### Broker Portal (Next.js)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server-side only) |
| `AZURE_TENANT_ID` | Azure AD tenant for email sending |
| `AZURE_CLIENT_ID` | Azure AD client ID for email sending |
| `AZURE_CLIENT_SECRET` | Azure AD client secret for email sending |
| `EMAIL_SENDER_ADDRESS` | From address for outbound emails |
| `INTERNAL_API_SECRET` | Shared secret for internal API routes |
| `IMPERSONATION_COOKIE_SECRET` | Cookie signing secret (falls back to service-role key) |
| `NEXT_PUBLIC_APP_URL` | Public app URL for invite links |
| `NEXT_PUBLIC_CLARITY_PROJECT_ID` | Microsoft Clarity analytics ID |

## Windows Build Notes

Windows packaging (`npm run package:win`) produces an NSIS installer. Code signing requires an EV (Extended Validation) code certificate. Without signing, Windows SmartScreen will warn users on first launch.

To sign Windows builds, configure these electron-builder environment variables:

- `WIN_CSC_LINK` - Path or URL to the `.pfx` certificate
- `WIN_CSC_KEY_PASSWORD` - Certificate password

See the [electron-builder code signing docs](https://www.electron.build/code-signing) for details.

## Native Module Troubleshooting

If you see `NODE_MODULE_VERSION` mismatch errors after install or Node.js upgrade:

```bash
npm rebuild better-sqlite3-multiple-ciphers
npx electron-rebuild
```

If that fails (common on Windows without Python):

```bash
cd node_modules/better-sqlite3-multiple-ciphers
npx prebuild-install --runtime=electron --target=$(npx electron --version) --arch=x64
```

## License

Copyright (c) 2024-2026 Blue Spaces LLC. All rights reserved.

This software and associated documentation files are the proprietary
property of Blue Spaces LLC.

No part of this software may be used, copied, modified, merged, published,
distributed, sublicensed, or sold without the express written permission
of Blue Spaces LLC.
