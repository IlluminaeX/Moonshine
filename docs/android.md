# Moonshine for Android

Stream games from your own PC, or a friend's, to your phone or tablet. The PC runs Moonshine too.

## Install
Download `Moonshine-Android.apk` from the [latest release](https://github.com/IlluminaeX/Moonshine/releases/latest) and open it. Android asks once whether your browser may install apps. Allow it, install, and you can switch that off again.

After that Moonshine updates itself: it checks when it opens and then on the schedule you pick in Settings, downloads and verifies the update, and Android asks you to confirm. Your PCs, pairings and settings are kept.

## Getting started
1. **Sign in with Discord.** It's only used to know who you are. Pick a username; friends add you by it.
2. **Your own PCs** show up on the Computers tab, already paired, as soon as Moonshine on the PC is signed in with the same account.
3. **Friends:** add them by username on the Friends tab. Any friend who's hosting gets a Connect button. Moonshine tries the quickest route (same network, Tailscale, a direct connection over the internet) and falls back to a relay, which adds a little delay.
4. The first time you connect to a friend's PC, they get a one-tap request to accept your phone. No PIN.

Tap a PC's **...** to rename it, wake it, send it files, change its stream settings, or run a speed test. The small badge says how you're connected and the delay.

## Files
- **Phone to PC:** pick "Send files" on a PC you're paired with. The PC's owner has to accept each file.
- **PC to phone:** when someone sends you a file, Moonshine asks "Save / Decline" every time, and a saved file goes to Downloads/Moonshine. Do not disturb declines for you. Receiving works while the app is running; Android TV never receives files.

## Invite links
Someone without an account can send you an invite link. Open it, tap Join, and you're connected to their PC as a guest. It works once, and Leave ends it.

## Help
- **Export log:** in Settings, Help. It saves a file you can send when something goes wrong.
- **No PC shows up:** open Moonshine on the PC and check it's signed in with the same account. A friend's PC only shows while they're hosting.
- **"Isn't connected right now":** their Moonshine isn't running or signed in.
- **"Couldn't connect directly":** one of your networks blocks direct connections, which is common on mobile data. Try Wi-Fi, or install [Tailscale](https://tailscale.com) on both sides.
- **PC asleep:** use Wake on its row. It needs Wake-on-LAN turned on in the PC's BIOS and network adapter, and works on the same network.
- **Pairing waits:** your friend hasn't answered the request on their PC yet.
- **Stutter:** lower the resolution or bitrate, or use 5 GHz Wi-Fi.
- **Stream dropped:** Moonshine retries for about 30 seconds. "Stop reconnecting" gives up.

Still stuck? [Open an issue](https://github.com/IlluminaeX/Moonshine/issues).
