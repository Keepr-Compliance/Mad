# Google Places API Setup Guide

## Overview
This guide walks through setting up Google Places API for address verification in the Audit Transaction feature.

## Cost Analysis

### Free Tier (Generous!)
- **$200 free credit per month** (automatically applied)
- **Address Autocomplete**: ~$2.83 per 1,000 requests
- **Free allowance**: ~28,000 autocomplete requests/month
- **Typical agent usage**: 50-200 transactions/year = **FREE**

### Pricing Breakdown
| Service | Cost per 1,000 Requests | Free Monthly Allowance |
|---------|------------------------|------------------------|
| Autocomplete (per session) | $2.83 | ~70,000 |
| Place Details | $17 | ~11,000 |
| Geocoding | $5 | ~40,000 |

**For most real estate agents: Completely FREE**

## Setup Steps

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **"Create Project"** or select existing project
3. Name it: "Keepr" or similar
4. Click **Create**

### 2. Enable Required APIs

1. Go to **APIs & Services → Library**
2. Search and enable:
   - ✅ **Places API**
   - ✅ **Maps JavaScript API**
   - ✅ **Geocoding API**

### 3. Create API Key

1. Go to **APIs & Services → Credentials**
2. Click **+ CREATE CREDENTIALS → API Key**
3. Copy the API key (you'll need this)

### 4. Restrict API Key (IMPORTANT - Security!)

1. Click **Edit API Key** (pencil icon)
2. Under **API restrictions**:
   - Select **"Restrict key"**
   - Check:
     - ✅ Places API
     - ✅ Maps JavaScript API
     - ✅ Geocoding API
3. Under **Application restrictions**:
   - For development: Choose **"None"**
   - For production: Choose **"HTTP referrers"** and add your domains

### 5. Enable Billing (Required for Free Tier)

⚠️ **You MUST enable billing to use the API**, but you'll still get $200 free credit!

1. Go to **Billing** in Google Cloud Console
2. Link a payment method (credit card)
3. Set up budget alerts:
   - Click **Budgets & alerts**
   - Create budget: $10/month (will alert if you exceed free tier)
   - Add alert at 50%, 90%, 100%

**Don't worry:** With the free tier, you won't be charged unless you exceed it.

## Where the key lives (BACKLOG-3834)

The desktop app does **not** hold a Google key. Address lookups go to the
`maps-proxy` Supabase Edge Function with the signed-in user's session; the
function reads the key from the server-only secret `GOOGLE_MAPS_SERVER_KEY`.
Never put a Maps key in `.env.production` or any other file that ships with the
app: `scripts/ci/check-packaged-secrets.mjs` fails the release if one appears.

Restrict the server key to the Places API and the Geocoding API, and set
per-API daily quotas — that quota is the hard ceiling on spend.

## Alternative Free Options

If you want to avoid Google entirely:

### 1. OpenStreetMap Nominatim (Completely Free)
- **Pros**: Free, no API key needed
- **Cons**: Rate limited (1 req/sec), less accurate
- **URL**: https://nominatim.openstreetmap.org/

### 2. Mapbox Geocoding (Free Tier)
- **Free tier**: 100,000 requests/month
- **Pros**: Good accuracy, generous free tier
- **Cons**: Requires account/API key
- **URL**: https://www.mapbox.com/

### 3. HERE Geocoding (Free Tier)
- **Free tier**: 250,000 transactions/month
- **Pros**: Very generous free tier
- **Cons**: Requires account/API key
- **URL**: https://developer.here.com/

## Recommendation

**Use Google Places API** because:
✅ Best accuracy for US addresses
✅ $200/month free credit is plenty
✅ Industry standard
✅ Most reliable autocomplete
✅ Includes structured address components
✅ Already widely trusted

For a real estate agent creating 50-200 transactions/year, you'll **never exceed the free tier**.

## Security Best Practices

1. ✅ **Restrict API key** to specific APIs
2. ✅ **Set up budget alerts** ($10/month threshold)
3. ✅ **Never commit API key** to git
4. ✅ **Use environment variables** or encrypted storage
5. ✅ **Monitor usage** in Google Cloud Console

## Next Steps

Once you have your API key, you can implement it in the app using the AddressVerificationService I'll create next.
