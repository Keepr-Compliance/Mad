#!/bin/bash
#
# Keepr Cleanup Script for macOS
# Removes all app data, caches, logs, and keychain entries
#
# FALLBACK ONLY — canonical enumeration lives in
# electron/services/appCleanupService.ts; keep in sync.
# Prefer the in-app flow (Settings → Troubleshooting) whenever the app launches:
# it clears secrets in-process and logs the event to app_lifecycle_events.
#
# Usage: Double-click this file or run: ./cleanup-macos.sh
#

echo "=========================================="
echo "  Keepr Cleanup Tool"
echo "=========================================="
echo ""

# Kill any running app FIRST
echo "Stopping Keepr if running..."
pkill -f "Keepr" 2>/dev/null || true
sleep 1

# Delete all app data folders
echo "Removing application data..."
rm -rf ~/Library/Application\ Support/keepr

# Delete logs
echo "Removing logs..."
rm -rf ~/Library/Logs/keepr

# Delete caches (app cache + electron-updater download cache)
echo "Removing caches..."
rm -rf ~/Library/Caches/keepr
rm -rf ~/Library/Caches/keepr-updater

# Remove the application
echo "Removing application..."
rm -rf /Applications/Keepr.app

# Delete keychain entries
echo "Removing keychain entries..."
security delete-generic-password -s "keepr Safe Storage" 2>/dev/null || true

# Verify cleanup
echo ""
echo "=========================================="
echo "  Verification"
echo "=========================================="
remaining=$(ls ~/Library/Application\ Support/ 2>/dev/null | grep -iE "keepr")
if [ -z "$remaining" ]; then
    echo "Status: All Keepr data removed"
else
    echo "Warning: Some files may remain:"
    echo "$remaining"
fi

echo ""
echo "Cleanup complete. You can now reinstall Keepr."
echo ""
