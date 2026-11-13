# BACKLOG-4185 PR B — Windows device-profile probe (fixture source for the AV/disk mapping tests).
#
# Everything from the `param(` line down is the SAME body the desktop collector passes to
# `powershell -NoProfile -NonInteractive -Command` (deviceProfileCollector.ts
# WINDOWS_PROBE_SCRIPT). A unit test pins the two together.
#
# The app passes the drive letter in the KEEPR_PROBE_DRIVE environment variable (never in
# the command text). Run once on a Windows CLIENT PC (not Windows Server: it has no
# root/SecurityCenter2):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\win-device-profile-probe.ps1 C
# Paste the single JSON line it prints.
#
# Output, by construction: AV product display names (vendor text) + productState integers,
# numeric disk MediaType/BusType codes, OS UBR + DisplayVersion, elapsed ms, PowerShell version,
# process bitness. It reads NO computer name, user name, path, serial, or hardware id.

param([string]$Drive = $env:KEEPR_PROBE_DRIVE)
$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($Drive -notmatch '^[A-Za-z]$') { $Drive = 'C' }
$Drive = $Drive.ToUpperInvariant()

$out = [ordered]@{ v = 1; avState = 'unavailable'; av = @(); disk = [ordered]@{ media = $null; bus = $null }; ubr = $null; displayVersion = $null }

try {
  $out.av = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName 'AntiVirusProduct' |
    ForEach-Object { [ordered]@{ n = [string]$_.displayName; s = [int64]$_.productState } })
  $out.avState = 'ok'
} catch { $out.avState = 'unavailable' }

try {
  $part = Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName 'MSFT_Partition' |
    Where-Object { [string]$_.DriveLetter -eq $Drive } | Select-Object -First 1
  if ($part) {
    $pd = Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName 'MSFT_PhysicalDisk' |
      Where-Object { [string]$_.DeviceId -eq [string]$part.DiskNumber } | Select-Object -First 1
    if ($pd) { $out.disk.media = [int]$pd.MediaType; $out.disk.bus = [int]$pd.BusType }
  }
} catch { }

try {
  $cv = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'UBR', 'DisplayVersion' -ErrorAction SilentlyContinue
  if ($cv) { $out.ubr = $cv.UBR; $out.displayVersion = [string]$cv.DisplayVersion }
} catch { }

$out.ms = [int]$sw.ElapsedMilliseconds
$out.ps = [string]$PSVersionTable.PSVersion
$out.is64 = [Environment]::Is64BitProcess
ConvertTo-Json -InputObject $out -Compress -Depth 4
