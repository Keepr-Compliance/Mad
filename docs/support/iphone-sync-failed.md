# iPhone Sync Failed — Support Runbook

Audience: **Keepr support staff.** This guide helps you work out why an iPhone
sync failed and what the user should do next. It is written for support, not
engineers; no code is needed to follow it.

> **Scope:** iPhone syncs from the desktop app (macOS and Windows). Every
> on-screen sentence quoted below is copied from the code. An HTML comment
> beside each quote names the file and line it came from, measured at
> `int/stable-ground-2.46` @ `f285f8863`. If the app and this guide disagree,
> the app's code is the source of truth.

> **Privacy:** the desktop log names the user's iPhone and prints its device
> identifier (UDID). Do not paste either into a ticket title, a chat channel or
> anything public. The phone's name is often a personal nickname.

---

## 1. Where to look first

Look in this order:

1. **Admin portal → Reports → iPhone Sync Performance.** Each run card shows
   **Ended by** and **Reason**. Hover a value to see its raw code. A value with
   no friendly label (for example `size-unknown`) is shown as the raw code.
   <!-- lit admin-portal/lib/reports/registry.ts:35 `title: 'iPhone Sync Performance',` -->
   <!-- lit admin-portal/app/dashboard/reports/iphone-sync/RunCard.tsx:226 `label: 'Ended by'` -->
   <!-- lit admin-portal/app/dashboard/reports/iphone-sync/RunCard.tsx:229 `label: 'Reason'` -->
   <!-- lit admin-portal/lib/reports/iphone-sync.ts:342 `The phone was locked` -->
   <!-- lit admin-portal/lib/reports/iphone-sync.ts:344 `The backup ran out of time` -->
   <!-- lit admin-portal/lib/reports/iphone-sync.ts:345 `Not enough free space on the computer` -->
   <!-- lit admin-portal/lib/reports/iphone-sync.ts:347 `The connection to the phone was lost` -->
   <!-- lit admin-portal/lib/reports/iphone-sync.ts:348 `The device service was unavailable` -->
   <!-- lit admin-portal/lib/reports/iphone-sync.ts:351 `The device reported an error it could not name` -->
   <!-- lit admin-portal/lib/reports/iphone-sync.ts:407 `Stopped by the app to protect the computer` -->
   <!-- lit admin-portal/lib/reports/iphone-sync.ts:408 `Stopped by the watchdog after no progress` -->
   <!-- lit admin-portal/lib/reports/iphone-sync.ts:409 `Stopped by an error from the phone` -->
2. **What the user saw.** Since BACKLOG-2913, each cause has its own sentence
   (§3). Ask the user for the exact wording, or a screenshot.
3. **The desktop log** (`main.log`). Use it to confirm, not to diagnose (see §2).

Where the codes are recorded:

- **Supabase `sync_outcomes`**: `reason_code`, `ended_by`, and
  `device_error_code` (the phone's own MBErrorDomain number, for example 105 or
  208) on every run.
- **Sentry** event **"Sync outcome: error"**: tagged `reason_code` and
  `endedBy`. **Pending:** a `device_error_code` tag (BACKLOG-2950 PR-A).
- **Pending:** the portal run card does not show `device_error_code` yet. It
  will once BACKLOG-2950 PR-B lands.

### Quick lookup

<!-- Writers of every Reason / Ended by value below (deviceSyncOrchestrator.ts at f285f8863): -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:1782 `endedBy: deviceNoAnswer ? "device-no-answer" : "size-unknown",` -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:2026 `syncTimeline.setContext({ endedBy: "device-disconnect" });` -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:2006 `syncTimeline.setContext({ endedBy: "host-guard" });` -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:2122 `syncTimeline.setContext({ endedBy: "app-quit" });` -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:1129 `syncTimeline.setContext({ endedBy: "tool-blocked", reasonCode: "TOOL_BLOCKED" });` -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:3874 `syncTimeline.setContext({ endedBy: "tool-timeout", reasonCode: "IPHONE_TOOL_TIMEOUT" });` -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:2138 `...(backupResult.errorCode ? { reasonCode: backupResult.errorCode } : {}),` -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:2149 `? "watchdog"` -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:2156 `: "device-error",` -->
<!-- lit electron/services/deviceSyncOrchestrator.ts:2143 `? { deviceErrorCode: backupResult.failureCause.deviceErrorCode }` -->
<!-- lit electron/services/syncOutcomeSupabase.ts:205 `device_error_code: int(f, "deviceErrorCode"),` -->

| Reason (raw) | Ended by (raw) | Section |
|---|---|---|
| `BACKUP_SIZE_UNKNOWN` | `size-unknown` | [3.1](#31-backup-size-unknown) |
| `DEVICE_NO_ANSWER` | `device-no-answer` | [3.2](#32-the-iphone-did-not-answer) |
| *(empty)* | `device-disconnect` | [3.3](#33-iphone-disconnected-during-the-backup) |
| `CONNECTION_LOST` | `device-error` | [3.4](#34-connection-lost) |
| `SERVICE_UNAVAILABLE` | `device-error` | [3.5](#35-backup-service-stuck-on-the-iphone) |
| `INSUFFICIENT_SPACE` | `device-error` | [3.6](#36-not-enough-real-free-space-on-the-computer) |
| *(empty)* | `host-guard` | [3.6](#36-not-enough-real-free-space-on-the-computer) |
| `DEVICE_LOCKED` | `device-error` | [3.7](#37-iphone-locked) |
| `IPHONE_TOOL_TIMEOUT` | `tool-timeout` | [3.8](#38-iphone-check-timed-out) |
| `BACKUP_TIMEOUT` | `watchdog` | [3.9](#39-backup-made-no-progress-watchdog) |
| `TOOL_BLOCKED` | `tool-blocked` | [3.10](#310-antivirus-blocked-the-iphone-tools-windows) |
| `UNKNOWN_ERROR` | `device-error` | [3.11](#311-an-error-keepr-has-no-explanation-for) |
| *(empty)* | *(empty)* or `app-quit` | [3.12](#312-no-reason-recorded) |

---

## 2. Log lines that are NOT evidence

These lines appear in **healthy runs too**. None of them identifies a cause on
its own:

- **`np_lock(): Locked` and `afc_lock(): Locked`.** These are internal
  housekeeping lines from the iPhone tools. They appear hundreds of times in
  every run and say **nothing** about whether the phone is locked. Until
  BACKLOG-2913, these lines made the app say "iPhone is locked" for every
  failure.
- **`SSL_read 4, received 0`.** Routine polling. A run that ended with a locked
  phone (208) contained about thirty of these on a healthy cable.
- **`usbmuxd_send returned -32 (Broken pipe)`.** This line is printed whenever
  the connection closes. It appeared in four of five real failures on
  2026-08-27, **including the locked phone**. It points to a dropped connection
  only when the phone reported no error code of its own (§3.4).

**What does identify a cause:** the phone's own error line
(`ErrorCode <N>: <description>`), the tool's exit code, and whether
`Device disconnected` events appear.

---

## 3. The causes

Every section uses the same order: what the portal shows, what the user saw,
the log lines, the cause, and what to do.

Unless a section says otherwise, the user sees the heading **Sync Failed**
with the sentence below it.
<!-- lit src/components/iphone/IPhoneSyncFlow.tsx:343 `Sync Failed</h3>` -->

### 3.1 Backup size unknown

- **Portal:** Reason `BACKUP_SIZE_UNKNOWN`, Ended by `size-unknown`. The sync
  was refused **before** the backup started, so there is no exit code.
- **User saw:**
  > Keepr couldn't work out how big this iPhone backup will be, so it can't tell whether it fits on this computer — and it won't start a sync it can't check. Unlock your iPhone, leave it connected and tap Trust if asked, then try again.
  <!-- lit electron/services/diagnostics/userFacingErrors.ts:99 `Keepr couldn't work out how big this iPhone backup will be, so it can't tell whether it fits on this computer — and it won't start a sync it can't check. Unlock your iPhone, leave it connected and tap Trust if asked, then try again.` -->
- **Log:** `[DeviceSyncOrchestrator] Sync refused: backup size could not be
  determined`, carrying `estimateSource` and `reason`. Often preceded by
  `[DeviceDetection] disk_usage output carried no usable capacity. keysSeen=[] lines=1`.
  Sentry: **"Sync refused: backup size unknown"**.
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1758 `[DeviceSyncOrchestrator] Sync refused: backup size could not be determined` -->
  <!-- lit electron/services/deviceDetectionService.ts:1582 `[DeviceDetection] disk_usage output carried no usable capacity. keysSeen=` -->
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1767 `Sync refused: backup size unknown` -->
- **Cause:** the phone did not return its storage figures when Keepr asked.
  This usually happens when the phone is locked at that moment. Keepr will not
  start a backup it cannot size. (This was cause 1 in the original list, §7.)
- **Do:** unlock the phone, leave it unlocked and connected, tap **Trust** if
  the phone asks, then try again. If it repeats, unplug and replug the cable.

### 3.2 The iPhone did not answer

- **Portal:** Reason `DEVICE_NO_ANSWER`, Ended by `device-no-answer`. Refused
  before the backup started. Added by BACKLOG-4124, which is still in testing.
- **User saw:**
  > Your iPhone didn't answer when Keepr checked the backup size, so the sync didn't start. Unlock it, unplug and replug it, then try again.
  <!-- lit electron/services/diagnostics/userFacingErrors.ts:116 `Your iPhone didn't answer when Keepr checked the backup size, so the sync didn't start. Unlock it, unplug and replug it, then try again.` -->
- **Log:** the same `Sync refused: backup size could not be determined` line as
  §3.1, with `reasonCode` `DEVICE_NO_ANSWER`.
- **Cause:** the storage query connected, then exited without a single byte
  from the phone. No Trust prompt was involved.
- **Do:** unlock the phone, unplug it, plug it back in, then try again.

### 3.3 iPhone disconnected during the backup

- **Portal:** Ended by `device-disconnect`. **Reason is empty**: this exit
  records no reason code.
- **User saw:**
  > Your iPhone was disconnected during the backup. Reconnect it and select Try Again.
  <!-- lit electron/services/deviceSyncOrchestrator.ts:671 `Your iPhone was disconnected during the backup. Reconnect it and select Try Again.` -->
- **Log:** `[DeviceDetection] Device disconnected: <name> (<udid>)`. The line
  carries the phone's name and UDID; do not copy it anywhere public.
  <!-- lit electron/services/deviceDetectionService.ts:837 `[DeviceDetection] Device disconnected: ` -->
- **Cause:** Keepr saw the phone go away while the backup was running. Either
  the user unplugged it, or the USB link is **flapping** (cause 2 in §7).
  **Count the `Device disconnected` events:** one event usually means an
  unplug. Repeated events every 40–95 seconds mean the link is flapping.
- **Do (flapping):** try a different cable first. Then try a different port
  directly on the computer, with no hub or dock. If it still flaps,
  **restart the phone.** On 2026-08-27, restarting the phone fixed it after a
  new cable alone had not.

### 3.4 Connection lost

- **Portal:** Reason `CONNECTION_LOST` ("The connection to the phone was
  lost"), Ended by `device-error` ("Stopped by an error from the phone").
- **User saw** one of two sentences. Which one depends on whether file transfer
  had already started.
  - *Before any file was transferred:*
    > The connection to your iPhone dropped during the backup. Try a different cable, plug the iPhone straight into this computer without a hub or dock, then sync again. If it keeps dropping, restart your iPhone.
    <!-- lit electron/services/backupService.ts:321 `The connection to your iPhone dropped during the backup. Try a different cable, ` -->
    <!-- lit electron/services/backupService.ts:322 `plug the iPhone straight into this computer without a hub or dock, then sync again. ` -->
    <!-- lit electron/services/backupService.ts:323 `If it keeps dropping, restart your iPhone.` -->
  - *After file transfer had started:*
    > The connection to your iPhone dropped during the backup. This is often temporary — try syncing again. If it keeps happening, plug the iPhone straight into this computer without a hub, and check that neither device is going to sleep.
    <!-- lit electron/services/backupService.ts:346 `The connection to your iPhone dropped during the backup. This is often ` -->
    <!-- lit electron/services/backupService.ts:347 `temporary — try syncing again. If it keeps happening, plug the iPhone ` -->
    <!-- lit electron/services/backupService.ts:348 `straight into this computer without a hub, and check that neither device is going ` -->
    <!-- lit electron/services/backupService.ts:349 `to sleep.` -->
- **Log:** exit code **255**, plus `usbmuxd_send returned -32 (Broken pipe)`,
  and **no** `ErrorCode <N>:` line from the phone. Keepr picks this cause only
  when the phone reported no code. The broken-pipe line by itself is not
  evidence (§2). `[BackupService] File transfer started after <N>s of waiting
  for the device` marks a mid-transfer drop.
  <!-- lit electron/services/backupService.ts:1681 `[BackupService] File transfer started after ` -->
- **Cause:** the USB link dropped before the phone could report anything.
  Before transfer, the likely causes are a bad cable, port, hub or dock. Once
  transfer has started, the likely causes are either device going to sleep, USB
  power management, a hub, or an unplug. A cable fault is the least likely at
  that point.
- **Do:** follow the sentence the user saw. If drops keep happening, use the
  flapping steps in §3.3.

### 3.5 Backup service stuck on the iPhone

- **Portal:** Reason `SERVICE_UNAVAILABLE` ("The device service was
  unavailable"), Ended by `device-error`.
- **User saw:**
  > Your iPhone's backup service did not respond. Unplug the iPhone, wait ten seconds, plug it back in and unlock it, then try once. Repeated quick retries are what causes this, so give it a moment rather than syncing again straight away.
  <!-- lit electron/services/backupService.ts:357 `Your iPhone's backup service did not respond. Unplug the iPhone, wait ten ` -->
  <!-- lit electron/services/backupService.ts:358 `seconds, plug it back in and unlock it, then try once. Repeated quick retries ` -->
  <!-- lit electron/services/backupService.ts:359 `are what causes this, so give it a moment rather than syncing again straight away.` -->
- **Log:** exit code **255**, with
  `mobilebackup2_client_new(): version exchange failed, error -5` or
  `Could not perform backup protocol version exchange, error code -1`, and
  **no** `Device disconnected` events. That absence separates this cause from
  §3.3.
  <!-- lit electron/services/backupService.ts:428 `version exchange failed|Could not perform backup protocol version exchange` -->
- **Cause:** the backup service on the phone stopped responding. This usually
  follows several aborted attempts in quick succession. (Cause 3 in §7.)
- **Do:** unplug, wait 10 seconds, replug, unlock, then make **one** attempt.
  Do not retry in a loop; that is what causes this state. If it persists on a
  Mac, run `sudo launchctl kickstart -k system/com.apple.usbmuxd`, then restart
  the phone.

### 3.6 Not enough real free space on the computer

This cause can show up three ways.

**(a) The phone refused: Reason `INSUFFICIENT_SPACE`** ("Not enough free space
on the computer"), Ended by `device-error`.

- **User saw:**
  > Not enough free disk space on this computer to back up your iPhone. Your computer may report far more space than this: it can count space held by local snapshots as free, and a backup cannot use it. Deleting files often frees nothing while those snapshots are holding them.
  <!-- lit electron/services/backupService.ts:298 `Not enough free disk space on this computer to back up your iPhone. ` -->
  <!-- lit electron/services/backupService.ts:299 `Your computer may report far more space than this: it can count space held by local ` -->
  <!-- lit electron/services/backupService.ts:300 `snapshots as free, and a backup cannot use it. Deleting files often ` -->
  <!-- lit electron/services/backupService.ts:301 `frees nothing while those snapshots are holding them.` -->
- **Log:** `ErrorCode 105: Insufficient free disk space on drive to back up (MBErrorDomain/105)`,
  exit code **151**, and `device_error_code` 105 on the run. The same sentence
  is also used when the tool reports "No space left on device", and when the
  disk filled mid-transfer. In those two cases, there may be no 105 line.
  <!-- lit electron/services/backupService.ts:226 `/no space left on device/i,` -->
- **Note:** the phone's own wording, "on drive", names no drive. The disk that is
  full is the **computer's**, not the phone's. On 2026-08-27 the founder checked his
  phone, saw 80 GB free there, and concluded the app was broken.

**(b) Keepr stopped the backup mid-transfer: Ended by `host-guard`**
("Stopped by the app to protect the computer"). Reason is empty.

- **User saw** (numbers filled in at run time, then one closing sentence about
  the unfinished backup):
  > Sync stopped to protect your computer: free disk space fell to *N* GB (below the *R* GB this sync keeps in reserve) while the iPhone backup was running.
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1981 `Sync stopped to protect your computer: free disk space fell to ` -->
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1982 ` GB this sync keeps in reserve) while the iPhone backup was running. ` -->
- **Log:** `[DeviceSyncOrchestrator] Sync aborted mid-transfer: disk space`.
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1984 `[DeviceSyncOrchestrator] Sync aborted mid-transfer: disk space` -->

**(c) Refused before starting.** Reason and Ended by are both empty.

- **User saw** (sizes filled in):
  > iPhone sync requires at least *X* of free space. You currently have *Y* available.
  <!-- lit electron/services/diagnostics/userFacingErrors.ts:74 `iPhone sync requires at least ${requiredStr} of free space. You currently have ${availableStr} available.` -->
- **Log:** `Sync refused: free space below reserve` or `Pre-sync disk space
  check failed`.
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1636 `[DeviceSyncOrchestrator] Sync refused: free space below reserve` -->
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1105 `[DeviceSyncOrchestrator] Pre-sync disk space check failed` -->

- **Cause (all three):** the computer's **real** free space is too low. The
  user will often say they have plenty of space. Read §4 before replying.
  (Cause 4 in §7.)
- **Do:** follow §4. Deleting files may free nothing.

### 3.7 iPhone locked

- **Portal:** Reason `DEVICE_LOCKED` ("The phone was locked"), Ended by
  `device-error`.
- **User saw:**
  > iPhone is locked. Please unlock your iPhone and try again, and leave it unlocked while the sync runs.
  <!-- lit electron/services/backupService.ts:305 `iPhone is locked. Please unlock your iPhone and try again, and leave it unlocked ` -->
  <!-- lit electron/services/backupService.ts:306 `while the sync runs.` -->
- **Log:** `ErrorCode 208: Device locked (MBErrorDomain/208)`, exit code
  **48**, and `device_error_code` 208 on the run.
  `*** Waiting for passcode to be entered on the device ***` normally appears
  just before this, but it also appears in healthy runs while the user enters
  the passcode.
- **Cause:** the phone really was locked when the backup asked for it. Since
  BACKLOG-2913, this sentence appears **only** when the phone reports 208. If a
  user sees it, believe it.
- **Do:** unlock the phone, keep it unlocked and connected until the sync
  finishes, then try again.

### 3.8 iPhone check timed out

- **Portal:** Reason `IPHONE_TOOL_TIMEOUT`, Ended by `tool-timeout`.
- **User saw** a heading, a sentence and numbered steps:
  > **This is taking longer than expected**
  > Keepr's iPhone check did not finish within 90 seconds, so Keepr stopped it. Sometimes security software pauses Keepr's iPhone tools while it checks them.
  <!-- lit electron/services/diagnostics/userFacingErrors.ts:314 `This is taking longer than expected` -->
  <!-- lit electron/services/diagnostics/userFacingErrors.ts:315 `did not finish within ${QUERY_TIMEOUT_SECONDS} seconds, so Keepr stopped it. Sometimes security software pauses Keepr's iPhone tools while it checks them.` -->
  <!-- lit electron/services/iphoneToolLimits.ts:19 `export const IPHONE_QUERY_TIMEOUT_MS = 90_000;` -->
  The steps tell the user to keep the phone unlocked and connected, check for
  an antivirus alert about Keepr, then wait and select **Try Again**.
- **Log:** a `... did not answer within 90s; stopped it` line. Examples:
  `[BackupService] Encryption check did not answer within 90s; stopped it`, or
  the device-info query.
  <!-- lit electron/services/backupService.ts:1239 `Encryption check did not answer within ` -->
- **Cause:** a short iPhone query before the backup (the storage query or the
  encryption check) did not finish within 90 seconds. Security software is one
  possible cause, not a verdict.
- **Do:** follow the on-screen steps. Wait a few seconds before Try Again: a
  sync started straight away is refused for 5 seconds.
  <!-- lit electron/services/diagnostics/userFacingErrors.ts:308 `a sync started again at once is refused for 5 seconds.` -->

### 3.9 Backup made no progress (watchdog)

- **Portal:** Reason `BACKUP_TIMEOUT` ("The backup ran out of time"), Ended by
  `watchdog` ("Stopped by the watchdog after no progress").
- **User saw** one of two headings, each with numbered steps:
  - > **The backup stopped making progress**
    > The backup made no progress for 30 minutes, so Keepr stopped it.
    <!-- lit electron/services/diagnostics/userFacingErrors.ts:381 `The backup stopped making progress` -->
    <!-- lit electron/services/diagnostics/userFacingErrors.ts:382 `The backup made no progress for ${WATCHDOG_MINUTES} minutes, so Keepr stopped it.` -->
  - *If the "antivirus may have paused the backup" notice was showing when the watchdog fired:*
    > **Your antivirus may have paused the backup**
    > Something on this computer, usually antivirus software, paused the tool Keepr uses to back up your iPhone. The backup made no progress for 30 minutes, so Keepr stopped it.
    <!-- lit electron/services/diagnostics/userFacingErrors.ts:366 `Your antivirus may have paused the backup` -->
    <!-- lit electron/services/diagnostics/userFacingErrors.ts:367 `Something on this computer, usually antivirus software, paused the tool Keepr uses to back up your iPhone. The backup made no progress for ${WATCHDOG_MINUTES} minutes, so Keepr stopped it.` -->
  <!-- lit electron/services/iphoneToolLimits.ts:26 `export const BACKUP_WATCHDOG_NO_PROGRESS_TIMEOUT_MS = 1_800_000;` -->
- **Log:** `Backup process became unresponsive and was terminated`.
  <!-- lit electron/services/backupService.ts:1809 `Backup process became unresponsive and was terminated` -->
- **Cause:** the backup tool produced no progress for 30 minutes. The usual
  causes are security software suspending it, or the phone locking or sleeping
  partway through.
- **Do:** follow the on-screen steps: keep the phone unlocked and connected, and
  on Windows check the antivirus for an alert or quarantined Keepr files.

### 3.10 Antivirus blocked the iPhone tools (Windows)

- **Portal:** Reason `TOOL_BLOCKED`, Ended by `tool-blocked`.
- **User saw** a heading, a sentence and numbered steps:
  > **Your antivirus blocked Keepr's iPhone tools**
  > Security software on this computer blocked one of the tools Keepr uses to connect to your iPhone.
  <!-- lit electron/services/diagnostics/userFacingErrors.ts:260 `Your antivirus blocked Keepr's iPhone tools` -->
  <!-- lit electron/services/diagnostics/userFacingErrors.ts:262 `Security software on this computer blocked one of the tools Keepr uses to connect to your iPhone.` -->
  The steps tell the user to open the antivirus, restore Keepr's files from its
  Quarantine list, add an exception for the Keepr folder, and reopen Keepr.
  They end with "If this keeps happening, contact support."
  <!-- lit electron/services/diagnostics/userFacingErrors.ts:237 `If this keeps happening, contact support.` -->
- **Log:** `[DeviceSyncOrchestrator] iPhone tool files missing`, listing the
  missing files.
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1124 `[DeviceSyncOrchestrator] iPhone tool files missing` -->
- **Cause:** security software removed or blocked one of the bundled iPhone
  tools, so the tool never started.
- **Do:** follow the on-screen steps. Restore the files first; an exception on
  its own does not bring back a quarantined file.

### 3.11 An error Keepr has no explanation for

- **Portal:** Reason `UNKNOWN_ERROR` ("The device reported an error it could
  not name"), Ended by `device-error`.
- **User saw** one of two sentences:
  - *The phone reported a code Keepr has not mapped.* The sentence names the
    number and quotes the phone's own words:
    > The backup stopped with error *N*. Your iPhone reported: "*the phone's description*". Keepr does not have a specific explanation for this one — please send this message to support.
    <!-- lit electron/services/backupService.ts:670 `The backup stopped with error ${code}.${quoted} ` -->
    <!-- lit electron/services/backupService.ts:671 `Keepr does not have a specific explanation for this one — please send this ` -->
  - *Nothing reported a reason:*
    > The backup stopped and neither this computer nor your iPhone reported a reason (exit code *N*). Please try again with your iPhone unlocked and plugged in directly. If it keeps happening, send this message to support.
    <!-- lit electron/services/backupService.ts:813 `The backup stopped and neither this computer nor your iPhone reported a reason` -->
    <!-- lit electron/services/backupService.ts:816 `keeps happening, send this message to support.` -->
- **Do:** record the error number, or the exit code, in the ticket and
  escalate. A new number is worth a backlog item: in the 90 days to
  2026-11-05, no run recorded an unmapped code.

### 3.12 No reason recorded

- **Portal:** Reason empty, and Ended by empty or `app-quit`.
- **What it means:**
  - `app-quit`: Keepr was closed during the backup. The user saw
    "Backup stopped because Keepr was closed."
    <!-- lit electron/services/backupService.ts:295 `Backup stopped because Keepr was closed.` -->
  - **Both empty:** the sync was refused at a check before the backup started.
    Examples are the up-front disk check (§3.6 c), the Windows driver checks,
    and runs from older builds that did not record a reason. In the 90 days to
    2026-11-05, 25 error runs had no reason, no ended-by and no device code.
- **Do:** ask the user for the exact on-screen sentence, then match it against
  this section list. If the screen showed no sentence, the fallback was:
  > The sync stopped before it finished. Check that your iPhone is connected and unlocked, then select Try Again.
  <!-- lit src/components/iphone/IPhoneSyncFlow.tsx:20 `The sync stopped before it finished. Check that your iPhone is connected and unlocked, then select Try Again.` -->

---

## 4. The disk trap — read this before any disk-space reply

**macOS can show a user about 10 times more free space than a backup can
use.** These readings were taken on the founder's Mac on 2026-08-27, within one
minute of each other:

| Source | Reported free |
|---|---|
| macOS Storage pane (what the user reads) | **283 GB** |
| `df -k /System/Volumes/Data` | **23 GB** |
| `diskutil info`, Container Free Space | **24 GB** |
| What Electron sees (`fs.statfsSync()`) | **24 GB** |
| **What the backup tool reports to the phone** | **23 GB** |

The gap is **purgeable** space: local Time Machine snapshots plus iCloud files
macOS can evict. The Storage pane counts it as free. Nothing else does.

**Deleting files can free nothing.** Deleted blocks stay held in the snapshots,
so the Storage pane number goes **up** while the real number stays put or goes
**down**. Measured three times in a row that evening:

```
deleted 20 GB backup      ->  4 GB actually freed
deleted 26 GB attachments ->  0 GB actually freed
deleted a 25 GB file      ->  0 GB actually freed
```

**"macOS will purge it when needed" is false here.** macOS reclaims purgeable
space when something is writing. The backup tool refuses **before writing a
single byte**, so macOS never purges.

### What works

The fix is the local snapshots:

```bash
sudo tmutil deletelocalsnapshots /     # deletes every local snapshot on the volume
```

On 2026-08-27 this removed 17 snapshots and took free space from 22 GB to
256 GB.

**Do not give the user the one-snapshot-at-a-time form.**
`tmutil deletelocalsnapshots com.apple.TimeMachine.<date>.local` fails with
"is not a valid disk". The command wants the bare date, with no prefix and no
`.local`. The `/` form above avoids the problem.

**If the user wants to keep their restore points:**

- Local snapshots expire 24 hours after they are made. Turning Time Machine off
  and waiting a day clears them.
- Connecting the Time Machine drive and letting a backup finish also makes
  macOS release them.

**Also check iCloud Drive.** The `bird` process can download files in the
background. On 2026-08-27 it downloaded about 2 GB a minute and undid every
attempt to free space. `killall -STOP bird` pauses it and
`killall -CONT bird` resumes it. While it is paused, the macOS Storage pane
**hangs**, because it asks iCloud for its breakdown.

---

## 5. How much free space is actually needed

**BACKLOG-2918 is still pending.** Until it lands, the app's own number is too
low for a first backup. At `f285f8863`:

- With no earlier backup, the app estimates the backup at **25% of the phone's
  used space**. The code marks this figure UNVALIDATED.
  It then asks for **1.5×** that estimate, which is about 38% of used space.
  With a complete earlier backup, the estimate is that backup's measured size
  and the app asks for 1.1×.
  <!-- lit electron/services/deviceDetectionService.ts:1624 `const BACKUP_SIZE_RATIO = 0.25; // UNVALIDATED — see BACKLOG-2896` -->
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1817 `const headroom = estimate.source === "existing-backup" ? 1.1 : 1.5;` -->
- When a known estimate does not fit, the app **only warns and continues**. The
  log says `Low disk space warning: ... Proceeding anyway.` The phone then
  refuses with 105 (§3.6 a).
  <!-- lit electron/services/deviceSyncOrchestrator.ts:1835 `GB available. Proceeding anyway.` -->

**Working rule until 2918 lands:** for a first full backup, the computer needs
roughly as much **real** free space (as `df` reports it, §4) as the phone has
**used**. One phone, measured on 2026-08-27, had about 47 GB used. It refused
at 24, 25, 26 and 35.6 GB free, and accepted at 52.6 GB.

Once a complete backup exists, later syncs are incremental and much smaller. A
**partial** backup does not help: there is no resume for an interrupted
first backup.

---

## 6. Diagnostic commands (safe, read-only)

```bash
# Real free space: the only number that matters (macOS)
df -h /System/Volumes/Data

# How many local snapshots are holding space
tmutil listlocalsnapshots / | grep -c com.apple.TimeMachine

# Is the phone reachable and paired at all?
idevicepair validate
ideviceinfo -k ProductType

# Is the phone's BACKUP SERVICE healthy? (separates §3.5 from everything else)
idevicebackup2 -u <UDID> info /tmp/probe
#   "ErrorCode 4 ... Status.plist"         -> service is HEALTHY (normal for an empty folder)
#   "version exchange ... error code -1"   -> service is STUCK  -> §3.5
```

No shell command returns the Storage pane's purgeable-inclusive figure. `df`,
`diskutil` and `system_profiler` all report the real one. Ask the user to read
it from **System Settings → General → Storage** if you need it for comparison.

Do not paste the `<UDID>` you use here into a ticket or a public channel.

---

## 7. History: four causes, one message

On 2026-08-27, every iPhone sync failure showed the same sentence: "iPhone is
locked. Please unlock your iPhone and try again." This happened even with the
phone unlocked in the user's hand. The cause was the routine `Locked` log
lines in §2. BACKLOG-2913 fixed this, and each cause now has its own sentence.
The four causes from that evening map to today's sections as follows:

| # | Cause as first recorded | Today |
|---|---|---|
| 1 | Device storage query returned nothing | §3.1 `BACKUP_SIZE_UNKNOWN`, or §3.2 `DEVICE_NO_ANSWER` |
| 2 | USB link flapping (exit 255) | §3.3 `device-disconnect` when Keepr saw the unplug, otherwise §3.4 `CONNECTION_LOST` |
| 3 | Backup service stuck on the phone (exit 255, no disconnects) | §3.5 `SERVICE_UNAVAILABLE` |
| 4 | Not enough real free space on the Mac (105, exit 151) | §3.6 `INSUFFICIENT_SPACE` |

A fifth cause was added the next day: a phone that really was locked (208,
exit 48), §3.7.

---

## Related items

- **BACKLOG-2913** — the one-message bug. Each cause now has its own sentence.
- **BACKLOG-2950** — the phone's error code reaches Sentry as a tag (PR-A) and
  the portal run card (PR-B). Both are pending.
- **BACKLOG-2918** — refuse up front when a backup will not fit. Pending; see §5.
- **BACKLOG-4124** — `DEVICE_NO_ANSWER`. In testing.
- **BACKLOG-2911** — interrupted backups.
