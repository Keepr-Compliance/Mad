#Requires -Version 5.1
<#
.SYNOPSIS
    Keepr Cleanup Script for Windows
    Removes all app data and caches

.DESCRIPTION
    FALLBACK ONLY — canonical enumeration lives in
    electron/services/appCleanupService.ts; keep in sync.
    Prefer the in-app flow (Settings -> Troubleshooting) whenever the app
    launches: it has the engine's safety rails and logs the event to
    app_lifecycle_events.

    This script performs a full cleanup of Keepr on Windows:
    - Kills any running Keepr processes
    - Removes application data from AppData (Roaming and Local), including the
      electron-updater download cache
    - Removes the application from Program Files
    - Prints verification status

    NOTE (Windows secret storage): Keepr stores all secrets via Electron
    safeStorage (DPAPI). The encryption key lives in %APPDATA%\keepr\Local State
    and the DPAPI-encrypted material lives inside the two data dirs. Keepr
    creates NO Windows Credential Manager entries (no keytar / cmdkey usage
    anywhere in the codebase; "Keepr Safe Storage" is the macOS Keychain item
    name, not a Windows credential). Therefore deleting the data directories IS
    the complete credential cleanup on Windows — no cmdkey step is needed.

.NOTES
    Usage: Right-click this file and select "Run with PowerShell"
    Or run from an elevated PowerShell prompt: .\cleanup-windows.ps1
#>

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Keepr Cleanup Tool (Windows)"            -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# --- Kill any running processes ---
Write-Host "Stopping Keepr if running..."
$processes = Get-Process -Name "Keepr" -ErrorAction SilentlyContinue
if ($processes) {
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "  Processes stopped." -ForegroundColor Green
} else {
    Write-Host "  No running processes found." -ForegroundColor Gray
}

# --- Remove application data directories ---
# Includes %LOCALAPPDATA%\keepr-updater (electron-updater download cache; can
# hold a full installer), mirroring appCleanupService.ts enumeration.
Write-Host "Removing application data..."

$dataPaths = @(
    "$env:APPDATA\keepr",
    "$env:LOCALAPPDATA\keepr",
    "$env:LOCALAPPDATA\keepr-updater"
)

foreach ($path in $dataPaths) {
    if (Test-Path $path) {
        Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue
        Write-Host "  Removed: $path" -ForegroundColor Green
    }
}

# --- Remove the application from Program Files ---
Write-Host "Removing application..."

$appPaths = @(
    "$env:ProgramFiles\Keepr",
    "${env:ProgramFiles(x86)}\Keepr"
)

foreach ($path in $appPaths) {
    if (Test-Path $path) {
        Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue
        Write-Host "  Removed: $path" -ForegroundColor Green
    }
}

# --- Verification ---
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Verification"                             -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$remainingPaths = @()
foreach ($path in ($dataPaths + $appPaths)) {
    if (Test-Path $path) {
        $remainingPaths += $path
    }
}

if ($remainingPaths.Count -eq 0) {
    Write-Host "Status: All Keepr data removed" -ForegroundColor Green
} else {
    Write-Host "Warning: Some files may remain:" -ForegroundColor Yellow
    foreach ($path in $remainingPaths) {
        Write-Host "  $path" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Cleanup complete. You can now reinstall Keepr." -ForegroundColor Cyan
Write-Host ""
