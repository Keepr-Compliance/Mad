# Backup Research: what idevicebackup2 can and cannot be asked for

> **Status:** rewritten 2026-08-26 under BACKLOG-2910.
>
> An earlier version of this file existed, was cited from four places in the
> source, and was then archived out of the repository — leaving every citation
> dangling. Worse, its central recommendation was **false**: it listed
> `--skip-apps` as a backup option ("USEFUL FOR SIZE REDUCTION"). That single
> line is the origin of a belief the code carried for months. It is not restored
> verbatim here, deliberately. What follows separates what was **measured** from
> what is **inferred**.

## Executive summary

Two independent limits, often confused with each other:

1. **No domain filtering.** The iOS MobileBackup2 protocol has no way to request
   a subset of domains. Unchanged and still true — this is the claim the source
   correctly cites this document for.
2. **No app exclusion either.** The `backup` command of `idevicebackup2` accepts
   exactly one option: `--full`. `--skip-apps` is a **restore** option meaning
   *do not trigger re-installation of apps after restore*. Passing it to `backup`
   is accepted and does nothing.

**Consequence: every backup this product has ever taken is a full device backup,
app data included.** The argv cannot influence backup size at all.

## 1. The `--skip-apps` correction (MEASURED)

`--help`, from both binaries this project uses. `--skip-apps` appears only in the
`restore` block; `backup` lists only `--full`:

```
CMD:
  backup        create backup for the device
    --full              force full backup from device.
  restore       restore last backup to the device
    ...
    --skip-apps         do not trigger re-installation of apps after restore
```

### The A/B measurement

Run 2026-08-26 against `idevicebackup2 1.4.0` (Homebrew, macOS).
`USBMUXD_SOCKET_ADDRESS=127.0.0.1:1` forces the device connection to fail
*after* argv is fully parsed, so argument handling is exercised end to end
without touching any attached device.

| # | Invocation (`-d -u <fake-udid> … <dir>`) | exit | stdout sha256 |
|---|---|---|---|
| A | `backup` | 255 | `dd1bedf5d68aa0358f2abe756ff634cd952b187d2b16d4a0bbb8cd8d89b22db1` |
| B | `backup --skip-apps` | 255 | `dd1bedf5…b22db1` (**identical to A**) |
| C | `backup --not-a-real-flag` | **2** | *(empty; usage error on stderr)* |

stderr was empty (`e3b0c442…`) for both A and B.

**C is the control that makes A≡B mean something.** The parser *does* reject
unknown long options — `idevicebackup2: unrecognized option '--not-a-real-flag'`,
exit 2. So `--skip-apps` is not junk being silently discarded; it is a
**recognised global option that the backup path never consults**.

### Corroboration in the binary we actually ship (MEASURED)

`strings resources/win/libimobiledevice/idevicebackup2.exe` places `--skip-apps`
inside the restore option group, between `--remove` and `--password`:

```
--no-reboot  --copy  --settings  --remove  --skip-apps  --password
```

### What is INFERRED

That the option is parsed in a single flat pass over `argv` (hence "accepted
globally, read only by restore") rather than per-command. The observable
behaviour above is fully consistent with it, and upstream Debian/Arch man pages
document `--skip-apps` as restore-only, but the source was not read as part of
this work.

## 2. Measured cost of a full backup

From the founder's Windows run, 2026-08-26 (BACKLOG-2900):

| | |
|---|---|
| backup on disk | **58.8 GB** (58,761,372,853 bytes) |
| `Manifest.db` | **863 MB** |
| incremental duration | **20.1–23.5 min**, for a net gain of 1–13 messages |
| effective throughput | ~5–6 MB/s |
| app's own size estimate | **3.7 GB** — a 15.9x underestimate |

`Manifest.db` scales with **file count**, not bytes, and on an incremental it
crosses the wire in **both directions**. Cutting file count is therefore the
lever that would matter — and it is exactly the lever the argv does not offer.

## 3. Post-transfer pruning: feasibility notes (NOT a decision)

Pruning unwanted domains from the backup directory *after* transfer would not
save transfer time, but would reclaim most of the 58.8 GB. **Whether to do it is
the founder's call — it means deleting from a user's backup.** These are the
facts a decision would rest on.

### Prior art

`extractHomeDomainOnly()` was written for exactly this (commit `4a64a89d3`,
"add post-backup HomeDomain extraction to reduce storage"). It **never reached
`develop`** — it exists only on the abandoned `claude/complete-task-006/007`
branches. Nothing in the shipping product prunes anything.

### It would work, mechanically (MEASURED from the code)

- **Parsers do not scan the directory.** They compute `SHA1(domain-relativePath)`
  and open that filename directly (`iosMessagesParser.computeBackupFileHash`,
  `REQUIRED_BACKUP_FILES`). A directory missing unrelated files is invisible to
  them.
- **`checkBackupStatus` would still report the backup complete.** It requires
  only `Manifest.db` and `Info.plist` to exist (`backupService.ts`), plus a size
  calculation. Pruning content files does not make it report incomplete.
- **Encrypted backups also resolve by `fileID`** through `Manifest.db`
  (`backupDecryptionService`), so the same holds.

### Three hazards that must be answered first

1. **HomeDomain alone is the wrong filter — it would destroy attachments.**
   SMS attachments live in **`MediaDomain`**, not HomeDomain
   (`iosMessagesParser.ts:105`, `resolveAttachmentPath`). The prior-art
   `extractHomeDomainOnly()` would have deleted every message attachment the
   product reads. Any prune must keep `HomeDomain` **and** the
   `MediaDomain/Library/SMS/Attachments/` subtree.
2. **Pruning silently under-provisions the disk guard.** `checkBackupStatus`
   returns `sizeBytes` from `calculateBackupSize`; the orchestrator uses it as
   `existingBackupSize` and, when non-zero, takes it as the estimate with only
   **1.1x** headroom (versus 1.5x for a fresh estimate). Prune 58.8 GB down to
   ~2 GB and the next run asks the disk for ~2.2 GB before an operation that
   still needs tens of GB — because the device re-sends whatever the manifest
   says is missing. This directly weakens BACKLOG-2899. *(Mechanism traced in
   code; the re-send behaviour in the next clause is inferred.)*
3. **The effect on the next incremental is UNKNOWN and is the real question.**
   *(INFERRED, not measured.)* An incremental hands the device the existing
   `Manifest.db`. If files are deleted but left listed in the manifest, the
   likely outcomes are either (a) the device does not re-request them, leaving a
   permanently inconsistent backup that would fail any future restore, or
   (b) it does re-request them, and the pruning is undone every sync while
   costing a full re-transfer. **These have opposite implications and nobody has
   measured which one happens.** A single instrumented run on a real device
   settles it, and no pruning should be built before it does.

## 4. Alternatives, unchanged from the original research

- **pymobiledevice3** — same protocol, same limit. Domain-based *extraction*
  from an existing backup, no selective backup creation.
- **iTunes/Finder backup + parse** — sidesteps the transfer entirely; out of
  scope as previously assessed.

## 5. Standing rule

Do not add an option to `buildBackupArgs` that the `backup` command does not
document. It will be accepted, it will do nothing, and — as this file's own
history demonstrates — the comment explaining it will outlive the person who
could have corrected it.
