# Keepr for Google Messages — Chrome Web Store

The source of truth for the store listing, the privacy practices form and the
review notes. Built from the BACKLOG-3640 readiness plan and the Limited Use
mapping. Keep it in step with `manifest.json` and with what the code does.
This file is not shipped: `scripts/package-extension.mjs` leaves it out of the
store zip.

## 1. Identity

| Field | Value |
|---|---|
| Name | Keepr for Google Messages |
| Publisher | Keepr Compliance |
| Category | Productivity |
| Version | the `version` in `manifest.json` (the store zip carries the same) |
| Extension id | assigned by the store. The source manifest keeps a `key` for a stable development id; `npm run package:extension` removes it from the zip. |
| Package | `npm run package:extension` → `release/keepr-extension-<version>.zip` |
| Privacy policy | https://keeprcompliance.com/privacy |
| Website / support | https://keeprcompliance.com |

## 2. Single purpose

> Copy your Google Messages for Web texts into the Keepr desktop app on your
> own computer, when you start a Sync in Keepr, so they are kept with your
> real estate transaction records.

Everything in the extension serves that one purpose: reading the
conversations on messages.google.com during a Sync the user started, sending
them to the Keepr app on the same computer, the per-chat on/off switch (the
eye), and linking the extension with that Keepr app.

## 3. Permissions — justification for each

| Permission / host | Why it is needed |
|---|---|
| `storage` | Small settings only, never message content: `storage.local` keeps the time of the last Sync and where the user dragged the Sync box and the link guide on the page; `storage.session` keeps when the extension last told Keepr it is installed (cleared when the browser closes). The link window's state is kept in memory only. The link key with Keepr is a non-extractable WebCrypto key kept in the extension's IndexedDB (never readable, never sent). |
| `https://messages.google.com/*` (host) and the content scripts on `https://messages.google.com/web/*` | The extension's only website. During a Sync the user started in Keepr, it reads the open conversations on Google Messages for Web and shows its Sync box and the per-chat eye there. It never changes, sends or deletes a message. |
| `http://127.0.0.1:38619/*` (host) | The Keepr desktop app on the same computer. Texts are sent only there — never to a server. Every request and reply is signed with a key agreed when the user links the extension with Keepr (a 6-digit code typed in Keepr), so no other local program can take or forge them. |
| `chrome.tabs` / `chrome.windows` APIs (no `tabs` permission requested) | Used only on Google Messages tabs (covered by the host permission): find or open the Google Messages tab when the user clicks Sync or "Go to Google Messages", bring that window forward, keep the tab from being discarded while a Sync runs, and open the link window. The extension never reads the URL or title of any other tab. |
| `commands` (Alt+Shift+E) | Keyboard shortcut for the eye: switches syncing off or on for the selected chat. |

- No remote code: every script ships in the package (the vendored @noble
  cryptography is bundled and recorded in `vendor/SBOM.json`).
- No `<all_urls>`, no `cookies`, no `webRequest`, no `history`, no `identity`.

## 4. Data use — the privacy practices form

### What the extension handles

| Data type (store form) | Handled? | What exactly |
|---|---|---|
| Personal communications | Yes | Text messages, the images in them and reactions, from the conversations read during a Sync. |
| Personally identifiable information | Yes | Names and phone numbers of the people in those conversations, as Google Messages shows them. |
| Website content | Yes | The above, read from the Google Messages for Web page. |
| Authentication information | No | The extension never sees the user's Google sign-in. Its own link key with Keepr is a non-extractable key stored only in the browser. |
| Location, health, financial, web history, user activity | No | — |

### Where it goes

- **Only to the Keepr desktop app on the same computer** (127.0.0.1). The
  extension itself sends nothing to any server.
- In Keepr, the texts are stored on that computer (encrypted local database).
  They leave the computer only when the user sends them: by submitting a
  transaction to their brokerage, or (a solo agent) by exporting their records
  to PDF. Both are started by the user.
- Diagnostics (counts and timings only, never message content, names or
  numbers) are sent by the Keepr desktop app, not by the extension.

### Consent and control

- Before the first Sync, Keepr shows: "Keepr copies your texts from Google
  Messages into Keepr on this computer." with **Agree and sync**. Nothing is
  copied before that. The consent is recorded with its version; a change of
  practice raises the version and asks again.
- The user can **withdraw** it in Keepr: Settings › Google Messages. The next
  Sync asks again.
- A Sync runs only when the user starts it in Keepr (or clicks Try again
  after a failed Sync). The eye on each chat switches syncing off for that
  chat.
- Deleting: Keepr's Force re-import (Settings › Google Messages) deletes every
  text it copied from Google Messages.
- The extension's options page says the same and links the privacy policy; the
  popup links it in its footer.

### Limited Use — certification answers

| Statement | Answer |
|---|---|
| I do not sell or transfer user data to third parties, outside of the approved use cases | **Certify.** The extension sends data only to the user's own Keepr app. In Keepr, texts leave the computer only when the user sends them: by submitting a transaction to their brokerage, or (a solo agent) by exporting their records to PDF. Both are user-initiated and part of keeping the user's transaction records, the reason the texts are copied into Keepr (§2). |
| I do not use or transfer user data for purposes that are unrelated to my item's single purpose | **Certify.** |
| I do not use or transfer user data to determine creditworthiness or for lending purposes | **Certify.** |

Further Limited Use points:

- **No advertising, no data brokers, no profiling.**
- **Human access:** no person reads message content, except when the user
  sends it to support themselves (a support ticket with their consent), for
  security or legal obligations, or as aggregated, anonymised data.
- **Secure handling:** the local link is signed with a key agreed by a
  password-authenticated key exchange (SPAKE2 over P-256); requests are
  checked for size, type and rate; images are limited to JPEG, PNG, GIF, WebP,
  HEIC and HEIF.

## 5. Privacy policy — the section for this extension

Text for the "Keepr for Google Messages" section of
https://keeprcompliance.com/privacy (the founder publishes it):

> **Keepr for Google Messages (Chrome extension)**
>
> **What it reads.** When you start a Sync in Keepr, the extension reads the
> conversations in Google Messages for Web for the period set in Keepr: the
> texts, the images in them, reactions, and the names and phone numbers of the
> people in each chat. When no Sync is running, it only looks at the chat list
> to show its switches; it copies nothing. It reads nothing outside
> messages.google.com.
>
> **Where it goes.** Only to the Keepr app on your own computer. The extension
> does not send your texts to Keepr's servers or anywhere else. Keepr stores
> them on your computer in an encrypted database. They leave your computer only
> when you submit a transaction to your brokerage or export your records to PDF.
>
> **Your choice.** Keepr asks for your consent before the first Sync. You can
> withdraw it in Keepr (Settings › Google Messages), switch any chat off with
> the eye on its row, and delete the copied texts with Force re-import.
>
> **No sale, no ads.** We do not sell or transfer this data to third parties,
> do not use it for advertising or profiling, and do not use it to determine
> creditworthiness. Keepr's use of this data complies with the Chrome Web
> Store User Data Policy, including the Limited Use requirements.
>
> **Diagnostics.** The Keepr app may send counts and timings about a Sync (for
> example, how many chats were read). These never include message content,
> names or phone numbers.

## 6. Listing text

- **Short description** (≤ 132 characters): "Copies your Google Messages
  texts into the Keepr desktop app on your computer when you start a Sync in
  Keepr."
- **Description:**

  > Keep your real estate texts with your transactions.
  >
  > Keepr for Google Messages works with the Keepr desktop app. When you start
  > a Sync in Keepr, it reads your conversations in Google Messages for Web and
  > copies them into Keepr on your computer, where they are matched to your
  > transactions by phone number.
  >
  > • Works only when you start a Sync, and only on messages.google.com.
  > • Your texts go only to the Keepr app on this computer.
  > • Switch any chat off with the eye on its row.
  > • Link it with Keepr once, using a 6-digit code.
  >
  > Requires the Keepr desktop app.

## 7. Screenshots and images

1280×800, demo data only (555-01xx numbers, invented names):

1. The popup, linked: "Linked to Keepr", Go to Google Messages, Open Keepr.
2. Linking: the popup's 6-digit code and Keepr's code field.
3. Keepr's Sync Android modal before the first Sync: the consent line and
   **Agree and sync**.
4. A Sync running on Google Messages for Web: the Sync box with its progress.
5. The eye on the chat list (a chat switched off).

Also: the 128×128 icon (`icons/keepr-128.png`, 96 art + 16 padding) and a
440×280 promo tile.

## 8. Release checklist

- [ ] `npm run package:extension`; upload `release/keepr-extension-<version>.zip`.
- [ ] The zip's manifest has no `key` (the C8 test checks it).
- [ ] Privacy policy section above is live at the policy URL.
- [ ] Privacy practices form filled from section 4; the three certifications.
- [ ] Permission justifications from section 3.
- [ ] Screenshots from section 7.
- [ ] Reviewer notes: the extension needs the Keepr desktop app; a test
      account and a short video of linking and a Sync.
- [ ] Visibility **Unlisted** first, then Public.
- [ ] After approval: put the store id in `RCS_EXTENSION_STORE_URL`
      (`…/detail/<slug>/<id>`), then turn `EXTENSION_PUBLISHED` on (the C4
      release guard refuses it with a URL that has no id) and add the store id
      to Keepr's allowed origins.

## 9. Change log

| Version | Change |
|---|---|
| 0.3.70 | Consent before the first Sync; privacy links on the options page and in the popup. |
| 0.3.71 | This file (store notes); no code change. |
| 0.3.72 | Store notes corrected (SR); no code change. |
| 0.3.73 | Every Sync (also per transaction) needs the consent; PDF export disclosed. |
| 0.3.74 | The per-transaction Sync is removed: the Sync Android Sync is the only one. |
| 0.3.75 | The extension's per-transaction run code removed; an older Keepr's claim is refused with "Update Keepr". |
| 0.3.76 | Comment tidies; the older-Keepr line is "Update Keepr, then Sync again." |
| 0.3.77 | History budgets on the wall clock (hidden tabs); a stalled chat ends; "Google Messages stopped responding." |
| 0.3.78 | Stalled-run count only from stalled chats; the wall clock counts after 30 real polls. |
| 0.3.79 | Step timings in the diagnostics log (one line per chat, one photo line) and as run totals in the Sync metrics. |
| 0.3.80 | A chat ends after 10 minutes of loading history, however few polls ran. |
| 0.3.81 | The link code can be selected and copied (Ctrl+C); one "Copy code and open Keepr" button; the welcome page shows the countdown and "Code expired" (one shared code area). |
| 0.3.82 | A retried chat that reads less far back than before is not marked complete. |
| 0.3.83 | Short-code senders: their own "skipped" line, not "Not fully imported". |
| 0.3.84 | While a Sync runs, each wait is one short message to the service worker, answered from its own timer (a hidden tab throttles the page's timers); the page timer is the fallback; nothing when no Sync runs, no port, no keepalive. Within the service-worker rules: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle and https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers |

## 10. Review history

None yet.
