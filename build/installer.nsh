; ---------------------------------------------------------------------------
; Keepr NSIS custom installer hooks (BACKLOG-2114, BACKLOG-3417)
;
; Adds an OPTIONAL user-data cleanup question to the one-click (oneClick:true)
; uninstaller. This macro is !insertmacro'd by electron-builder inside the
; uninstall Section, AFTER un.onInit has run initMultiUser (which sets
; $installMode and the shell-var context). So ${isUpdated} and $installMode are
; authoritative here. ${Silent}/IfSilent is NOT -- see WHY NOT IfSilent below.
;
; See node_modules/app-builder-lib/templates/nsis/uninstaller.nsh
; (app-builder-lib 26.15.6):
;   Function un.onInit -> parses "/S" -> SetSilent silent (:12-16); with
;                         ONE_CLICK and no /S, shows "Are you sure you want to
;                         uninstall?" and then ALSO calls SetSilent silent
;                         (:21-28); then initMultiUser (:31, sets $installMode
;                         + SetShellVarContext).
;   Section un.<name>  -> `!insertmacro customUnInstall` (:156-157), then the
;                         default delete-app-data block, which runs only with
;                         --delete-app-data or DELETE_APP_DATA_ON_UNINSTALL
;                         (neither applies to Keepr) (:216-248).
;
; CRITICAL (silent/update safety): an update runs this uninstaller SILENTLY. The
; NEW installer calls the OLD uninstaller as
;   "<uninstaller>" /S /KEEP_APP_DATA /currentuser --updated _?=<dir>
; (templates/nsis/include/installUtil.nsh:224, retry :230; --updated added at
; :206). We must NEVER touch user data in that path, and NEVER show a MessageBox
; when the caller asked for silent (a modal in a silent update would hang the
; updater indefinitely). We bail on BOTH ${isUpdated} and a /S on the command
; line. Who passes what:
;   - Windows Settings / Add-Remove Programs: UninstallString, no /S
;     (include/installer.nsh:122) -> we ask.
;   - winget and similar tools: QuietUninstallString, /S
;     (include/installer.nsh:123) -> we never ask, never delete.
;   - In-app uninstall/reset (BACKLOG-2111): Start-Process ... -ArgumentList '/S'
;     (electron/services/appCleanupService.ts) -> we never ask; that flow deletes
;     the data itself.
;
; WHY NOT IfSilent (BACKLOG-3417): with oneClick:true, un.onInit calls
; `SetSilent silent` for EVERY uninstall, including one a person started from
; Windows Settings, right after its own "Are you sure" box -- uninstaller.nsh:25-27:
; "one-click installer executes uninstall section in the silent mode". IfSilent
; is therefore always true here and would skip the question for everyone.
; Instead we re-parse the real command line for /S exactly as un.onInit does
; (uninstaller.nsh:12-13) and as the stock delete-app-data block does inside
; this same Section (:219-221). SetSilent does not rewrite the command line, so
; we ask exactly when un.onInit showed its "Are you sure" box. This is also
; correct if oneClick is ever set back to false: there, un.onInit sets silent
; only when this same parse matches. GetOptions matches case-insensitively on
; the prefix, so any switch starting with /S counts as silent -- that errs
; toward NOT asking, which keeps data.
;
; WHY THE MessageBox STILL SHOWS WHILE THE UNINSTALLER IS SILENT: NSIS suppresses
; a MessageBox in silent mode ONLY when it carries an /SD default. NSIS
; Source/exehead/util.c, my_MessageBox:
;   if (g_exec_flags.silent && type >> 21) return type >> 21;
;   // no silent or no default, just show
; DO NOT add /SD to the MessageBox below: under oneClick the Section is always
; silent, so an /SD default would hide the question on every uninstall again.
; The /S check is what keeps it out of genuinely silent runs.
; `SetSilent normal` around the box is not an option: the NSIS docs say SetSilent
; "Can only be used in .onInit" (NSIS Docs/src/ui.but, SetSilent).
;
; MB_TOPMOST|MB_SETFOREGROUND: a silent uninstaller has no window to own the box,
; so ask Windows to bring it to the front. electron-builder uses the same flags
; for its own ownerless box (templates/nsis/installer.nsi:112).
;
; WHAT THE USER SEES: an interactive uninstall shows TWO dialogs in a row --
; electron-builder's "Are you sure you want to uninstall Keepr?" (OK/Cancel,
; uninstaller.nsh:22), then this question (Yes/No, No is the default). If Keepr
; is running, electron-builder's "app is running" box appears between them.
;
; CRITICAL (per-machine path): for a per-machine install ($installMode == "all")
; un.onInit runs `SetShellVarContext all`, so $APPDATA/$LOCALAPPDATA would
; resolve to C:\ProgramData instead of the user's Roaming/Local profile. Electron
; always writes its data under the USER profile, so we temporarily switch to
; `SetShellVarContext current` around the RMDir calls (then restore `all`),
; mirroring electron-builder's own delete-app-data block in uninstaller.nsh.
; (A one-click build with perMachine unset installs per-user, so $installMode is
; "CurrentUser" for new installs; the swap is kept for safety.)
;
; KNOWN LIMITATION (documented; matches electron-builder's own behaviour): on an
; IT-managed machine a standard user's per-machine uninstall UAC-elevates, so the
; uninstall Section (and this macro) re-runs as the ELEVATING ADMIN account. In
; that case `SetShellVarContext current` resolves to the admin's profile, not the
; original end user's, so the end user's data dirs are not removed. electron-
; builder's stock uninstaller has the identical limitation. The in-app uninstall/
; reset flow (BACKLOG-2111) is the primary full-cleanup path because it runs as
; the real user.
;
; NOTE (Windows secret storage): Keepr stores all secrets via Electron safeStorage
; (DPAPI on Windows); the encryption key lives in %APPDATA%\keepr\Local State and
; the DPAPI-encrypted material lives inside the two data dirs. Keepr creates NO
; Windows Credential Manager entries (no keytar / cmdkey usage anywhere in the
; codebase; "Keepr Safe Storage" is the macOS Keychain item name, not a Windows
; credential). Therefore deleting the two data directories IS the complete
; credential cleanup on Windows — no cmdkey step is needed.
; ---------------------------------------------------------------------------

!macro customUnInstall
  ; Skip entirely during an auto-update reinstall.
  ${ifNot} ${isUpdated}
    ; Skip entirely when the caller asked for a silent uninstall (/S on the
    ; command line). NOT IfSilent: always true under oneClick (see WHY NOT
    ; IfSilent above). GetOptions sets the error flag when /S is ABSENT, so
    ; clear it first -- a stale error from earlier in the Section must never
    ; read as "no /S" and put a modal in a silent run. Mirrors
    ; uninstaller.nsh:219-221. $R0/$R1 are overwritten by that stock block
    ; right after this macro, so using them here is safe.
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "/S" $R1
    IfErrors keepr_maybe_prompt keepr_skip_data_cleanup

    keepr_maybe_prompt:
      ; No /SD on purpose -- see WHY THE MessageBox STILL SHOWS above.
      MessageBox MB_YESNO|MB_DEFBUTTON2|MB_TOPMOST|MB_SETFOREGROUND "Also delete your Keepr data and saved credentials (emails, transactions, and DPAPI-encrypted secrets)? This cannot be undone." IDYES keepr_delete_data IDNO keepr_skip_data_cleanup
      Goto keepr_skip_data_cleanup ; fail-safe: a MessageBox that fails to show falls through to the next line, so keep the data

      keepr_delete_data:
        ; Electron always stores data under the USER profile. For a per-machine
        ; install the shell-var context is "all" (C:\ProgramData), so switch to
        ; the current user around the deletes, then restore. Mirrors electron-
        ; builder's own delete-app-data block in uninstaller.nsh.
        ; NOTE: under an elevated per-machine uninstall this resolves to the
        ; elevating admin's profile (see KNOWN LIMITATION above).
        ${if} $installMode == "all"
          SetShellVarContext current
        ${endif}
        RMDir /r "$APPDATA\keepr"
        RMDir /r "$LOCALAPPDATA\keepr"
        ${if} $installMode == "all"
          SetShellVarContext all
        ${endif}

      keepr_skip_data_cleanup:
  ${endIf}
!macroend

; ---------------------------------------------------------------------------
; MIGRATE A PRIOR PER-MACHINE INSTALL TO PER-USER (BACKLOG-3432)
;
; Keepr installs per-user so that it needs no administrator rights. Versions up
; to 2.37.0 shipped an assisted installer that offered "anyone who uses this
; computer" and landed in C:\Program Files\Keepr. Those two installs do not see
; each other: installSection.nsh:52 scans SHELL_CONTEXT, which is HKLM only
; after `SetShellVarContext all` (multiUser.nsh:64), and a one-click per-user
; install never sets that. :55-58 is the mirror case -- per-machine cleaning up
; per-user -- and is NOT the direction we need.
;
; Measured result of NOT doing this (BACKLOG-3431, run on a real Windows 11 PC):
; two install directories, two desktop icons identical in name, tooltip, icon
; and ProductVersion, two Add/Remove entries both reading "Keepr 2.37.0", and a
; natural launch that started the OLD binary. So this macro removes the
; per-machine install before the per-user one is written.
;
; All line citations below are app-builder-lib 26.15.6 (the version package.json
; pins), read from node_modules on disk.
;
; WHY customInit AND NOT customInstall: `!insertmacro customInit` sits at
; templates/nsis/installer.nsi:79-80, inside .onInit, AFTER
; check64BitAndSetRegView (:67, so SetRegView 64 is in effect) and AFTER
; initMultiUser (:77, so $installMode and $INSTDIR are authoritative). Nothing
; is on disk yet. customInstall (installSection.nsh:81-82) fires after
; installApplicationFiles (:66), registryAddInstallInfo (:67) and both shortcut
; macros (:68-69) -- aborting there would leave exactly the half-installed state
; this macro exists to prevent.
;
; WHY WE DO NOT REUSE `uninstallOldVersion` (include/installUtil.nsh:142-243),
; even though it accepts HKEY_LOCAL_MACHINE: at :184-189 it picks the mode flag
; with `${if} $installMode == "CurrentUser" ${orIf} $rootKey == ...`. The FIRST
; disjunct fires for any per-user install, so the per-machine uninstaller would
; be invoked with /currentuser, take assistedInstaller.nsh:129-133 ->
; setInstallModePerUser, and have its `_?=` directory overwritten
; (multiUser.nsh:26-48): a silent no-op that clears nothing in HKLM and never
; elevates. Its retry loop (:215-239) then runs five more times because the
; elevating path exits via a bare `Quit` (multiUser.nsh:70) with no
; SetErrorLevel -- six UAC prompts -- and handleUninstallResult (:128-133) ends
; by aborting the install with an error box. It would also pass
; --keep-shortcuts (:193-200), preserving the duplicate icons. Hence the
; hand-written invocation below.
;
; WHY WE DO NOT ELEVATE OURSELVES: the shipped uninstaller elevates itself.
; setInstallModePerAllUsers calls UAC_RunElevated when not admin
; (multiUser.nsh:66-72), compiled in because NsisTarget.js:450-451 defines
; INSTALL_MODE_PER_ALL_USERS_REQUIRED when `!oneClick || perMachine`, and 2.37.0
; shipped oneClick:false. `RequestExecutionLevel user` (installer.nsi:27) MUST
; stay: it is what lets Keepr install without admin rights. Calling
; UAC_RunElevated from here would re-run the WHOLE installer elevated, and
; one-click initMultiUser (oneClick.nsh:13-18) unconditionally calls
; setInstallModePerUser -- installing into the elevating ADMIN's profile.
;
; WHY THE USER'S DATA SURVIVES, on every version that ever shipped:
;   - 2.37.0 and later: its customUnInstall bails on `${ifNot} ${isUpdated}`
;     before IfSilent is reached, so --updated alone already skips the prompt
;     and the delete.
;   - Pre-BACKLOG-2114 builds: no customUnInstall at all; they fall to the stock
;     block at uninstaller.nsh:216-230, which needs --delete-app-data or
;     DELETE_APP_DATA_ON_UNINSTALL. We pass neither and Keepr sets neither.
;   /S is passed as well, which makes the 2.37.0 IfSilent branch skip too.
;   Both are load-bearing -- see the mutation note at the end of this comment.
;
; WHAT THE INVOCATION PRODUCES, traced through the shipped uninstaller:
;   /S          -> un.onInit sets silent (uninstaller.nsh:12-16) and calls
;                  un.checkAppRunning (:19) with $INSTDIR still the `_?=` value,
;                  so FIND_PROCESS (allowOnlyOneInstallerInstance.nsh:66) matches
;                  the Program Files processes and closes them. That is what
;                  fixes the "installed underneath a running app" finding.
;   --updated   -> keeps data (above) and skips the "app is running" modal
;                  (allowOnlyOneInstallerInstance.nsh:108-119).
;   /allusers   -> setInstallModePerAllUsers -> the UAC prompt.
;   no --keep-shortcuts -> uninstaller.nsh:190-207 deletes the Public Desktop and
;                  All-Users Start Menu shortcuts.
;   then RMDir /r $INSTDIR (:187) and DeleteRegKey SHELL_CONTEXT (:250-254).
;
; ORDER OF EVENTS WORTH KNOWING: un.checkAppRunning (:19) runs BEFORE
; initMultiUser (:31), so a user who declines the UAC prompt has still had Keepr
; closed. The explanatory box below is what lets them cancel before anything at
; all happens.
;
; SIDE EFFECT, stated plainly: this removes the per-machine install for EVERY
; account on the PC, not only the one running the installer. That is inherent to
; removing a per-machine install and is not avoidable.
;
; WHAT HAPPENS WHEN THE ELEVATION PROMPT IS DECLINED: the install stops and
; nothing on the machine changes. Founder decision of 2026-09-17 (recorded on
; BACKLOG-3432): attempt the migration on the silent path too, and a user who
; declines "stays on their current version" with no message; the mitigation is
; the install-mode telemetry plus direct contact, not a code path. Continuing to
; install instead would reproduce the double-install measured in BACKLOG-3431,
; which is strictly worse. Do not "soften" this by installing anyway.
;
; WHICH PATH IS SILENT, measured rather than assumed. Keepr calls
; `autoUpdater.quitAndInstall(false, true)` (electron/handlers/updaterHandlers.ts
; :155), so the user-initiated "Install update" reaches
; NsisUpdater.js:101-113 with isSilent=false and spawns `--updated --force-run`
; with NO /S -- that path is INTERACTIVE and does show the box below. Only the
; install-on-quit path is silent: BaseUpdater.js:88 calls install(true, false)
; when autoInstallOnAppQuit is set, which is its default (AppUpdater.js:114).
;
; BOTH MessageBoxes CARRY /SD DEFAULTS. They are unreachable in a silent run
; because of the ${IfNot} ${Silent} guards, but a modal that ever did reach one
; would hang the updater forever. The defaults are chosen to land on the founder
; decision, not against it: IDOK (proceed) on the explanation, IDCANCEL (stop) on
; the retry. This is the opposite call from the uninstall macro above, where a
; default would have suppressed the question for everyone -- different because
; there the Section is ALWAYS silent under oneClick, and here ${Silent} is
; genuine.
;
; VERIFICATION IS BY OUTCOME, NEVER BY EXIT CODE. The elevating uninstaller
; leaves its outer process via a bare `Quit` (multiUser.nsh:70) with no
; SetErrorLevel -- electron-builder has a whole `quitSuccess` macro to "avoid
; exit code 2" (common.nsh:78-82) -- so its exit code says nothing. We re-read
; HKLM in both registry views and check that the old Keepr.exe is gone.
;
; THE MUTATION THAT REDDENS THIS, for whoever verifies it: dropping /S ALONE
; proves nothing, because --updated makes the shipped macro bail one line
; earlier. Drop BOTH /S and --updated; the shipped assisted uninstaller then
; runs its full wizard and asks the delete-data question.
; ---------------------------------------------------------------------------

!macro customInit
  Var /GLOBAL keeprOldUninstallString
  Var /GLOBAL keeprOldInstallDir
  Var /GLOBAL keeprOldUninstaller
  Var /GLOBAL keeprScanBuf
  Var /GLOBAL keeprScanIdx
  Var /GLOBAL keeprScanChar
  Var /GLOBAL keeprOutcome

  ; $PLUGINSDIR does not exist yet here -- installSection.nsh:3 is where
  ; electron-builder normally creates it. InitPluginsDir is idempotent.
  InitPluginsDir

  StrCpy $keeprOldUninstallString ""
  StrCpy $keeprOldInstallDir ""
  StrCpy $keeprOldUninstaller ""

  ; Detect on the uninstall ENTRY, not on the directory: APP_FILENAME differs
  ; between the two builds ("Keepr" for assisted, "keepr" for one-click --
  ; NsisTarget.js:171, targetUtil.js:40-41) and $PROGRAMFILES64 is not fixed.
  ; UNINSTALL_APP_KEY and APP_GUID are UUID.v5(appId) (NsisTarget.js:162-168) and
  ; appId has never changed, so this matches installs from every prior version.
  ; UninstallString: include/installer.nsh:122. InstallLocation lives under
  ; INSTALL_REGISTRY_KEY (:104), NOT under the Uninstall key -- electron-builder
  ; never writes it there, which is why the BACKLOG-3431 census read it as empty.
  ReadRegStr $keeprOldUninstallString HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ReadRegStr $keeprOldInstallDir HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"

  ; check64BitAndSetRegView left us on SetRegView 64 (common.nsh:65-67); for this
  ; APP_64-only build it has already Quit any machine where that is not right
  ; (:69-72), so ${RunningX64} is true here. The guard keeps the restore honest
  ; if a 32-bit target is ever added.
  ${if} $keeprOldUninstallString == ""
  ${andIf} ${RunningX64}
    SetRegView 32
    ReadRegStr $keeprOldUninstallString HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ReadRegStr $keeprOldInstallDir HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ; Restore immediately, or registryAddInstallInfo (installSection.nsh:67)
    ; writes the new per-user entry into WOW6432Node.
    SetRegView 64
  ${endif}

  ; No per-machine install: return, and the 99% case behaves exactly as before.
  ${if} $keeprOldUninstallString == ""
    Goto keepr_migrate_done
  ${endif}

  ; UninstallString is always '"<dir>\Uninstall <Product>.exe" <mode flag>'
  ; (include/installer.nsh:121-122). Take the text between the first two quotes.
  ; GetInQuotes cannot be used: it lives in include/installUtil.nsh, which
  ; installer.nsi includes at :91 -- AFTER this macro is expanded at :80.
  StrCpy $keeprScanChar $keeprOldUninstallString 1
  ${if} $keeprScanChar == '"'
    StrCpy $keeprScanBuf $keeprOldUninstallString "" 1
    StrCpy $keeprScanIdx 0
    keepr_scan_quote:
      StrCpy $keeprScanChar $keeprScanBuf 1 $keeprScanIdx
      StrCmp $keeprScanChar "" keepr_scan_end
      StrCmp $keeprScanChar '"' keepr_scan_end
      IntOp $keeprScanIdx $keeprScanIdx + 1
      Goto keepr_scan_quote
    keepr_scan_end:
    StrCpy $keeprOldUninstaller $keeprScanBuf $keeprScanIdx
  ${endif}

  ; Unquoted or malformed entry: fall back to the conventional file name inside
  ; InstallLocation. UNINSTALL_FILENAME is common.nsh:17.
  ${if} $keeprOldUninstaller == ""
  ${andIf} $keeprOldInstallDir != ""
    StrCpy $keeprOldUninstaller "$keeprOldInstallDir\${UNINSTALL_FILENAME}"
  ${endif}

  ; A registry entry whose uninstaller is gone is stale. Leave it alone: removing
  ; it is not this item's job, and there is nothing to migrate.
  ${ifNot} ${FileExists} "$keeprOldUninstaller"
    Goto keepr_migrate_done
  ${endif}

  ; The directory is what `_?=` needs. Same fallback electron-builder uses
  ; (installUtil.nsh:169-176), via StdUtils, which is included by the shared
  ; header (NsisTarget.js:581) and so IS available this early.
  ${if} $keeprOldInstallDir == ""
    ${StdUtils.GetParentPath} $keeprOldInstallDir "$keeprOldUninstaller"
  ${endif}
  ${if} $keeprOldInstallDir == ""
    Goto keepr_migrate_done
  ${endif}

  ; No installer UI is on screen yet (SpiderBanner::Show is installSection.nsh
  ; :20), so without this the UAC prompt for "Uninstall Keepr.exe" would be the
  ; very first thing the user sees, unexplained.
  ${ifNot} ${Silent}
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION|MB_TOPMOST|MB_SETFOREGROUND "Keepr is already installed on this computer for all users.$\r$\n$\r$\nThis version installs for your account only, so the existing installation is removed first. Windows will ask you to approve that, and Keepr will close if it is open.$\r$\n$\r$\nYour Keepr data, accounts and transactions are not touched." /SD IDOK IDOK keepr_migrate_run
    ; Cancel: nothing has been written, so the machine is left exactly as found.
    Quit
  ${endif}

  keepr_migrate_run:
    ; Copy it out first: the uninstaller lives in the directory it is about to
    ; delete. One attempt only -- a second automatic attempt would mean a second
    ; UAC prompt, which is the failure mode that makes uninstallOldVersion
    ; unusable. The interactive retry below is user-driven instead.
    Delete "$PLUGINSDIR\keepr-old-uninstaller.exe"
    CopyFiles /SILENT "$keeprOldUninstaller" "$PLUGINSDIR\keepr-old-uninstaller.exe"
    ${if} ${FileExists} "$PLUGINSDIR\keepr-old-uninstaller.exe"
      ; `_?=` must be last and unquoted -- same shape as installUtil.nsh:224.
      ; The exit code is deliberately not captured; see the comment above.
      ExecWait '"$PLUGINSDIR\keepr-old-uninstaller.exe" /S /allusers --updated _?=$keeprOldInstallDir'
    ${endif}

  ; --- verify by outcome ---
  StrCpy $keeprOutcome "gone"

  StrCpy $keeprScanBuf ""
  ReadRegStr $keeprScanBuf HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${if} $keeprScanBuf != ""
    StrCpy $keeprOutcome "present"
  ${endif}

  ${if} ${RunningX64}
    SetRegView 32
    StrCpy $keeprScanBuf ""
    ReadRegStr $keeprScanBuf HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    SetRegView 64
    ${if} $keeprScanBuf != ""
      StrCpy $keeprOutcome "present"
    ${endif}
  ${endif}

  ; The old application binary, not the old uninstaller: the uninstaller is the
  ; one file that can legitimately survive (it is running), while Keepr.exe was
  ; closed by un.checkAppRunning and must be gone.
  ${if} ${FileExists} "$keeprOldInstallDir\${APP_EXECUTABLE_FILENAME}"
    StrCpy $keeprOutcome "present"
  ${endif}

  ${if} $keeprOutcome == "gone"
    Goto keepr_migrate_done
  ${endif}

  ; Still there. Stop, so the user keeps the working install they already had.
  ${ifNot} ${Silent}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION|MB_TOPMOST|MB_SETFOREGROUND "The existing all-users installation of Keepr was not removed, so this installation has been stopped.$\r$\n$\r$\nNothing on this computer has been changed and your data is untouched. Choose Retry to try again." /SD IDCANCEL IDRETRY keepr_migrate_run
  ${endif}
  SetErrorLevel 2
  Quit

  keepr_migrate_done:
!macroend
