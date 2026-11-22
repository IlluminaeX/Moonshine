# Moonshine

One Windows app for game streaming. **Host** shares your PC, and **Connect** plays on someone else's. Under the hood the host is a build of [Apollo](https://github.com/ClassicOldSong/Apollo) and the stream player is [Moonlight](https://github.com/moonlight-stream/moonlight-qt); both are installed inside Moonshine and driven by it, with no windows, tray icons or web pages of their own.

## Features
- **Host / Connect in one window**
  - **Connect** lists your saved PCs (shared with an installed Moonlight), PCs found on your network, and friends' PCs on Tailscale, and you can add any PC by IP.
  - It handles pairing, shows each PC's games with box art, and starts full-screen streams.
  - Stream settings (resolution, frame rate, bitrate, codec, HDR and more) are on the Settings tab, with Start with Windows.
- **You decide who streams, each time**
  - Every paired device has an **Ask before streaming** switch (on by default). When it's on, a Moonshine popup asks you to **Allow** or **Decline** each stream. This works for any device, however it was paired.
  - The popup's **Don't ask again** turns the switch off for that device.
  - If Moonshine isn't running, devices that have to ask are turned away.
  - When a device joins without asking (it's allowed to), a popup with a chime says so for 5 seconds, with **Kick** and **Dismiss**. Kicking also makes it ask next time.
  - **Pause hosting** (tray menu or Host tab) for 30 minutes, 1 or 2 hours, or until you resume: hosting stays on, but every stream request is declined, anyone watching is disconnected, and friends see this PC as not hosting. No Windows admin prompt, unlike turning hosting off.
- **Pairing without the browser**
  - Friends on Moonshine pair with each other's PCs by themselves, the first time each PC sees the other online. No PIN, no popup. A friend's PC that is off says it will pair once it's on; **Pair** appears only if pairing by itself didn't work.
  - Other PCs with Moonshine (on Tailscale, your network, or by IP): click **Pair**, they get one **Accept** popup, and nobody types the PIN.
  - Any other Moonlight client: Moonshine pops up a box to type the PIN that device is showing.
- **Connect** tab: friends, your PCs and other PCs in one list (sign in with Discord, add friends by username, or add a PC by its address). Click a PC's name for its games, to rename it, or to remove it.
  - The list updates live: who is online, free, hosting or in a game, and **what they're playing** (turn off **Share what I'm playing** to hide yours).
  - **Quick messages**: one-tap phrases ("Want to play?", "On my way"...) or a short note, delivered at once to friends who are online. Conversations stay on your PC.
  - **Nicknames** only you see, kept with your account.
  - A badge when a friend's Moonshine is older or newer than yours.
  - **Do not disturb** (tray menu or Connect tab), for an hour, until morning, or until you turn it off: no notifications, and invites to play are answered "not now". Messages still arrive, unread. Requests to stream from your PC still ask.
- **Speed test**: **Test my speed** under the bitrate (Settings) measures this PC's download and suggests a stream bitrate; **Test my upload** under the upload limit (Host) measures the upload and suggests a limit. **Apply** or **Dismiss**. Uses Cloudflare's free speed test servers for a few seconds.
- **Auto-reconnect**: if a stream's connection drops (Wi-Fi blip, a direct connection lost), Moonshine gets it back by itself and picks up the same game, which keeps running on the other PC meanwhile. Up to 5 tries over about 30 seconds; **Stop reconnecting** or the Settings switch turns it off.
- **Volume boost**: play a PC's stream up to 10x louder, for when its owner keeps their game quiet. A slider on that PC's page and in the stream window, or Ctrl+Alt+Shift+Up/Down during the stream. Remembered per PC; loud parts are softened instead of crackling.
- **Devices** (Host tab): rename, disconnect or remove a device, and set what it may do: keyboard, mouse, controller, touch, pen; see the app list, start apps, join a running stream; clipboard, file transfer, server commands; a fixed resolution or its own virtual display.
  - **New devices can**: what a device gets when it pairs, however it pairs. "Start apps and use a controller" by default; or full control with clipboard and files; or only watch. Devices already paired keep theirs.
- **Host settings** tab: all of the host's settings, the applications list with an editor (including commands to run before and after an app), global commands, the logs, and **Tools** (pair by typing a PIN, one-time pairing codes, close a stuck app, reset display settings, remove all devices, set the web page's login).
  - The settings for each GPU's encoder (NVIDIA, AMD, Intel, software) are grouped under **Advanced**.
  - The settings pages are generated from Apollo's own settings page by `scripts/gen-apollo-schema.js`, so they use the same options, defaults and wording. Run it again after updating Apollo.
- **Per-app stream audio**: stream all system audio, everything *except* one app (e.g. `Discord.exe`), or *only* one app. This uses Windows' process-loopback capture and needs Windows 10 build 20348 or later, or Windows 11.

## Layout
| Path | What |
|------|------|
| `app/` | Moonshine app (Electron) |
| `upstream/apollo/` | Official Apollo source (git submodule, pinned to v0.4.6) |
| `upstream/moonlight-qt/` | Official Moonlight source (git submodule, pinned to v6.2.0) |
| `patches/` | Moonshine's changes to Apollo and Moonlight, applied on top of the official sources |
| `vendor/moonlight/` | Official Moonlight portable release (optional fallback player; downloaded, not committed) |
| `scripts/` | Build, fetch and package scripts |
| `installer/` | NSIS installer, its artwork, and `prepare-host.ps1` |
| `versions.json` | Pinned upstream versions |

## Building
Requirements: [MSYS2](https://www.msys2.org) at `C:\msys64`, Node.js 20 or later, and PowerShell 7.

```powershell
git submodule update --init --recursive
pwsh scripts/patches.ps1 apply                        # optional: the build scripts do this too
pwsh scripts/build-apollo.ps1 -InstallDeps -Package   # host engine, via MSYS2 UCRT64
pwsh scripts/build-moonlight.ps1 -InstallDeps -Package # stream player, via MSYS2 UCRT64 (Qt 6)
cd app; npm install; npm start                        # run Moonshine from source
pwsh scripts/package.ps1                              # dist/Moonshine-Setup.exe
```

`package.ps1` ships Moonshine's own player build from `build/moonlight/dist` when it exists. Without it, it falls back to the official Moonlight release fetched by `scripts/fetch-moonlight.ps1` (same features, but the stream window is named Moonlight).

The player build uses MSYS2's Qt, SDL2, FFmpeg, libplacebo, OpenSSL and Opus instead of Moonlight's prebuilt MSVC libraries, and leaves out its AntiHooking and Discord integrations. It keeps Moonlight's own settings location, so saved PCs and pairings are shared with a standalone Moonlight.

`build-apollo.ps1` builds through a `subst` drive (`M:` by default; pass `-Drive` to change it), because Apollo's resource compiler can't handle the spaces or `~` in some paths.

## Patches
Moonshine doesn't fork Apollo or Moonlight. The submodules point at their official releases, and Moonshine's changes are plain patch files in `patches/` (`apollo.patch`, `moonlight-qt.patch`, and `moonlight-common-c.patch` for Moonlight's streaming library). `build-apollo.ps1` and `build-moonlight.ps1` apply them first; applying twice is harmless.

To change Apollo or Moonlight: edit the files under `upstream/`, then run `pwsh scripts/patches.ps1 save` and commit the updated patches. To move to a newer upstream release: check out the new tag in the submodule, apply the patches, fix any parts that no longer fit, then save.

## Moonshine's changes to Apollo
In `patches/apollo.patch`:
- **Per-app audio capture** (`src/platform/windows/audio.cpp`): settings `audio_capture_mode` and `audio_capture_app`.
- **Managed mode** (setting `moonshine_managed`): no tray icon or notifications of its own, and newly paired devices get stream and input permissions only.
- **Ask before streaming** (`src/nvhttp.cpp`): each paired device has a `require_approval` flag. A launch or resume from such a device waits, up to a minute, for Moonshine to allow or decline it. After an Allow, reconnects within three minutes don't ask again.
- **Local API for Moonshine** (`src/confighttp.cpp`): `GET /api/moonshine/pending` lists stream requests, pairing requests from another Moonshine, and pairing requests waiting for a PIN; `POST /api/moonshine/decide` answers a stream request and `POST /api/moonshine/decide-pair` a pairing request. Moonshine polls the first once a second, which is also how the host knows Moonshine is running.
- **No login for Moonshine**: at each start the host writes a random key to `config/moonshine_token`. Requests from this PC that send it (`X-Moonshine-Token`) need no web login, so Moonshine works on a PC whose Apollo login it was never given.
- **Pairing requests** (`src/nvhttp.cpp`, on the port pairing already uses): `/moonshine/hello`, `/moonshine/pair` and `/moonshine/pair-status`, described below. A new pairing attempt also replaces an abandoned one instead of getting stuck behind it.
- **Service renamed** to `MoonshineHost` ("Moonshine Host"), with its own firewall rule name.
- The build reports its real version (0.4.6) instead of 0.0.0.

## How pairing between two Moonshines works
1. The friend's Moonshine picks a random PIN, shows it, and sends it to the host engine: `GET http://<host>:47989/moonshine/pair?pin=...&name=...`. If Moonshine isn't open on the host, the friend is told so straight away.
2. The friend's Moonshine runs `Moonlight pair <host> --pin <pin>` as usual.
3. The host's Moonshine shows an Accept popup, with the Tailscale user when the request came over Tailscale.
4. On Accept, the host's Moonshine gives the PIN to its host engine, which completes the pairing. The new device can stream and use inputs; clipboard, file and command permissions stay off until you turn them on under Devices.

That request travels the same way Moonlight's own pairing does (plain HTTP on your network, encrypted inside Tailscale), and nothing happens until the host's user accepts. A host that isn't Moonshine doesn't answer it, so the PIN is typed there as usual.

## Installer
- No options: Welcome, Installing, Finish. Everything goes to `C:\Program Files\Moonshine`; the host engine is in its `host` folder and runs as the **Moonshine Host** service.
- **A separately installed Apollo is moved in.** `installer/prepare-host.ps1` copies its settings, apps, login, paired devices and identity into Moonshine (only if Moonshine has none yet), then removes the old Apollo: its service, firewall rule, PATH entry, Start menu folder, files and its entry in Windows' installed apps. Nothing has to pair again.
- Every external command the installer runs has a time limit, so no step can leave it stuck. The host preparation step logs what it did to `C:\Program Files\Moonshine\install.log`.
- The virtual display and virtual gamepad drivers are installed system-wide. The uninstaller asks before removing them.
- `makensis /DPREVIEW` builds a look-only copy of the installer that needs no admin and installs nothing, for checking its pages.
- The welcome/finish artwork is `installer/welcome.bmp`, made by `scripts/gen-installer-art.js`. The app icons are made from `app/assets/moonshine.svg` by `scripts/gen-icons.js`.
- If the host had an Apollo web login before Moonshine and Moonshine doesn't know it, sign in once on the Host tab. Otherwise Moonshine creates its own login automatically.

## Updates
Moonshine checks GitHub for a new release shortly after it starts and every 6 hours (or on demand: click the version at the bottom of the sidebar). A new version shows in the sidebar and the tray menu. **Update now** downloads it, checks it, asks once, then closes Moonshine, installs behind a Windows admin prompt, and opens Moonshine again. Anyone streaming from that PC is disconnected while it installs, and the prompt says so.

Every release is signed. `scripts/release.ps1` signs `Moonshine-Setup.exe` with an Ed25519 key kept outside the repository (`%USERPROFILE%\.moonshine-release\update-key.pem`), and the app installs only a download whose checksum and signature match the public key built into `app/lib/updater.js` and whose version is newer than its own. So a damaged or tampered download, or an old installer, is refused.

To publish a release:
1. Raise `version` in `app/package.json` (and `package-lock.json`).
2. Build: `build-apollo.ps1 -Package`, `build-moonlight.ps1 -Package`, `package.ps1`.
3. Commit and push, then `pwsh scripts/release.ps1 -Notes "What's new"`. It signs the installer and creates the GitHub release `v<version>` with it (needs the GitHub CLI, signed in). The signature goes into the release notes as a hidden comment (`<!-- moonshine-update-sig: … -->`), so the release page shows only the installer. Don't remove that line when editing a release's notes, or the app can't install that release. Moonshine 0.3.2 and older only read a separate `Moonshine-Setup.exe.sig` file; `-SigAsset` attaches one too (0.3.3 was released that way so those copies could update).

Keep a backup of the signing key. Without it, the copies of Moonshine already installed can't take another in-app update.

Licences: see [LICENSES/](LICENSES/).
