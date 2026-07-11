# Email Sync QA Methodology

End-to-end verification that Keepr correctly fetches emails from a provider,
stores them locally, and auto-links them to the right transactions.

Used originally to reproduce **BACKLOG-1708** with named-email evidence during
the Sprint G PR review, and to verify the BACKLOG-1722 email_participants
junction migration end-to-end (G1, G4).

---

## Canonical acceptance standard (v2.20.0+)

> **Supersedes the legacy "G1 ≥58" threshold.** The founder standard is
> EXACT deterministic assertions, not minimum thresholds.

- **Corpus:** 190 emails.
- **Transaction under test (TX1):** 742 Birchwood Lane NE, Tumwater; audit
  window covering 2026-02-05 → 2026-04-14; the 9 documented contacts.
- **Required result:** TX1 must link **EXACTLY 69** emails filter-OFF and
  **EXACTLY 37** filter-ON. Any other count — higher or lower — is a FAIL.
- **Email-by-email list:** see [`tx1-canonical-list-v2.20.0.md`](./tx1-canonical-list-v2.20.0.md)
  for the canonical checklist of every expected email.

---

## Overview

The QA loop is:

```
1. Seed sandbox mailbox  ─►  scripts/qa/email/seed-m365.py
                              (posts .eml files into a real M365 mailbox
                               with MAPI extended properties for threading)
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
- **macOS system Python 3** — always invoke as `/usr/bin/python3`.
  pyenv / Homebrew Pythons are frequently compiled without SSL and will fail
  with `SSL: CERTIFICATE_VERIFY_FAILED` on any Graph call.  This has bitten
  us twice; use the Apple-shipped binary explicitly.
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
# Basic seeding — inbox/sentitems routing, no date shift
/usr/bin/python3 scripts/qa/email/seed-m365.py --corpus /path/to/corpus

# With date shift (shift all dates 6 months into the past relative to .eml headers)
/usr/bin/python3 scripts/qa/email/seed-m365.py \
    --corpus /path/to/corpus \
    --date-shift-months -6

# Full production run: wipe first, shift dates, set outbound sender
/usr/bin/python3 scripts/qa/email/seed-m365.py \
    --corpus /path/to/corpus \
    --wipe \
    --date-shift-months -3 \
    --outbound-sender sarah.mitchell@cascaderealty.com

# Wipe only (no seeding)
/usr/bin/python3 scripts/qa/email/seed-m365.py --wipe-only
```

The script:
- Walks the corpus directory, parsing each `.eml` file.
- Topologically sorts by reply chain (`"Re: X"` ⇒ parent `"X"`) so originals
  post before replies.
- Routes messages to **Sent Items** if the From address matches
  `--outbound-sender` (default: `sarah.mitchell@cascaderealty.com`), and to
  **Inbox** for everything else.  The old `--inbox-only` flag is removed; it
  accidentally defaulted to `/me/messages` (Drafts) when omitted.
- POSTs each message to the appropriate folder, capturing the Graph-assigned
  `internetMessageId`.
- For replies, sets `PR_IN_REPLY_TO_ID` (MAPI `String 0x1042`) and
  `PR_INTERNET_REFERENCES` (MAPI `String 0x1039`) via
  `singleValueExtendedProperties` so Graph groups them in the same
  conversation thread (verified live 2026-07-03).
- If `--date-shift-months` is non-zero, shifts each message's Date header by
  that many months and writes it to `PR_MESSAGE_DELIVERY_TIME`
  (`SystemTime 0x0E06`) and `PR_CLIENT_SUBMIT_TIME` (`SystemTime 0x0039`).
  Without this Graph stamps POST-time and all emails land "today", outside
  any audit date window.
- Preserves display names in From/To/Cc/Bcc (e.g. `"Sarah Mitchell
  <sarah.mitchell@cascaderealty.com>"`) so sender fidelity is maintained —
  critical for the BACKLOG-1708/BACKLOG-1722 junction refactor which stores
  names alongside addresses.
- Handles semicolon-separated recipient lists (some MUAs use `;` not `,`).
- Retries automatically on HTTP 429/503, honouring the `Retry-After` header.

**Why MAPI extended properties instead of internetMessageHeaders?**
Graph returns `400 InvalidInternetMessageHeader` for `In-Reply-To` and
`References` when set via `internetMessageHeaders` on a direct POST — only
`X-*` custom headers are permitted by the API.  The MAPI extended-property
approach (`singleValueExtendedProperties`) is the only supported mechanism
to set threading identity on injected messages.  See BACKLOG-1721.

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
2. Expected link counts are EXACT: 69 filter-OFF, 37 filter-ON (see the
   canonical acceptance standard above and `tx1-canonical-list-v2.20.0.md`).
3. Click into individual emails to confirm preview body renders before
   attaching (BACKLOG-1707 gate).
4. Try "Remove from transaction" on any thread email — should remove ALL
   sibling thread emails (BACKLOG-1718 / G8 gate). Then click Restore;
   the whole thread should reappear.

---

## Mapping to acceptance gates

| Gate | What this loop verifies | Step |
|------|-------------------------|------|
| G1   | EXACTLY 69 linked filter-OFF / EXACTLY 37 filter-ON on Agent@izzyrescue.org TX1 (canonical standard) | Steps 2 + 4 |
| G2   | Junction lookup distinct addresses (lisa ≠ alisa) | Tests + Step 3 |
| G3   | BCC-only search returns results | Step 3 (participants by role) |
| G4   | "Lisa Chen" inbound + outbound on both providers | Step 4 |
| G5   | EXPLAIN QUERY PLAN hits the participants index | Tests |
| G6   | 100k-row backfill < 60s, idempotent | Tests + Step 1 perf |
| G7   | Manual Attach preview body renders before attach | Step 4 |
| G8   | Remove-from-thread removes all siblings atomically | Step 4 |

---

## Troubleshooting

- **`urllib.error.URLError: SSL: CERTIFICATE_VERIFY_FAILED`** — you're using
  a pyenv or Homebrew Python compiled without SSL.  Always use
  `/usr/bin/python3` (Apple system Python) on macOS.
- **Graph returns `401 unauthorized`** — token expired; rerun the device-code
  flow.
- **Graph returns `400 InvalidInternetMessageHeader`** — an old version of
  the seed script is setting `In-Reply-To`/`References` via
  `internetMessageHeaders`.  Upgrade to the current script which uses MAPI
  `singleValueExtendedProperties` (String 0x1042/0x1039) instead.
- **All seeded emails land today (wrong dates)** — you didn't pass
  `--date-shift-months`.  Graph ignores `.eml` Date headers on POST and stamps
  the current time unless overridden via MAPI `SystemTime 0x0E06`/`0x0039`.
- **All seeded emails show as disconnected** — confirm the seed ran with the
  current threading path (MAPI 0x1042/0x1039, not `internetMessageHeaders`).
  Single-message conversations are the old behaviour.
- **Seeded messages land in Drafts** — old script defaulted to `/me/messages`
  (the Drafts folder) when `--inbox-only` was omitted.  Current script routes
  to inbox/sentitems by default; no extra flag needed.
- **Auto-link returns 0 even with filter OFF** — confirm migration v41 ran
  (`sqlite3 ... "SELECT version FROM schema_version"` should be ≥ 41).
- **Preview shows empty body in Attach modal** — confirm `getCachedEmails`
  SELECT includes `body_plain` + `body_html` (BACKLOG-1707).

## Provider cells + recursive wipe (BACKLOG-1851 / QA-H4)

This runbook is now productized by the harness at `scripts/qa/harness/` and split
into per-provider cells (founder decision 3: PER-PROVIDER manifests):

- **Outlook** — `seed-m365.py` (above), scenario `tx1-birchwood`, manifest
  `tx1-canonical-list-v2.20.0.md` (190/69/37).
- **Gmail** — `seed-gmail.py` (Gmail API `users.messages.insert`,
  `internalDateSource=dateHeader`, native In-Reply-To/References threading,
  INBOX/SENT labels), scenario `tx1-birchwood-gmail`, PROVISIONAL manifest
  `tx1-canonical-list-gmail-v2.20.0.md`. **GATED on the Google Workspace tenant
  (BACKLOG-1845):** with no `~/.keepr-qa/gmail-token.json` the cell reports GATED
  (non-fail), never FAILED. Pre-parity `gmailFetchService` gaps (no `$filter`-
  first, no existence-validation) are findings referencing BACKLOG-1806 — not
  harness/app bugs to fix here.

The deterministic seed core (`eml_corpus.py`) is unit-tested without a live
tenant (`npm run qa:py-test`): date-shift, base64url `raw`, threading headers,
label routing, and a reseed-idempotence check (same corpus → identical
`(subject, shifted-date)` multiset, absorbing BACKLOG-1807).

### Recursive wipe (all folders + `$search` = 0)

`seed-m365.py --wipe-only` clears only 4 well-known folders. For a true reset
that guarantees a reseed reproduces EXACTLY 190/69/37 with 0 ghosts, use
`wipe-mailbox-recursive.py`, which recurses **every** folder and verifies the
mailbox empty two ways (folder enumeration + a `$search` index probe). It is
guarded: it refuses unless `--confirm-mailbox <owner>` matches the token's
allowlisted QA mailbox — see `docs/qa/README.md` → "Email cells (H4)".
