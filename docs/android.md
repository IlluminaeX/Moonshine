# Moonshine for Android

Moonshine for Android streams games from a PC to your phone, tablet or Android TV. It works with any PC that hosts with Moonshine, and with other streaming hosts too.

## Getting it
Download `Moonshine-Android.apk` from the [latest release](https://github.com/IlluminaeX/Moonshine/releases/latest) on your phone and open it. Android asks whether your browser may install apps the first time: allow it, install, then you can turn that permission off again.

Moonshine checks for a new version once a day and offers to open its page. A new version installs over the old one and keeps your PCs, pairings and settings.

## Your friends' PCs
Tap the **Friends** button (two people) on the PC list.

1. **Sign in with Discord.** Moonshine only uses it to know it's you. Pick a username; friends add you by it.
2. **Add friends** by their Moonshine username. Requests to you show at the top with Accept and Decline.
3. **Connect.** Every friend's PC that's hosting shows a Connect button. Moonshine tries the quickest way first (the same home network, or Tailscale), and otherwise makes a direct connection over the internet, with no port forwarding or VPN. If even that can't get through, a relay carries it, with a little more delay.
4. **The first time,** your friend's Moonshine asks them to accept your phone (one tap for them, no PIN to read out). A phone on their home network or Tailscale, or one that comes through a direct connection, is let in by itself. After that, their PC appears in your PC list like any other.

The **…** button next to a friend sends them a quick message, sets a nickname only you see, or removes them.

While Moonshine is open your friends see your phone online. A minute after you leave the app it shows offline. Messages and "join my game" invites arrive while the app is open; tapping the notification opens it.

## Invite links
A friend without an account to share can send you an invite link (`moonshine://join/...` or a page with an **Open in Moonshine** button). Open it on your phone, tap Join, and Moonshine connects you to their PC as a guest. A link works once. **Leave** on the invite card ends it; so does your friend.

## Streaming from a PC without Moonshine
Moonshine also streams from PCs that host with Sunshine, Apollo or GeForce Experience. On the same network they show up by themselves; otherwise tap **+** and type the PC's address. When you pair, Moonshine shows a PIN: enter it in that host's settings page (Moonshine on a PC asks its user instead).

## If something doesn't work
- **"Isn't connected right now":** your friend's Moonshine isn't running or isn't signed in. Ask them to open it.
- **"Couldn't connect directly":** your network or theirs doesn't allow direct connections (common on mobile data). Try Wi-Fi, or set up [Tailscale](https://tailscale.com) on both sides; Moonshine uses it by itself.
- **Pairing waits forever:** your friend hasn't answered the request in Moonshine on their PC. Ask them to look for it.
- **The stream stutters:** lower the resolution or bitrate in Settings, or use 5 GHz Wi-Fi.
- **A friend's PC shows offline** after a while: the connection closes after 10 idle minutes and reopens when you open the PC list again.

Still stuck? [Open an issue](https://github.com/IlluminaeX/Moonshine/issues).
