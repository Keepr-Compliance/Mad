; Microsoft Store build only (BACKLOG-3927). release.yml's store run passes
; --config.nsis.include=build/installer-store.nsh; the website build includes
; build/installer.nsh directly (package.json build.nsis.include).
; The include is by path next to THIS file, never by bare name: a bare
; "installer.nsh" resolves to app-builder-lib's own templates/nsis/include/
; installer.nsh (first on the include path), which installSection.nsh then
; includes a second time -> "macro named extractEmbeddedAppPackage already
; exists".
!define KEEPR_STORE_BUILD
!include "${__FILEDIR__}\installer.nsh"
