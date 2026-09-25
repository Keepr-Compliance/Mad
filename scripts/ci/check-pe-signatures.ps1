<#
.SYNOPSIS
  Asserts that every Portable Executable file inside the Windows installer is
  Authenticode-signed with a Valid signature (BACKLOG-3533).

.DESCRIPTION
  Unpacks three levels of the NSIS installer and checks every PE file found:
    outer  - the installer itself, unpacked (NSIS plugin DLLs, the uninstaller)
    app    - the app archive (app-*.7z) found inside outer
    uninst - the uninstaller (Uninstall*.exe) found inside outer, unpacked
  plus the installer file itself.

  PE files are found by header (MZ, then "PE\0\0" at e_lfanew), never by
  extension. Every file is reported in one table before the script exits, so a
  failing run shows the full set, not just the first offender.

  Per-root floors stop an empty or partial unpack from passing green. The
  measured counts for v2.38.1 are outer 7, app 64, uninst 4 (+1 installer).

  Exit code: 0 = every file Valid and every floor met; 1 = anything else.

.PARAMETER Installer
  Path to the built installer (e.g. release\Keepr-Setup-2.38.1.exe).
.PARAMETER WorkDir
  Scratch directory for the unpacked trees. Must not exist or must be empty.
.PARAMETER SevenZip
  7-Zip executable. Default "7z" (present on windows-latest runners).
.PARAMETER HeaderOnly
  Skip Get-AuthenticodeSignature and report only whether each file carries a
  certificate table. For running the enumeration half off Windows. Never used
  in CI: with this switch the script always exits 1 after printing, because it
  has not verified any signature.
#>
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [string]$SevenZip = "7z",
  [switch]$HeaderOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Minimum PE files each unpack root must contribute (v2.38.1 measured 7 / 64 / 4).
$Floors = [ordered]@{ outer = 7; app = 60; uninst = 4 }

function Fail([string]$msg) {
  Write-Host "::error::$msg"
  exit 1
}

# 7-Zip exit codes: 0 = OK, 1 = warning (non-fatal), 2+ = error. Only 0 is
# accepted: a warning on an archive we built ourselves is unexplained.
function Expand-Archive7z([string]$archive, [string]$dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $out = & $SevenZip x -y "-o$dest" -- $archive 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    $out | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }
    Fail "7-Zip exited $code unpacking '$archive'"
  }
}

# Returns $null for a non-PE file, else the size in bytes of the certificate
# table (IMAGE_DIRECTORY_ENTRY_SECURITY). 0 = no embedded signature.
function Get-PeCertTableSize([string]$path) {
  $fs = [System.IO.File]::OpenRead($path)
  try {
    if ($fs.Length -lt 64) { return $null }
    $br = New-Object System.IO.BinaryReader($fs)
    if ($br.ReadUInt16() -ne 0x5A4D) { return $null }        # "MZ"
    $fs.Position = 0x3C
    $e = [int64]$br.ReadUInt32()
    if ($e + 24 + 2 -gt $fs.Length) { return $null }
    $fs.Position = $e
    if ($br.ReadUInt32() -ne 0x00004550) { return $null }    # "PE\0\0"
    $opt = $e + 24
    $fs.Position = $opt
    $magic = $br.ReadUInt16()
    $dd = $opt + $(if ($magic -eq 0x10b) { 96 } else { 112 })
    $sec = $dd + 4 * 8
    if ($sec + 8 -gt $fs.Length) { return $null }
    $fs.Position = $sec + 4
    return [int64]$br.ReadUInt32()
  } finally {
    $fs.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { Fail "Installer not found: $Installer" }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
if ((Test-Path -LiteralPath $WorkDir) -and (Get-ChildItem -LiteralPath $WorkDir -Force | Select-Object -First 1)) {
  Fail "WorkDir is not empty: $WorkDir"
}
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path

$roots = [ordered]@{
  outer  = Join-Path $WorkDir "outer"
  app    = Join-Path $WorkDir "app"
  uninst = Join-Path $WorkDir "uninst"
}

# Level 1: the installer. Paths inside it contain "$PLUGINSDIR" and "$R0"; they
# are only ever handled as values returned by Get-ChildItem, never as literals.
Expand-Archive7z $Installer $roots.outer

$appArchive = @(Get-ChildItem -LiteralPath $roots.outer -Recurse -File -Filter "app-*.7z")
if ($appArchive.Count -ne 1) { Fail "Expected exactly 1 app-*.7z inside the installer, found $($appArchive.Count)" }
Expand-Archive7z $appArchive[0].FullName $roots.app

$uninstaller = @(Get-ChildItem -LiteralPath $roots.outer -Recurse -File -Filter "Uninstall*.exe")
if ($uninstaller.Count -ne 1) { Fail "Expected exactly 1 Uninstall*.exe inside the installer, found $($uninstaller.Count)" }
Expand-Archive7z $uninstaller[0].FullName $roots.uninst

# Enumerate PE files by header.
$rows = New-Object System.Collections.Generic.List[object]
$rows.Add([pscustomobject]@{ Root = "installer"; Rel = (Split-Path -Leaf $Installer); Full = $Installer; CertBytes = (Get-PeCertTableSize $Installer) })
$perRoot = [ordered]@{}
foreach ($name in $roots.Keys) {
  $n = 0
  foreach ($f in Get-ChildItem -LiteralPath $roots[$name] -Recurse -File -Force) {
    $size = Get-PeCertTableSize $f.FullName
    if ($null -eq $size) { continue }
    $n++
    $rel = [System.IO.Path]::GetRelativePath($roots[$name], $f.FullName).Replace('\', '/')
    $rows.Add([pscustomobject]@{ Root = $name; Rel = "$name/$rel"; Full = $f.FullName; CertBytes = $size })
  }
  $perRoot[$name] = $n
}

# Signature status per file.
foreach ($r in $rows) {
  if ($HeaderOnly) {
    $status = $(if ($r.CertBytes -gt 0) { "HasCertTable" } else { "NotSigned" })
    $r | Add-Member Status $status
    $r | Add-Member Signer ""
    $r | Add-Member Message "header only - Authenticode not checked"
  } else {
    $sig = Get-AuthenticodeSignature -LiteralPath $r.Full
    $r | Add-Member Status ([string]$sig.Status)
    $r | Add-Member Signer $(if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "" })
    $r | Add-Member Message ([string]$sig.StatusMessage)
  }
}

# Report everything before deciding.
Write-Host ""
Write-Host "PE files: $($rows.Count) (installer 1, $(($perRoot.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', '))"
Write-Host ""
foreach ($r in ($rows | Sort-Object Rel)) {
  Write-Host ("{0,-13} cert={1,-6} {2}  | {3}" -f $r.Status, $r.CertBytes, $r.Rel, $r.Signer)
}
Write-Host ""
$byStatus = $rows | Group-Object Status | Sort-Object Name
foreach ($g in $byStatus) { Write-Host ("TOTAL {0}: {1}" -f $g.Name, $g.Count) }

$problems = New-Object System.Collections.Generic.List[string]
foreach ($name in $Floors.Keys) {
  if ($perRoot[$name] -lt $Floors[$name]) {
    $problems.Add("root '$name' has $($perRoot[$name]) PE files, floor is $($Floors[$name]) (unpack incomplete?)")
  }
}
$bad = @($rows | Where-Object { $_.Status -ne "Valid" })
if ($bad.Count -gt 0) {
  $problems.Add("$($bad.Count) of $($rows.Count) PE files are not Valid")
  foreach ($b in ($bad | Sort-Object Rel)) {
    Write-Host ("NOT VALID: {0} [{1}] {2}" -f $b.Rel, $b.Status, $b.Message)
  }
}

if ($problems.Count -gt 0) {
  foreach ($p in $problems) { Write-Host "::error::$p" }
  exit 1
}
Write-Host "All $($rows.Count) PE files carry a Valid Authenticode signature."
exit 0
