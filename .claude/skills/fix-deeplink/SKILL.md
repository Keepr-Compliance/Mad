---
name: fix-deeplink
description: Fix the keepr:// deep link protocol registration so OAuth login works in dev mode. Run this when login fails with "Deep link auth error" or "Deep link callback timeout".
user_invocable: true
---

# Fix Deep Link Protocol Registration

**Run this skill as written. Do not substitute narrower fixes.**

Fixes the `keepr://` OAuth callback not routing to the dev Electron app. Causes:
1. Installed Keepr.app at /Applications intercepting the protocol
2. Git worktrees with node_modules/electron registering competing handlers
3. Stale Launch Services cache remembering old bindings

## Dead end: do not try to re-point the handler directly

`LSSetDefaultHandlerForURLScheme('keepr', 'com.github.Electron')` and
`NSWorkspace.setDefaultApplication(at:toOpenURLsWithScheme:)` both **return success and change nothing**
(observed 2026-11-06). macOS only routes a scheme to apps that **declare** it in `CFBundleURLTypes`.
The dev `Electron.app` does not, so while any declaring Keepr.app is registered, Keepr.app wins.
The only working path is to take Keepr.app out of Launch Services (steps below), after which dev's
runtime `setAsDefaultProtocolClient` owns `keepr:`.

## Steps

1. Stop the processes that are yours; quit installed Keepr gently
2. Rename /Applications/Keepr.app so it no longer declares `keepr:`
3. List worktrees (informational only)
4. Reset the macOS Launch Services cache
5. Wait 3 seconds for the cache to rebuild
6. Start `npm run dev` and verify the effective handler
7. **After sign-in: restore Keepr.app (mandatory)**

## Commands

```bash
# Step 1: List dev Electron processes and who owns them. Do NOT blanket `pkill -f electron`.
# Other sessions/worktrees may own these — ask the user before closing any that aren't yours.
# The dev binary is the SHARED node_modules Electron, so `pkill -f <worktree>` misses it: kill by PID.
for pid in $(pgrep -f electron/dist/Electron.app/Contents/MacOS/Electron); do
  echo "$pid $(lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')"
done
# kill <pid>   # only your own, or with the user's go

# Quit the installed app gently (no pkill)
osascript -e 'tell application id "com.keeprcompliance.keepr" to quit'
sleep 1

# Step 2: Rename the installed app
[ -e /Applications/Keepr.app ] && mv /Applications/Keepr.app /Applications/Keepr-disabled.app && echo "Renamed Keepr.app -> Keepr-disabled.app"

# Step 3: Worktrees — informational only. NEVER remove one without the user's go.
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || cd /Users/daniel/Developer/Mad
git worktree list

# Step 4: Reset Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -kill -r -domain local -domain system -domain user

# Step 5: Wait
sleep 3

# Step 6: Start dev (from the worktree you are testing)
npm run dev
```

**Env files:** dev needs `.env.development` / `.env.local` in the worktree, or sign-in fails with a
missing `SUPABASE_URL`. Copy them from `/Users/daniel/Developer/Mad` with `cp` — never print them.

## Verification

Resolve the **effective** handler (what macOS actually opens):
```bash
osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("keepr://x")).path.js'
```
Expected while dev is running: `.../node_modules/electron/dist/Electron.app`.

`defaults read com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers` can show a stale
stored entry that macOS ignores — do not trust it over the command above.

## Restore after sign-in (MANDATORY)

The installed app must never be left renamed.

```bash
# 1. Quit the dev app if you are done with it (by PID, see Step 1)
# 2. Put the installed app back and re-register it
mv /Applications/Keepr-disabled.app /Applications/Keepr.app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Keepr.app
osascript -l JavaScript -e "ObjC.import('CoreServices'); \$.LSSetDefaultHandlerForURLScheme(\$('keepr'), \$('com.keeprcompliance.keepr'))"
# 3. Verify — must print /Applications/Keepr.app
osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("keepr://x")).path.js'
```
