# Email Sync QA Methodology

End-to-end verification that Keepr correctly fetches emails from a provider,
stores them locally, and auto-links them to the right transactions.

Used originally to reproduce **BACKLOG-1708** with named-email evidence during
the Sprint G PR review, and to verify the BACKLOG-1722 email_participants
junction migration end-to-end (G1, G4).

---

## Overview

The QA loop is:

```
1. Seed sandbox mailbox  ─►  scripts/qa/email/seed-m365.py
                              (posts .eml files into a real M365 mailbox
                               with In-Reply-To/References for threading)
2. Sync in Keepr         ─►  packaged DMG build, sign in as sandbox owner
3. Inspect local DB      ─►  scripts/qa/email/inspect-local-cache.sh
                              (counts emails + participants per address)
4. Verify auto-link      ─►  open transaction, confirm expected link count
```

Each step is independently runnable so you can iterate (e.g. delete corpus,
re-seed with different headers, re-sync without re-installing the app).

---

## Prerequisites

- **M365 dev tenant** with at least one mailbox you can use as a sandbox.
  We use `izzyrescue.org`, mailbox `Agent@izzyrescue.org`.
- **Azure CLI**: `brew install azure-cli`
- **Node.js 20+** (for the CDP driver in the corpus-build step)
- **macOS Python 3** at `/usr/bin/python3` (built-in — has SSL).
  pyenv Python *will not work* (compiled without SSL on most setups).
- **Keepr installed locally as a packaged DMG build** — *not* dev mode.
  Dev mode's ad-hoc-signed Electron breaks macOS TCC and OAuth flows.

---

## One-time setup

### 1. Create Azure app registration for Graph API access

```bash
az login --tenant <your-tenant.onmicrosoft.com> --allow-no-subscriptions

APP_ID=$(az ad app create \
  --display-name "Keepr QA Seed Script" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)
GRAPH="00000003-0000-0000-c000-000000000000"

# Delegated permissions: Mail.ReadWrite, Mail.Send, Contacts.ReadWrite, User.Read
az ad app permission add --id $APP_ID --api $GRAPH --api-permissions \
  024d486e-b451-40bb-833d-3e66d98c5c73=Scope \
  e383f46e-2787-4529-855e-0e479a3ffac0=Scope \
  ff74d97f-43af-4b68-9f2a-b77ee6968c5d=Scope \
  e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope

az ad app update --id $APP_ID \
  --is-fallback-public-client true \
  --public-client-redirect-uris "http://localhost"
az ad sp create --id $APP_ID
az ad app permission admin-consent --id $APP_ID
```

### 2. Acquire an OAuth token as the sandbox mailbox owner

```bash
TENANT_ID="<your-tenant-id>"

curl -s -X POST "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/devicecode" \
  -d "client_id=${APP_ID}" \
  --data-urlencode \
  "scope=Mail.ReadWrite Mail.Send Contacts.ReadWrite User.Read offline_access"
```

Open the `verification_uri` in an **Incognito** window (forces account picker),
sign in as the sandbox mailbox owner, then poll the token endpoint with the
`device_code` until you get a `bearer_token`. Save it to
`~/.keepr-qa/token.json` — the seed script reads it from there.

---

## Per-run loop

### Step 1: Seed the sandbox mailbox

```bash
python3 scripts/qa/email/seed-m365.py --corpus /path/to/corpus --inbox-only
```

The script:
- Walks the corpus directory, parsing each `.eml` file.
- Topologically sorts by reply chain (`"Re: X"` ⇒ parent `"X"`) so originals
  post before replies.
- POSTs each message to `/me/mailFolders/inbox/messages`, capturing the
  Graph-assigned `internetMessageId`.
- For replies, sets `In-Reply-To` and `References` to the parent's
  `internetMessageId` via `internetMessageHeaders`.
- Outlook groups them as a single conversation (matches real agent inbox).

Without these headers, Microsoft Graph assigns a new `conversationId` per
POST and reply chains show as disconnected emails. See BACKLOG-1721.

### Step 2: Sync in Keepr

1. Launch the packaged Keepr DMG build (NOT `npm run dev`).
2. Sign in with Microsoft OAuth as the sandbox mailbox owner.
3. Wait for the initial sync to finish (the contact list grows as emails
   arrive — count should match the corpus size).
4. (Optional) Toggle "Apply address filter to auto-link" OFF in Settings
   to exercise the BACKLOG-1544 path.

### Step 3: Inspect the local cache

```bash
scripts/qa/email/inspect-local-cache.sh Agent@izzyrescue.org
```

This wraps `sqlite3` against the live encrypted DB (read-only, no decryption
required for these counts). It reports:

- Total emails synced
- Count per-direction (inbound/outbound)
- Count of `email_participants` rows
- Counts grouped by participant address (helps spot drops)
- Sender vs participant cross-check (post-1722 these should agree
  modulo edge-case-parse errors)

### Step 4: Verify auto-link

1. Open the canonical test transaction (`TX1` in the Agent@izzyrescue.org
   sandbox).
2. Expected link counts come from the corpus (e.g. for the 742-Birchwood
   thread: 6 inbound smoking-gun emails plus 52 ambient mentions).
3. Click into individual emails to confirm preview body renders before
   attaching (BACKLOG-1707 gate).
4. Try "Remove from transaction" on any thread email — should remove ALL
   sibling thread emails (BACKLOG-1718 / G8 gate). Then click Restore;
   the whole thread should reappear.

---

## Mapping to acceptance gates

| Gate | What this loop verifies | Step |
|------|-------------------------|------|
| G1   | ≥58 emails linked filter-OFF on Agent@izzyrescue.org TX1 | Steps 2 + 4 |
| G2   | Junction lookup distinct addresses (lisa ≠ alisa) | Tests + Step 3 |
| G3   | BCC-only search returns results | Step 3 (participants by role) |
| G4   | "Lisa Chen" inbound + outbound on both providers | Step 4 |
| G5   | EXPLAIN QUERY PLAN hits the participants index | Tests |
| G6   | 100k-row backfill < 60s, idempotent | Tests + Step 1 perf |
| G7   | Manual Attach preview body renders before attach | Step 4 |
| G8   | Remove-from-thread removes all siblings atomically | Step 4 |

---

## Troubleshooting

- **`urllib.error.URLError: SSL: CERTIFICATE_VERIFY_FAILED`** — you're on
  pyenv Python. Use `/usr/bin/python3` (Apple-shipped).
- **Graph returns `401 unauthorized`** — token expired; rerun the device-code
  flow.
- **All seeded emails show as disconnected** — confirm the seed ran with the
  new `In-Reply-To`/`References` path (BACKLOG-1721). Single-message
  conversations are the old behavior.
- **Auto-link returns 0 even with filter OFF** — confirm migration v41 ran
  (`sqlite3 ... "SELECT version FROM schema_version"` should be ≥ 41).
- **Preview shows empty body in Attach modal** — confirm `getCachedEmails`
  SELECT includes `body_plain` + `body_html` (BACKLOG-1707).
