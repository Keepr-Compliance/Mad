; ---------------------------------------------------------------------------
; Keepr NSIS custom installer hooks (BACKLOG-2114)
;
; Adds an OPTIONAL user-data cleanup step to the assisted (oneClick:false)
; uninstaller. This macro is !insertmacro'd by electron-builder inside the
; uninstall Section, AFTER un.onInit has run initMultiUser (which sets
; $installMode and the shell-var context) and parsed the /S flag
; (SetSilent silent). So ${Silent}, ${isUpdated}, and $installMode are all
; authoritative here.
;
; See node_modules/app-builder-lib/templates/nsis/uninstaller.nsh:
;   Function un.onInit -> initMultiUser (sets $installMode + SetShellVarContext),
;                         parses "/S" -> SetSilent silent
;   Section un.<name>  -> `!insertmacro customUnInstall`, then the default
;                         delete-app-data block guarded by `$installMode == "all"`.
;
; CRITICAL (silent/update safety): the auto-updater (electron-updater / NSIS
; differential update) runs the uninstaller SILENTLY during an update. We must
; NEVER touch user data in that path, and NEVER show a MessageBox when silent
; (a modal in a silent update would hang the updater indefinitely). We bail on
; BOTH ${isUpdated} and ${Silent}/IfSilent.
;
; CRITICAL (per-machine path): for a per-machine install ($installMode == "all")
; un.onInit runs `SetShellVarContext all`, so $APPDATA/$LOCALAPPDATA would
; resolve to C:\ProgramData instead of the user's Roaming/Local profile. Electron
; always writes its data under the USER profile, so we temporarily switch to
; `SetShellVarContext current` around the RMDir calls (then restore `all`),
; mirroring electron-builder's own delete-app-data block in uninstaller.nsh.
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
    ; Skip entirely for any silent uninstall (no modal that could hang the updater).
    IfSilent keepr_skip_data_cleanup keepr_maybe_prompt

    keepr_maybe_prompt:
      MessageBox MB_YESNO|MB_DEFBUTTON2 "Also delete your Keepr data and saved credentials (emails, transactions, and DPAPI-encrypted secrets)? This cannot be undone." IDYES keepr_delete_data IDNO keepr_skip_data_cleanup

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
