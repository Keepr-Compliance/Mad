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
