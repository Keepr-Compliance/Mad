# Google OAuth Setup & Troubleshooting Guide

## Error 403: access_denied - The developer hasn't given you access

This error occurs when your Google OAuth app is in **Testing mode** and the user trying to sign in is not in the test users list.

---

## Quick Fix: Add Test Users

### Step 1: Access Google Cloud Console

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com)
2. Sign in with the Google account that owns the project
3. Select your project from the dropdown (top left)
   - Look for project with client ID: `892134553674-0vc87dp5oseka55i7rgi37oo5phmfjem.apps.googleusercontent.com`

### Step 2: Add Test Users

1. Navigate to **APIs & Services** → **OAuth consent screen** (left sidebar)
2. Scroll down to the **Test users** section
3. Click **+ ADD USERS**
4. Enter email addresses (one per line):
   ```
   danielxhaim@gmail.com
   support@keeprcompliance.com
   [add other users here]
   ```
5. Click **SAVE**

### Step 3: Test the Fix

1. Wait 1-2 minutes for changes to propagate
2. Try signing in again with the added email
3. You should now be able to authenticate successfully

---

## Understanding OAuth Publishing Status

### Testing Mode (Current State)

- **Limitations**: Only explicitly added test users can sign in
- **Max Test Users**: 100
- **Verification Required**: No
- **Best For**: Development and testing with known users

### Production Mode (Published)

- **Limitations**: None - any Google user can sign in
- **Verification Required**: Yes (for sensitive/restricted scopes)
- **Best For**: Public release

---

## Publishing Your App (Optional - For Public Access)

If you want to allow **any** Google user to sign in (not just test users):

### Option A: Publish Without Verification (Shows "Unverified App" Warning)

1. Go to **APIs & Services** → **OAuth consent screen**
2. Click **PUBLISH APP**
3. Confirm the dialog
4. ⚠️ Users will see: "This app hasn't been verified by Google"
5. Users can still proceed by clicking "Advanced" → "Go to [App Name] (unsafe)"

**Note**: This is acceptable for internal tools or small user bases, but not ideal for public-facing apps.

### Option B: Submit for Verification (Recommended for Production)

To remove the "unverified" warning and make your app fully public:

1. Go to **APIs & Services** → **OAuth consent screen**
2. Ensure all required information is filled:
   - ✅ App name, logo, support email
   - ✅ Privacy Policy URL
   - ✅ Terms of Service URL
   - ✅ Authorized domains
3. Click **PUBLISH APP**
4. Click **Submit for Verification**
5. Complete the verification form:
   - Explain why you need Gmail API access
   - Provide video demonstration
   - List where scopes are used in your app
6. Wait 2-10 business days for Google review

**Verification Requirements for Gmail API (`gmail.readonly` scope):**
- Valid privacy policy
- Valid terms of service
- Video showing OAuth consent flow
- Explanation of data usage
- Screenshots of your app

---

## Checking Your Current OAuth Configuration

### Verify OAuth Consent Screen Settings

1. Go to **APIs & Services** → **OAuth consent screen**
2. Check the **Publishing status**:
   - 🟡 **Testing**: Only test users can access
   - 🟢 **In production**: Anyone can access (may show unverified warning)
   - 🔵 **Verified**: Fully verified by Google
3. Review the scopes you've configured:
   - `openid`
   - `email`
   - `profile`
   - `https://www.googleapis.com/auth/gmail.readonly` ⚠️ Sensitive scope

### Verify OAuth Credentials

1. Go to **APIs & Services** → **Credentials**
2. Find your OAuth 2.0 Client ID (should be **Desktop app** type)
3. Click on it to view details
4. **Important**: Check the **Authorized redirect URIs**
   - For desktop apps using device code flow, this should be empty or set to:
     - `urn:ietf:wg:oauth:2.0:oob` (legacy)
     - `http://localhost` (recommended)
   - ⚠️ If you see `http://localhost:3001/callback`, this might cause issues

### Fix Redirect URI Issues (If Applicable)

If you see `http://localhost:3001/callback` in your OAuth credentials:

1. The error message shows this URI, but it's not in the code
2. This suggests you might have created a **Web application** instead of **Desktop app**
3. To fix:
   - Create a new OAuth client of type **Desktop app**
   - Update your `.env.development` with the new client ID and secret
   - OR modify the existing credential to remove redirect URIs

---

## Recommended Configuration for This App

Based on your code (`electron/services/googleAuthService.js`), the app uses:

### OAuth Client Type
- ✅ **Desktop app** (not Web application)
- ✅ Redirect URI: `urn:ietf:wg:oauth:2.0:oob`

### Required Scopes

**For Login (Step 1 - Minimal Scopes):**
```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

**For Mailbox Access (Step 2 - Incremental Consent):**
```
https://www.googleapis.com/auth/gmail.readonly
```

### OAuth Consent Screen Configuration

1. **App Information**
   - App name: `Mad`
   - User support email: `support@keeprcompliance.com`
   - Developer contact: `support@keeprcompliance.com`

2. **Scopes** (add all of these):
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `.../auth/gmail.readonly` ⚠️ Sensitive

3. **Test Users** (while in Testing mode):
   - Add all developers and testers
   - Maximum 100 users

---

## Troubleshooting Common Issues

### Issue 1: "Error 403: access_denied"

**Cause**: User not in test users list (app in Testing mode)

**Solution**: Add user to test users list (see Quick Fix above)

---

### Issue 2: "Redirect URI mismatch"

**Cause**: OAuth credentials configured for wrong application type

**Symptoms**:
- Error shows `redirect_uri: http://localhost:3001/callback`
- But code uses `urn:ietf:wg:oauth:2.0:oob`

**Solution**:
1. Check OAuth credential type in Google Cloud Console
2. Should be **Desktop app**, not Web application
3. If wrong type:
   - Delete the existing credential
   - Create new **Desktop app** credential
   - Update `.env.development` with new values

---

### Issue 3: "The app hasn't been verified by Google"

**Cause**: App is published but not verified (using sensitive scopes)

**Solution**: This is expected for unpublished apps. Options:
1. Keep in Testing mode with test users (development)
2. Publish unverified (users see warning but can proceed)
3. Submit for verification (production-ready)

---

### Issue 4: "Invalid client" error

**Cause**: Client ID is incorrect

**Solution**:
1. Verify credentials in `.env.development`:
   ```bash
   GOOGLE_CLIENT_ID=892134553674-0vc87dp5oseka55i7rgi37oo5phmfjem.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx
   ```
2. Copy exact values from Google Cloud Console → Credentials
3. Ensure no extra spaces or line breaks

---

## Testing Your OAuth Flow

### Test Login Flow (Minimal Scopes)

```bash
# Start the app
npm run dev

# Click "Sign in with Google"
# Expected: Browser opens with Google login
# Expected: Shows consent screen for email, profile
# Expected: After consent, redirects back to app
# Expected: User is logged in
```

### Test Mailbox Connection (Gmail Scope)

```bash
# After login, click "Connect Gmail" or similar
# Expected: Browser opens for incremental consent
# Expected: Shows Gmail read-only permission request
# Expected: After consent, mailbox is connected
```

---

## When to Keep Testing Mode vs Publish

### Keep in Testing Mode If:
- ✅ Still in development
- ✅ Only internal team needs access
- ✅ Fewer than 100 users
- ✅ Not ready for public launch

### Publish to Production If:
- ✅ Ready for public use
- ✅ More than 100 users
- ✅ Want to remove test user restrictions
- ✅ Have completed verification (or accept "unverified" warning)

---

## Security Best Practices

### 1. Limit Scopes
Only request the scopes you actually need:
- ✅ Start with minimal scopes (email, profile)
- ✅ Use incremental consent for Gmail
- ❌ Don't request all scopes upfront

### 2. Protect Credentials
```bash
# Never commit these to git
GOOGLE_CLIENT_ID=xxxxx
GOOGLE_CLIENT_SECRET=xxxxx

# Ensure .env.development is in .gitignore
```

### 3. Use Appropriate OAuth Flow
- ✅ Desktop app → Device code flow or loopback
- ❌ Don't use web app flow for desktop apps

### 4. Handle Token Refresh
- ✅ Store refresh tokens securely
- ✅ Automatically refresh expired access tokens
- ✅ Handle token revocation gracefully

---

## Quick Reference: Where to Find Things

### Google Cloud Console
- **Project Dashboard**: https://console.cloud.google.com
- **OAuth Consent Screen**: APIs & Services → OAuth consent screen
- **Credentials**: APIs & Services → Credentials
- **API Library**: APIs & Services → Library
- **Enabled APIs**: APIs & Services → Enabled APIs

### Current Configuration (From Error)
- **Client ID**: `892134553674-0vc87dp5oseka55i7rgi37oo5phmfjem.apps.googleusercontent.com`
- **Scope**: `https://www.googleapis.com/auth/gmail.readonly`
- **Support Email**: `support@keeprcompliance.com`
- **Redirect URI**: `http://localhost:3001/callback` ⚠️ May need review

---

## Next Steps

### Immediate Actions (To Fix Current Error):
1. ✅ Add `danielxhaim@gmail.com` to test users
2. ✅ Verify OAuth credential is **Desktop app** type
3. ✅ Test login flow again

### Before Production Launch:
1. ⏳ Create privacy policy
2. ⏳ Create terms of service
3. ⏳ Submit for Google verification
4. ⏳ Test with multiple users
5. ⏳ Set up error monitoring

---

## Support Resources

- [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [OAuth Consent Screen Help](https://support.google.com/cloud/answer/10311615)
- [App Verification Process](https://support.google.com/cloud/answer/9110914)
- [Gmail API Scopes](https://developers.google.com/gmail/api/auth/scopes)

---

**Last Updated**: 2025-11-18
**Issue**: Error 403: access_denied
**Status**: Documented fix - add test users
