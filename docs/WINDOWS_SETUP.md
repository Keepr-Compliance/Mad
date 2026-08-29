# Keepr - Windows Setup Guide

This guide explains how to use Keepr on Windows to sync messages and contacts from your iPhone.

## System Requirements

- **Operating System:** Windows 10 (version 1903 or later) or Windows 11
- **iTunes:** Required for Apple device drivers
- **iPhone:** iOS 15 or later
- **USB Cable:** Lightning or USB-C cable for iPhone connection

## Installation

### Step 1: Install iTunes

iTunes is required for the Apple Mobile Device drivers that allow Windows to communicate with your iPhone.

**Option A: Microsoft Store (Recommended)**
1. Open the Microsoft Store
2. Search for "iTunes"
3. Click "Get" to install

**Option B: Apple Website**
1. Visit [apple.com/itunes](https://www.apple.com/itunes/)
2. Download the Windows installer
3. Run the installer and follow the prompts

> **Note:** After installing iTunes, you may need to restart your computer.

### Step 2: Install Keepr

1. Download the Keepr installer from [your download location]
2. Run the installer
3. Follow the installation wizard
4. Launch Keepr from the Start Menu

## First-Time iPhone Sync

### Step 1: Connect Your iPhone

1. Connect your iPhone to your Windows PC using a USB cable
2. **Unlock your iPhone** - the screen must be on and unlocked

### Step 2: Trust This Computer

When you connect your iPhone to a new computer:

1. A prompt will appear on your iPhone: **"Trust This Computer?"**
2. Tap **"Trust"**
3. Enter your iPhone passcode to confirm

> **Important:** If you don't see the prompt, disconnect and reconnect your iPhone, then unlock it.

### Step 3: Start the Sync

1. In Keepr, your iPhone should appear in the device list
2. Click **"Sync from iPhone"**
3. Wait for the sync to complete

### Step 4: Encrypted Backup (If Required)

If you've previously enabled "Encrypt iPhone backup" in iTunes:

1. Keepr will prompt you for your backup password
2. Enter the password you set when enabling encrypted backups
3. Click **"Continue"**

> **Forgot your password?** Unfortunately, there's no way to recover a forgotten backup password. You would need to reset your backup settings on your iPhone by going to Settings > General > Transfer or Reset iPhone > Reset > Reset All Settings.

## Sync Duration

The first sync takes longer because it creates a complete backup:

| Scenario | Duration | Size |
|----------|----------|------|
| First sync | 20-45 minutes | as large as the used space on your iPhone |
| Subsequent syncs | 20-25 minutes | grows toward the same size |

Subsequent syncs transfer only new data, but they are **not** proportionally
faster: a measured incremental run on 2026-08-26 took 20-23 minutes to add a
handful of new messages, because the backup index itself is large and is sent
in both directions before any content moves.

> **Note on size:** the sync stores a **complete** iPhone backup, including app
> data. It is not possible to back up only messages and contacts — Apple's
> backup protocol has no option to request a subset, and `idevicebackup2` has no
> option to exclude apps from a backup. A measured run produced a **58.8 GB**
> backup. Make sure the destination drive has room for a full backup of your
> iPhone. An earlier version of this page claimed app data was excluded; that
> was wrong (BACKLOG-2910).

## Troubleshooting

### iPhone Not Detected

1. **Check USB Connection**
   - Try a different USB port (preferably USB-A)
   - Try a different cable
   - Connect directly to the PC, not through a hub

2. **Check iTunes Installation**
   - Open iTunes and verify it detects your iPhone
   - If iTunes doesn't see the iPhone, Keepr won't either

3. **Restart Services**
   - Open Services (Win+R, type `services.msc`)
   - Find "Apple Mobile Device Service"
   - Right-click and select "Restart"

4. **Reinstall Drivers**
   - Uninstall iTunes completely
   - Restart your computer
   - Reinstall iTunes

### "Trust This Computer" Not Appearing

1. **Unlock Your iPhone** - The prompt only appears when the phone is unlocked
2. **Disconnect and Reconnect** - Unplug the USB cable and plug it back in
3. **Restart iPhone** - Sometimes a restart is needed
4. **Reset Trust Settings** - On iPhone, go to Settings > General > Transfer or Reset iPhone > Reset > Reset Location & Privacy

### Sync Fails Partway Through

1. **Don't Disconnect** - Keep your iPhone connected and unlocked
2. **Check Storage** - Ensure you have at least 60 GB free on your Windows PC
3. **Try Again** - Click "Sync" again; incremental backup will resume from where it left off

### Wrong Password for Encrypted Backup

If you enter the wrong password:
1. Keepr will show an error
2. Click "Try Again"
3. Enter the correct password

If you don't remember the password:
1. You cannot sync with Keepr using encrypted backups
2. Option: Disable encrypted backups in iTunes
   - Open iTunes
   - Select your iPhone
   - Uncheck "Encrypt local backup"
   - Enter your current password to disable
   - Sync again with Keepr

### Slow Sync Speed

1. **Use USB 3.0** - Blue USB ports are faster
2. **Direct Connection** - Avoid USB hubs
3. **Close Other Apps** - Reduce disk I/O from other applications
4. **Defragment SSD/HDD** - Ensure your drive is optimized

## Security & Privacy

### Where is Data Stored?

- Backup data: `%APPDATA%\Keepr\Backups\`
- Extracted messages: Stored in encrypted local database
- Cleanup: Temporary backup files are deleted after extraction

### Is My Data Encrypted?

- **At Rest:** Yes, using SQLCipher AES-256 encryption
- **Backup Password:** If your iPhone backup is encrypted, that encryption is preserved
- **Windows DPAPI:** Authentication tokens are protected using Windows Data Protection API

### SOC 2 Compliance

Keepr on Windows meets the same SOC 2 compliance standards as the macOS version:
- Data encrypted at rest
- Secure credential storage
- Audit logging
- No cloud transmission of message data

## Comparison: Windows vs macOS

| Feature | Windows | macOS |
|---------|---------|-------|
| Message Source | iPhone backup via USB | Local Messages.app database |
| Sync Required | Yes (15-45 min first time) | No (instant access) |
| Contact Source | iPhone backup | Local Contacts.app |
| Encryption | AES-256 (SQLCipher) | AES-256 (SQLCipher) |
| Credential Storage | Windows DPAPI | macOS Keychain |

## Getting Help

If you continue to experience issues:

1. **Check Logs**
   - Open Keepr
   - Go to Help > View Logs
   - Look for error messages

2. **Contact Support**
   - Email: [support email]
   - Include: Windows version, iPhone model, iOS version, error messages

3. **Known Issues**
   - See our [GitHub Issues](https://github.com/your-repo/issues) for known problems and workarounds
