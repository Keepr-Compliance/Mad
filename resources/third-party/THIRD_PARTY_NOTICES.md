# Third-party notices for Keepr

Keepr includes the third-party software listed below. This file covers components bundled outside the npm dependency tree: the iPhone tools for Windows and the libraries they contain, and the Electron and Chromium licence files. The licences of the npm packages Keepr is built from are not listed in this file. Each component remains under its own licence. Nothing in Keepr's own terms restricts the rights these licences give you.

This file is generated from components.json. Do not edit it by hand.

## Source code and your rights under the LGPL and GPL

Several components below are licensed under the GNU Lesser General Public License (LGPL) or the GNU General Public License (GPL). Keepr does not modify them. Keepr starts the iPhone tools for Windows as separate programs; it does not link them into Keepr itself.

- The files in the iPhone tools folder are unmodified copies of the imobiledevice-net v1.3.17 release (https://github.com/libimobiledevice-win32/imobiledevice-net/releases/tag/v1.3.17, asset libimobiledevice.1.2.1-r1122-win-x64.zip, sha256 d7cb57a71270848c35c3f01006701535aadf6dfb52325863ea368c94a34a2cab).
- Under each component below, the source line names where its source can be found. For components marked with a pinned commit, that is the repository and commit. For the libraries built by the vcpkg package manager (libiconv, libusb, libusb-win32, getopt-win32 and the other libraries in that group), it is the upstream project at the identified version; the exact build recipe used for those binaries is not recorded.
- You may replace any LGPL-licensed library in that folder with your own modified version built from that source. Keepr loads whatever is in the folder.

Where the iPhone tools folder is on your computer:

- Windows: resources\win\libimobiledevice (in the Keepr installation folder)
- macOS: Keepr.app/Contents/Resources/win/libimobiledevice

## Summary

| Component | Version | Licence | Platforms |
|---|---|---|---|
| libimobiledevice (library and idevice* tools) | imobiledevice-net build 1.2.1-r1122 | LGPL-2.1-or-later | Windows, macOS |
| libplist (library and plist tools) | imobiledevice-net build 1.2.1-r1122 | LGPL-2.1-or-later | Windows, macOS |
| libusbmuxd (library) | imobiledevice-net build 1.2.1-r1122 | LGPL-2.1-or-later | Windows, macOS |
| libirecovery (library and irecovery tool) | imobiledevice-net build 1.2.1-r1122 | LGPL-2.1-or-later | Windows, macOS |
| idevicerestore | imobiledevice-net build 1.2.1-r1122 | LGPL-3.0 | Windows, macOS |
| libideviceactivation (library) | imobiledevice-net build 1.2.1-r1122 | LGPL-2.1-or-later | Windows, macOS |
| ios_webkit_debug_proxy | imobiledevice-net build 1.2.1-r1122 | BSD-3-Clause | Windows, macOS |
| imobiledevice-net helper (imobiledevice-net-lighthouse.dll) | v1.3.17 | LGPL-2.1 | Windows, macOS |
| OpenSSL | 1.1.1i | OpenSSL AND SSLeay | Windows, macOS |
| libcurl | 7.74.0-DEV | curl | Windows, macOS |
| zlib | 1.2.11 | Zlib | Windows, macOS |
| libxml2 | 2.9.10 | MIT | Windows, macOS |
| GNU libiconv | 1.16 | LGPL-2.0-or-later | Windows, macOS |
| liblzma (XZ Utils) | 5.2.5 | LicenseRef-PublicDomain | Windows, macOS |
| libusb | 1.0.24 | LGPL-2.1-or-later | Windows, macOS |
| libusb-win32 | 1.2.6.0 (inferred) | LGPL-3.0 | Windows, macOS |
| PThreads4W (POSIX Threads for Windows) | 3.0.0 | Apache-2.0 | Windows, macOS |
| PCRE | 8.44 | BSD-3-Clause | Windows, macOS |
| bzip2 (libbzip2) | 1.0.8 | bzip2-1.0.6 | Windows, macOS |
| libzip | 1.7.3 | BSD-3-Clause | Windows, macOS |
| getopt-win32 (getopt for Microsoft C, by Ludvik Jerabek) | 0.1 | LGPL-3.0 | Windows, macOS |
| Microsoft Visual C++ 2015 Runtime (vcruntime140.dll) | 14.00.24406.0 | LicenseRef-Proprietary | Windows, macOS |
| Apple Mobile Device Support | see win/apple-drivers/version.txt in the installed app | LicenseRef-Proprietary | Windows |
| Electron and Chromium | the Electron version this build of Keepr ships with | MIT AND (Chromium notices) | Windows, macOS |
| @noble/curves (vendored in the Keepr Chrome extension) | 1.9.7 | MIT | Windows, macOS |

## Components

### libimobiledevice (library and idevice* tools)

- Version: imobiledevice-net build 1.2.1-r1122 (build label of the imobiledevice-net v1.3.17 asset; exact source commit pinned in the release's gitinfo)
- Licence: LGPL-2.1-or-later (source headers of src/ and every tools/*.c at the pinned commit)
- Copyright: Copyright (c) 2008-2020 Nikias Bassen, Martin Szulecki, Zach C. and other libimobiledevice contributors
- Project: https://libimobiledevice.org
- Source code (pinned commit): https://github.com/libimobiledevice-win32/libimobiledevice/tree/0d4a7e905baeadafa098e629a5241fac6fbf7d24, commit 0d4a7e905baeadafa098e629a5241fac6fbf7d24, dated 2021-02-22
- Shipped as part of: imobiledevice-net v1.3.17
- Files: imobiledevice.dll, idevice_id.exe, idevicebackup.exe, idevicebackup2.exe, idevicecrashreport.exe, idevicedate.exe, idevicedebug.exe, idevicedebugserverproxy.exe, idevicediagnostics.exe, ideviceenterrecovery.exe, ideviceimagemounter.exe, ideviceinfo.exe, idevicename.exe, idevicenotificationproxy.exe, idevicepair.exe, ideviceprovision.exe, idevicescreenshot.exe, idevicesyslog.exe
- Run by Keepr: idevice_id.exe, ideviceinfo.exe, idevicebackup2.exe, idevicepair.exe
- Licence text: [GNU Lesser General Public License v2.1](licenses/LGPL-2.1.txt)

### libplist (library and plist tools)

- Version: imobiledevice-net build 1.2.1-r1122 (pinned source commit (gitinfo))
- Licence: LGPL-2.1-or-later (source headers at the pinned commit)
- Copyright: Copyright (c) 2008-2019 Nikias Bassen, Martin Szulecki, Zach C. and other libplist contributors
- Project: https://github.com/libimobiledevice/libplist
- Source code (pinned commit): https://github.com/libimobiledevice-win32/libplist/tree/8bb8b24c0774022c9b2190b1996e3acd711325b4, commit 8bb8b24c0774022c9b2190b1996e3acd711325b4, dated 2021-02-22
- Shipped as part of: imobiledevice-net v1.3.17
- Files: plist.dll, plistutil.exe, plist_cmp.exe, plist_test.exe
- Licence text: [GNU Lesser General Public License v2.1](licenses/LGPL-2.1.txt)

### libusbmuxd (library)

- Version: imobiledevice-net build 1.2.1-r1122 (pinned source commit (gitinfo))
- Licence: LGPL-2.1-or-later (src/libusbmuxd.c header at the pinned commit)
- Copyright: Copyright (C) 2009-2019 Nikias Bassen, Martin Szulecki, Paul Sladen
- Project: https://github.com/libimobiledevice/libusbmuxd
- Source code (pinned commit): https://github.com/libimobiledevice-win32/libusbmuxd/tree/ac86b23f57879b8b702f3712ba66729008d059a3, commit ac86b23f57879b8b702f3712ba66729008d059a3, dated 2020-06-12
- Shipped as part of: imobiledevice-net v1.3.17
- Files: usbmuxd.dll
- Licence text: [GNU Lesser General Public License v2.1](licenses/LGPL-2.1.txt)

### libirecovery (library and irecovery tool)

- Version: imobiledevice-net build 1.2.1-r1122 (pinned source commit (gitinfo))
- Licence: LGPL-2.1-or-later (src/libirecovery.c and tools/irecovery.c headers at the pinned commit)
- Copyright: Copyright (c) 2008-2020 Nikias Bassen, Martin Szulecki, Chronic-Dev Team, Joshua Hill, Nicolas Haunold
- Project: https://github.com/libimobiledevice/libirecovery
- Source code (pinned commit): https://github.com/libimobiledevice-win32/libirecovery/tree/825b81cbe93deb24b099d8f0bf22f18246a82034, commit 825b81cbe93deb24b099d8f0bf22f18246a82034, dated 2020-06-15
- Shipped as part of: imobiledevice-net v1.3.17
- Files: irecovery.dll, irecovery.exe
- Licence text: [GNU Lesser General Public License v2.1 (copy shipped by libirecovery)](licenses/LGPL-2.1-libirecovery.txt)

### idevicerestore

- Version: imobiledevice-net build 1.2.1-r1122 (pinned source commit (gitinfo))
- Licence: LGPL-3.0 (repository COPYING is LGPL-3.0; individual source headers say LGPL-2.1-or-later)
- Copyright: Copyright (c) 2010-2019 Nikias Bassen, Martin Szulecki, Joshua Hill
- Project: https://github.com/libimobiledevice/idevicerestore
- Source code (pinned commit): https://github.com/libimobiledevice-win32/idevicerestore/tree/5e4e8d8095672f25f40ce9c0c347e31e4b89ab64, commit 5e4e8d8095672f25f40ce9c0c347e31e4b89ab64, dated 2020-06-15
- Shipped as part of: imobiledevice-net v1.3.17
- Files: idevicerestore.exe
- Licence text: [GNU Lesser General Public License v3.0](licenses/LGPL-3.0.txt); [GNU General Public License v3.0](licenses/GPL-3.0.txt)

### libideviceactivation (library)

- Version: imobiledevice-net build 1.2.1-r1122 (pinned source commit (gitinfo))
- Licence: LGPL-2.1-or-later (src/activation.c header at the pinned commit)
- Copyright: Copyright (c) 2011-2019 Nikias Bassen, Martin Szulecki, Mirell Development
- Project: https://github.com/libimobiledevice/libideviceactivation
- Source code (pinned commit): https://github.com/libimobiledevice-win32/libideviceactivation/tree/fbe0476cfeddc2fc317ceb900eec12302c1d4c11, commit fbe0476cfeddc2fc317ceb900eec12302c1d4c11, dated 2020-06-15
- Shipped as part of: imobiledevice-net v1.3.17
- Files: ideviceactivation.dll
- Licence text: [GNU Lesser General Public License v2.1](licenses/LGPL-2.1.txt)

### ios_webkit_debug_proxy

- Version: imobiledevice-net build 1.2.1-r1122 (pinned source commit (gitinfo))
- Licence: BSD-3-Clause (LICENSE.md at the pinned commit)
- Copyright: Copyright 2012, Google Inc.
- Project: https://github.com/google/ios-webkit-debug-proxy
- Source code (pinned commit): https://github.com/libimobiledevice-win32/ios-webkit-debug-proxy/tree/5ef16d17408aa5455003b0d10241ef87d415c751, commit 5ef16d17408aa5455003b0d10241ef87d415c751, dated 2020-06-18
- Shipped as part of: imobiledevice-net v1.3.17
- Files: ios_webkit_debug_proxy.exe
- Licence text: [Google BSD licence (ios-webkit-debug-proxy)](licenses/BSD-3-Clause-ios-webkit-debug-proxy.txt)

### imobiledevice-net helper (imobiledevice-net-lighthouse.dll)

- Version: v1.3.17 (byte-identical to the v1.3.17 release asset)
- Licence: LGPL-2.1 (repository LICENSE.txt at v1.3.17)
- Copyright: Copyright the imobiledevice-net contributors (maintained by Quamotion); no copyright line is stated in the repository
- Project: https://github.com/libimobiledevice-win32/imobiledevice-net
- Source code (pinned commit): https://github.com/libimobiledevice-win32/imobiledevice-net/tree/v1.3.17, commit d043dda518cc4df830c37f8c85d3f19384978541
- Shipped as part of: imobiledevice-net v1.3.17
- Files: imobiledevice-net-lighthouse.dll
- Licence text: [GNU Lesser General Public License v2.1 (copy shipped by imobiledevice-net)](licenses/LGPL-2.1-imobiledevice-net.txt)

### OpenSSL

- Version: 1.1.1i (FileVersion in the DLLs' VERSIONINFO)
- Licence: OpenSSL AND SSLeay (LICENSE at tag OpenSSL_1_1_1i)
- Copyright: Copyright (c) 1998-2019 The OpenSSL Project; Copyright (C) 1995-1998 Eric Young (eay@cryptsoft.com)
- Project: https://www.openssl.org
- Upstream project: https://github.com/openssl/openssl/tree/OpenSSL_1_1_1i
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: libcrypto-1_1-x64.dll, libssl-1_1-x64.dll
- Licence text: [OpenSSL License and original SSLeay License (dual)](licenses/OpenSSL-SSLeay.txt)
- Note: This product includes software developed by the OpenSSL Project for use in the OpenSSL Toolkit (http://www.openssl.org/). This product includes cryptographic software written by Eric Young (eay@cryptsoft.com).

### libcurl

- Version: 7.74.0-DEV (FileVersion in VERSIONINFO)
- Licence: curl (COPYING at tag curl-7_74_0)
- Copyright: Copyright (c) 1996 - 2020, Daniel Stenberg, <daniel@haxx.se>, and many contributors
- Project: https://curl.se
- Upstream project: https://github.com/curl/curl/tree/curl-7_74_0
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: libcurl.dll
- Licence text: [curl License](licenses/curl.txt)

### zlib

- Version: 1.2.11 (FileVersion in VERSIONINFO)
- Licence: Zlib (zlib.h licence comment at tag v1.2.11)
- Copyright: Copyright (C) 1995-2017 Jean-loup Gailly and Mark Adler
- Project: https://zlib.net
- Upstream project: https://github.com/madler/zlib/tree/v1.2.11
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: zlib1.dll
- Licence text: [zlib License](licenses/Zlib.txt)

### libxml2

- Version: 2.9.10 (FileVersion in VERSIONINFO)
- Licence: MIT (Copyright file at tag v2.9.10)
- Copyright: Copyright (C) 1998-2012 Daniel Veillard
- Project: https://gitlab.gnome.org/GNOME/libxml2
- Upstream project: https://gitlab.gnome.org/GNOME/libxml2/-/tree/v2.9.10
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: libxml2.dll
- Licence text: [libxml2 licence (MIT)](licenses/MIT-libxml2.txt)

### GNU libiconv

- Version: 1.16 (FileVersion in VERSIONINFO)
- Licence: LGPL-2.0-or-later (COPYING.LIB in libiconv-1.16 (the file vcpkg installs as this port's copyright))
- Copyright: Copyright (C) 1999-2019 Free Software Foundation, Inc.
- Project: https://www.gnu.org/software/libiconv/
- Upstream project: https://ftp.gnu.org/gnu/libiconv/libiconv-1.16.tar.gz
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: iconv-2.dll
- Licence text: [GNU Library General Public License v2 (libiconv COPYING.LIB)](licenses/LGPL-2.0-libiconv.txt)

### liblzma (XZ Utils)

- Version: 5.2.5 (FileVersion in VERSIONINFO)
- Licence: LicenseRef-PublicDomain (COPYING at tag v5.2.5 (liblzma is in the public domain))
- Copyright: Public domain (The Tukaani Project)
- Project: https://tukaani.org/xz/
- Upstream project: https://github.com/tukaani-project/xz/tree/v5.2.5
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: lzma.dll
- Licence text: [XZ Utils licensing (liblzma is in the public domain)](licenses/xz-liblzma-public-domain.txt)

### libusb

- Version: 1.0.24 (FileVersion in VERSIONINFO (1.0.24.11584))
- Licence: LGPL-2.1-or-later (COPYING at tag v1.0.24 and the DLL's LegalCopyright)
- Copyright: Copyright the libusb authors (see AUTHORS in libusb 1.0.24)
- Project: https://libusb.info
- Upstream project: https://github.com/libusb/libusb/tree/v1.0.24
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: libusb-1.0.dll
- Licence text: [GNU Lesser General Public License v2.1 (copy shipped by libusb)](licenses/LGPL-2.1-libusb.txt)

### libusb-win32

- Version: 1.2.6.0 (inferred) (NOT determined from the binary (no VERSIONINFO); inferred from the vcpkg libusb-win32 port version at the time)
- Licence: LGPL-3.0 (COPYING_LGPL.txt in libusb-win32-src-1.2.6.0.zip (the file vcpkg installs as this port's copyright))
- Copyright: Copyright the libusb-win32 authors (Stephan Meyer, Travis Robinson and contributors)
- Project: https://sourceforge.net/projects/libusb-win32/
- Upstream project: https://sourceforge.net/projects/libusb-win32/files/libusb-win32-releases/1.2.6.0/
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: libusb0.dll
- Licence text: [GNU Lesser General Public License v3.0](licenses/LGPL-3.0.txt); [GNU General Public License v3.0](licenses/GPL-3.0.txt)

### PThreads4W (POSIX Threads for Windows)

- Version: 3.0.0 (FileVersion in VERSIONINFO (3, 0, 0, 0))
- Licence: Apache-2.0 (LICENSE and NOTICE in pthreads4w-code-v3.0.0.zip (sha512 matches the vcpkg port))
- Copyright: Copyright 1998 John E. Bossom; Copyright 1999-2018, Pthreads4w contributors
- Project: https://sourceforge.net/projects/pthreads4w/
- Upstream project: https://sourceforge.net/projects/pthreads4w/files/pthreads4w-code-v3.0.0.zip
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: pthreadVC3.dll
- Licence text: [Apache License 2.0 (copy shipped by pthreads4w)](licenses/Apache-2.0-pthreads4w.txt); [pthreads4w NOTICE file (Apache-2.0 section 4d)](licenses/NOTICE-pthreads4w.txt)

### PCRE

- Version: 8.44 (version string inside pcre.dll ("8.44 2020-02-12"))
- Licence: BSD-3-Clause (LICENCE in pcre-8.44)
- Copyright: Copyright (c) 1997-2020 University of Cambridge; Copyright (c) 2010-2020 Zoltan Herczeg; Copyright (c) 2007-2012 Google Inc.
- Project: https://www.pcre.org
- Upstream project: https://sourceforge.net/projects/pcre/files/pcre/8.44/
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: pcre.dll, pcreposix.dll
- Licence text: [PCRE licence (BSD)](licenses/BSD-3-Clause-PCRE.txt)

### bzip2 (libbzip2)

- Version: 1.0.8 (version string inside bz2.dll ("1.0.8, 13-Jul-2019"))
- Licence: bzip2-1.0.6 (LICENSE at tag bzip2-1.0.8)
- Copyright: Copyright (C) 1996-2019 Julian R Seward
- Project: https://sourceware.org/bzip2/
- Upstream project: https://sourceware.org/git/?p=bzip2.git;a=tree;hb=bzip2-1.0.8
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: bz2.dll
- Licence text: [bzip2 licence (SPDX id bzip2-1.0.6; text from bzip2 1.0.8)](licenses/bzip2.txt)

### libzip

- Version: 1.7.3 (version string inside zip.dll)
- Licence: BSD-3-Clause (LICENSE at tag v1.7.3)
- Copyright: Copyright (C) 1999-2020 Dieter Baron and Thomas Klausner
- Project: https://libzip.org
- Upstream project: https://github.com/nih-at/libzip/tree/v1.7.3
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: zip.dll
- Licence text: [libzip licence (BSD-3-Clause)](licenses/BSD-3-Clause-libzip.txt)

### getopt-win32 (getopt for Microsoft C, by Ludvik Jerabek)

- Version: 0.1 (vcpkg getopt-win32 port pins libimobiledevice-win32/getopt tag 0.1)
- Licence: LGPL-3.0 (repository LICENSE at tag 0.1; getopt.c header says "License: LGPL")
- Copyright: Copyright Ludvik Jerabek (Visual C++ port); derived from the Free Software Foundation getopt library
- Project: https://github.com/libimobiledevice-win32/getopt
- Upstream project: https://github.com/libimobiledevice-win32/getopt/tree/0.1
  (upstream project at the identified version; the exact build recipe is not recorded)
- Shipped as part of: imobiledevice-net v1.3.17
- Files: getopt.dll
- Licence text: [GNU Lesser General Public License v3.0 (copy shipped by getopt-win32)](licenses/LGPL-3.0-getopt-win32.txt); [GNU General Public License v3.0](licenses/GPL-3.0.txt)

### Microsoft Visual C++ 2015 Runtime (vcruntime140.dll)

- Version: 14.00.24406.0 (FileVersion in VERSIONINFO)
- Licence: LicenseRef-Proprietary
- Copyright: (c) Microsoft Corporation. All rights reserved.
- Project: https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist
- Shipped as part of: imobiledevice-net v1.3.17
- Files: vcruntime140.dll
- Licence text: not reproduced (proprietary; attribution only)
- Note: Proprietary Microsoft runtime library, redistributed unmodified as part of the imobiledevice-net package. Not open source; its terms are Microsoft's and are not reproduced here.

### Apple Mobile Device Support

- Version: see win/apple-drivers/version.txt in the installed app (written by the Windows release build when it extracts the installer)
- Licence: LicenseRef-Proprietary
- Copyright: (c) Apple Inc.
- Project: https://www.apple.com/itunes/download/win64
- Location: resources/win/apple-drivers/AppleMobileDeviceSupport64.msi (Windows only; added by the release build, not stored in the repository)
- Licence text: not reproduced (proprietary; attribution only)
- Note: Proprietary Apple software, redistributed unmodified. It is extracted from Apple's iTunes for Windows installer when the Windows build is made and is installed only if you choose to set up iPhone sync and confirm the Windows prompt. It is not open source and is not covered by these notices.

### Electron and Chromium

- Version: the Electron version this build of Keepr ships with (not repeated here so this file does not change on every Electron update)
- Licence: MIT AND (Chromium notices)
- Copyright: Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.
- Project: https://www.electronjs.org
- Licence text: Electron licence (MIT) (Windows: LICENSE.electron.txt in the Keepr installation folder; macOS: Keepr.app/Contents/Resources/third-party/LICENSE.electron.txt); Chromium and its dependencies: licence notices (LICENSES.chromium.html) (Windows: LICENSES.chromium.html in the Keepr installation folder; macOS: Keepr.app/Contents/Resources/third-party/LICENSES.chromium.html)
- Note: Keepr is built on Electron, which includes Chromium, Node.js, FFmpeg and other components. Their licences are in LICENSES.chromium.html. On Windows this also covers the graphics libraries Electron installs beside Keepr.exe (d3dcompiler_47.dll, dxcompiler.dll, dxil.dll, libEGL.dll, libGLESv2.dll, vk_swiftshader.dll, vulkan-1.dll, ffmpeg.dll).

### @noble/curves (vendored in the Keepr Chrome extension)

- Version: 1.9.7 (chrome-extension/vendor/LICENSE-noble.txt and SBOM.json)
- Licence: MIT
- Copyright: Copyright (c) 2022 Paul Miller (https://paulmillr.com)
- Project: https://github.com/paulmillr/noble-curves
- Licence text: @noble/curves licence (MIT) (Windows: resources/chrome-extension/vendor/LICENSE-noble.txt; macOS: Keepr.app/Contents/Resources/chrome-extension/vendor/LICENSE-noble.txt)

## Licence texts

Each file is copied verbatim from the upstream source shown.

- licenses/LGPL-2.1.txt: GNU Lesser General Public License v2.1. From https://raw.githubusercontent.com/libimobiledevice-win32/libimobiledevice/0d4a7e905baeadafa098e629a5241fac6fbf7d24/COPYING.LESSER
- licenses/LGPL-2.1-libirecovery.txt: GNU Lesser General Public License v2.1 (copy shipped by libirecovery). From https://raw.githubusercontent.com/libimobiledevice-win32/libirecovery/825b81cbe93deb24b099d8f0bf22f18246a82034/COPYING
- licenses/LGPL-2.1-libusb.txt: GNU Lesser General Public License v2.1 (copy shipped by libusb). From https://raw.githubusercontent.com/libusb/libusb/v1.0.24/COPYING
- licenses/LGPL-2.1-imobiledevice-net.txt: GNU Lesser General Public License v2.1 (copy shipped by imobiledevice-net). From https://raw.githubusercontent.com/libimobiledevice-win32/imobiledevice-net/v1.3.17/LICENSE.txt
- licenses/LGPL-2.0-libiconv.txt: GNU Library General Public License v2 (libiconv COPYING.LIB). From https://ftp.gnu.org/gnu/libiconv/libiconv-1.16.tar.gz (libiconv-1.16/COPYING.LIB)
- licenses/LGPL-3.0.txt: GNU Lesser General Public License v3.0. From https://raw.githubusercontent.com/libimobiledevice-win32/idevicerestore/5e4e8d8095672f25f40ce9c0c347e31e4b89ab64/COPYING
- licenses/LGPL-3.0-getopt-win32.txt: GNU Lesser General Public License v3.0 (copy shipped by getopt-win32). From https://raw.githubusercontent.com/libimobiledevice-win32/getopt/0.1/LICENSE
- licenses/GPL-3.0.txt: GNU General Public License v3.0. From https://raw.githubusercontent.com/libimobiledevice-win32/usbmuxd/f1329e742825c93fd080bdb8253d710ef8b6f751/COPYING.GPLv3
- licenses/BSD-3-Clause-ios-webkit-debug-proxy.txt: Google BSD licence (ios-webkit-debug-proxy). From https://raw.githubusercontent.com/libimobiledevice-win32/ios-webkit-debug-proxy/5ef16d17408aa5455003b0d10241ef87d415c751/LICENSE.md
- licenses/OpenSSL-SSLeay.txt: OpenSSL License and original SSLeay License (dual). From https://raw.githubusercontent.com/openssl/openssl/OpenSSL_1_1_1i/LICENSE
- licenses/curl.txt: curl License. From https://raw.githubusercontent.com/curl/curl/curl-7_74_0/COPYING
- licenses/Zlib.txt: zlib License. From https://raw.githubusercontent.com/madler/zlib/v1.2.11/zlib.h (zlib.h lines 1-24 (the licence comment); zlib 1.2.11 has no separate LICENSE file)
- licenses/MIT-libxml2.txt: libxml2 licence (MIT). From https://gitlab.gnome.org/GNOME/libxml2/-/raw/v2.9.10/Copyright
- licenses/bzip2.txt: bzip2 licence (SPDX id bzip2-1.0.6; text from bzip2 1.0.8). From https://sourceware.org/git/?p=bzip2.git;a=blob_plain;f=LICENSE;hb=bzip2-1.0.8
- licenses/BSD-3-Clause-libzip.txt: libzip licence (BSD-3-Clause). From https://raw.githubusercontent.com/nih-at/libzip/v1.7.3/LICENSE
- licenses/BSD-3-Clause-PCRE.txt: PCRE licence (BSD). From https://downloads.sourceforge.net/project/pcre/pcre/8.44/pcre-8.44.tar.bz2 (pcre-8.44/LICENCE)
- licenses/xz-liblzma-public-domain.txt: XZ Utils licensing (liblzma is in the public domain). From https://raw.githubusercontent.com/tukaani-project/xz/v5.2.5/COPYING
- licenses/Apache-2.0-pthreads4w.txt: Apache License 2.0 (copy shipped by pthreads4w). From https://downloads.sourceforge.net/project/pthreads4w/pthreads4w-code-v3.0.0.zip (LICENSE)
- licenses/NOTICE-pthreads4w.txt: pthreads4w NOTICE file (Apache-2.0 section 4d). From https://downloads.sourceforge.net/project/pthreads4w/pthreads4w-code-v3.0.0.zip (NOTICE)

