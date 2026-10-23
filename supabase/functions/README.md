# Supabase Edge Functions

Edge Functions run on Deno Deploy and provide secure server-side functionality for the Mad application.

## Available Functions

### `send-ticket-confirmation`
Sends a confirmation email when a new support ticket is created. Triggered automatically by a database webhook (pg_net) on `support_tickets` INSERT.

**Features:**
- Server-side trigger ensures ALL ticket sources receive confirmation emails
- Calls the broker portal's existing `/api/email/ticket-confirmation` endpoint
- Fire-and-forget: never blocks the ticket insert
- Authenticated via `INTERNAL_API_SECRET` header

**Required Secrets:**
```bash
supabase secrets set BROKER_PORTAL_URL=https://app.keeprcompliance.com
supabase secrets set INTERNAL_API_SECRET=your-internal-api-secret
```

**Task:** BACKLOG-1573

## Deployment

### Prerequisites

1. **Install Supabase CLI:**
   ```bash
   # macOS
   brew install supabase/tap/supabase

   # Or npm
   npm install -g supabase
   ```

2. **Login to Supabase:**
   ```bash
   supabase login
   ```

3. **Link to your project:**
   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   ```
   (Find your project ref in Supabase Dashboard > Settings > General)

### Set Secrets

Before deploying, set the secrets the function needs:

```bash
supabase secrets set NAME=value
```

Verify secrets are set:
```bash
supabase secrets list
```

### Deploy Functions

#### Deploy All Functions
```bash
supabase functions deploy
```

#### Deploy Specific Function
```bash
supabase functions deploy <function-name>
```

#### Deploy with Debug Output
```bash
supabase functions deploy <function-name> --debug
```

## Local Development

### Serve Functions Locally

1. **Start Supabase locally:**
   ```bash
   supabase start
   ```

2. **Serve a specific function:**
   ```bash
   supabase functions serve <function-name>
   ```

3. **Set local secrets:**
   Create a `.env` file in the function directory:
   ```bash
   echo "NAME=value" > supabase/functions/.env
   ```

### Test Function Locally

```bash
curl -i --location --request POST 'http://localhost:54321/functions/v1/<function-name>' \
  --header 'Authorization: Bearer YOUR_ANON_KEY' \
  --header 'Content-Type: application/json' \
  --data '{}'
```

## Monitoring

### View Logs

```bash
# Real-time logs
supabase functions logs <function-name> --tail

# Historical logs
supabase functions logs <function-name>
```

### Check Function Status

In Supabase Dashboard:
1. Go to "Edge Functions"
2. Click on function name
3. View metrics, logs, and invocations

## Troubleshooting

### Function Not Found
- Verify deployment: `supabase functions list`
- Check project link: `supabase projects list`

### 401 Unauthorized
- Check Authorization header includes valid Supabase key
- Verify RLS policies allow access

### 500 Internal Server Error
- Check function logs: `supabase functions logs <function-name>`
- Verify secrets are set: `supabase secrets list`

## Future Functions

Planned Edge Functions:
- `address-autocomplete` - Google Places autocomplete
- `send-export-email` - Email exports via SendGrid
- `analyze-communication` - AI-powered data extraction (OpenAI)
