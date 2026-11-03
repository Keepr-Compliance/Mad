# Mad Application - Setup Guide

This guide will walk you through setting up all the required accounts and API keys for the Mad application.

## Overview

The Mad application uses:
- **Supabase**: Cloud database and backend services
- **Google OAuth**: User authentication and Gmail access
- **Microsoft OAuth**: User authentication and Outlook access
- **Google Maps API**: Address validation and geocoding

## Phase 1: Supabase Setup (Cloud Database)

### Step 1: Create Supabase Account

1. Go to [https://supabase.com](https://supabase.com)
2. Click "Start your project" or "Sign up"
3. Sign up with GitHub (recommended) or email
4. Verify your email if required

### Step 2: Create New Project

1. Click "New Project" in your Supabase dashboard
2. Choose your organization (or create one)
3. Fill in project details:
   - **Name**: `mad-production` (or your preferred name)
   - **Database Password**: Generate a strong password (save this!)
   - **Region**: Choose `US West (Oregon)` or closest to your users
   - **Pricing Plan**: Start with "Free" tier
4. Click "Create new project"
5. Wait 2-3 minutes for project to initialize

### Step 3: Get Supabase Credentials

1. In your project dashboard, click "Settings" (gear icon) in the left sidebar
2. Click "API" under Project Settings
3. You'll need these values:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: `eyJhbGc...` (starts with eyJ)
   - **service_role key**: `eyJhbGc...` (starts with eyJ, different from anon)

**IMPORTANT**: The `service_role` key bypasses Row Level Security - keep it secret!

### Step 4: Run Database Schema

1. In Supabase dashboard, click "SQL Editor" in the left sidebar
2. Click "New query"
3. Open the file `docs/sql/supabase_schema.sql` from this project
4. Copy the entire contents
5. Paste into the Supabase SQL Editor
6. Click "Run" (or press Ctrl/Cmd + Enter)
7. You should see "Success. No rows returned"
8. Click "Tables" in the left sidebar to verify tables were created:
   - users
   - licenses
   - devices
   - analytics_events
   - user_preferences
   - api_usage

---

## Phase 2: Google Cloud Setup (OAuth & Maps)

### Step 1: Create Google Cloud Project

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com)
2. Sign in with your Google account
3. Click the project dropdown (top left, next to "Google Cloud")
4. Click "NEW PROJECT"
5. Enter project details:
   - **Project name**: `mad-app`
   - **Organization**: (leave default or select your org)
6. Click "CREATE"
7. Wait for project creation, then select it from the project dropdown

### Step 2: Enable Required APIs

1. In the Google Cloud Console, go to "APIs & Services" > "Library"
2. Search for and enable each of these APIs (click "ENABLE" for each):
   - **Google Identity Services API** (for OAuth login)
   - **Gmail API** (for email access)
   - **Geocoding API** (for address validation)
   - **Places API** (for address autocomplete)

### Step 3: Configure OAuth Consent Screen

1. Go to "APIs & Services" > "OAuth consent screen"
2. Select **External** user type, click "CREATE"
3. Fill in the required fields:
   - **App name**: `Mad`
   - **User support email**: Your email
   - **Developer contact email**: Your email
   - **App logo**: (optional, can add later)
4. Click "SAVE AND CONTINUE"
5. On "Scopes" page:
   - Click "ADD OR REMOVE SCOPES"
   - Search for and add:
     - `openid`
     - `email`
     - `profile`
     - `gmail.readonly`
   - Click "UPDATE", then "SAVE AND CONTINUE"
6. On "Test users" page:
   - Click "+ ADD USERS"
   - Add your email address and any testers
   - **IMPORTANT**: While your app is in "Testing" mode, ONLY users added here can sign in
   - Add all users who will test the app (e.g., <your-google-account>, support@keeprcompliance.com)
   - Click "SAVE AND CONTINUE"
7. Click "BACK TO DASHBOARD"

**⚠️ Common Issue**: If users get "Error 403: access_denied" when signing in, they need to be added as test users. See `GOOGLE_OAUTH_SETUP.md` for detailed troubleshooting.

### Step 4: Create OAuth Credentials

1. Go to "APIs & Services" > "Credentials"
2. Click "+ CREATE CREDENTIALS" > "OAuth client ID"
3. Select **Desktop app** as application type
4. **Name**: `Mad Desktop App`
5. Click "CREATE"
6. A popup will show your credentials - **SAVE THESE**:
   - **Client ID**: `xxxxx.apps.googleusercontent.com`
   - **Client Secret**: `GOCSPX-xxxxx`
7. Click "OK"

### Step 5: Get Google Maps API Key

1. Still in "Credentials" page
2. Click "+ CREATE CREDENTIALS" > "API key"
3. Copy the API key that appears
4. Click "RESTRICT KEY" (recommended for security)
5. **Name**: `Mad Maps API Key`
6. Under "API restrictions":
   - Select "Restrict key"
   - Check only:
     - Geocoding API
     - Places API
7. Click "SAVE"

**IMPORTANT**: This Maps API key should be stored in Supabase Secrets, NOT in your app!

---

## Phase 3: Microsoft Azure Setup (OAuth)

### Step 1: Create Azure Account

1. Go to [https://portal.azure.com](https://portal.azure.com)
2. Sign in with your Microsoft account
3. If first time, you may need to sign up for Azure (free tier available)

### Step 2: Register Application

1. In Azure Portal, search for "Azure Active Directory" or "Microsoft Entra ID"
2. Click on it
3. In the left menu, click "App registrations"
4. Click "+ New registration"
5. Fill in the form:
   - **Name**: `Mad Desktop App`
   - **Supported account types**: Select "Accounts in any organizational directory and personal Microsoft accounts"
   - **Redirect URI**: Leave blank (we'll use device code flow)
6. Click "Register"

### Step 3: Get Application Credentials

1. On the app overview page, copy these values:
   - **Application (client) ID**: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
   - **Directory (tenant) ID**: (should be "common" or a specific tenant ID)

### Step 4: Create Client Secret

1. In the left menu, click "Certificates & secrets"
2. Click "+ New client secret"
3. **Description**: `Mad Desktop Client Secret`
4. **Expires**: Choose "24 months" or longer
5. Click "Add"
6. **IMMEDIATELY COPY** the "Value" - you won't be able to see it again!
   - **Client Secret**: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### Step 5: Configure API Permissions

1. In the left menu, click "API permissions"
2. Click "+ Add a permission"
3. Select "Microsoft Graph"
4. Select "Delegated permissions"
5. Search for and add:
   - `User.Read`
   - `Mail.Read`
   - `openid`
   - `email`
   - `profile`
6. Click "Add permissions"
7. *Optional*: Click "Grant admin consent for [your tenant]" if you have admin rights

---

## Phase 4: Configure Environment Variables

### Step 1: Create Local Environment File

1. In your project root, create a file named `.env.development`
2. Copy the contents from `.env.example`
3. Fill in all your credentials:

```bash
# Google OAuth (PKCE + client_secret — Google requires secret for all app types)
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx

# Microsoft OAuth
MICROSOFT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_TENANT_ID=common
MICROSOFT_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_KEY=eyJhbGc...

# App Config
NODE_ENV=development
APP_VERSION=1.0.7
```

### Step 2: Store Google Maps Key in Supabase Secrets

The Maps API key should NOT be in your Electron app. Instead, store it in Supabase:

1. Install Supabase CLI (if not already installed):
   ```bash
   # macOS
   brew install supabase/tap/supabase

   # Or npm
   npm install -g supabase
   ```

2. Login to Supabase:
   ```bash
   supabase login
   ```

3. Link your project:
   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   ```
   (Find your project ref in Supabase dashboard under Settings > General)

4. Set the Maps API key as a secret:
   ```bash
   supabase secrets set GOOGLE_MAPS_API_KEY=your-google-maps-api-key
   ```

---

## Phase 5: Verify Setup

### Check 1: Environment Variables

Run this command to verify your .env file is loaded:
```bash
node -e "require('dotenv').config({path: '.env.development'}); console.log('Supabase URL:', process.env.SUPABASE_URL)"
```

You should see your Supabase URL printed.

### Check 2: Supabase Connection

Test the connection to Supabase (we'll add this test file):
```bash
npm run test:supabase
```

### Check 3: Google OAuth Flow

Test Google OAuth (manual test during development):
1. Start the app: `npm run dev`
2. Click "Sign in with Google"
3. Follow the device code flow
4. Verify you can login successfully

### Check 4: Microsoft OAuth Flow

Test Microsoft OAuth:
1. Click "Sign in with Microsoft"
2. Follow the device code flow
3. Verify you can login successfully

---

## Security Checklist

Before deploying to production:

- [ ] `.env.development` and `.env.production` are in `.gitignore`
- [ ] Never commit actual credentials to git
- [ ] Google Maps API key is restricted to specific APIs
- [ ] Supabase service_role key is kept secret
- [ ] Microsoft client secret is stored securely
- [ ] OAuth redirect URIs are properly configured
- [ ] Test users are added to Google OAuth consent screen (for testing)
- [ ] Row Level Security is enabled in Supabase

---

## Cost Estimates

### Free Tier Limits

- **Supabase**: 500MB database, 2GB bandwidth, 50K users
- **Google Maps**: $200/month free credit (~40,000 address validations)
- **Google OAuth**: Free (no limits)
- **Microsoft OAuth**: Free (no limits)

### When You'll Need to Pay

- **Supabase**: After 500MB of data or 2GB bandwidth
- **Google Maps**: After using $200/month credit
- **Stripe** (future): If you add payment processing for subscriptions

---

## Troubleshooting

### Supabase Connection Fails

- Verify the URL and keys are correct
- Check if you're using the service_role key (not anon key) in backend
- Ensure your IP is not blocked (check Supabase dashboard)

### Google OAuth Not Working

**Error 403: "The developer hasn't given you access to this app"**
- ✅ **Solution**: Add the user to test users list in OAuth consent screen
- See detailed guide: `GOOGLE_OAUTH_SETUP.md`

**Other Issues:**
- Verify app is in "Testing" mode with test users added
- Check that required APIs are enabled
- Ensure scopes match what you requested in consent screen
- For detailed troubleshooting, see `GOOGLE_OAUTH_SETUP.md`

### Microsoft OAuth Fails

- Verify tenant ID is "common" for personal accounts
- Check that API permissions are granted
- Ensure client secret hasn't expired

### Database Tables Not Created

- Re-run the `docs/sql/supabase_schema.sql` in Supabase SQL Editor
- Check for error messages in the SQL editor
- Verify you have CREATE TABLE permissions

---

## Next Steps

Once setup is complete:

1. **Phase 2**: We'll install Supabase client and create services
2. **Phase 3**: Implement Google OAuth login flow
3. **Phase 4**: Refactor Microsoft OAuth to new architecture
4. **Phase 5**: Add session management and user profiles
5. **Phase 6-10**: Build transaction system, export generation, and polish

---

## Support

If you encounter issues:

1. Check this guide first
2. Review error messages carefully
3. Search for similar issues in Google/Stack Overflow
4. Ask Claude for help with specific error messages
5. Check provider documentation:
   - [Supabase Docs](https://supabase.com/docs)
   - [Google OAuth Docs](https://developers.google.com/identity/protocols/oauth2)
   - [Microsoft OAuth Docs](https://learn.microsoft.com/en-us/azure/active-directory/develop/)

---

**Last Updated**: 2025-11-16
**Version**: 1.0
