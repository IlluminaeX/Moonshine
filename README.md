# Moonshine

Stream games from your PC to your friends, or from theirs to you, in one Windows app (plus an Android app). You sign in with Discord, add friends by username, and click Connect. No port forwarding, no VPN, no PIN typing.

Under the hood the host is a build of [Apollo](https://github.com/ClassicOldSong/Apollo) and the player is [Moonlight](https://github.com/moonlight-stream/moonlight-qt). Both live inside Moonshine, so there are no extra windows, tray icons or web pages.

**Download:** the installer and the Android APK are on the [latest release](https://github.com/IlluminaeX/Moonshine/releases/latest). Android has its own short guide: [docs/android.md](docs/android.md).

## What it does

**Connect** (the first tab) lists your PCs and your friends' PCs in one place. You see who's online, who's hosting, and what they're playing. Click Connect and it works out the fastest route by itself: same network, Tailscale, a direct connection through both routers, or a relay as a last resort. Streams are encrypted end to end, so the relay only carries scrambled data.

- **Friends:** add people by username, set nicknames only you see, send quick messages, or invite someone into your game. Do not disturb mutes it all.
- **Invite links:** "Copy invite link" in your account box gives you a one-time link for someone without an account. It works once and runs out after an hour if nobody uses it.
- **Send files:** drop files on a friend's PC, or on a friend's phone, and they get a Save / Decline prompt first. Files go straight from PC to PC (or PC to phone), never through a server, and have no size limit.
- **Discord status:** friends see what you're hosting, with a Join button that opens Moonshine on their side.
- **Wake** a sleeping PC on your network, boost quiet audio up to 10x, auto-reconnect when Wi-Fi blips, and run a speed test to pick a bitrate.

**Host** is where you control your own PC.

- **You decide who streams.** Every device asks first by default, and you get an Allow / Decline popup (or tick "don't ask again" for that device). If Moonshine isn't running, devices that have to ask are turned away.
- **Stop hosting** closes the PC to everyone but leaves the host running, so you can still manage devices. **Pause** does the same for 30 minutes to a few hours.
- **Devices:** rename, disconnect or remove a device, and set what it can do (keyboard, mouse, controller, clipboard, files, and so on). New devices, and devices paired before 0.8.0, may send you files, and you still click Accept on each one.
- Friends pair with each other automatically. Any other Moonlight client gets a box to type the PIN it shows.

**Settings** has Moonshine's own options, per-PC stream settings (resolution, frame rate, bitrate, codec, HDR, virtual display), and all of the host's settings, with the rarely needed ones under Advanced. **Beta** holds features that haven't had much real-world use yet (auto-tuned quality and steadier Wi-Fi).

Also in there: per-app audio capture (stream everything except Discord, say), a "Save log for support" button, and a local API that a Steam plugin can use to invite friends ([docs/stream-link.md](docs/stream-link.md)).

## Building

You need [MSYS2](https://www.msys2.org) at `C:\msys64`, Node.js 20+, and PowerShell 7.

```powershell
git submodule update --init --recursive
pwsh scripts/build-apollo.ps1 -InstallDeps -Package     # host
pwsh scripts/build-moonlight.ps1 -InstallDeps -Package  # player
cd app; npm install; npm test; npm start                # run from source
pwsh scripts/package.ps1                                # dist/Moonshine-Setup.exe
```

For Android you need JDK 17 and the Android SDK (platform 36, build-tools 36.0.0, NDK 27.0.12077973):

```powershell
pwsh scripts/build-android.ps1 -Test    # signed dist/Moonshine-Android.apk, runs the unit tests
pwsh scripts/build-android.ps1 -Debug -Install   # debug build onto a plugged-in phone
```

The first Android release build creates a signing key in `%USERPROFILE%\.moonshine-release\`. Back it up and never commit it: Android only installs an update signed with the same key.

## How it's put together

| Path | What |
|------|------|
| `app/` | The Moonshine app (Electron) |
| `cloud/` | The friends service (a Cloudflare Worker with a D1 database) |
| `upstream/` | Apollo, Moonlight and the Android app, pinned to official releases |
| `patches/` | Moonshine's changes to those, as patch files |
| `scripts/`, `installer/` | Build, package and release scripts, and the NSIS installer |

Moonshine doesn't fork Apollo or Moonlight. To change them, edit under `upstream/`, run `pwsh scripts/patches.ps1 save`, and commit the patch. The build scripts apply the patches first.

The main changes to Apollo: per-app audio capture, a managed mode with no tray icon of its own, "ask before streaming" enforced inside the host, a local API for Moonshine, Moonshine-to-Moonshine pairing and file endpoints, and the service renamed to Moonshine Host. Details are in `patches/apollo.patch`.

## The friends service

`cloud/` is a small Cloudflare Worker. It keeps accounts, friend lists, presence and the live link that carries messages, invites, file offers and the handshake for direct connections. It never sees stream data or file contents. To deploy: `npx wrangler deploy` from `cloud/`. When a release adds a migration from `cloud/migrations/`, apply it first with `npx wrangler d1 execute moonshine --remote --file=migrations/<file>.sql`.

## Installer and updates

The installer has no options. It installs to `C:\Program Files\Moonshine` and runs the host as the "Moonshine Host" service. If a separate Apollo is installed, its settings, apps and paired devices are moved in and the old install is removed, so nothing has to be paired again.

Moonshine checks GitHub for updates a few times a day and installs one only if its signature matches the public key built into the app. The Android app updates itself the same way and asks you to confirm.

To publish a release: raise the version in `app/package.json`, build the host, player, installer and APK, then run `pwsh scripts/release.ps1 -Notes "What's new"`. It signs the installer and creates the GitHub release. The signature goes into the release notes as a hidden comment, so don't delete it when editing the notes. Keep a backup of the signing key (`%USERPROFILE%\.moonshine-release\update-key.pem`); without it, installed copies can't take another update.

Licences are in [LICENSES/](LICENSES/).
