# Third-party software in Moonshine

Moonshine is distributed under the GNU General Public License v3.0 (see `GPL-3.0.txt`).
It bundles the following GPLv3 projects. Their complete source code is available at the links below.

| Component | Version | Source | Changes |
|-----------|---------|--------|---------|
| Apollo (fork of Sunshine) | v0.4.6 | https://github.com/ClassicOldSong/Apollo | Modified: per-app audio capture via Windows process loopback; a mode in which Moonshine manages it (no tray icon, the host's user approves each stream, local API for pending requests); service renamed "Moonshine Host". Moonshine's modified source lives in `upstream/apollo`, branch `moonshine`. |
| Moonlight PC | v6.2.0 | https://github.com/moonlight-stream/moonlight-qt | Modified: builds with MSYS2 MinGW against MSYS2's Qt, SDL2, FFmpeg, libplacebo, OpenSSL and Opus (without the AntiHooking and Discord integrations); stream window named and iconed as Moonshine. Moonshine's modified source lives in `upstream/moonlight-qt`, branch `moonshine`. |
| Electron | 38.8.6 | https://github.com/electron/electron | Unmodified (MIT licence). |

Apollo and Moonlight also include third-party components under their own licences;
see the licence files shipped inside each project's folder. The stream player's folder also
contains Qt 6 and the libraries listed above as built and distributed by MSYS2
(https://www.msys2.org), each under its own licence.
