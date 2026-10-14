; Microsoft Store build only (BACKLOG-3927). release.yml's store run passes
; --config.nsis.include=build/installer-store.nsh; the website build includes
; build/installer.nsh directly (package.json build.nsis.include).
; electron-builder adds the build resources dir as an include dir before this
; file (NsisTarget.js: !addincludedir), so "installer.nsh" resolves there.
!define KEEPR_STORE_BUILD
!include "installer.nsh"
