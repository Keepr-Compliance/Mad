; ---------------------------------------------------------------------------
; Keepr NSIS custom installer hooks (BACKLOG-2114)
;
; Adds an OPTIONAL app-data + Windows Credential Manager cleanup step to the
; assisted (oneClick:false) uninstaller. This macro is !insertmacro'd by
; electron-builder inside the uninstall Section, AFTER un.onInit has parsed the
; /S flag and called `SetSilent silent`, so ${Silent} and ${isUpdated} are both
; authoritative here.
;
; See packages/app-builder-lib/templates/nsis/uninstaller.nsh in electron-builder:
;   Function un.onInit    -> parses "/S" and calls SetSilent silent
;   Section un.<name>     -> `!insertmacro customUnInstall`, then `${if} ${isUpdated}`
;
; CRITICAL: The auto-updater (electron-updater / NSIS differential update) runs
; the uninstaller SILENTLY during an update. We must NEVER touch user data in
; that path, and must NEVER show a MessageBox when silent (a modal in a silent
; update would hang the updater indefinitely). We therefore bail on BOTH:
;   - ${isUpdated}  (uninstall triggered by an in-place update)
;   - ${Silent} / IfSilent (any silent uninstall)
; Only a genuine interactive uninstall reaches the prompt, and it defaults to No.
; ---------------------------------------------------------------------------

!macro customUnInstall
  ; Skip entirely during an auto-update reinstall.
  ${ifNot} ${isUpdated}
    ; Skip entirely for any silent uninstall (no modal that could hang the updater).
    IfSilent keepr_skip_data_cleanup keepr_maybe_prompt

    keepr_maybe_prompt:
      MessageBox MB_YESNO|MB_DEFBUTTON2 "Also delete your Keepr data and saved credentials? This cannot be undone." IDYES keepr_delete_data IDNO keepr_skip_data_cleanup

      keepr_delete_data:
        ; Remove application data directories (quoted; best-effort).
        RMDir /r "$APPDATA\keepr"
        RMDir /r "$LOCALAPPDATA\keepr"

        ; Remove Windows Credential Manager entries (best-effort; ignore failures).
        ; ExecToLog pushes the exit code onto the stack; Pop it to keep the stack clean.
        nsExec::ExecToLog 'cmdkey /delete:"keepr"'
        Pop $0
        nsExec::ExecToLog 'cmdkey /delete:"Keepr"'
        Pop $0
        nsExec::ExecToLog 'cmdkey /delete:"Keepr Safe Storage"'
        Pop $0

      keepr_skip_data_cleanup:
  ${endIf}
!macroend
