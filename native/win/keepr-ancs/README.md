# keepr-ancs (BACKLOG-3839 spike)

Windows-only console helper. It connects to a paired iPhone over Bluetooth LE, subscribes
to Apple Notification Center Service (ANCS), and prints each incoming text as one JSON line.

This is a go/no-go spike for Phase 2 (Electron bridge). It has **not been compiled or run** —
it was written on a Mac with no .NET SDK. The first run on Windows is also its first build.

## Layout

| Folder | What | Target |
|---|---|---|
| `KeeprAncs/` | The console app (`keepr-ancs.exe`). Only code that touches WinRT. | `net8.0-windows10.0.19041.0` |
| `KeeprAncs.Core/` | Pure ANCS byte parsing + JSON output. No WinRT. | `net8.0` |
| `KeeprAncs.Tests/` | xunit tests for the parsers. | `net8.0` |

## Founder test steps (Windows 10 2004+ / Windows 11)

1. Install the **.NET 8 SDK** (x64) from Microsoft, then open a new PowerShell and check `dotnet --version` prints `8.x`.
2. **Quit Phone Link** (right-click its tray icon > Close, or Task Manager > end "Phone Link"). It may hold the ANCS subscription.
3. Pair the iPhone: Windows **Settings > Bluetooth & devices > Add device > Bluetooth**, pick the iPhone, confirm the code on both screens.
4. On the iPhone:
   - **Settings > Bluetooth > (i) next to this PC > Share System Notifications = ON.**
   - **Settings > Notifications > Show Previews = Always.**
   - **Settings > Notifications > Messages > Allow Notifications = ON.**
5. In PowerShell:
   ```powershell
   cd <repo>\native\win\keepr-ancs
   dotnet test KeeprAncs.Tests                       # parser tests; should all pass
   dotnet run --project KeeprAncs -- --list          # shows paired devices
   dotnet run --project KeeprAncs -- --pretty        # human-readable live log
   ```
   If more than one device is listed, add `--device "iPhone"` (any part of the name, or the full id).
6. Send the iPhone a text from another phone. Expected line: `[2026-10-09T14:30:12] [Sender Name]: message text`.
7. If nothing prints, run without `--pretty` and add `--all-apps`, then copy every `"type":"error"` line into the table below.

Stop with **Ctrl+C**.

### Flags

| Flag | Effect |
|---|---|
| `--pretty` | `[Timestamp] [Sender]: [Body]` instead of JSON for message lines |
| `--all-apps` | Print every app's notifications, not only Messages (`com.apple.MobileSMS`) |
| `--device <s>` | Pick the device by id or name substring |
| `--list` | List paired devices and exit |
| `--max-message <n>` | Message length requested from the iPhone (default 1000) |
| `--retry-seconds <n>` | Wait before reconnecting after a drop (default 5) |
| `--response-timeout <n>` | Seconds to wait for a Data Source response (default 10) |

## stdout contract

One JSON object per line. Extra fields are diagnostics; consumers ignore unknown fields.

```json
{"type":"message","ts":"2026-10-09T14:30:12","sender":"...","body":"...","appId":"com.apple.MobileSMS","preExisting":false,"uid":12,"category":"Social","bodyLength":42,"receivedAt":"2026-10-09T18:30:12.345Z"}
{"type":"status","state":"searching|connected|disconnected","detail":"...","device":"..."}
{"type":"error","stage":"get-ancs-service","message":"...","gattStatus":"Unreachable","protocolError":5,"protocolErrorName":"...","hresult":"0x80070490"}
```

- `ts` is the iPhone's **local** time from the ANCS Date attribute. The wire value has no time zone, so `ts` has no `Z`/offset. `receivedAt` is the PC's UTC clock.
- `sender` is the ANCS Title (contact name or number as the iPhone shows it). `subtitle` appears when non-empty (may carry a group name — unmeasured).
- `preExisting: true` = notification already on the iPhone when the helper connected.

### Error stages, in order

`enumerate-devices` > `select-device` > `connect` > `gatt-session` > `get-ancs-service` > `service-access` > `service-open` > `get-characteristic-{notification-source,control-point,data-source}` > `subscribe-data-source` > `subscribe-notification-source` > `write-control-point` > `data-source-timeout` / `parse-data-source` / `parse-notification-source`. `fatal` = uncaught.

Reading them:
- `get-ancs-service` with zero services: Share System Notifications is off, or Windows is not seeing the iPhone's LE side.
- `subscribe-*` with `protocolError` 5 or 15: link not bonded/encrypted — iOS refuses ANCS.
- `write-control-point` with `protocolError` 0xA0–0xA3 (160–163): ANCS command errors (Unknown command / Invalid command / Invalid parameter / Action failed). 163 is normal when a notification is dismissed before it is fetched.
- Only `searching` lines listing `paired Classic device` and no LE candidate: the pairing is Classic-only and ANCS cannot be reached.

## Measurement checklist (BACKLOG-3839 acceptance — fill in on the founder's PC)

| # | Measurement | Expected (from Phone Link reports, unmeasured) | Observed | Notes / raw line |
|---|---|---|---|---|
| 1 | Do live texts print? If not: failing **stage**, `gattStatus`, `protocolError`, `hresult` | prints | | |
| 2 | Text sent **from** the iPhone | NOT captured | | |
| 3 | Text arriving while that thread is **open** on the iPhone | unknown (iOS may suppress the banner) | | |
| 4 | Body length where truncation starts (send 200 / 500 / 1000 / 1500 chars; compare `bodyLength`) | truncated at some length | | |
| 5 | After a Bluetooth dropout (walk out of range ~1 min, or toggle iPhone Bluetooth): reconnects? texts during the gap? | reconnects; gap lost | | |
| 6 | **Group** text | not usable / unknown | | |
| 7 | **iMessage** (blue) vs **SMS** (green) — both arrive as `com.apple.MobileSMS`? | both | | |
| 8 | Same tests with Phone Link **running** | unknown | | |

If row 1 is blocked, the ESP32 fallback is written up as a follow-up item; it is not built here.

## Not done in this spike

No Electron integration, no bundling under `resources/win`, no CI job, no code signing.
