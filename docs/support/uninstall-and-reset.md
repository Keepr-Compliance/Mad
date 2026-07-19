# Uninstall & App Reset — Support Guide

Audience: **Keepr support staff.** This is a decision-and-verification guide for
helping a user reset or fully remove Keepr from their machine. It is written for
support, not engineers — no code is required to follow it.

> **Scope:** These flows wipe **local** desktop data only. A user's **cloud
> data in Supabase is NOT touched** by a reset or uninstall. Resetting the app
> does not delete their account, credits, or synced records.

The canonical enumeration of everything Keepr owns on disk lives in
`electron/services/appCleanupService.ts`. This guide mirrors it; if the two ever
disagree, the service is the source of truth.

---

## 1. Which path do I send the user down?

Pick the path top-to-bottom — use the first one that applies.

```
Does the Keepr app still launch?
│
├─ YES  → PRIMARY PATH: In-app Settings → Troubleshooting
│         (Reset app data OR Uninstall Keepr)
│         ✔ Cleanest. Clears OS secrets. Logs to app_lifecycle_events.
│
└─ NO (app won't launch / is broken)
   │
   ├─ Windows → Add/Remove Programs → uninstall Keepr
   │            (the uninstaller PROMPTS to also delete data)
   │            ✘ Does NOT log to app_lifecycle_events.
   │
   └─ macOS, OR the Windows uninstaller is broken/missing
      → LAST RESORT: fallback scripts
        scripts/cleanup-macos.sh / scripts/cleanup-windows.ps1
        ✘ Does NOT log to app_lifecycle_events.
```

### Path A — In-app (PRIMARY, use whenever the app launches)

**Settings → Troubleshooting** offers two actions:

| Action | What it does |
|--------|--------------|
| **Reset app data** | Wipes all local data + OS secrets, then relaunches Keepr into fresh onboarding. The app is NOT removed. |
| **Uninstall Keepr** | Wipes all local data + OS secrets **and** removes the application itself. |

Both actions show a confirmation dialog and can capture an optional free-text
**reason**. **Uninstall** additionally requires the user to type **`KEEPR`** to
confirm (a deliberate guard against accidental removal).

Why this path is preferred:
- It runs **as the real signed-in user**, so it can reach that user's keychain
  (macOS) and delete that user's data directories (both OSes).
- It clears **OS-level secrets in-process** before wiping files — only the
  running app has keychain access.
- It records the event to **`app_lifecycle_events`** (see §3) *before* the wipe,
  so support gets visibility. This is the **only** path that logs.

Behind the scenes the wipe runs in a **detached helper** so the app can fully
exit and get its own files deleted. On a reset, the helper (not the app)
relaunches Keepr after the wipe completes — so a reset always lands the user in
fresh onboarding.

### Path B — Windows Add/Remove Programs (app won't launch, Windows)

Direct the user to **Settings → Apps → Installed apps → Keepr → Uninstall**
(or Control Panel → Programs and Features).

The uninstaller asks:

> *"Also delete your Keepr data and saved credentials (emails, transactions, and
> DPAPI-encrypted secrets)? This cannot be undone."*

- **Yes** → removes the app **and** the two Windows data directories.
- **No** (the default) → removes only the app; data is left in place (useful if
  they intend to reinstall and keep their local data).

> This path does **not** log to `app_lifecycle_events` (the app is not running,
> so there is no authenticated session to write the event).

### Path C — Fallback scripts (LAST RESORT)

Use these only when the app won't launch **and** the Windows uninstaller is
unavailable (or the user is on macOS with a broken app). They are hand-run
scripts that delete the known data directories and the app bundle.

- macOS: `scripts/cleanup-macos.sh` — double-click, or `./cleanup-macos.sh`.
- Windows: `scripts/cleanup-windows.ps1` — right-click → *Run with PowerShell*.

These are **fallback only**. They cannot log to `app_lifecycle_events` and they
do not have the safety rails of the in-app engine (install-dir sanity checks,
reparse-point handling, guaranteed-exit ordering). Prefer Path A or B whenever
possible.

---

## 2. Reset vs Uninstall vs Reinstall

| Event | Removes app? | Wipes local data + secrets? | Relaunches? | Cloud data |
|-------|:---:|:---:|:---:|:---:|
| **reset** | No | Yes | Yes (fresh onboarding) | Untouched |
| **uninstall** | Yes | Yes | No | Untouched |
| **reinstall** | — | — | — | Untouched |

`reset`, `uninstall`, and `reinstall` are the three `event_type` values recorded
in `app_lifecycle_events`.

---

## 3. What gets logged, and where

Only the **in-app path (Path A)** logs. It writes one row to the Supabase table
**`app_lifecycle_events`** *before* the wipe, best-effort (a 3-second timeout —
an offline or signed-out user can still complete the wipe; the event is simply
skipped).

### `app_lifecycle_events` columns

| Column | Meaning |
|--------|---------|
| `id` | Row UUID. |
| `user_id` | The user who reset/uninstalled. `ON DELETE SET NULL` — the row **survives** deletion of the user's auth account (the point is post-hoc forensics). |
| `device_id` | Machine identifier, when available (optional). |
| `event_type` | `reset` \| `uninstall` \| `reinstall`. |
| `app_version` | App version at the time of the event. |
| `platform` | `darwin` (macOS) or `win32` (Windows). |
| `reason` | Optional free text the user typed in the confirmation dialog. |
| `metadata` | Optional structured context (JSON; defaults to `{}`). |
| `created_at` | Timestamp of the event. |

### How support checks it

The table is **internal-roles-only for reads** (RLS). Regular users cannot read
it; `anon` has no access at all. To check a user's reset/uninstall history, ask
an **internal-role user** (support/admin) to query it, newest-first, e.g.:

```sql
SELECT event_type, app_version, platform, reason, created_at
FROM public.app_lifecycle_events
WHERE user_id = '<the-user-uuid>'
ORDER BY created_at DESC;
```

> **If nothing shows up:** the event is only written by the in-app path AND only
> when the user had an authenticated session at wipe time. A user who
> uninstalled via Add/Remove Programs, ran a fallback script, or was offline/
> signed-out will have **no row** — that is expected, not a bug.

---

## 4. Verifying the data is actually gone (per OS)

After any path, confirm the artifacts below are gone. These are exactly the
paths the in-app engine enumerates (`appCleanupService.ts`). The `keepr` /
`keepr-updater` cache and `%LOCALAPPDATA%` entries are removed by the in-app
engine and the fallback scripts; the Windows Add/Remove path removes only the
two primary data dirs (`%APPDATA%\keepr`, `%LOCALAPPDATA%\keepr`).

### macOS

Data / caches / logs (removed on **reset** and **uninstall**):

| Path | Notes |
|------|-------|
| `~/Library/Application Support/keepr` | Primary app data (`userData` + `sessionData`). |
| `~/Library/Logs/keepr` | App logs. |
| `~/Library/Caches/keepr` | Cache (existence-checked). |
| `~/Library/Caches/keepr-updater` | Auto-updater download cache (existence-checked). |

App bundle (removed on **uninstall** only):

| Path | Notes |
|------|-------|
| `/Applications/Keepr.app` | The app itself. The in-app engine resolves this from the running executable, so a non-standard install location is handled too. |

OS secret (cleared in-process by the in-app path):

- macOS Keychain generic-password item **`keepr Safe Storage`** (this is the
  Electron `safeStorage` key). The fallback macOS script also removes it via
  `security delete-generic-password -s "keepr Safe Storage"`.

**Verify (macOS):**
```bash
ls ~/Library/Application\ Support/ | grep -i keepr    # → no output
ls ~/Library/Caches/           | grep -i keepr        # → no output
ls ~/Library/Logs/             | grep -i keepr        # → no output
ls /Applications/              | grep -i Keepr        # → no output (uninstall)
security find-generic-password -s "keepr Safe Storage" 2>&1 | tail -1
#   → "could not be found" once cleared
```

### Windows

Data / caches (removed on **reset** and **uninstall**):

| Path | Notes |
|------|-------|
| `%APPDATA%\keepr` | Primary app data (`userData` + logs live under here). |
| `%LOCALAPPDATA%\keepr` | Local app data (existence-checked). |
| `%LOCALAPPDATA%\keepr-updater` | electron-updater download cache — can hold a full installer (existence-checked). |

App install dir (removed on **uninstall** only):

| Path | Notes |
|------|-------|
| `%ProgramFiles%\Keepr` or `%ProgramFiles(x86)%\Keepr` (per-machine), or a per-user install dir | The in-app engine prefers the NSIS uninstaller (`Uninstall Keepr.exe`) and only falls back to deleting the install dir when it passes strict sanity checks (see §5). |

OS secret: **none on Windows.** Keepr stores all secrets via Electron
`safeStorage` (**DPAPI**). The encryption key lives in `%APPDATA%\keepr\Local
State` and the DPAPI-encrypted material lives inside the two data dirs — so
**deleting the data directories IS the credential cleanup**. Keepr creates **no
Windows Credential Manager entries** (there is no `keytar`/`cmdkey` usage in the
product; "Keepr Safe Storage" is the *macOS* Keychain item, not a Windows
credential).

**Verify (Windows, PowerShell):**
```powershell
Test-Path "$env:APPDATA\keepr"              # → False
Test-Path "$env:LOCALAPPDATA\keepr"         # → False
Test-Path "$env:LOCALAPPDATA\keepr-updater" # → False
Test-Path "$env:ProgramFiles\Keepr"         # → False (uninstall)
```

---

## 5. Known limitations

- **Elevated per-machine Windows uninstall (admin-profile context).** For a
  per-machine install, a standard user's Add/Remove uninstall UAC-elevates and
  the data-cleanup step re-runs as the **elevating admin** account. It then
  resolves the *admin's* profile, so the original end user's data dirs may be
  left behind. This matches electron-builder's own stock behaviour. **Fix:** use
  the **in-app** flow (Path A) — it runs as the real user — or run the fallback
  script while signed in as that user.

- **Wipe aborts if the app didn't fully exit (`.failed` marker).** The in-app
  engine wipes from a detached helper that waits up to **30 seconds** for the
  app process to exit. If the app is still alive at the deadline, the helper
  **deletes nothing** (deleting under a live app corrupts the DB), writes a
  small **`.failed` marker file into the system temp directory**
  (`keepr-cleanup-<mode>-<pid>-<timestamp>.failed`), and self-deletes. If a user
  reports "I reset but my data is still there," check the temp dir for a
  `keepr-cleanup-*.failed` marker — it means the app didn't exit. Ask them to
  fully quit Keepr and retry.

- **Silent / auto-update uninstalls never delete data (by design).** The
  auto-updater runs the NSIS uninstaller **silently** during every update. The
  installer explicitly bails on both the "updated" and "silent" cases, so a
  routine app update **never** touches user data. Only an *interactive*
  Add/Remove uninstall prompts to delete data.

- **Guarded Windows install-dir deletion.** If the NSIS uninstaller is missing
  or fails, the engine only deletes the install dir when it passes sanity checks
  (the running exe lives there, an electron-builder `resources\app.asar` is
  present, the folder name contains "keepr", it is not a drive root or a known
  user/system folder like Downloads/Documents/Windows). If those checks fail, it
  **skips app removal** and reports `appRemovalSkipped` rather than risk deleting
  the wrong folder. Data is still wiped.

- **Residual no-op credential step (Windows).** The in-app engine's in-process
  secret-clearing still issues a best-effort `cmdkey /delete` for a few legacy
  target names on Windows. Because Keepr never wrote any Credential Manager
  entries, this is a **harmless no-op** (each call simply reports "not found").
  The real Windows credential cleanup is the deletion of the data directories.

---

## Quick reference

| Situation | Send user to | Logs to `app_lifecycle_events`? |
|-----------|--------------|:---:|
| App launches, wants a clean slate | In-app → Settings → Troubleshooting → **Reset app data** | ✅ |
| App launches, wants Keepr gone | In-app → Settings → Troubleshooting → **Uninstall Keepr** (type `KEEPR`) | ✅ |
| App won't launch, Windows | Add/Remove Programs → Keepr → Uninstall (say **Yes** to delete data) | ❌ |
| App won't launch, macOS / uninstaller broken | Fallback script (`cleanup-macos.sh` / `cleanup-windows.ps1`) | ❌ |
